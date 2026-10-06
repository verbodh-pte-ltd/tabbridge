// The bridge, end to end, with a fake extension in place of Chrome:
//   BridgeClient / `tabbridge mcp`  →  host  →  fake extension (native messaging frames)
// Every test gets its own TABBRIDGE_HOME and pipe, so nothing real is touched.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BridgeClient, NOT_CONNECTED } from "../bridge/src/client.ts";
import { encodeLine, encodeNative, lineDecoder, nativeDecoder } from "../bridge/src/framing.ts";
import { runHost } from "../bridge/src/host.ts";
import { TOOL_NAMES } from "../bridge/src/shared/tools.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
let n = 0;

function isolate(): { home: string; pipe: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-test-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\tabbridge-test-${process.pid}-${++n}`
    : path.join(home, "bridge.sock");
  process.env.TABBRIDGE_HOME = home;
  process.env.TABBRIDGE_PIPE = pipe;
  return { home, pipe };
}

/** Starts a host whose "Chrome side" is in this test. Returns what the extension received. */
async function startHost(opts: { ready?: boolean; reply?: (msg: any) => any } = {}) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const received: any[] = [];
  fromHost.on("data", nativeDecoder((msg) => {
    received.push(msg);
    if (msg.type === "call") {
      const result = opts.reply?.(msg) ?? { content: [{ type: "text", text: `ran ${msg.tool} ${JSON.stringify(msg.args)}` }] };
      toHost.write(encodeNative({ type: "result", id: msg.id, result }));
    }
  }));
  const server = await runHost({ input: toHost, output: fromHost, log: () => {} });
  if (opts.ready !== false) toHost.write(encodeNative({ type: "ready", version: "test", protocol: 1 }));
  await new Promise((r) => setImmediate(r));
  return { server, received, toHost, stop: () => { toHost.end(); server.close(); } };
}

test("native frames survive being split across chunks", () => {
  const got: any[] = [];
  const feed = nativeDecoder((m) => got.push(m));
  const bytes = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: "ü".repeat(3) })]);
  for (let i = 0; i < bytes.length; i += 3) feed(bytes.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: 1 }, { b: "ü".repeat(3) }]);
});

test("line frames survive being split across chunks", () => {
  const got: any[] = [];
  const feed = lineDecoder((m) => got.push(m));
  const text = encodeLine({ x: 1 }) + encodeLine({ y: 2 });
  feed(text.slice(0, 5));
  feed(text.slice(5));
  assert.deepEqual(got, [{ x: 1 }, { y: 2 }]);
});

test("no host running: a clear error, not a hang", async () => {
  isolate();
  const client = new BridgeClient("test");
  const result = await client.call("tabs_list", {}, 3000);
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as any).text, NOT_CONNECTED);
});

test("a call goes to the extension and its result comes back", async () => {
  isolate();
  const host = await startHost();
  const client = new BridgeClient("claude-code");
  const result = await client.call("navigate", { url: "https://example.com" });
  assert.equal((result.content[0] as any).text, 'ran navigate {"url":"https://example.com"}');
  const open = host.received.find((m) => m.type === "session_open");
  assert.equal(open.client, "claude-code");
  client.close();
  host.stop();
});

test("two agents get two sessions, and each gets only its own results", async () => {
  isolate();
  const host = await startHost({ reply: (m) => ({ content: [{ type: "text", text: m.session }] }) });
  const a = new BridgeClient("agent-a"), b = new BridgeClient("agent-b");
  const [ra, rb] = await Promise.all([a.call("tabs_list", {}), b.call("tabs_list", {})]);
  const opens = host.received.filter((m) => m.type === "session_open");
  assert.equal(opens.length, 2);
  assert.notEqual((ra.content[0] as any).text, (rb.content[0] as any).text);
  a.close(); b.close();
  host.stop();
});

test("closing an agent tells the extension the session ended", async () => {
  isolate();
  const host = await startHost();
  const client = new BridgeClient("x");
  await client.call("tabs_list", {});
  client.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(host.received.some((m) => m.type === "session_close"));
  host.stop();
});

test("a wrong token is refused", async () => {
  const { home } = isolate();
  const host = await startHost();
  fs.writeFileSync(path.join(home, "token"), "not-the-token");
  const client = new BridgeClient("intruder");
  const result = await client.call("tabs_list", {}, 3000);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as any).text, /wrong or missing token/);
  assert.equal(host.received.filter((m) => m.type === "call").length, 0);
  host.stop();
});

test("extension not ready yet: the agent is told, nothing is sent", async () => {
  isolate();
  const host = await startHost({ ready: false });
  const client = new BridgeClient("early");
  const result = await client.call("tabs_list", {});
  assert.equal(result.isError, true);
  assert.match((result.content[0] as any).text, /hasn't finished starting/);
  client.close();
  host.stop();
});

test("the token file is private to the user", { skip: process.platform === "win32" }, async () => {
  const { home } = isolate();
  const host = await startHost();
  assert.equal(fs.statSync(path.join(home, "token")).mode & 0o077, 0);
  host.stop();
});

test("`tabbridge mcp` lists every tool and relays a call (built bridge, real MCP over stdio)", async () => {
  isolate();
  const host = await startHost();
  const cli = path.join(ROOT, "bridge", "dist", "cli.js");
  assert.ok(fs.existsSync(cli), "run npm run build first");
  const child = spawn(process.execPath, [cli, "mcp"], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, any>();
  child.stdout.on("data", lineDecoder((m) => { if (m.id !== undefined) replies.set(m.id, m); }));
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const reply = async (id: number) => {
    for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return replies.get(id);
  };

  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-agent", version: "1" } } });
  const init = await reply(1);
  assert.match(init.result.instructions, /untrusted-page-content/);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const list = await reply(2);
  assert.deepEqual(list.result.tools.map((t: any) => t.name), TOOL_NAMES);
  send({ id: 3, method: "tools/call", params: { name: "find", arguments: { query: "Save" } } });
  const call = await reply(3);
  assert.equal(call.result.content[0].text, 'ran find {"query":"Save"}');
  assert.equal(host.received.find((m) => m.type === "session_open").client, "test-agent");
  send({ id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal((await reply(4)).result.isError, true);

  child.stdin.end();
  child.kill();
  host.stop();
});

test("two Chromes: each host takes its own slot, agents list them and switch by name", async () => {
  isolate();
  const first = await startHost();
  first.toHost.write(encodeNative({ type: "label", label: "Work Chrome" }));
  const second = await startHost({ reply: () => ({ content: [{ type: "text", text: "from the second" }] }) });
  second.toHost.write(encodeNative({ type: "label", label: "Testing profile" }));
  await new Promise((r) => setTimeout(r, 100));

  const client = new BridgeClient("agent");
  const list = await client.browsers();
  assert.deepEqual(list.map((b) => [b.slot, b.label, b.selected]), [[1, "Work Chrome", true], [2, "Testing profile", false]]);
  assert.match(((await client.call("tabs_list", {})).content[0] as any).text, /ran tabs_list/);
  await client.selectBrowser("testing");
  assert.equal(((await client.call("tabs_list", {})).content[0] as any).text, "from the second");
  await assert.rejects(client.selectBrowser("Firefox"), /No running Chrome called "Firefox"/);
  client.close();
  first.stop();
  second.stop();
});

test("TABBRIDGE_BROWSER pins a client to one Chrome; if that one isn't running it says so", async () => {
  isolate();
  const host = await startHost();
  host.toHost.write(encodeNative({ type: "label", label: "Work Chrome" }));
  await new Promise((r) => setTimeout(r, 50));
  process.env.TABBRIDGE_BROWSER = "Home Chrome";
  const pinned = new BridgeClient("agent");
  const r = await pinned.call("tabs_list", {}, 3000);
  delete process.env.TABBRIDGE_BROWSER;
  assert.equal(r.isError, true);
  pinned.close();
  host.stop();
});

test("file_upload paths are made absolute and must exist, before Chrome is asked", async () => {
  const { prepareUpload, isResult } = await import("../bridge/src/bridge-tools.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-up-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  const ok = prepareUpload({ ref: "e1", paths: ["a.txt"] }, dir) as any;
  assert.ok(!isResult(ok));
  assert.equal(ok.paths[0], path.join(dir, "a.txt"));
  const missing = prepareUpload({ ref: "e1", paths: ["nope.txt"] }, dir);
  assert.ok(isResult(missing) && missing.isError);
});
