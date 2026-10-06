// `tabbridge mcp`: the MCP server an agent starts over stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { browsersTool, isResult, prepareUpload } from "./bridge-tools.ts";
import { BridgeClient } from "./client.ts";
import { GuideRecorder } from "./guide.ts";
import { SERVER_INSTRUCTIONS, TOOLS, TOOL_NAMES } from "./shared/tools.ts";
import { VERSION } from "./version.ts";

export async function runMcp(): Promise<void> {
  const server = new Server(
    { name: "tabbridge", version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const bridge = new BridgeClient("agent");
  const guide = new GuideRecorder("agent");

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (!TOOL_NAMES.includes(name)) {
      return { content: [{ type: "text", text: `TabBridge has no tool called ${name}.` }], isError: true };
    }
    const client = server.getClientVersion()?.name || "agent";
    bridge.setClient(client);
    guide.setClient(client);
    if (name === "browsers") return (await browsersTool(bridge, args)) as any;
    let send: Record<string, any> = args;
    if (name === "file_upload") {
      const prepared = prepareUpload(args);
      if (isResult(prepared)) return prepared as any;
      send = prepared;
    }
    const timeout = name === "wait_for" ? Math.min(Number(args.ms) || 30_000, 30_000) + 20_000 : 150_000;
    return guide.record(name, args, await bridge.call(name, send, timeout)) as any;
  });

  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => { bridge.close(); process.exit(0); });
}
