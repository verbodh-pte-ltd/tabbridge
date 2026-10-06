// Do real agent CLIs drive TabBridge? Starts the throwaway Chrome and the test site, then asks
// each installed agent to read a codeword that only exists on the test page.
//
//   node tests/live/agents.mjs            (runs whichever of claude, codex, gemini are installed)
//
// NOT RUN YET: written, never executed (it spends a little of each agent's AI usage). Its result is
// not part of any reported test count.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./chrome.mjs";
import { startSite } from "./site.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI = path.join(ROOT, "bridge", "dist", "cli.js").replaceAll("\\", "/");
process.env.TABBRIDGE_BROWSER = "tabbridge-live-agents";
const site = await startSite();
const chrome = await launch(path.join(ROOT, "extension", "dist"));
await new Promise((r) => setTimeout(r, 1500));
await chrome.extEval(`chrome.storage.local.set({ settings: { browserName: "tabbridge-live-agents" } })`);
await new Promise((r) => setTimeout(r, 800));
const prompt = `Use the tabbridge tools: navigate to ${site.url("/second")} and read the page text. Reply with only the codeword on the page.`;

// Windows: npm's .cmd wrappers can't take JSON arguments safely, so find the real executables.
function exe(name) {
  if (process.platform !== "win32") return spawnSync("which", [name], { encoding: "utf8" }).status === 0 ? name : null;
  const npm = path.join(process.env.APPDATA ?? "", "npm");
  const candidates = {
    claude: [path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")],
    codex: [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenAI", "Codex", "bin", "codex.exe")],
    gemini: [],
  }[name] ?? [];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}
const has = (cmd) => !!exe(cmd);
const results = [];

if (has("claude")) {
  const config = JSON.stringify({ mcpServers: { tabbridge: { command: "node", args: [CLI, "mcp"] } } });
  const r = spawnSync(exe("claude"), ["-p", prompt, "--mcp-config", config, "--strict-mcp-config",
    "--allowedTools", "mcp__tabbridge__navigate,mcp__tabbridge__get_page_text,mcp__tabbridge__read_page,mcp__tabbridge__tabs_list"],
    { encoding: "utf8", timeout: 240_000, cwd: ROOT });
  results.push(["Claude Code", /TB-7731/.test(r.stdout), `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}`.trim().slice(-300)]);
}
if (has("codex")) {
  const r = spawnSync(exe("codex"), ["exec", "--skip-git-repo-check",
    "-c", `mcp_servers.tabbridge.command="node"`, "-c", `mcp_servers.tabbridge.args=["${CLI}","mcp"]`,
    "-c", `mcp_servers.tabbridge.default_tools_approval_mode="approve"`, prompt],
    { encoding: "utf8", timeout: 240_000, cwd: ROOT });
  results.push(["Codex", /TB-7731/.test(r.stdout), `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}`.trim().slice(-300)]);
}
if (has("gemini")) {
  results.push(["Gemini CLI", false, "installed, but not wired into this test yet"]);
} else {
  results.push(["Gemini CLI", null, "not installed on this computer"]);
}

await chrome.close();
site.close();
for (const [name, ok, out] of results) console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${out}`}`);
process.exit(results.some(([, ok]) => ok === false) ? 1 : 0);
