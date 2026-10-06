// Tool work done in the bridge, before or instead of asking Chrome:
// - browsers: which Chrome this agent uses (a bridge choice, not a page action);
// - file_upload: turn the agent's paths into checked absolute paths on this computer.

import fs from "node:fs";
import path from "node:path";
import type { BridgeClient } from "./client.ts";
import { textResult, type ToolResult } from "./shared/protocol.ts";

export async function browsersTool(bridge: BridgeClient, args: Record<string, any>): Promise<ToolResult> {
  try {
    if (args.select) await bridge.selectBrowser(String(args.select));
  } catch (err: any) {
    return textResult(err.message, true);
  }
  const list = await bridge.browsers();
  if (!list.length) return textResult("No Chrome is running TabBridge right now.", true);
  return textResult(list.map((b) => `${b.selected ? "*" : " "} ${b.slot}. ${b.label}`).join("\n") +
    "\n(* = the one this agent uses. Rename a browser in TabBridge settings.)");
}

/** Returns the args to send on, or an error result. */
export function prepareUpload(args: Record<string, any>, cwd = process.cwd()): Record<string, any> | ToolResult {
  const paths: string[] = Array.isArray(args.paths) ? args.paths.map(String) : [];
  if (!paths.length) return textResult("file_upload needs paths: a list of files.", true);
  const absolute = paths.map((p) => path.resolve(cwd, p));
  const missing = absolute.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
  if (missing.length) return textResult(`Not found, or not a file: ${missing.join(", ")}`, true);
  return { ...args, paths: absolute };
}

export function isResult(x: unknown): x is ToolResult {
  return !!x && typeof x === "object" && Array.isArray((x as any).content);
}
