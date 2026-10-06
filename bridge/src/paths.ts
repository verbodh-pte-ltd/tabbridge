import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Everything TabBridge keeps on disk lives here. TABBRIDGE_HOME overrides it (tests use that). */
export function homeDir(): string {
  return process.env.TABBRIDGE_HOME || path.join(os.homedir(), ".tabbridge");
}

// Each Chrome running TabBridge starts its own host. The first takes slot 1, the next slot 2…
// Each slot has its own pipe and token, and browsers.json says which Chrome holds which slot.
export const MAX_BROWSERS = 9;

/** Where a host listens for agents: a named pipe on Windows, a socket file elsewhere. */
export function pipePath(slot = 1): string {
  const suffix = slot === 1 ? "" : `-${slot}`;
  if (process.env.TABBRIDGE_PIPE) return process.env.TABBRIDGE_PIPE + suffix;
  if (process.platform === "win32") {
    const user = (os.userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\tabbridge-${user}${suffix}`;
  }
  return path.join(homeDir(), `bridge${suffix}.sock`);
}

export const tokenPath = (slot = 1) => path.join(homeDir(), slot === 1 ? "token" : `token-${slot}`);
export const logPath = () => path.join(homeDir(), "host.log");
const registryPath = () => path.join(homeDir(), "browsers.json");

export interface BrowserEntry { slot: number; label: string; pid: number; started: string }

export function readBrowsers(): BrowserEntry[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return [];
  }
}

export function writeBrowser(entry: BrowserEntry | { slot: number; remove: true }): void {
  const list = readBrowsers().filter((b) => b.slot !== entry.slot);
  if (!("remove" in entry)) list.push(entry);
  list.sort((a, b) => a.slot - b.slot);
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(registryPath(), JSON.stringify(list, null, 2));
}

export function pipeAlive(where: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(where);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/** The Chromes whose host is answering right now, in slot order. */
export async function liveBrowsers(): Promise<BrowserEntry[]> {
  const out: BrowserEntry[] = [];
  for (let slot = 1; slot <= MAX_BROWSERS; slot++) {
    if (!(await pipeAlive(pipePath(slot)))) continue;
    out.push(readBrowsers().find((b) => b.slot === slot) ?? { slot, label: `Chrome ${slot}`, pid: 0, started: "" });
  }
  return out;
}
