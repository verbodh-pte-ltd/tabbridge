// `tabbridge install | uninstall | doctor`: registers the native messaging host with Chrome
// (and Edge, Brave, Chromium when present) for the current user. No admin rights needed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir, pipePath, tokenPath } from "./paths.ts";
import { DEV_EXTENSION_ID, HOST_NAME, STORE_EXTENSION_IDS } from "./shared/protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const WIN_KEYS = [
  "Software\\Google\\Chrome",
  "Software\\Microsoft\\Edge",
  "Software\\BraveSoftware\\Brave-Browser",
  "Software\\Chromium",
].map((k) => `HKCU\\${k}\\NativeMessagingHosts\\${HOST_NAME}`);

function unixBrowserDirs(): { dir: string; always: boolean }[] {
  const home = os.homedir();
  const base = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : path.join(home, ".config");
  const names = process.platform === "darwin"
    ? ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"]
    : ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"];
  return names.map((n, i) => ({ dir: path.join(base, n), always: i === 0 }));
}

const manifestPath = () => path.join(homeDir(), `${HOST_NAME}.json`);
const hostScript = () => path.join(homeDir(), "host.js");
const launcher = () => path.join(homeDir(), process.platform === "win32" ? "tabbridge-host.bat" : "tabbridge-host.sh");

export function install(extraIds: string[] = []): void {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });

  // The host is copied out of the npm cache so it keeps working after npx clears that cache.
  const bundled = path.join(here, "host.js");
  if (!fs.existsSync(bundled)) throw new Error(`Missing ${bundled}. Run "npm run build" first.`);
  fs.copyFileSync(bundled, hostScript());

  if (process.platform === "win32") {
    fs.writeFileSync(launcher(), `@echo off\r\n"${process.execPath}" "${hostScript()}" %*\r\n`);
  } else {
    fs.writeFileSync(launcher(), `#!/bin/sh\nexec "${process.execPath}" "${hostScript()}" "$@"\n`, { mode: 0o755 });
  }

  const ids = [DEV_EXTENSION_ID, ...STORE_EXTENSION_IDS, ...extraIds];
  const manifest = {
    name: HOST_NAME,
    description: "TabBridge: lets AI agents use this browser",
    path: launcher(),
    type: "stdio",
    allowed_origins: [...new Set(ids)].map((id) => `chrome-extension://${id}/`),
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));

  const registered: string[] = [];
  if (process.platform === "win32") {
    for (const key of WIN_KEYS) {
      execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath(), "/f"], { stdio: "ignore" });
      registered.push(key);
    }
  } else {
    for (const { dir, always } of unixBrowserDirs()) {
      if (!always && !fs.existsSync(dir)) continue;
      const target = path.join(dir, "NativeMessagingHosts", `${HOST_NAME}.json`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
      registered.push(target);
    }
  }

  console.log("TabBridge host installed.");
  for (const r of registered) console.log(`  registered: ${r}`);
  console.log(`  trusts extension ids: ${ids.join(", ")}`);
  console.log("\nNext:");
  console.log("  1. Add the TabBridge extension to Chrome (see the README).");
  console.log("  2. Connect an agent, for example:  claude mcp add tabbridge -- npx -y @verbodhpteltd/tabbridge mcp");
  console.log("  3. Check everything:               npx @verbodhpteltd/tabbridge doctor");
}

export function uninstall(): void {
  if (process.platform === "win32") {
    for (const key of WIN_KEYS) {
      try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); } catch { /* not there */ }
    }
  } else {
    for (const { dir } of unixBrowserDirs()) {
      fs.rmSync(path.join(dir, "NativeMessagingHosts", `${HOST_NAME}.json`), { force: true });
    }
  }
  fs.rmSync(homeDir(), { recursive: true, force: true });
  console.log("TabBridge host removed. Remove the extension from chrome://extensions as well.");
}

/** Prints one line per check. Returns false if anything needs fixing. */
export async function doctor(): Promise<boolean> {
  const checks: [string, boolean, string][] = [];
  const add = (name: string, ok: boolean, fix: string) => checks.push([name, ok, fix]);

  add("host program copied", fs.existsSync(hostScript()), "run: npx @verbodhpteltd/tabbridge install");
  add("host launcher written", fs.existsSync(launcher()), "run: npx @verbodhpteltd/tabbridge install");

  let manifestOk = false;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
    manifestOk = m.name === HOST_NAME && fs.existsSync(m.path);
  } catch { /* missing or broken */ }
  add("host manifest valid", manifestOk, "run: npx @verbodhpteltd/tabbridge install");

  if (process.platform === "win32") {
    let value = "";
    try { value = execFileSync("reg", ["query", WIN_KEYS[0], "/ve"], { encoding: "utf8" }); } catch { /* missing */ }
    add("registered with Chrome", value.includes(manifestPath()), "run: npx @verbodhpteltd/tabbridge install");
  } else {
    const chrome = unixBrowserDirs()[0].dir;
    add("registered with Chrome", fs.existsSync(path.join(chrome, "NativeMessagingHosts", `${HOST_NAME}.json`)),
      "run: npx @verbodhpteltd/tabbridge install");
  }

  const nodeOk = (() => {
    try {
      const text = fs.readFileSync(launcher(), "utf8");
      const node = text.match(/"([^"]+)"/)?.[1];
      return !!node && fs.existsSync(node);
    } catch { return false; }
  })();
  add("Node.js still at the installed path", nodeOk, "Node moved or was upgraded: run npx @verbodhpteltd/tabbridge install again");

  const running = await new Promise<boolean>((resolve) => {
    const s = net.connect(pipePath());
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  add("Chrome extension connected", running && fs.existsSync(tokenPath()),
    "open Chrome and check the TabBridge extension is turned on (chrome://extensions)");

  for (const [name, ok, fix] of checks) console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  →  ${fix}`}`);
  return checks.every(([, ok]) => ok);
}
