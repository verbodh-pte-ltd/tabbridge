// The Versions block of tabbridge doctor.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { versionReport } from "../bridge/src/versions.ts";

function home(hostVersion: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ver-"));
  if (hostVersion !== null) fs.writeFileSync(path.join(dir, "host.js"), `var x = 1;\nvar VERSION = "${hostVersion}";\n`);
  return dir;
}
const chrome = (over: Record<string, unknown> = {}) => ({ slot: 1, label: "Work", pid: 1, started: "", host: "0.2.4", extension: "0.2.4", ...over });

test("the report names this command, the host program and each running Chrome with its versions", () => {
  const r = versionReport({ bridge: "0.2.4", home: home("0.2.4"), browsers: [chrome()] });
  const text = r.lines.join("\n");
  assert.ok(text.includes("Versions"), text);
  assert.ok(/this command.*0\.2\.4/.test(text), text);
  assert.ok(/host program.*0\.2\.4/.test(text), text);
  assert.ok(/Work.*extension 0\.2\.4.*host 0\.2\.4/.test(text), text);
  assert.equal(r.mismatch, false);
});

test("a difference is a warning that names both versions and the fix", () => {
  const r = versionReport({ bridge: "0.2.4", home: home("0.2.4"), browsers: [chrome({ extension: "1.0.0", host: "1.0.1" })] });
  const text = r.lines.join("\n");
  assert.equal(r.mismatch, true);
  assert.ok(text.includes("1.0.0") && text.includes("1.0.1"), text);
  assert.ok(text.includes("npx @verbodhpteltd/tabbridge@latest install"), text);
});

test("a host that recorded no version shows as unknown, and is no mismatch by itself", () => {
  const r = versionReport({ bridge: "0.2.4", home: home(null), browsers: [chrome({ extension: undefined, host: undefined })] });
  const text = r.lines.join("\n");
  assert.ok(text.includes("unknown (older host)"), text);
  assert.equal(r.mismatch, false);
});

test("a browser name with control characters is printed without them", () => {
  const r = versionReport({ bridge: "0.2.4", home: home("0.2.4"), browsers: [chrome({ label: "Wo\x1b[31mrk\x07" })] });
  assert.ok(!/[\x00-\x1f\x7f]/.test(r.lines.join("")), JSON.stringify(r.lines));
});

test("the report writes nothing", () => {
  const h = home("0.2.4");
  const before = fs.readdirSync(h).join();
  versionReport({ bridge: "0.2.4", home: h, browsers: [chrome()] });
  assert.equal(fs.readdirSync(h).join(), before);
});
