// Records docs/demo.gif, plus docs/demo-steps/: one numbered screenshot per screen with a README
// guide (TabBridge's own screenshot guide). The GIF: an agent filling in and sending a form through TabBridge, with the risky
// click approved, then a page_report. Real tool calls against a local demo page (fictional Acme),
// in a throwaway Chrome profile. A caption bar on the page names each tool call as it happens.
//
//   npm run build && node bridge/dist/cli.js install && node scripts/demo-gif.mjs

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { BridgeClient } from "../bridge/src/client.ts";
import { GuideRecorder } from "../bridge/src/guide.ts";
import { launch } from "../tests/live/chrome.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = "tabbridge-demo";
process.env.TABBRIDGE_BROWSER = LABEL;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Acme Support</title><style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;background:#f3f5f8;color:#1d2433}
  header{background:#1f3a5f;color:#fff;padding:16px 32px;font-weight:600;font-size:18px}
  main{max-width:620px;margin:28px auto;background:#fff;border-radius:10px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{margin:0 0 4px;font-size:22px} p.sub{margin:0 0 18px;color:#5b6475}
  label{display:block;font-weight:600;margin:12px 0 4px;font-size:14px}
  input[type=text],select,textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid #c9d0db;border-radius:6px}
  textarea{height:80px} .check{display:flex;gap:8px;align-items:center;font-weight:400;margin-top:14px}
  button{margin-top:18px;background:#2f6f4e;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;font-weight:600}
  #done{display:none;margin-top:16px;padding:12px;border-radius:6px;background:#e3f4ea;color:#1f6b43;font-weight:600}
  #cap{position:fixed;left:0;right:0;bottom:0;background:#11161a;color:#e6edf3;font:15px/1.4 Consolas,ui-monospace,monospace;padding:12px 24px;min-height:46px}
  #cap b{color:#7cc0ef}
</style></head><body>
<header>Acme Support</header>
<main>
  <h1>Contact us</h1><p class="sub">We answer within one working day.</p>
  <form id="f">
    <label for="name">Name</label><input type="text" id="name">
    <label for="topic">Topic</label><select id="topic"><option>General</option><option>Billing</option><option>Technical</option></select>
    <label for="msg">Message</label><textarea id="msg"></textarea>
    <label class="check"><input type="checkbox" id="copy"> Email me a copy</label>
    <button type="submit">Send message</button>
  </form>
  <div id="done">Message sent. Ticket ACME-1042 created.</div>
</main>
<div id="cap"></div>
<script>document.getElementById("f").onsubmit=(e)=>{e.preventDefault();document.getElementById("done").style.display="block";};</script>
</body></html>`;

const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/support`;

const chrome = await launch(path.join(root, "extension", "dist"));
await sleep(1500);
await chrome.extEval(`chrome.storage.local.set({ settings: { browserName: ${JSON.stringify(LABEL)} } })`);
await sleep(800);

const agent = new BridgeClient("claude-code");
const stepsDir = path.join(root, "docs", "demo-steps");
fs.rmSync(stepsDir, { recursive: true, force: true });
const guide = new GuideRecorder("claude-code", stepsDir);
const call = async (tool, args = {}) => {
  const r = guide.record(tool, args, await agent.call(tool, args));
  if (r.isError) throw new Error(`${tool}: ${r.content.map((c) => c.text).join(" ")}`);
  return r;
};
const caption = (html) => agent.call("javascript", { code: `document.getElementById("cap").innerHTML = ${JSON.stringify(html)}` });
const shot = (text) => call("screenshot", { caption: text });
const ref = async (q) => (await call("find", { query: q })).content[0].text.match(/\[(e\d+)\]/)[1];

try {
  for (let i = 0; i < 40 && (await agent.call("tabs_list", {}, 3000)).isError; i++) { agent.close(); await sleep(250); }
  await call("navigate", { url });
  await call("resize_window", { width: 1000, height: 820 });
  await call("gif_record", { action: "start", fps: 5 });
  await caption(`<b>navigate</b> ${url.replace(/\/\/[^/]+/, "//acme.example")}`);
  await sleep(1500);
  await shot("The support form opens");

  await caption(`<b>find</b> "Name" → <b>form_input</b> "Ada Lovelace"`);
  await sleep(700);
  await call("form_input", { ref: await ref("Name"), value: "Ada Lovelace" });
  await sleep(1000);
  await shot("Name filled in");

  await caption(`<b>form_input</b> Topic = "Billing"`);
  await sleep(600);
  await call("form_input", { ref: await ref("Topic"), value: "Billing" });
  await sleep(1000);
  await shot("Topic set to Billing");

  await caption(`<b>click</b> Message → <b>type</b> "Invoice 0041 was charged twice."`);
  await call("click", { ref: await ref("Message") });
  for (const word of "Invoice 0041 was charged twice.".split(" ")) {
    await call("type", { text: word + " " });
    await sleep(180);
  }
  await sleep(700);
  await shot("Message typed");

  await caption(`<b>form_input</b> "Email me a copy" = on`);
  await call("form_input", { ref: await ref("Email me a copy"), value: true });
  await sleep(1000);
  await shot("Copy by email ticked");

  await caption(`<b>click</b> "Send message" → TabBridge asks you first… <b>Allowed</b>`);
  await sleep(800);
  const send = call("click", { ref: await ref("Send message") });
  await chrome.answerApproval("Allow");
  await send;
  await sleep(1500);
  await shot("Sent after the user allowed it");

  // The caption shows page_report's real numbers, read from its answer.
  const report = (await call("page_report", {})).content[0].text;
  const errors = report.match(/Console errors and warnings \((\d+)\)/)?.[1] ?? "?";
  const failed = report.match(/Failed requests \((\d+)\)/)?.[1] ?? "?";
  const load = report.match(/Load (\d+) ms/)?.[1];
  await caption(`<b>page_report</b> → ${errors} console errors · ${failed} failed requests${load ? ` · load ${load} ms` : ""}`);
  await sleep(1200);
  await shot("page_report checks the page");
  await sleep(1000);

  await call("gif_record", { action: "stop", name: "Demo recording" });
  // The guide saved the GIF as one of its steps; the README gets a copy at a fixed name.
  const folder = path.join(stepsDir, fs.readdirSync(stepsDir)[0]);
  const gifName = fs.readdirSync(folder).find((f) => f.endsWith(".gif"));
  const out = path.join(root, "docs", "demo.gif");
  fs.copyFileSync(path.join(folder, gifName), out);
  console.log(`docs/demo-steps/${path.basename(folder)}: ${fs.readdirSync(folder).join(", ")}`);
  console.log(`docs/demo.gif: ${Math.round(fs.statSync(out).size / 1024)} KB`);
} finally {
  agent.close();
  await chrome.close();
  server.close();
}
