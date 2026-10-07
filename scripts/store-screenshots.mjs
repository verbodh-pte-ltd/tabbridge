// Takes the Chrome Web Store screenshots (1280×800) from the real extension, in a throwaway Chrome
// profile, against the local test site. Output: store/screenshots/NN-*.png
//
//   npm run build && node bridge/dist/cli.js install && node scripts/store-screenshots.mjs
//   (TABBRIDGE_HEADLESS=1 in front: no window on the screen)

import fs from "node:fs";
import path from "node:path";
import { BridgeClient } from "../bridge/src/client.ts";
import { launch } from "../tests/live/chrome.mjs";
import { startSite } from "../tests/live/site.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "store", "screenshots");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pin every call to the test Chrome by name; otherwise the agent may drive your everyday Chrome.
const LABEL = "tabbridge-store-shots";
process.env.TABBRIDGE_BROWSER = LABEL;
const site = await startSite();
const chrome = await launch(path.join(root, "extension", "dist"));
const agent = new BridgeClient("claude-code");
await sleep(1500);

async function shoot(url, file, setup) {
  const { targetId } = await chrome.cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.cdp("Target.attachToTarget", { targetId, flatten: true });
  await chrome.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await chrome.cdp("Page.enable", {}, sessionId);
  await chrome.cdp("Page.navigate", { url }, sessionId);
  await sleep(1200);
  if (setup) await chrome.cdp("Runtime.evaluate", { expression: setup, awaitPromise: true }, sessionId);
  await sleep(300);
  const { data } = await chrome.cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(out, file), Buffer.from(data, "base64"));
  await chrome.cdp("Target.closeTarget", { targetId });
  console.log(`saved store/screenshots/${file}`);
}

try {
  // 1. The settings page as a new user sees it: taken before the test names this browser.
  await shoot(`chrome-extension://${chrome.extensionId}/options.html`, "01-settings.png",
    "document.body.style.background = getComputedStyle(document.body).backgroundColor");
  await chrome.extEval(`chrome.storage.local.set({ settings: { browserName: ${JSON.stringify(LABEL)} } })`);
  for (let i = 0; i < 40 && (await agent.call("tabs_list", {}, 3000)).isError; i++) { agent.close(); await sleep(250); }


  // 2. A real risky-action question, drawn over the page it came from. YOLO mode starts on and
  // asks nothing, so switch it off first.
  await chrome.extEval(`chrome.storage.local.set({ settings: { browserName: ${JSON.stringify(LABEL)}, yolo: false } })`);
  await agent.call("navigate", { url: site.url() });
  const send = (await agent.call("find", { query: "Send message" })).content[0].text.match(/\[(e\d+)\]/)[1];
  const pending = agent.call("click", { ref: send });
  // Wait for the question, then open the pane's page as a normal page: the real pane (a toolbar
  // popup) can't be resized for the picture, and headless Chrome may not open it at all.
  for (let i = 0; i < 50; i++) {
    if (await chrome.extEval(`chrome.storage.session.get("approvals").then(x => (x.approvals ?? []).length)`)) break;
    await sleep(100);
  }
  const approval = await chrome.cdp("Target.createTarget", { url: `chrome-extension://${chrome.extensionId}/popup.html`, background: true });
  // Extension pages can't be framed into a web page, so photograph the real window and lay the
  // picture over the page it belongs to.
  const { sessionId: pop } = await chrome.cdp("Target.attachToTarget", { targetId: approval.targetId, flatten: true });
  for (let i = 0; i < 50; i++) {
    const { result } = await chrome.cdp("Runtime.evaluate", { expression: "document.querySelectorAll('[data-approval] button').length", returnByValue: true }, pop);
    if (result.value > 0) break;
    await sleep(100);
  }
  await chrome.cdp("Emulation.setDeviceMetricsOverride", { width: 440, height: 300, deviceScaleFactor: 2, mobile: false }, pop);
  await sleep(300);
  const { data: popup } = await chrome.cdp("Page.captureScreenshot", { format: "png" }, pop);
  await shoot(site.url(), "02-asks-before-risky-actions.png", `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${popup}";
    Object.assign(img.style, { position: "fixed", right: "56px", top: "56px", width: "440px",
      border: "1px solid #ccd", borderRadius: "10px", boxShadow: "0 18px 50px rgba(0,0,0,.28)" });
    document.body.append(img);
    await img.decode();
  })()`);
  await chrome.answerApproval("Don't allow").catch(() => {});
  await pending;

  // 3. What an agent gets from page_report, shown as it reads in a terminal.
  const report = (await agent.call("page_report", {})).content[0].text.replace(/<\/?untrusted-page-content[^>]*>/g, "").trim();
  const terminal = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#11161a;color:#d7e0e6;font:15px/1.45 Consolas,ui-monospace,monospace;padding:36px 48px">
    <div style="color:#7cc0ef">&gt; The contact form on our test site is broken. What's wrong?</div>
    <div style="color:#8a98a3;margin:14px 0 6px">● tabbridge · page_report</div>
    <pre style="white-space:pre-wrap;margin:0;max-height:640px;overflow:hidden">${report.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;")).slice(0, 2400)}</pre>
  </body></html>`)}`;
  await shoot(terminal, "03-page-report-for-the-agent.png");

  // 4. The popup: connected, with the agent listed.
  await shoot(`chrome-extension://${chrome.extensionId}/popup.html`, "04-connected-agents.png",
    "document.body.style.width = '1280px'; document.querySelector('main').style.cssText = 'max-width:420px;margin:80px auto;transform:scale(1.5);transform-origin:top center'");
} finally {
  agent.close();
  await chrome.close();
  site.close();
}
