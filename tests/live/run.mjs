// Live test: real Chrome, the real extension, the real installed host, a local test site.
//
//   npm run build && node bridge/dist/cli.js install && npm run test:live
//   TABBRIDGE_HEADLESS=1 npm run test:live      # no window on the screen
//
// It uses a throwaway Chrome profile, so your own profile, tabs and sign-ins are not touched. Each
// Chrome gets its own host slot, and every call is pinned to the test browser by name, so it is
// safe while TabBridge runs in your everyday Chrome.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeClient, NOT_CONNECTED } from "../../bridge/src/client.ts";
import { DEV_EXTENSION_ID } from "../../bridge/src/shared/protocol.ts";
import { launch } from "./chrome.mjs";
import { startSite } from "./site.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI = path.join(ROOT, "bridge", "dist", "cli.js");
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const unwrap = (t) => t.replace(/<\/?untrusted-page-content[^>]*>/g, "").trim();
const only = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
// TABBRIDGE_SKIP="regex" leaves matching checks out, to find which one disturbs a later one.
const skip = process.env.TABBRIDGE_SKIP ? new RegExp(process.env.TABBRIDGE_SKIP, "i") : null;

async function check(name, fn) {
  if (only && !only.test(name)) return;
  if (skip && skip.test(name)) return;
  try {
    await fn();
    results.push([name, true, ""]); console.error(`... pass  ${name}`);
  } catch (err) {
    results.push([name, false, err?.message ?? String(err)]); console.error(`... FAIL  ${name}: ${err?.message ?? err}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(String(msg).slice(0, 600)); }
const js = async (client, code) => unwrap(text(await client.call("javascript", { code })));
const refFor = async (client, query) => text(await client.call("find", { query })).match(/\[(e\d+)\]/)?.[1];

// Every client is pinned to the test browser by name, so this never acts in your own Chrome,
// even if TabBridge runs there too.
const LABEL = "tabbridge-live-a";
process.env.TABBRIDGE_BROWSER = LABEL;
const site = await startSite();
const chrome = await launch(path.join(ROOT, "extension", "dist"));
const settings = (browser, patch) => browser.extEval(`chrome.storage.local.get("settings").then(x => chrome.storage.local.set({ settings: { ...(x.settings || {}), ...${JSON.stringify(patch)} } }))`);
await sleep(1500);
// TABBRIDGE_LIVE_SETTINGS='{"agentWindow":false,"overlay":false}' runs the suite as it was before the agent window and the overlay.
await settings(chrome, { browserName: LABEL, ...JSON.parse(process.env.TABBRIDGE_LIVE_SETTINGS ?? "{}") });
const a = new BridgeClient("agent-a");
const b = new BridgeClient("agent-b");
let downloaded = null;

try {
  await check("extension loads with the fixed development id", () => {
    expect(chrome.extensionId === DEV_EXTENSION_ID, `got ${chrome.extensionId}`);
  });

  await check("extension connects to the host", async () => {
    for (let i = 0; i < 40; i++) {
      const r = await a.call("tabs_list", {}, 3000);
      if (!r.isError) return;
      a.close();
      await sleep(250);
    }
    throw new Error("never connected");
  });

  await check("defaults: sites allowed, shared group, guards on, secrets hidden (only the test's browser name set)", async () => {
    const s = await chrome.extEval(`chrome.storage.local.get("settings").then(x => x.settings ?? null)`);
    expect(JSON.stringify(s) === JSON.stringify({ browserName: LABEL }), `settings: ${JSON.stringify(s)}`);
  });

  await check("tabs_list: no tabs at first", async () => {
    expect(/No tabs/.test(text(await a.call("tabs_list", {}))), "expected no tabs");
  });

  let tabA;
  await check("navigate with no tab opens one, without asking about the site", async () => {
    const r = await a.call("navigate", { url: site.url() });
    expect(!r.isError, text(r));
    expect(!(await chrome.approvalOpen()), "asked about the site although sites are allowed by default");
    tabA = Number(text(r).match(/tab (\d+)/)?.[1]);
    expect(tabA && /Acme contact form/.test(text(r)), text(r));
  });

  await check("navigate again reuses the same tab (one tab, not a new one each time)", async () => {
    await a.call("navigate", { url: site.url("/second") });
    await a.call("navigate", { url: site.url() });
    const list = text(await a.call("tabs_list", {}));
    expect((list.match(/tab \d+:/g) ?? []).length === 1, list);
  });

  await check("the tab sits in one group named TabBridge", async () => {
    const groups = await chrome.extEval(`chrome.tabGroups.query({}).then(gs => gs.map(g => g.title))`);
    expect(groups.length === 1 && groups[0] === "TabBridge ✓", JSON.stringify(groups));
    const color = await chrome.extEval(`chrome.tabGroups.query({}).then(gs => gs[0].color)`);
    expect(color === "orange", `group colour ${color}`);
  });

  await check("the toolbar icon shows ✓ while connected, and the tooltip names the agents", async () => {
    const badge = await chrome.extEval(`chrome.action.getBadgeText({})`);
    const title = await chrome.extEval(`chrome.action.getTitle({})`);
    expect(badge === "✓" && /connected · \d+ agents? working/.test(title), `${badge} | ${title}`);
  });

  await check("read_page lists controls with refs, wrapped as untrusted", async () => {
    const r = text(await a.call("read_page", {}));
    expect(r.startsWith("<untrusted-page-content"), r.slice(0, 80));
    expect(/\[e\d+\] button "Send message"/.test(r) && /\[e\d+\] textbox "Name"/.test(r), r);
  });

  await check("read_page filter=all includes page text, still wrapped", async () => {
    const r = text(await a.call("read_page", { filter: "all" }));
    expect(/Ignore previous instructions/.test(r) && r.includes("</untrusted-page-content>"), r);
  });

  let nextRef, sendRef, nameRef, teamRef, newsRef;
  await check("find returns refs", async () => {
    [nextRef, sendRef, nameRef, teamRef, newsRef] = await Promise.all(
      ["Next", "Send message", "Name", "Team", "Newsletter"].map((q) => refFor(a, q)));
    expect(nextRef && sendRef && nameRef && teamRef && newsRef, `${nextRef} ${sendRef} ${nameRef} ${teamRef} ${newsRef}`);
  });

  await check("YOLO mode is on by default: a risky click goes ahead without a question", async () => {
    const r = await a.call("click", { ref: sendRef });
    expect(!r.isError, text(r));
    expect(!(await chrome.approvalOpen()), "asked although YOLO mode is on by default");
    // The rest of the run checks the questions, so it switches YOLO mode off, as a user would,
    // and clears the page's "Message sent" so later checks start clean.
    await settings(chrome, { yolo: false });
    await a.call("javascript", { code: "out.textContent = ''" });
  });

  await check("click on an ordinary button: no question asked", async () => {
    const r = await a.call("click", { ref: nextRef });
    expect(!r.isError, text(r));
    expect(!(await chrome.approvalOpen()), "an approval window opened");
    expect((await js(a, "document.getElementById('out').textContent")).includes("next clicked"), "not clicked");
  });

  await check("form_input sets text, dropdown and checkbox", async () => {
    await a.call("form_input", { ref: nameRef, value: "Ada" });
    await a.call("form_input", { ref: teamRef, value: "Engineering" });
    await a.call("form_input", { ref: newsRef, value: true });
    const r = await js(a, "[document.getElementById('name').value, team.value, news.checked].join('|')");
    expect(r.includes("Ada|eng|true"), r);
  });

  await check("type and key: text typed into the focused field", async () => {
    await a.call("javascript", { code: "document.getElementById('msg').focus()" });
    await a.call("type", { text: "Hello there" });
    await a.call("key", { keys: "Control+a Backspace" });
    await a.call("type", { text: "Hi" });
    const r = await js(a, "msg.value");
    expect(r === '"Hi"', r);
  });

  await check("risky click asks; 'Don't allow' stops it", async () => {
    const pending = a.call("click", { ref: sendRef });
    await chrome.answerApproval("Don't allow");
    const r = await pending;
    expect(r.isError && /did not allow/.test(text(r)), text(r));
    expect(!(await js(a, "out.textContent")).includes("Message sent"), "it was sent anyway");
  });

  await check("risky click asks; 'Allow' goes ahead", async () => {
    const pending = a.call("click", { ref: sendRef });
    await chrome.answerApproval("Allow");
    const r = await pending;
    expect(!r.isError, text(r));
    expect((await js(a, "out.textContent")).includes("Message sent"), "not sent");
  });

  await check("Enter in a form with a Send button asks first", async () => {
    await a.call("click", { ref: nameRef });
    const pending = a.call("key", { keys: "Enter" });
    await chrome.answerApproval("Don't allow");
    expect((await pending).isError, "Enter went through without asking");
  });

  await check("the question opens in the toolbar pane, and the badge counts it", async () => {
    const click = a.call("click", { ref: sendRef });
    // Wait for the question itself first: the previous pane may still be closing.
    for (let i = 0; i < 50 && !(await chrome.approvalOpen()); i++) await sleep(100);
    let badge = "";
    for (let i = 0; i < 30 && badge !== "1"; i++) { badge = await chrome.extEval(`chrome.action.getBadgeText({})`); await sleep(100); }
    expect(badge === "1", `badge: ${badge}`);
    await chrome.answerApproval("Don't allow", 15_000, { paneOnly: true });
    expect((await click).isError, "went ahead after Don't allow");
    let after = "";
    for (let i = 0; i < 30 && after !== "✓"; i++) { after = await chrome.extEval(`chrome.action.getBadgeText({})`); await sleep(100); }
    expect(after === "✓", `badge did not go back to ✓: ${after}`);
  });

  await check("closing the pane keeps the question; reopening it lets you answer", async () => {
    const click = a.call("click", { ref: sendRef });
    for (let i = 0; i < 50 && !(await chrome.approvalOpen()); i++) await sleep(100);
    await sleep(800);  // let any earlier pane finish closing and the new one open
    let pane = null;
    for (let i = 0; i < 50 && !(pane = await chrome.paneTarget()); i++) await sleep(100);
    expect(pane, "the TabBridge pane did not open");
    await chrome.cdp("Target.closeTarget", { targetId: pane });
    await sleep(500);
    expect(await chrome.approvalOpen(), "closing the pane answered the question");
    // What a user does: click the TabBridge icon (here: focus the window, then open the pane).
    await chrome.extEval(`chrome.windows.getAll({ windowTypes: ["normal"] }).then(async (ws) => { await chrome.windows.update(ws[0].id, { focused: true }); await chrome.action.openPopup({ windowId: ws[0].id }).catch(() => {}); })`);
    await chrome.answerApproval("Don't allow");
    expect((await click).isError, "went ahead after Don't allow");
  });

  // The side panel page, opened as a tab: Chrome only opens the real side panel after a click.
  async function consolePage() {
    const { targetId } = await chrome.cdp("Target.createTarget", { url: `chrome-extension://${chrome.extensionId}/sidepanel.html`, background: true });
    const { sessionId } = await chrome.cdp("Target.attachToTarget", { targetId, flatten: true });
    const run = async (expression) => (await chrome.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('main')")); i++) await sleep(100);
    return { run, close: () => chrome.cdp("Target.closeTarget", { targetId }) };
  }

  await check("live console: each agent step shows, typed text does not", async () => {
    await a.call("click", { ref: nextRef });
    await a.call("javascript", { code: "document.getElementById('msg').focus()" });
    await a.call("type", { text: "hunter2-not-shown" });
    const page = await consolePage();
    try {
      let text = "";
      for (let i = 0; i < 30 && !/Typed 17 characters/.test(text); i++) { text = await page.run("document.body.innerText"); await sleep(100); }
      expect(/Clicked e\d+/.test(text) && /Typed 17 characters/.test(text), text.slice(0, 600));
      expect(!text.includes("hunter2"), "typed text is shown in the console");
    } finally { await page.close(); }
  });

  await check("live console: a note reaches the agent through user_captures, as the user's own words", async () => {
    await a.call("user_captures", {});  // start empty
    const page = await consolePage();
    try {
      await page.run(`(async () => {
        const t = document.querySelector("textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Acme note: the Send button looks wrong");
        t.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        document.querySelector("form button[type=submit]").click();
      })()`);
      let shown = "";
      for (let i = 0; i < 50 && !/Sent/.test(shown); i++) { shown = await page.run("document.body.innerText"); await sleep(100); }
      expect(/Sent\. Ask your agent/.test(shown), shown);
    } finally { await page.close(); }
    const r = text(await a.call("user_captures", {}));
    expect(/Note from the user \(typed in the TabBridge side panel\): Acme note: the Send button looks wrong/.test(r), r);
    expect(!/<untrusted-page-content[^>]*>[^<]*Acme note/.test(r), "the user's note was wrapped as page content");
  });

  await check("YOLO mode: a risky click goes ahead with no question; off asks again", async () => {
    await chrome.extEval(`chrome.runtime.sendMessage({ type: "set_yolo", on: true })`);
    try {
      const r = await a.call("click", { ref: sendRef });
      expect(!r.isError, text(r));
      expect(!(await chrome.approvalOpen()), "asked although YOLO mode is on");
    } finally {
      await chrome.extEval(`chrome.runtime.sendMessage({ type: "set_yolo", on: false })`);
    }
    const click = a.call("click", { ref: sendRef });
    await chrome.answerApproval("Don't allow");
    expect((await click).isError, "went ahead after Don't allow with YOLO off");
  });

  await check("'Allow, and stop asking' allows this click and turns YOLO mode on", async () => {
    const click = a.call("click", { ref: sendRef });
    await chrome.answerApproval("Allow, and stop asking");
    try {
      expect(!(await click).isError, "the click didn't go ahead");
      const s = await chrome.extEval(`chrome.storage.local.get("settings").then(x => x.settings.yolo)`);
      expect(s === true, `yolo: ${s}`);
    } finally {
      await chrome.extEval(`chrome.runtime.sendMessage({ type: "set_yolo", on: false })`);
    }
  });

  await check("screenshot returns a JPEG of the page", async () => {
    const r = await a.call("screenshot", {});
    const img = r.content.find((c) => c.type === "image");
    expect(img && img.mimeType === "image/jpeg" && img.data.length > 1000, text(r));
  });

  await check("click by x/y from the screenshot", async () => {
    const pos = JSON.parse(await js(a, "(() => { const r = document.getElementById('next').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()"));
    await a.call("javascript", { code: "out.textContent = ''" });
    await a.call("click", { x: pos.x, y: pos.y });
    expect((await js(a, "out.textContent")).includes("next clicked"), "missed");
  });

  await check("console_messages: log and error, and onlyErrors", async () => {
    const all = text(await a.call("console_messages", {}));
    expect(all.includes("hello-from-page") && all.includes("boom-from-page"), all);
    const errors = text(await a.call("console_messages", { onlyErrors: true }));
    expect(!errors.includes("hello-from-page") && errors.includes("boom-from-page"), errors);
  });

  let pingIndex;
  await check("network_requests: the page's requests with status and a [number]", async () => {
    const r = text(await a.call("network_requests", { pattern: "ping|missing" }));
    expect(/\[\d+\] GET 200 .*\/api\/ping/.test(r) && /GET 404 .*\/missing/.test(r), r);
    pingIndex = Number([...r.matchAll(/\[(\d+)\] GET 200 .*\/api\/ping/g)].at(-1)[1]);
  });

  await check("network_request: headers, timing and the response body", async () => {
    const r = text(await a.call("network_request", { index: pingIndex }));
    expect(/Status: 200/.test(r) && /content-type: application\/json/i.test(r) && r.includes('{"ok":true}'), r);
  });

  await check("inspect_element: attributes, computed styles and HTML", async () => {
    const r = text(await a.call("inspect_element", { ref: sendRef }));
    expect(/<button>/.test(r) && /display: /.test(r) && /type="submit"/.test(r) && /Send message/.test(r), r);
    expect(!/data-tabbridge-inspect/.test(r), "marker leaked");
    const bySelector = text(await a.call("inspect_element", { selector: "#next" }));
    expect(/Event listeners on it: click/.test(bySelector) || /onclick|click/.test(bySelector), bySelector);
  });

  await check("storage: local storage shown, token-like values and cookie values hidden", async () => {
    const r = text(await a.call("storage", { kind: "all" }));
    expect(r.includes('theme = "dark"'), r);
    expect(/auth_token = \(hidden/.test(r) && !r.includes("secret-token-value"), "token shown");
    expect(/sessionid .*value=\(hidden/.test(r) && !r.includes("very-secret"), "cookie value shown");
    expect(/Service workers:/.test(r) && /No manifest detected/.test(r), r);
  });

  await check("performance: timings and Web Vitals", async () => {
    const r = text(await a.call("performance", {}));
    expect(/Time to first byte \d+ ms/.test(r) && /DOM nodes/.test(r), r);
  });

  await check("security: HTTP page, missing headers reported", async () => {
    await a.call("navigate", { url: "reload" });
    const r = text(await a.call("security", {}));
    expect(/HTTP, not encrypted/.test(r) && /content-security-policy: missing/.test(r), r);
  });

  await check("page_report: console errors and failed requests in one call", async () => {
    const r = text(await a.call("page_report", {}));
    expect(r.includes("boom-from-page") && /404 .*\/missing/.test(r) && /Performance:/.test(r) && /Security:/.test(r), r);
  });

  await check("wait_for: text that appears later", async () => {
    await a.call("navigate", { url: "reload" });
    expect(!(await a.call("wait_for", { text: "Late arrival", ms: 5000 })).isError, "never appeared");
  });

  await check("navigate to another page on the site, then back", async () => {
    let r = await a.call("navigate", { url: site.url("/second") });
    expect(/Second page/.test(text(r)), text(r));
    r = await a.call("navigate", { url: "back" });
    expect(/Acme contact form/.test(text(r)), text(r));
  });

  await check("get_page_text returns the readable text", async () => {
    expect(text(await a.call("get_page_text", {})).includes("Contact Acme"), "no text");
  });

  await check("scroll runs", async () => {
    expect(!(await a.call("scroll", { direction: "down", amount: 200 })).isError, "scroll failed");
  });

  await check("downloads: a downloaded file shows with its path", async () => {
    await a.call("click", { ref: await refFor(a, "Download report") });
    let r = "";
    for (let i = 0; i < 30; i++) {
      r = text(await a.call("downloads", {}));
      if (/done .*tabbridge-live-report/.test(r)) break;
      await sleep(300);
    }
    expect(/done .*tabbridge-live-report.*\.txt/.test(r), r);
    downloaded = unwrap(r).match(/done\s+(.*?tabbridge-live-report[^ ]*\.txt)/)?.[1] ?? null;
  });

  await check("user_captures: empty until the user sends something", async () => {
    expect(/Nothing sent yet/.test(text(await a.call("user_captures", {}))), "not empty");
  });

  await check("a second agent shares the group but can't see or use the first one's tab", async () => {
    expect(/No tabs/.test(text(await b.call("tabs_list", {}))), "agent b sees agent a's tab");
    expect((await b.call("read_page", { tabId: tabA })).isError, "agent b read agent a's tab");
  });

  await check("with 'ask about new sites' turned on, a new site asks; 'Allow once' opens it", async () => {
    await settings(chrome, { askNewSites: true });
    const pending = b.call("navigate", { url: site.other() });
    await chrome.answerApproval("Allow once");
    const r = await pending;
    expect(!r.isError, text(r));
    const groups = await chrome.extEval(`chrome.tabGroups.query({}).then(gs => gs.length)`);
    expect(groups === 1, `${groups} groups`);
  });

  await check("'Allow once' is per agent: another agent is asked again; 'Always allow' is remembered", async () => {
    const pending = a.call("navigate", { url: site.other() });
    await chrome.answerApproval("Always allow");
    expect(!(await pending).isError, "refused");
    const again = await b.call("navigate", { url: site.other("/second") });
    expect(!again.isError && !(await chrome.approvalOpen()), "asked again");
  });

  await check("'Block' refuses the site, and keeps refusing without asking", async () => {
    const pending = a.call("navigate", { url: site.third() });
    await chrome.answerApproval("Block this site");
    expect((await pending).isError, "the blocked site loaded");
    const again = await b.call("navigate", { url: site.third("/second") });
    expect(again.isError && /blocked/.test(text(again)), text(again));
    expect(!(await chrome.approvalOpen()), "asked again about a blocked site");
    await chrome.extEval(`chrome.storage.local.set({ settings: { browserName: ${JSON.stringify(LABEL)}, yolo: false }, sites: {} })`);
  });

  await check("tabbridge call (one-shot CLI) reuses the open tab and saves screenshots as a numbered guide", async () => {
    a.close();   // agent a goes away; its tab is free for the next caller
    await sleep(300);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-live-"));
    const call = (tool, args) => spawnSync(process.execPath, [CLI, "call", tool, JSON.stringify(args)], {
      cwd, env: { ...process.env, TABBRIDGE_CLIENT: "live-cli" }, encoding: "utf8", timeout: 60_000,
    });
    const nav = call("navigate", { url: site.url() });
    expect(nav.status === 0, nav.stdout + nav.stderr);
    const tabsAfter = (await chrome.extEval(`chrome.tabs.query({}).then(t => t.filter(x => x.groupId !== -1).length)`));
    const shot1 = call("screenshot", {});
    const shot2 = call("screenshot", { caption: "Second look" });
    expect(shot1.status === 0 && shot2.status === 0, shot1.stdout + shot1.stderr);
    expect(!shot1.stdout.includes('"data"'), "the CLI printed base64 image data");
    const [folder] = fs.readdirSync(path.join(cwd, "tabbridge"));
    const files = fs.readdirSync(path.join(cwd, "tabbridge", folder)).sort();
    expect(/^01-acme-contact-form$/.test(folder), folder);
    expect(files.join() === "01-acme-contact-form.jpg,02-second-look.jpg,README.md", files.join());
    expect(tabsAfter <= 2, `${tabsAfter} grouped tabs: the CLI opened a new tab instead of reusing one`);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ── added in 0.1.1, to match Claude in Chrome ──
  const evs = async (client) => (await js(client, "[...document.querySelectorAll('.ev')].map(e => e.textContent).join('|')"));
  const at = async (client, id) => JSON.parse(await js(client, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`));

  await check("hover fires the page's mouseover", async () => {
    await b.call("navigate", { url: site.url("/tools") });
    const r = await b.call("hover", { ref: await refFor(b, "Hover me") });
    expect(!r.isError, text(r));
    expect((await evs(b)).includes("hovered"), await evs(b));
  });

  await check("click with clickCount 2 is a double click", async () => {
    await b.call("click", { ...(await at(b, "dbl")), clickCount: 2 });
    expect((await evs(b)).includes("double clicked"), await evs(b));
  });

  await check("click with clickCount 3 selects the paragraph", async () => {
    await b.call("click", { ...(await at(b, "tri")), clickCount: 3 });
    const sel = await js(b, "getSelection().toString().trim()");
    expect(sel.includes("Three little words here."), sel);
  });

  // Shift, not Control: on a Mac, Control+click is a right-click and fires no click event.
  await check("click with modifiers holds the key (Shift)", async () => {
    await b.call("click", { ...(await at(b, "mod")), modifiers: "Shift" });
    expect((await evs(b)).includes("shift click"), await evs(b));
  });

  await check("drag: HTML drag-and-drop lands in the drop zone", async () => {
    const from = await at(b, "card"), to = await at(b, "zone");
    const r = await b.call("drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    expect(!r.isError, text(r));
    expect((await evs(b)).includes("dropped card-1"), await evs(b));
  });

  await check("drag: a mouse-drag slider moves", async () => {
    const from = await at(b, "knob");
    await b.call("drag", { fromX: from.x, fromY: from.y, toX: from.x + 150, toY: from.y });
    const slid = (await evs(b)).match(/slid (\d+)/)?.[1];
    expect(slid && Number(slid) >= 140, await evs(b));
  });

  await check("zoom returns a sharper picture of a small region", async () => {
    const t = await at(b, "tiny");
    const r = await b.call("zoom", { x0: t.x - 40, y0: t.y - 8, x1: t.x + 40, y1: t.y + 8 });
    const img = r.content.find((c) => c.type === "image");
    expect(img && /enlarged 4\.0×/.test(text(r)), text(r));
  });

  await check("file_upload asks first, then the page sees the file", async () => {
    const tmp = path.join(os.tmpdir(), "tabbridge-upload-test.txt");
    fs.writeFileSync(tmp, "Acme upload");
    const pending = b.call("file_upload", { selector: "#file", paths: [tmp] });
    await chrome.answerApproval("Allow");
    const r = await pending;
    expect(!r.isError, text(r));
    expect((await evs(b)).includes("files tabbridge-upload-test.txt"), await evs(b));
    fs.rmSync(tmp, { force: true });
  });

  await check("file_upload: Don't allow attaches nothing", async () => {
    await b.call("navigate", { url: "reload" });
    const tmp = path.join(os.tmpdir(), "tabbridge-upload-test2.txt");
    fs.writeFileSync(tmp, "x");
    const pending = b.call("file_upload", { selector: "#file", paths: [tmp] });
    await chrome.answerApproval("Don't allow");
    expect((await pending).isError, "uploaded anyway");
    expect(!(await evs(b)).includes("files"), await evs(b));
    fs.rmSync(tmp, { force: true });
  });

  await check("gif_record: start, act, stop (from the CLI) saves an animated GIF into the guide", async () => {
    b.close();   // the CLI must be able to use this tab
    await sleep(300);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-gif-live-"));
    const call = (tool, args) => spawnSync(process.execPath, [CLI, "call", tool, JSON.stringify(args)], {
      cwd, env: { ...process.env, TABBRIDGE_CLIENT: "live-cli" }, encoding: "utf8", timeout: 90_000,
    });
    const start = call("gif_record", { action: "start", fps: 5 });
    expect(start.status === 0, start.stdout + start.stderr);
    await sleep(2500);
    const stop = call("gif_record", { action: "stop", name: "Widgets ticking" });
    expect(stop.status === 0 && /Saved the recording/.test(stop.stdout), stop.stdout + stop.stderr);
    expect(!stop.stdout.includes('"data"'), "the GIF was printed");
    const folder = fs.readdirSync(path.join(cwd, "tabbridge"))[0];
    const gif = path.join(cwd, "tabbridge", folder, "01-widgets-ticking.gif");
    const head = fs.readFileSync(gif).subarray(0, 6).toString("latin1");
    expect(head === "GIF89a" && fs.statSync(gif).size > 2000, `${head} ${fs.statSync(gif).size}`);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await check("browsers: two Chromes running TabBridge, an agent lists them and switches by name", async () => {
    const chrome2 = await launch(path.join(ROOT, "extension", "dist"));
    try {
      await sleep(1500);
      await settings(chrome2, { browserName: "tabbridge-live-b" });
      await sleep(800);
      const c = new BridgeClient("agent-c");
      const { browsersTool } = await import("../../bridge/src/bridge-tools.ts");
      let list = "";
      for (let i = 0; i < 40; i++) {   // the second Chrome's host may still be starting
        list = text(await browsersTool(c, {}));
        if (/tabbridge-live-b/.test(list)) break;
        await sleep(250);
      }
      expect(/tabbridge-live-a/.test(list) && /tabbridge-live-b/.test(list), list);
      const picked = text(await browsersTool(c, { select: "tabbridge-live-b" }));
      expect(/\* \d\. tabbridge-live-b/.test(picked), picked);
      const r = await c.call("navigate", { url: site.url("/second") });
      expect(!r.isError, text(r));
      const inB = await chrome2.extEval(`chrome.tabs.query({}).then(t => t.filter(x => x.groupId !== -1).length)`);
      expect(inB === 1, `${inB} grouped tabs in the second Chrome`);
      c.close();
    } finally {
      await chrome2.close();
    }
  });

  await check("resize_window", async () => {
    const resized = text(await b.call("resize_window", { width: 900, height: 700 }));
    expect(/Window is now 9\d\d×/.test(resized), `not resized: ${resized}`);
  });

  await check("tab_create opens a second tab only when asked; tab_close removes it", async () => {
    const r = await b.call("tab_create", { url: site.url("/second") });
    const id = Number(text(r).match(/tab (\d+)/)?.[1]);
    const listed = text(await b.call("tabs_list", {}));
    expect(!r.isError && listed.includes(`tab ${id}:`) && (listed.match(/tab \d+:/g) ?? []).length >= 2, `${text(r)}\n${listed}`);
    await b.call("tab_close", { tabId: id });
    expect(!text(await b.call("tabs_list", {})).includes(`tab ${id}:`), "still there");
  });

  await check("a bad ref gives a clear error", async () => {
    const r = await b.call("click", { ref: "e9999" });
    expect(r.isError && /fresh refs/.test(text(r)), text(r));
  });

  // ---- The agent window, the yellow edge and the pointer (plan feat/agent-window-pointer-edge) ----
  const winState = async () => JSON.parse(await chrome.extEval(`(async () => {
    const saved = (await chrome.storage.session.get("agentWindow")).agentWindow ?? null;
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    const last = await chrome.windows.getLastFocused();
    return JSON.stringify({ saved, last: last.id, person: wins.filter((w) => w.id !== saved).map((w) => [w.id, w.tabs.find((t) => t.active)?.id]), windows: wins.length });
  })()`));
  const personView = (s) => JSON.stringify([s.last, s.person]);
  const tabIds = async (client) => [...text(await client.call("tabs_list", {})).matchAll(/tab (\d+):/g)].map((m) => Number(m[1]));
  const overlayOf = async (tabId) => JSON.parse(await chrome.extEval(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => JSON.stringify(globalThis.__tbOverlay?.report() ?? null) }).then((r) => r[0].result)`));

  await check("agent window: no tool changes the person's active tab or focused window", async () => {
    await b.call("navigate", { url: site.url("/tools") });
    const calls = {
      navigate: async () => b.call("navigate", { url: site.url("/tools") }),
      click: async () => b.call("click", await at(b, "dbl")),
      type: async () => b.call("type", { text: "hi" }),
      key: async () => b.call("key", { keys: "End" }),
      hover: async () => b.call("hover", await at(b, "hov")),
      drag: async () => { const f = await at(b, "card"), t = await at(b, "zone"); return b.call("drag", { fromX: f.x, fromY: f.y, toX: t.x, toY: t.y }); },
      scroll: async () => b.call("scroll", { direction: "down", amount: 100 }),
      screenshot: async () => b.call("screenshot", {}),
      tab_select: async () => b.call("tab_select", { tabId: (await tabIds(b))[0] }),
      tab_create: async () => b.call("tab_create", { url: site.url("/second") }),
    };
    const first = await winState();
    expect(first.saved !== null && first.person.length >= 1, "no agent window yet: " + JSON.stringify(first));
    for (const [name, call] of Object.entries(calls)) {
      const before = await winState();
      const r = await call();
      expect(!r.isError, name + ": " + text(r));
      const after = await winState();
      expect(personView(before) === personView(after), name + " changed the person's view: " + personView(before) + " -> " + personView(after));
    }
    for (const id of (await tabIds(b)).slice(1)) await b.call("tab_close", { tabId: id });
  });

  await check("agent window setting off: tabs open in the person's window, as before", async () => {
    await settings(chrome, { agentWindow: false });
    try {
      const c = new BridgeClient("agent-c");
      const r = await c.call("tab_create", { url: site.url("/second") });
      const id = Number(text(r).match(/tab (\d+)/)?.[1]);
      const where = JSON.parse(await chrome.extEval(`Promise.all([chrome.tabs.get(${id}), chrome.storage.session.get("agentWindow")]).then(([t, s]) => JSON.stringify({ win: t.windowId, agent: s.agentWindow ?? null }))`));
      expect(where.agent === null || where.win !== where.agent, "the tab went to the agent window: " + JSON.stringify(where));
      await c.call("tab_close", { tabId: id });
      c.close();
    } finally {
      await settings(chrome, { agentWindow: true });
    }
  });

  await check("agent window: closed by the person, the next call opens a fresh one; a tab moved out is refused", async () => {
    const before = await winState();
    await chrome.extEval(`chrome.windows.remove(${before.saved})`);
    await sleep(500);
    const r = await b.call("navigate", { url: site.url("/second") });
    expect(!r.isError && /Second page/.test(text(r)), text(r));
    const after = await winState();
    expect(after.saved !== null && after.saved !== before.saved, "no new window: " + JSON.stringify(after));
    const made = await b.call("tab_create", { url: site.url("/second") });
    const id = Number(text(made).match(/tab (\d+)/)?.[1]);
    const person = after.person[0][0];
    const quiet = await winState();
    await chrome.extEval(`chrome.tabs.move(${id}, { windowId: ${person}, index: -1 })`);
    const moved = await b.call("click", { tabId: id, x: 10, y: 10 });
    expect(moved.isError && /isn't one of this agent's TabBridge tabs/.test(text(moved)), text(moved));
    await chrome.extEval(`chrome.tabs.remove(${id})`);
    const end = await winState();
    expect(personView(quiet) === personView(end), "the person's view changed: " + personView(quiet) + " -> " + personView(end));
  });

  await check("agent window: two agents share one window and each screenshot shows its own page", async () => {
    await a.call("navigate", { url: site.url("/second") });
    await b.call("navigate", { url: site.url("/tools") });
    const s = await winState();
    expect(s.windows === s.person.length + 1, "expected one agent window: " + JSON.stringify(s));
    const shotA = text(await a.call("screenshot", {}));
    const shotB = text(await b.call("screenshot", {}));
    expect(shotA.includes("Second page") && shotB.includes("Acme widgets"), shotA + "\n" + shotB);
  });

  await check("agent window: its id survives in session storage for a restarted worker", async () => {
    const s = await winState();
    const live = await chrome.extEval(`chrome.windows.get(${s.saved}).then((w) => w.id)`);
    expect(live === s.saved, "saved id " + s.saved + " is not a live window");
  });

  const edgeTab = async () => {
    const r = await b.call("tab_create", { url: site.url("/tools") });
    const id = Number(text(r).match(/tab (\d+)/)?.[1]);
    await b.call("tab_select", { tabId: id });
    return id;
  };
  let ovTab = 0;

  await check("overlay: the edge shows while the agent works and goes 3 s after the last call", async () => {
    ovTab = await edgeTab();
    await b.call("get_page_text", { tabId: ovTab });
    await sleep(300);
    const on = await overlayOf(ovTab);
    expect(on?.visible && on.attached && on.edgeWidth > 300, "not on: " + JSON.stringify(on));
    await sleep(3400);
    const off = await overlayOf(ovTab);
    expect(off && !off.visible, "still on: " + JSON.stringify(off));
  });

  await check("overlay: the pointer lands on the target of click, hover, drag and scroll", async () => {
    const near = (p, want, what) => expect(p && Math.abs(p.x - want.x) <= 2 && Math.abs(p.y - want.y) <= 2, what + ": pointer " + JSON.stringify(p) + ", target " + JSON.stringify(want));
    const target = await at(b, "dbl");
    await b.call("click", { tabId: ovTab, ...target });
    await sleep(500);
    near((await overlayOf(ovTab)).pointer, target, "click");
    const hov = await at(b, "hov");
    await b.call("hover", { tabId: ovTab, ...hov });
    await sleep(500);
    near((await overlayOf(ovTab)).pointer, hov, "hover");
    const from = await at(b, "card"), to = await at(b, "zone");
    await b.call("drag", { tabId: ovTab, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    await sleep(500);
    near((await overlayOf(ovTab)).pointer, to, "drag");
    await b.call("scroll", { tabId: ovTab, direction: "down", amount: 50, x: 300, y: 200 });
    await sleep(500);
    near((await overlayOf(ovTab)).pointer, { x: 300, y: 200 }, "scroll");
  });

  await check("overlay: takes no click, shifts no layout, and the page cannot reach it", async () => {
    await js(b, "window.__edge = 0; document.addEventListener('click', () => { window.__edge++; }); document.documentElement.scrollHeight");
    const height = await js(b, "document.documentElement.scrollHeight");
    await b.call("click", { tabId: ovTab, x: 2, y: 2 });
    await sleep(400);
    expect((await overlayOf(ovTab)).visible, "overlay not on");
    expect(Number(await js(b, "window.__edge")) === 1, "the click did not reach the page");
    expect((await js(b, "document.documentElement.scrollHeight")) === height, "the layout moved");
    const reach = JSON.parse(await js(b, "(() => { const h = document.querySelector('tabbridge-overlay'); return { host: !!h, shadow: h ? h.shadowRoot : null, api: typeof globalThis.__tbOverlay }; })()"));
    expect(reach.host && reach.shadow === null && reach.api === "undefined", JSON.stringify(reach));
  });

  const pixels = (src, tabId, points) => chrome.extEval(`(async () => {
    const data = ${src === "raw" ? `(await chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.captureScreenshot", { format: "jpeg", quality: 90 })).data` : JSON.stringify(src)};
    const bm = await createImageBitmap(await (await fetch("data:" + (data.startsWith("iVBOR") ? "image/png" : "image/jpeg") + ";base64," + data)).blob());
    const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
    return JSON.stringify({ w: bm.width, h: bm.height, px: ${JSON.stringify(points)}.map(([x, y]) => Array.from(g.getImageData(x < 0 ? bm.width + x : x, y < 0 ? bm.height + y : y, 1, 1).data).slice(0, 3)) });
  })()`).then(JSON.parse);
  const yellow = (p) => p[0] > 200 && p[1] > 180 && p[2] < 190;
  const edgePoints = [[1, 200], [-2, 200], [400, 1], [400, -2]];

  await check("overlay: a screenshot shows no edge, though the page shows it", async () => {
    await b.call("click", { tabId: ovTab, x: 300, y: 300 });
    await sleep(500);
    const raw = await pixels("raw", ovTab, edgePoints);
    expect(raw.px.some(yellow), "the raw capture shows no yellow edge: " + JSON.stringify(raw.px));
    const shot = await b.call("screenshot", { tabId: ovTab });
    const image = shot.content.find((c) => c.type === "image").data;
    const seen = await pixels(image, ovTab, edgePoints);
    expect(!seen.px.some(yellow), "the screenshot shows the edge: " + JSON.stringify(seen.px));
    await sleep(300);
    expect((await overlayOf(ovTab)).visible, "the edge did not come back after the screenshot");
  });

  await check("overlay: a strict page policy, a removed host and a chrome:// page do not break a tool", async () => {
    const strict = await b.call("navigate", { url: site.url("/strict"), tabId: ovTab });
    expect(!strict.isError, text(strict));
    const press = await b.call("click", { tabId: ovTab, ref: await refFor(b, "Press") });
    expect(!press.isError, text(press));
    await sleep(300);
    expect((await overlayOf(ovTab))?.visible, "no overlay on a strict page");
    await js(b, "document.querySelector('tabbridge-overlay')?.remove()");
    expect(!(await b.call("get_page_text", { tabId: ovTab })).isError, "tool failed after the page removed the host");
    await sleep(300);
    expect((await overlayOf(ovTab)).attached, "the host was not put back");
    try {
      const chromePage = await b.call("navigate", { url: "chrome://version", tabId: ovTab });
      expect(!chromePage.isError, "navigate to chrome://: " + text(chromePage));
      const read = await b.call("read_page", { tabId: ovTab });
      // Tools that read the page already refuse a chrome:// page; the overlay adds no error of its own.
      expect(!read.isError || /Cannot access a chrome:\/\/ URL/.test(text(read)), "read_page on chrome://: " + text(read));
      expect(!/overlay|tbOverlay/i.test(text(read)), "the overlay leaked into an error: " + text(read));
    } finally {
      await b.call("navigate", { url: site.url("/tools"), tabId: ovTab });
    }
  });

  await check("overlay: with reduced motion the pointer is at the target at once", async () => {
    await b.call("screenshot", { tabId: ovTab }); // a tool that uses the debugger attaches it again after the chrome:// page
    await chrome.extEval(`chrome.debugger.sendCommand({ tabId: ${ovTab} }, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })`);
    try {
      const target = await at(b, "mod");
      await b.call("hover", { tabId: ovTab, ...target });
      const p = (await overlayOf(ovTab)).pointer;
      expect(p && Math.abs(p.x - target.x) <= 2 && Math.abs(p.y - target.y) <= 2, "pointer " + JSON.stringify(p) + ", target " + JSON.stringify(target));
    } finally {
      await chrome.extEval(`chrome.debugger.sendCommand({ tabId: ${ovTab} }, "Emulation.setEmulatedMedia", { features: [] })`);
    }
  });

  await check("overlay: a transform on the page's root and a link that navigates leave the pointer and the edge right", async () => {
    const near = (p, want, what) => expect(p && Math.abs(p.x - want.x) <= 2 && Math.abs(p.y - want.y) <= 2, what + ": pointer " + JSON.stringify(p) + ", target " + JSON.stringify(want));
    await b.call("navigate", { url: site.url("/transform"), tabId: ovTab });
    const target = await at(b, "t");
    await b.call("click", { tabId: ovTab, ...target });
    await sleep(500);
    near((await overlayOf(ovTab)).pointer, target, "scaled root");
    await b.call("navigate", { url: site.url("/link"), tabId: ovTab });
    const go = await at(b, "go");
    const r = await b.call("click", { tabId: ovTab, ...go });
    expect(!r.isError, text(r));
    await sleep(800);
    await b.call("get_page_text", { tabId: ovTab });
    await sleep(300);
    const after = await overlayOf(ovTab);
    expect(after?.attached && after.visible, "no overlay after the page navigated: " + JSON.stringify(after));
  });

  await check("overlay: calls at once never leave the edge in a screenshot or a zoom, and a recording holds it off", async () => {
    await b.call("navigate", { url: site.url("/tools"), tabId: ovTab });
    const hov = await at(b, "hov");
    for (let i = 0; i < 4; i++) {
      const [shot] = await Promise.all([b.call("screenshot", { tabId: ovTab }), b.call("hover", { tabId: ovTab, ...hov }), b.call("click", { tabId: ovTab, x: 300 + i, y: 300 })]);
      const seen = await pixels(shot.content.find((c) => c.type === "image").data, ovTab, edgePoints);
      expect(!seen.px.some(yellow), "round " + i + " shows the edge: " + JSON.stringify(seen.px));
    }
    await b.call("hover", { tabId: ovTab, ...hov });
    const zoom = await b.call("zoom", { tabId: ovTab, x0: 0, y0: 0, x1: 60, y1: 60 });
    const zoomed = await pixels(zoom.content.find((c) => c.type === "image").data, ovTab, [[3, 3], [3, 100], [100, 3]]);
    expect(!zoomed.px.some(yellow), "the zoom shows the edge: " + JSON.stringify(zoomed.px));
    process.env.TABBRIDGE_GUIDE = "0";
    try {
      await b.call("gif_record", { tabId: ovTab, action: "start" });
      await b.call("hover", { tabId: ovTab, ...hov });
      await sleep(300);
      const during = await overlayOf(ovTab);
      expect(during && !during.visible, "the overlay showed during a recording: " + JSON.stringify(during));
      await b.call("gif_record", { tabId: ovTab, action: "stop" });
    } finally {
      delete process.env.TABBRIDGE_GUIDE;
    }
    await b.call("hover", { tabId: ovTab, ...hov });
    await sleep(300);
    expect((await overlayOf(ovTab)).visible, "the overlay did not come back after the recording");
  });

  await check("overlay setting off: nothing is drawn on the page", async () => {
    await settings(chrome, { overlay: false });
    try {
      await b.call("navigate", { url: site.url("/second"), tabId: ovTab });
      await b.call("get_page_text", { tabId: ovTab });
      await sleep(300);
      expect((await overlayOf(ovTab)) === null, "an overlay was installed");
      expect((await js(b, "!!document.querySelector('tabbridge-overlay')")) === "false", "a host is on the page");
    } finally {
      await settings(chrome, { overlay: true });
    }
    await b.call("tab_close", { tabId: ovTab });
  });

} finally {
  a.close();
  b.close();
  await chrome.close();
  await check("Chrome closed: the agent gets a clear error, not a hang", async () => {
    await sleep(1000);
    const c = new BridgeClient("after");
    const r = await c.call("tabs_list", {}, 5000);
    c.close();
    expect(r.isError && text(r) === NOT_CONNECTED, text(r));
  });
  site.close();
  if (downloaded) fs.rmSync(downloaded, { force: true });
}

for (const [name, ok, why] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${why.slice(0, 600)}`}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
