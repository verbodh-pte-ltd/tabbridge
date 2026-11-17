// The Versions block of `tabbridge doctor`: which version each part of the setup is.

import fs from "node:fs";
import path from "node:path";
import type { BrowserEntry } from "./paths.ts";

const FIX = "Run: npx @verbodhpteltd/tabbridge@latest install, then click Reload on the TabBridge card in chrome://extensions.";
// A browser name is text from outside this command: no control characters reach the terminal.
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "");

/** The version of the installed host program, read from its file. Undefined for a host built before versions were recorded. */
function hostProgramVersion(home: string): string | undefined {
  try {
    return fs.readFileSync(path.join(home, "host.js"), "utf8").match(/VERSION = "([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

export function versionReport({ bridge, home, browsers }: { bridge: string; home: string; browsers: BrowserEntry[] }): { lines: string[]; mismatch: boolean } {
  const program = hostProgramVersion(home);
  const unknown = "unknown (older host)";
  const lines = ["", "Versions", `  this command: ${bridge}`, `  host program (installed copy): ${program ?? unknown}`];
  const known: string[] = [bridge];
  if (program) known.push(program);
  for (const b of browsers) {
    lines.push(`  ${plain(b.label)} (slot ${b.slot}): extension ${b.extension ?? unknown}, host ${b.host ?? unknown}`);
    if (b.extension) known.push(b.extension);
    if (b.host) known.push(b.host);
  }
  const mismatch = new Set(known).size > 1;
  if (mismatch) lines.push("", `  These versions differ: ${[...new Set(known)].join(", ")}. ${FIX}`);
  return { lines, mismatch };
}
