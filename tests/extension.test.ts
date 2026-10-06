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
    windows: { onRemoved: { addListener() {} } },
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
