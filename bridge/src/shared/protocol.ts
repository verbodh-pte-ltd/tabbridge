// Messages between the three parts:
//   agent-side client  ──(local pipe, one JSON per line)──►  host  ──(native messaging)──►  extension

export const HOST_NAME = "com.verbodh.tabbridge";

// The unpacked extension's id: fixed by the public key in extension/static/manifest.json.
export const DEV_EXTENSION_ID = "biffejdaeofpjdlaemechglldaeanifc";
// The Chrome Web Store build's id (https://chromewebstore.google.com/detail/pomolcbmcembghhjgnjllblncbpmihcd).
export const STORE_EXTENSION_IDS: string[] = ["pomolcbmcembghhjgnjllblncbpmihcd"];

export const PROTOCOL_VERSION = 1;

/** A tool result, already in MCP's shape so the bridge passes it through untouched. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// client → host
export type ClientMessage =
  | { type: "hello"; token: string; client: string; protocol: number }
  | { type: "call"; id: string; tool: string; args: Record<string, unknown> };

// host → client
export type HostToClient =
  | { type: "welcome"; session: string; extension: boolean }
  | { type: "result"; id: string; result: ToolResult }
  | { type: "error"; id?: string; message: string };

// host ↔ extension
export type HostToExtension =
  | { type: "session_open"; session: string; client: string }
  | { type: "session_close"; session: string }
  | { type: "call"; id: string; session: string; tool: string; args: Record<string, unknown> };

export type ExtensionToHost =
  | { type: "ready"; version: string; protocol: number; label?: string }
  | { type: "label"; label: string }
  | { type: "result"; id: string; result: ToolResult };

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}
