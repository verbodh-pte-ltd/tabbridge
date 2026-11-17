// Phase 1 probe (plan C1, C2, C3, C3b): what a window that is not focused does in real Chrome.
// Run: node tests/live/probe-window.mjs   (opens one throwaway Chrome window for about 25 s)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { launch } from "./chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = {
  "/green": '<body style="margin:0;background:#00aa00"><h1>Acme window one</h1>',
  "/purple": '<body style="margin:0;background:#aa00aa"><h1>Acme agent window</h1><button id="b" style="font-size:30px;margin:20px">Go</button><input id="i" style="font-size:30px;margin:20px"><script>window.__log=[];window.__raf=0;b.onclick=()=>__log.push("click");addEventListener("keydown",e=>__log.push("keydown:"+e.key));(function l(){__raf++;requestAnimationFrame(l)})();</script>',
};
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(pages[req.url.split("?")[0]] ?? "ok"); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

function pixel(x, y) {
  const file = path.join(os.tmpdir(), "tb-probe-" + process.pid + ".png");
  const r = spawnSync("screencapture", ["-x", "-R", [x, y, 1, 1].join(","), "-t", "png", file]);
  if (r.status !== 0 || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  let off = 8; const idat = []; let w = 0, bpp = 4;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") { w = buf.readUInt32BE(off + 8); bpp = buf[off + 17] === 6 ? 4 : 3; }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  fs.rmSync(file, { force: true });
  return [raw[1], raw[2], raw[3]];
}
const name = (p) => !p ? "no capture" : (p[0] < 40 && p[1] > 120 && p[2] < 40) ? "green (window one)" : (p[0] > 120 && p[1] < 40 && p[2] > 120) ? "purple (agent window)" : "other " + p.join(",");

const chrome = await launch(path.join(ROOT, "extension", "dist"), { real: true });
const ev = (code) => chrome.extEval(code);
const out = {};
try {
  await sleep(1500);
  const w1 = (await ev("chrome.windows.getAll({populate:true}).then(ws=>JSON.stringify(ws.map(w=>({id:w.id,tab:w.tabs[0].id}))))"));
  const W1 = JSON.parse(w1).find(Boolean);
  await ev("chrome.windows.update(" + W1.id + ",{left:0,top:0,width:1100,height:800,focused:true}).then(()=>chrome.tabs.update(" + W1.tab + ",{url:'" + base + "/green'}))");
  await sleep(1500);
  // C3: open a window that is not focused, on top of window one
  out.screenInfo = null;
  const w2 = JSON.parse(await ev("chrome.windows.create({url:'" + base + "/purple',focused:false,left:700,top:120,width:700,height:500}).then(w=>JSON.stringify({id:w.id,tab:w.tabs[0].id,focused:w.focused}))"));
  await sleep(2000);
  out.created = w2;
  out.focus = JSON.parse(await ev("chrome.windows.getAll().then(ws=>JSON.stringify(ws.map(w=>({id:w.id,focused:w.focused,state:w.state,left:w.left,top:w.top,width:w.width,height:w.height}))))"));
  const b2 = out.focus.find((w) => w.id === w2.id);
  out.requestedBounds = "left 700, top 120, width 700, height 500";
  const at = (rect) => ({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
  const p2 = at(b2);
  out.pixelAtAgentWindowCentre = name(pixel(p2.x, p2.y));
  out.pixelAtAgentWindowOnlyArea = name(pixel(Math.min(b2.left + b2.width - 40, 1400), b2.top + 200));
  out.pixelAtWindowOneOnly = name(pixel(Math.round(1000), Math.round(700)));
  const pop = JSON.parse(await ev("chrome.windows.create({type:'popup',url:'" + base + "/purple',focused:false,left:1000,top:500,width:460,height:340}).then(w=>JSON.stringify({id:w.id,left:w.left,top:w.top,width:w.width,height:w.height,focused:w.focused}))"));
  await sleep(1500);
  out.popupWindow = pop;
  out.popupGetAll = JSON.parse(await ev("chrome.windows.getAll().then(ws=>JSON.stringify(ws.map(w=>({id:w.id,type:w.type,focused:w.focused,left:w.left,top:w.top,width:w.width,height:w.height}))))"));
  // C1: events and typing in the active tab of the unfocused window
  const dbg = (method, params = {}) => ev("chrome.debugger.sendCommand({tabId:" + w2.tab + "}," + JSON.stringify(method) + "," + JSON.stringify(params) + ").then(r=>JSON.stringify(r||{}))");
  await ev("chrome.debugger.attach({tabId:" + w2.tab + "},'1.3')");
  const evalPage = async (expr) => JSON.parse(await dbg("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
  const rect = await evalPage("(()=>{const r=b.getBoundingClientRect();const i=document.getElementById('i').getBoundingClientRect();return {bx:r.x+r.width/2,by:r.y+r.height/2,ix:i.x+i.width/2,iy:i.y+i.height/2}})()");
  const click = async (x, y) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await dbg("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }); };
  const typeText = async (text) => { await dbg("Input.insertText", { text }); await dbg("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }); await dbg("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }); };
  await click(rect.bx, rect.by);
  await click(rect.ix, rect.iy);
  await typeText("hello");
  out.unfocusedWindowEvents = { log: await evalPage("JSON.stringify(__log)"), inputValue: await evalPage("document.getElementById('i').value"), hasFocus: await evalPage("document.hasFocus()"), visibility: await evalPage("document.visibilityState") };
  await dbg("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalPage("document.getElementById('i').value='';__log.length=0;0");
  await click(rect.bx, rect.by); await click(rect.ix, rect.iy); await typeText("hello");
  out.withFocusEmulation = { log: await evalPage("JSON.stringify(__log)"), inputValue: await evalPage("document.getElementById('i').value"), hasFocus: await evalPage("document.hasFocus()") };
  await dbg("Emulation.setFocusEmulationEnabled", { enabled: false });
  // C2: screenshot of the active tab of the unfocused window, and of a background tab
  const shot = async (tab) => { const t = Date.now(); const r = JSON.parse(await ev("Promise.race([chrome.debugger.sendCommand({tabId:" + tab + "},'Page.captureScreenshot',{format:'jpeg',quality:60}).then(r=>JSON.stringify({bytes:(r.data||'').length})),new Promise(r=>setTimeout(()=>r(JSON.stringify({timeout:true})),5000))])")); return { ...r, ms: Date.now() - t }; };
  out.screenshotUnfocusedActive = await shot(w2.tab);
  const bg = JSON.parse(await ev("chrome.tabs.create({windowId:" + w2.id + ",url:'" + base + "/purple',active:false}).then(t=>JSON.stringify({id:t.id}))"));
  await sleep(1500);
  await ev("chrome.debugger.attach({tabId:" + bg.id + "},'1.3')");
  out.screenshotBackgroundTab = await shot(bg.id);
  // C3b: cover the agent window with window one, then measure drawing, events and screenshots
  const rafRate = async () => { const a = await evalPage("__raf"); await sleep(1000); const c = await evalPage("__raf"); return c - a; };
  out.framesPerSecondUncovered = await rafRate();
  await ev("chrome.windows.update(" + W1.id + ",{focused:true})");
  await sleep(1500);
  out.pixelWhileCovered = name(pixel(p2.x, p2.y));
  out.framesPerSecondCovered = await rafRate();
  out.screenshotCovered = await shot(w2.tab);
  await evalPage("__log.length=0;0");
  await click(rect.bx, rect.by);
  out.eventsCovered = { log: await evalPage("JSON.stringify(__log)"), visibility: await evalPage("document.visibilityState") };
} catch (err) {
  out.error = String(err.stack || err).slice(0, 800);
} finally {
  await chrome.close();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
