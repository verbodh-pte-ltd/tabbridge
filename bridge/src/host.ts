// The native messaging host. Chrome starts it when the extension connects, and stops it when
// the extension goes away. It relays tool calls from agents (over the local pipe) to the extension.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { encodeLine, encodeNative, lineDecoder, nativeDecoder } from "./framing.ts";
import { homeDir, logPath, MAX_BROWSERS, pipeAlive, pipePath, tokenPath, writeBrowser } from "./paths.ts";
import { PROTOCOL_VERSION, textResult, type ExtensionToHost, type HostToExtension } from "./shared/protocol.ts";

interface HostOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (line: string) => void;
}

export async function runHost({ input, output, log = fileLog }: HostOptions): Promise<net.Server> {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString("hex");
  let slot = 0;
  let label = "";
  const register = () => {
    if (slot) writeBrowser({ slot, label: label || `Chrome ${slot}`, pid: process.pid, started: new Date().toISOString() });
  };

  let extensionReady = false;
  const sessions = new Map<string, net.Socket>();
  const pending = new Map<string, { socket: net.Socket; id: string; session: string }>();

  const toExtension = (message: HostToExtension) => output.write(encodeNative(message));

  input.on("data", nativeDecoder((message: ExtensionToHost) => {
    if (message.type === "label") {
      label = message.label;
      register();
    } else if (message.type === "ready") {
      extensionReady = true;
      label = message.label ?? label;
      register();
      log(`extension ready, version ${message.version}, browser "${label}"`);
      for (const [session, socket] of sessions) toExtension({ type: "session_open", session, client: clientOf(socket) });
    } else if (message.type === "result") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (!call.socket.destroyed) call.socket.write(encodeLine({ type: "result", id: call.id, result: message.result }));
    }
  }));

  const server = net.createServer((socket) => {
    let session: string | null = null;
    const helloTimer = setTimeout(() => socket.destroy(), 5000);

    socket.on("data", lineDecoder((message: any) => {
      if (!session) {
        if (message?.type !== "hello" || !sameToken(String(message.token ?? ""), token)) {
          socket.end(encodeLine({ type: "error", message: "TabBridge refused the connection: wrong or missing token." }));
          return;
        }
        clearTimeout(helloTimer);
        session = crypto.randomBytes(4).toString("hex");
        (socket as any).client = String(message.client || "agent").slice(0, 40);
        sessions.set(session, socket);
        log(`session ${session} opened by ${clientOf(socket)}`);
        socket.write(encodeLine({ type: "welcome", session, extension: extensionReady }));
        if (extensionReady) toExtension({ type: "session_open", session, client: clientOf(socket) });
        return;
      }
      if (message?.type !== "call") return;
      if (!extensionReady) {
        socket.write(encodeLine({ type: "result", id: message.id, result: textResult(NOT_READY, true) }));
        return;
      }
      const hostId = `${session}:${message.id}`;
      pending.set(hostId, { socket, id: message.id, session });
      toExtension({ type: "call", id: hostId, session, tool: message.tool, args: message.args ?? {} });
    }));

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!session) return;
      sessions.delete(session);
      for (const [key, call] of pending) if (call.session === session) pending.delete(key);
      if (extensionReady) toExtension({ type: "session_close", session });
      log(`session ${session} closed`);
    });
    socket.on("error", () => socket.destroy());
  });

  input.on("end", () => {
    log("extension disconnected; host stopping");
    server.close();
    for (const socket of sessions.values()) socket.destroy();
    if (process.platform !== "win32") fs.rmSync(pipePath(slot), { force: true });
    if (slot) writeBrowser({ slot, remove: true });
    if (input === process.stdin) process.exit(0);
  });

  slot = await listen(server, log);
  fs.writeFileSync(tokenPath(slot), token, { mode: 0o600 });
  register();
  log(`host listening on ${pipePath(slot)} (browser slot ${slot})`);
  return server;
}

const NOT_READY = "TabBridge's Chrome extension hasn't finished starting. Try again in a moment.";

function clientOf(socket: net.Socket): string {
  return (socket as any).client ?? "agent";
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Takes the first free slot. A slot whose pipe answers belongs to another Chrome; a dead socket file is cleared. */
async function listen(server: net.Server, log: (line: string) => void): Promise<number> {
  for (let slot = 1; slot <= MAX_BROWSERS; slot++) {
    const where = pipePath(slot);
    if (await pipeAlive(where)) continue;
    if (process.platform !== "win32") fs.rmSync(where, { force: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(where, resolve);
      });
    } catch (err: any) {
      if (err.code === "EADDRINUSE") continue;
      throw err;
    }
    if (process.platform !== "win32") fs.chmodSync(where, 0o600);
    return slot;
  }
  log(`all ${MAX_BROWSERS} browser slots are taken; this host stops`);
  throw new Error("No free TabBridge slot");
}

function fileLog(line: string): void {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break the host */ }
}
