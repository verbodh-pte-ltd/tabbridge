// Extension logic that runs without Chrome: the key parser, the risky-action check, and that
// the extension implements exactly the tools the bridge advertises.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BRIDGE_TOOLS, TOOL_NAMES } from "../bridge/src/shared/tools.ts";
import { parseKeys } from "../extension/src/keys.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the extension implements exactly the advertised tools", () => {
  const handlers: string[] = [];
  for (const [file, start] of [["tools.ts", "export const HANDLERS"], ["inspect.ts", "export const INSPECT_HANDLERS"], ["actions.ts", "export const ACTION_HANDLERS"]]) {
    const src = fs.readFileSync(path.join(ROOT, "extension/src", file), "utf8");
    const block = src.slice(src.indexOf(start));
    const end = block.search(/^};/m);
    handlers.push(...[...block.slice(0, end).matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]));
  }
  assert.deepEqual([...handlers].sort(), TOOL_NAMES.filter((t) => !BRIDGE_TOOLS.includes(t)).sort());
});

test("keys: plain, combined and several presses", () => {
  assert.deepEqual(parseKeys("Enter")[0], { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" });
  const ctrlA = parseKeys("Control+a")[0];
  assert.equal(ctrlA.modifiers, 2);
  assert.equal(ctrlA.text, undefined, "a shortcut must not type a character");
  assert.equal(parseKeys("Shift+a")[0].text, "A");
  assert.deepEqual(parseKeys("Tab Tab Enter").map((p) => p.key), ["Tab", "Tab", "Enter"]);
  assert.equal(parseKeys("Control++")[0].key, "+");
  assert.throws(() => parseKeys("Hyper+a"), /Unknown modifier/);
  assert.throws(() => parseKeys("Banana"), /Unknown key/);
});

test("risky labels are caught, ordinary ones are not", async () => {
  // permissions.ts touches chrome.* at load; give it a stub so the pattern can be tested here.
  (globalThis as any).chrome = {
    windows: { onFocusChanged: { addListener() {} } },
    notifications: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
  };
  const { RISKY } = await import("../extension/src/permissions.ts");
  for (const risky of ["click button \"Send\"", "click button \"Place order\"", "click \"Delete project\"",
    "press Enter, which submits \"Pay now\"", "click link \"Publish\"", "click \"Merge pull request\"",
    "upload report.pdf from this computer"]) {
    assert.ok(RISKY.test(risky), risky);
  }
  for (const safe of ["click link \"Docs\"", "click button \"Next\"", "click textbox \"Search\"", "click \"Settings\"",
    "click \"Sender details\"", "click \"Ordering guide\""]) {
    assert.ok(!RISKY.test(safe), safe);
  }
});

test("the manifest is ready for both load-unpacked and the store", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/static/manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.ok(m.key, "key keeps the unpacked id fixed");
  for (const p of ["debugger", "nativeMessaging", "tabs", "tabGroups", "scripting", "storage"]) assert.ok(m.permissions.includes(p), p);
  for (const size of ["16", "32", "48", "128"]) assert.ok(fs.existsSync(path.join(ROOT, "extension/static", m.icons[size])));
});

test("activity: each step is summed up in plain words, never showing typed text or values", async () => {
  const { summarize } = await import("../extension/src/activity.ts");
  assert.equal(summarize("navigate", { url: "https://example.test/a" }), "Opened https://example.test/a");
  assert.equal(summarize("navigate", { url: "back" }), "Went back");
  assert.equal(summarize("click", { ref: "e12" }), "Clicked e12");
  assert.equal(summarize("type", { text: "hunter2-secret" }), "Typed 14 characters");
  assert.equal(summarize("form_input", { ref: "e3", value: "4111 1111 1111 1111" }), "Filled e3");
  assert.equal(summarize("key", { keys: "Control+a Backspace" }), "Pressed Control+a Backspace");
  assert.equal(summarize("javascript", { code: "document.cookie" }), "Ran a script on the page");
  assert.equal(summarize("screenshot", {}), "Took a screenshot");
  assert.equal(summarize("find", { query: "Send" }), "Looked for “Send”");
  assert.equal(summarize("some_new_tool", { x: 1 }), "some_new_tool");
  for (const [tool, args] of [["type", { text: "hunter2-secret" }], ["form_input", { ref: "e3", value: "hunter2-secret" }], ["file_upload", { ref: "e1", paths: ["C:/secret.txt"] }]] as const) {
    assert.ok(!summarize(tool, args as any).includes("hunter2") && !summarize(tool, args as any).includes("secret"), tool);
  }
});

test("YOLO mode starts on, and secrets stay hidden (owner's defaults)", async () => {
  const { DEFAULT_SETTINGS } = await import("../extension/src/settings.ts");
  assert.equal(DEFAULT_SETTINGS.yolo, true);
  assert.equal(DEFAULT_SETTINGS.showSecrets, false);
});

test("tab edits retry while Chrome says tabs can't be edited right now; other errors fail at once", async () => {
  const { whenTabsEditable } = await import("../extension/src/retry.ts");
  let n = 0;
  const busy = () => { n++; if (n < 3) throw new Error("Tabs cannot be edited right now (user may be dragging a tab)."); return "ok"; };
  assert.equal(await whenTabsEditable(busy, 10, 1), "ok");
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(whenTabsEditable(() => { m++; throw new Error("No tab with id: 5"); }, 10, 1), /No tab with id/);
  assert.equal(m, 1);
});

test("a native port that closes at once is not written to (host not installed)", async () => {
  // Chrome closes the port right away when the host isn't registered; posting on it then throws
  // "Attempting to use a disconnected port object".
  let disconnected = false;
  let postedAfterClose = 0;
  const onDisconnect: (() => void)[] = [];
  const port = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener: (f: () => void) => onDisconnect.push(f) },
    postMessage() { if (disconnected) postedAfterClose++; },
  };
  const connectNative = () => {
    // Only the first connect fails; the worker's retry then finds the port open.
    if (!disconnected) queueMicrotask(() => { disconnected = true; onDisconnect.splice(0).forEach((f) => f()); });
    return port;
  };
  const any = (): any => new Proxy(() => {}, {
    get: (_t, key) => key === "then" ? undefined : key === "connectNative" ? connectNative : key === "getManifest" ? () => ({ version: "0" })
      : key === "lastError" ? { message: "Specified native messaging host not found." } : any(),
    apply: () => Promise.resolve([]),
  });
  (globalThis as any).chrome = any();
  // Bundled like the real build: the worker pulls in gifenc, which Node can't import by name.
  const { build } = await import("esbuild");
  const out = await build({ entryPoints: [path.join(ROOT, "extension/src/background.ts")], bundle: true, format: "esm", write: false, logLevel: "silent" });
  await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(postedAfterClose, 0);
});
