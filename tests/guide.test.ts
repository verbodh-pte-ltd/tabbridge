// Screenshots become a numbered guide in the project's tabbridge/ folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GuideRecorder, slug } from "../bridge/src/guide.ts";

const IMG = Buffer.from("fake-jpeg").toString("base64");
const shot = (title: string, url: string) => ({
  content: [
    { type: "image" as const, data: IMG, mimeType: "image/jpeg" },
    { type: "text" as const, text: "Screenshot of tab 1" },
    { type: "text" as const, text: `tabbridge-meta ${JSON.stringify({ title, url })}` },
  ],
});
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

test("slug: short, lowercase, safe for every file system", () => {
  assert.equal(slug("Acme — Sign in / Settings: 2FA!"), "acme-sign-in-settings-2fa");
  assert.equal(slug("***"), "page");
});

test("screenshots are numbered steps with the actions in between, and the meta is hidden from the agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-"));
  const g = new GuideRecorder("claude-code", root);
  g.record("navigate", { url: "https://example.com/login" }, text("Loaded: Example"));
  g.record("click", { ref: "e3" }, text('Clicked <untrusted-page-content source="x">button "Sign in"</untrusted-page-content>.'));
  const out = g.record("screenshot", {}, shot("Example login", "https://example.com/login"));
  assert.ok(!out.content.some((c: any) => c.type === "text" && c.text.startsWith("tabbridge-meta")), "meta leaked to the agent");
  assert.ok(out.content.some((c: any) => c.type === "text" && c.text.includes("01-example-login.jpg")));
  g.record("type", { text: "hunter2" }, text("Typed 7 characters."));
  g.record("screenshot", { caption: "Dashboard after sign-in" }, shot("Dash", "https://example.com/"));

  const [folder] = fs.readdirSync(root);
  assert.equal(folder, "01-example-login");
  const files = fs.readdirSync(path.join(root, folder)).sort();
  assert.deepEqual(files, ["01-example-login.jpg", "02-dashboard-after-sign-in.jpg", "README.md"]);
  const readme = fs.readFileSync(path.join(root, folder, "README.md"), "utf8");
  assert.match(readme, /## Step 1: Example login\n\n- Opened https:\/\/example.com\/login\n- Clicked button "Sign in"/);
  assert.match(readme, /## Step 2: Dashboard after sign-in\n\n- Typed 7 characters/);
  assert.ok(!readme.includes("hunter2"), "typed text must not be written to the guide");
});

test("a new recorder after the last guide went quiet starts guide 02; a fresh one within 30 minutes continues", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-"));
  new GuideRecorder("cli", root).record("screenshot", {}, shot("First", "https://a.example"));
  new GuideRecorder("cli", root).record("screenshot", {}, shot("Again", "https://a.example"));
  assert.deepEqual(fs.readdirSync(root), ["01-first"]);
  const readme = path.join(root, "01-first", "README.md");
  const old = new Date(Date.now() - 31 * 60_000);
  fs.utimesSync(readme, old, old);
  new GuideRecorder("cli", root).record("screenshot", {}, shot("Later", "https://b.example"));
  assert.deepEqual(fs.readdirSync(root).sort(), ["01-first", "02-later"]);
});

test("TABBRIDGE_GUIDE=0 turns it off", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-"));
  process.env.TABBRIDGE_GUIDE = "0";
  new GuideRecorder("x", root).record("screenshot", {}, shot("T", "https://a.example"));
  delete process.env.TABBRIDGE_GUIDE;
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a GIF recording is saved as a guide step and not sent back to the agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-"));
  const g = new GuideRecorder("x", root);
  g.record("gif_record", { action: "start" }, text("Recording"));
  g.record("click", {}, text('Clicked button "Next".'));
  const out = g.record("gif_record", { action: "stop", name: "Next button flow" }, {
    content: [
      { type: "image", data: IMG, mimeType: "image/gif" },
      { type: "text", text: "Recorded 3 frames over 2 s." },
      { type: "text", text: `tabbridge-meta ${JSON.stringify({ title: "Flow", url: "https://a.example" })}` },
    ],
  });
  assert.ok(!out.content.some((c: any) => c.type === "image"), "the GIF went back to the agent");
  assert.ok(out.content.some((c: any) => c.type === "text" && /01-next-button-flow\.gif/.test(c.text)));
  const [folder] = fs.readdirSync(root);
  const readme = fs.readFileSync(path.join(root, folder, "README.md"), "utf8");
  assert.match(readme, /## Step 1: Next button flow\n\n- Started recording\n- Clicked button "Next"/);
});

test("typing in pieces becomes one line; fields are named by their label, not their ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-guide-"));
  const g = new GuideRecorder("x", root);
  g.record("form_input", { ref: "e2", value: "Ada" }, text('Set "Name" (e2) to "Ada".'));
  for (const piece of ["Invoice ", "0041 ", "twice."]) g.record("type", { text: piece }, text("Typed."));
  g.record("screenshot", {}, shot("Form", "https://a.example"));
  const [folder] = fs.readdirSync(root);
  const readme = fs.readFileSync(path.join(root, folder, "README.md"), "utf8");
  assert.match(readme, /- Set "Name" to "Ada"\n- Typed 19 characters\n\n/);
});
