// Starts a throwaway Chrome profile and loads the unpacked extension through the DevTools
// protocol (Extensions.loadUnpacked). Branded Chrome ignores --load-extension since v137;
// this is the route it still allows, and it needs --remote-debugging-pipe.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  win32: [
    `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
};

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = (CANDIDATES[process.platform] ?? []).find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH.");
  return found;
}

export async function launch(extensionDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-live-"));
  // On macOS and Linux, Chrome looks for native hosts inside --user-data-dir, not in the everyday
  // profile's folder where `tabbridge install` put it. Windows uses the registry instead.
  if (process.platform !== "win32") {
    const name = "com.verbodh.tabbridge.json";
    fs.mkdirSync(path.join(profile, "NativeMessagingHosts"));
    fs.copyFileSync(path.join(os.homedir(), ".tabbridge", name), path.join(profile, "NativeMessagingHosts", name));
  }
  const child = spawn(findChrome(), [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--window-size=1280,900",
    // TABBRIDGE_HEADLESS=1: no window on the screen, so the test can run while someone works.
    ...(process.env.TABBRIDGE_HEADLESS ? ["--headless=new"] : []),
    // The test window is often behind other windows. Chrome would stop drawing it, which drops
    // screencast frames and delays input; keep it drawing as if it were in front.
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const out = child.stdio[3];
  const inn = child.stdio[4];
  let nextId = 1;
  const waiting = new Map();
  let pending = "";
  inn.on("data", (chunk) => {
    pending += chunk.toString();
    let at;
    while ((at = pending.indexOf("\0")) >= 0) {
      const msg = JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
      if (msg.id && waiting.has(msg.id)) {
        const { resolve, reject } = waiting.get(msg.id);
        waiting.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
      }
    }
  });

  // Every call has a time limit: a page that closes mid-call (the pane closes itself once
  // answered) must fail a check, not hang the whole run.
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} got no answer in 15 s`)); }, 15_000);
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });

  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extensionDir });

  async function close() {
    await cdp("Browser.close").catch(() => {});
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
    // Chrome can hold profile files for a moment after exit; a leftover temp folder is harmless.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* left in temp */ }
  }

  /** Answers a TabBridge question by clicking the button with this text. It uses the toolbar
   *  pane when it opens; the pane needs Chrome to be the window in front, which a desktop in use
   *  may not allow, so after a few seconds it answers in the side panel page instead (the same
   *  question, the same buttons). paneOnly: the pane itself is what is being tested. */
  async function answerApproval(buttonText, timeoutMs = 15_000, { paneOnly = false } = {}) {
    const until = Date.now() + timeoutMs;
    const start = Date.now();
    let focused = false;
    const clickIn = async (sessionId) => {
      const { result } = await cdp("Runtime.evaluate", {
        expression: `(() => { const b = [...document.querySelectorAll("[data-approval] button")].find(b => b.textContent.trim() === ${JSON.stringify(buttonText)}); if (!b) return ""; b.click(); return "clicked"; })()`,
        returnByValue: true,
      }, sessionId).catch(() => ({ result: {} }));
      return result.value === "clicked";
    };
    while (Date.now() < until) {
      const { targetInfos } = await cdp("Target.getTargets");
      const target = targetInfos.find((t) => t.url.includes(`${extensionId}/popup.html`));
      if (!target && !focused && Date.now() - start > 1500) {
        focused = true;
        await extEval(`chrome.windows.getAll({ windowTypes: ["normal"] }).then((ws) => { const w = ws.find((x) => x.type === "normal"); return w && chrome.windows.update(w.id, { focused: true }); })`).catch(() => {});
      }
      if (target) {
        // The pane found may be the previous one closing itself: try it for a moment, then look again.
        const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }).catch(() => ({}));
        for (let i = 0; sessionId && i < 15; i++) {
          if (await clickIn(sessionId)) return "pane";
          await new Promise((r) => setTimeout(r, 100));
        }
      } else if (!paneOnly && Date.now() - start > 4000) {
        const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel.html`, background: true });
        try {
          const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
          for (let i = 0; i < 50; i++) {
            if (await clickIn(sessionId)) return "side panel";
            await new Promise((r) => setTimeout(r, 100));
          }
        } finally {
          await cdp("Target.closeTarget", { targetId }).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const waiting = await extEval(`chrome.storage.session.get("approvals").then(x => (x.approvals || []).map(a => a.kind + ": " + a.detail).join(" | "))`).catch(() => "?");
    throw new Error(`No "${buttonText}" for a question appeared in TabBridge within ${timeoutMs} ms (waiting: ${waiting || "nothing"})`);
  }

  /** True while TabBridge is waiting for an answer (in the pane or the fallback window). */
  async function approvalOpen() {
    return (await extEval(`chrome.storage.session.get("approvals").then(x => (x.approvals ?? []).length)`)) > 0;
  }

  /** The toolbar pane, if it is open: its target id. */
  async function paneTarget() {
    const { targetInfos } = await cdp("Target.getTargets");
    return targetInfos.find((t) => t.url.includes(`${extensionId}/popup.html`))?.targetId ?? null;
  }

  /** Runs an expression inside the extension (an extension page), for settings and tab groups. */
  let extSession = null;
  async function extEval(expression, retry = true) {
    try {
      return await extEvalOnce(expression);
    } catch (err) {
      // Chrome may close or discard the helper tab mid-run: open a fresh one, once.
      if (!retry || !/Session with given id not found|Target closed|No target/i.test(err.message)) throw err;
      extSession = null;
      return extEval(expression, false);
    }
  }
  async function extEvalOnce(expression) {
    if (!extSession) {
      const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html`, background: true, newWindow: false });
      ({ sessionId: extSession } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
      // Wait until the extension page has loaded and chrome.storage exists.
      for (let i = 0; i < 50; i++) {
        const { result } = await cdp("Runtime.evaluate", { expression: "typeof chrome !== 'undefined' && !!chrome.storage", returnByValue: true }, extSession);
        if (result.value) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const { result, exceptionDetails } = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, extSession);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  return { cdp, extensionId, close, answerApproval, approvalOpen, paneTarget, extEval };
}
