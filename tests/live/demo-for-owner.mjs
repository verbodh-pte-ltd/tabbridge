// A slow run for a person to watch: their own window, the agent window on the right, the yellow edge and the pointer.
// Run: node tests/live/demo-for-owner.mjs   (opens one throwaway Chrome window for about 40 s; then closes it)
import path from "node:path";
import { BridgeClient } from "../../bridge/src/client.ts";
import { launch } from "./chrome.mjs";
import { startSite } from "./site.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").slice(0, 100);
process.env.TABBRIDGE_BROWSER = "tabbridge-demo";
const site = await startSite();
const chrome = await launch(path.join(ROOT, "extension", "dist"), { real: true });
try {
  await sleep(1500);
  await chrome.extEval('chrome.storage.local.get("settings").then(x => chrome.storage.local.set({ settings: { ...(x.settings || {}), browserName: "tabbridge-demo" } }))');
  const agent = new BridgeClient("demo-agent");
  for (let i = 0; i < 40; i++) { const r = await agent.call("tabs_list", {}, 3000); if (!r.isError) break; agent.close(); await sleep(250); }
  // The person's window: the left part of the screen, with a page of their own.
  await chrome.extEval('chrome.windows.getAll().then((ws) => chrome.windows.update(ws[0].id, { left: 0, top: 33, width: 800, height: 700, focused: true })).then(() => chrome.tabs.query({ active: true }).then((t) => chrome.tabs.update(t[0].id, { url: "' + site.url("/second") + '" })))');
  await sleep(2000);
  const step = async (name, tool, args) => { const r = await agent.call(tool, args); console.log(name, r.isError ? "ERROR" : "ok", text(r)); await sleep(1800); };
  console.log("Watch: your window on the left, the agent window opens on the right.");
  await step("1 navigate", "navigate", { url: site.url("/tools") });
  const full = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").replace(/<\/?untrusted-page-content[^>]*>/g, "").trim();
  const at = async (id) => JSON.parse(full(await agent.call("javascript", { code: "(() => { const r = document.getElementById(" + JSON.stringify(id) + ").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()" })));
  await step("2 hover", "hover", await at("hov"));
  await step("3 click", "click", await at("dbl"));
  await step("4 scroll", "scroll", { direction: "down", amount: 200 });
  const from = await at("card"), to = await at("zone");
  await step("5 drag", "drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
  console.log("Done. The edge and the pointer go 3 seconds after the last step.");
  await sleep(4000);
} finally {
  await chrome.close();
  site.close();
}
