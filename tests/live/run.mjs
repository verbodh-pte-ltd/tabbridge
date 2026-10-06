// Live test: real Chrome, the real extension, the real installed host, a local test site.
//
//   npm run build && node bridge/dist/cli.js install && npm run test:live
//
// It uses a throwaway Chrome profile, so your own profile, tabs and sign-ins are not touched.
// The host is the one `tabbridge install` registered, so the TabBridge extension must not be
// running in your everyday Chrome at the same time (two hosts can't share the pipe).

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

async function check(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    results.push([name, true, ""]);
  } catch (err) {
    results.push([name, false, err?.message ?? String(err)]);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(String(msg).slice(0, 600)); }
const js = async (client, code) => unwrap(text(await client.call("javascript", { code })));
const refFor = async (client, query) => text(await client.call("find", { query })).match(/\[(e\d+)\]/)?.[1];

const site = await startSite();
const chrome = await launch(path.join(ROOT, "extension", "dist"));
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

  await check("defaults: sites allowed, shared group, guards on, secrets hidden", async () => {
    const s = await chrome.extEval(`chrome.storage.local.get("settings").then(x => x.settings ?? null)`);
    expect(s === null, `settings were already changed: ${JSON.stringify(s)}`);
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
    expect(groups.length === 1 && groups[0] === "TabBridge", JSON.stringify(groups));
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

  await check("closing the approval window counts as no", async () => {
    const click = a.call("click", { ref: sendRef });
    for (let i = 0; i < 50 && !(await chrome.approvalOpen()); i++) await sleep(100);
    const { targetInfos } = await chrome.cdp("Target.getTargets");
    const t = targetInfos.find((x) => x.url.includes("/approve.html"));
    await chrome.cdp("Target.closeTarget", { targetId: t.targetId });
    expect((await click).isError, "went ahead after the window was closed");
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
    await chrome.extEval(`chrome.storage.local.set({ settings: { askNewSites: true } })`);
    const pending = b.call("navigate", { url: site.other() });
    await chrome.answerApproval("Allow once");
    const r = await pending;
    expect(!r.isError, text(r));
    const groups = await chrome.extEval(`chrome.tabGroups.query({}).then(gs => gs.length)`);
    expect(groups === 1, `${groups} groups`);
  });

  await check("'Allow once' is per agent: another agent is asked again; 'Always allow' is remembered", async () => {
    const pending = a.call("navigate", { url: site.other() });
    await chrome.answerApproval("Always allow this site");
    expect(!(await pending).isError, "refused");
    const again = await b.call("navigate", { url: site.other("/second") });
    expect(!again.isError && !(await chrome.approvalOpen()), "asked again");
  });

  await check("'Block' refuses the site, and keeps refusing without asking", async () => {
    const pending = a.call("navigate", { url: site.third() });
    await chrome.answerApproval("Block");
    expect((await pending).isError, "the blocked site loaded");
    const again = await b.call("navigate", { url: site.third("/second") });
    expect(again.isError && /blocked/.test(text(again)), text(again));
    expect(!(await chrome.approvalOpen()), "asked again about a blocked site");
    await chrome.extEval(`chrome.storage.local.set({ settings: {} , sites: {} })`);
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

  await check("resize_window", async () => {
    expect(/Window is now 9\d\d×/.test(text(await b.call("resize_window", { width: 900, height: 700 }))), "not resized");
  });

  await check("tab_create opens a second tab only when asked; tab_close removes it", async () => {
    const r = await b.call("tab_create", { url: site.url("/second") });
    const id = Number(text(r).match(/tab (\d+)/)?.[1]);
    expect((text(await b.call("tabs_list", {})).match(/tab \d+:/g) ?? []).length === 2, "not two tabs");
    await b.call("tab_close", { tabId: id });
    expect(!text(await b.call("tabs_list", {})).includes(`tab ${id}:`), "still there");
  });

  await check("a bad ref gives a clear error", async () => {
    const r = await b.call("click", { ref: "e9999" });
    expect(r.isError && /fresh refs/.test(text(r)), text(r));
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
