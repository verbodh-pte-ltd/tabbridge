// tabbridge extension: copies the packaged extension to the TabBridge home folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyExtension, describeCopy } from "../bridge/src/extension-copy.ts";

function source(version = "9.9.9") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ext-src-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, key: "public-dev-key" }));
  fs.writeFileSync(path.join(dir, "background.js"), "// background");
  fs.mkdirSync(path.join(dir, "chunks"));
  fs.writeFileSync(path.join(dir, "chunks", "a.js"), "// chunk");
  return dir;
}
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-ext-home-"));

test("copies the extension and says where it is and how to load it", () => {
  const from = source();
  const to = path.join(home(), "extension");
  const done = copyExtension({ from, to });
  assert.equal(done.version, "9.9.9");
  assert.equal(done.replaced, false);
  assert.ok(fs.existsSync(path.join(to, "manifest.json")) && fs.existsSync(path.join(to, "chunks", "a.js")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, "manifest.json"), "utf8")).key, "public-dev-key");
  const text = describeCopy(done);
  assert.ok(text.includes(to) && text.includes("Load unpacked") && text.includes("9.9.9"), text);
});

test("a second run replaces the folder, drops stale files and says to reload", () => {
  const to = path.join(home(), "extension");
  copyExtension({ from: source("1.0.0"), to });
  fs.writeFileSync(path.join(to, "old.txt"), "stale");
  const done = copyExtension({ from: source("1.0.1"), to });
  assert.equal(done.replaced, true);
  assert.equal(done.previous, "1.0.0");
  assert.ok(!fs.existsSync(path.join(to, "old.txt")), "the stale file stayed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, "manifest.json"), "utf8")).version, "1.0.1");
  const text = describeCopy(done);
  assert.ok(text.includes("Reload") && text.includes("1.0.0"), text);
});

test("it refuses a destination that is not named extension, and touches nothing beside the folder", () => {
  const h = home();
  fs.writeFileSync(path.join(h, "keep.txt"), "mine");
  assert.throws(() => copyExtension({ from: source(), to: path.join(h, "documents") }), /extension/);
  assert.ok(fs.existsSync(path.join(h, "keep.txt")) && !fs.existsSync(path.join(h, "documents")));
  copyExtension({ from: source(), to: path.join(h, "extension") });
  assert.equal(fs.readFileSync(path.join(h, "keep.txt"), "utf8"), "mine");
  assert.deepEqual(fs.readdirSync(h).sort(), ["extension", "keep.txt"]);
});

test("a home folder the command has to create is private to the person", { skip: process.platform === "win32" }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ext-new-"));
  const homeFolder = path.join(parent, "tabbridge-home");
  copyExtension({ from: source(), to: path.join(homeFolder, "extension") });
  assert.equal(fs.statSync(homeFolder).mode & 0o777, 0o700);
});

test("a source with no manifest is a plain error that says to build", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ext-empty-"));
  assert.throws(() => copyExtension({ from: empty, to: path.join(home(), "extension") }), /npm run build/);
});
