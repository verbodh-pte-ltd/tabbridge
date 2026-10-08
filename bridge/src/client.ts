// The agent side of the local pipe. Used by `tabbridge mcp` and `tabbridge call`.

import fs from "node:fs";
import net from "node:net";
import { encodeLine, lineDecoder } from "./framing.ts";
import { liveBrowsers, pipePath, tokenPath, type BrowserEntry } from "./paths.ts";
import { PROTOCOL_VERSION, textResult, type ToolResult } from "./shared/protocol.ts";

export const NOT_CONNECTED =
  "TabBridge can't reach Chrome. Open Chrome with the TabBridge extension turned on, then try again. " +
  "To check the setup, run: npx @verbodhpteltd/tabbridge doctor";

export class BridgeClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private waiting = new Map<string, (result: ToolResult) => void>();
  private client: string;
  private slot: number | null = null;   // which Chrome; null = decide on first call
  private wanted = process.env.TABBRIDGE_BROWSER ?? "";

  constructor(client: string) {
    this.client = client;
  }

  /** Every Chrome running TabBridge, with the one this client uses marked. */
  async browsers(): Promise<(BrowserEntry & { selected: boolean })[]> {
    const live = await liveBrowsers();
    const current = this.slot ?? (await this.pick(live))?.slot;
    return live.map((b) => ({ ...b, selected: b.slot === current }));
  }

  /** Switch to another Chrome, by its name (as set in TabBridge settings) or its number. */
  async selectBrowser(nameOrSlot: string): Promise<BrowserEntry> {
    const live = await liveBrowsers();
    const found = match(live, nameOrSlot);
    if (!found) throw new Error(`No running Chrome called "${nameOrSlot}". Running: ${live.map((b) => `${b.slot}. ${b.label}`).join(", ") || "none"}`);
    this.close();
    this.slot = found.slot;
    this.wanted = nameOrSlot;
    return found;
  }

  private async pick(live: BrowserEntry[]): Promise<BrowserEntry | undefined> {
    return (this.wanted ? match(live, this.wanted) : undefined) ?? live[0];
  }

  setClient(name: string): void {
    this.client = name;
  }

  /** Runs one tool. Never throws: a failure comes back as an error result the agent can read. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 150_000): Promise<ToolResult> {
    try {
      await this.connect();
    } catch (err: any) {
      return textResult(err?.message || NOT_CONNECTED, true);
    }
    const id = String(this.nextId++);
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(textResult(`TabBridge: ${tool} got no answer from Chrome in ${Math.round(timeoutMs / 1000)} s.`, true));
      }, timeoutMs);
      this.waiting.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.socket!.write(encodeLine({ type: "call", id, tool, args }));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>(async (resolve, reject) => {
      if (this.slot === null || !this.wanted) {
        const chosen = await this.pick(await liveBrowsers());
        if (!chosen) { reject(new Error(NOT_CONNECTED)); return; }
        if (this.wanted && !match([chosen], this.wanted)) { reject(new Error(NOT_CONNECTED)); return; }
        this.slot = chosen.slot;
      }
      const slot = this.slot;
      let token: string;
      try {
        token = fs.readFileSync(tokenPath(slot), "utf8").trim();
      } catch {
        reject(new Error(NOT_CONNECTED));
        return;
      }
      const socket = net.connect(pipePath(slot));
      let welcomed = false;
      socket.once("error", () => { if (!welcomed) reject(new Error(NOT_CONNECTED)); });
      socket.on("connect", () => {
        socket.write(encodeLine({ type: "hello", token, client: this.client, protocol: PROTOCOL_VERSION }));
      });
      socket.on("data", lineDecoder((message: any) => {
        if (message.type === "welcome") {
          welcomed = true;
          this.socket = socket;
          resolve();
        } else if (message.type === "error" && !welcomed) {
          reject(new Error(message.message));
        } else if (message.type === "result") {
          this.waiting.get(message.id)?.(message.result);
          this.waiting.delete(message.id);
        }
      }));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!this.wanted) this.slot = null;   // not pinned: next call picks whichever Chrome is running
        for (const done of this.waiting.values()) done(textResult(NOT_CONNECTED, true));
        this.waiting.clear();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
}

function match(list: BrowserEntry[], nameOrSlot: string): BrowserEntry | undefined {
  const want = nameOrSlot.trim().toLowerCase();
  return list.find((b) => String(b.slot) === want) ?? list.find((b) => b.label.toLowerCase() === want)
    ?? list.find((b) => b.label.toLowerCase().includes(want));
}
