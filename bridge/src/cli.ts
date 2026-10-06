import { browsersTool, isResult, prepareUpload } from "./bridge-tools.ts";
import { BridgeClient } from "./client.ts";
import { GuideRecorder } from "./guide.ts";
import { doctor, install, uninstall } from "./install.ts";
import { TOOLS } from "./shared/tools.ts";
import { VERSION } from "./version.ts";

const CONFIGS: Record<string, string> = {
  claude: "claude mcp add tabbridge -- npx -y tabbridge mcp",
  codex: `# ~/.codex/config.toml
[mcp_servers.tabbridge]
command = "npx"
args = ["-y", "tabbridge", "mcp"]`,
  gemini: `// ~/.gemini/settings.json
{ "mcpServers": { "tabbridge": { "command": "npx", "args": ["-y", "tabbridge", "mcp"] } } }`,
  cursor: `// ~/.cursor/mcp.json
{ "mcpServers": { "tabbridge": { "command": "npx", "args": ["-y", "tabbridge", "mcp"] } } }`,
  json: `{ "mcpServers": { "tabbridge": { "command": "npx", "args": ["-y", "tabbridge", "mcp"] } } }`,
};

const HELP = `TabBridge ${VERSION}: lets any AI agent use your Chrome.

  tabbridge install [--extension-id <id>]   register the host with Chrome (once per computer)
  tabbridge doctor                          check the setup, say what to fix
  tabbridge uninstall                       remove the host
  tabbridge config <claude|codex|gemini|cursor|json>
                                            how to connect an agent
  tabbridge mcp                             the MCP server (agents start this)
  tabbridge call <tool> ['<json args>']     run one tool and print the result (for apps and scripts)
                                            TABBRIDGE_BROWSER=<name> picks the Chrome when several run it
  tabbridge tools                           list the tools`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "install": {
      const ids: string[] = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === "--extension-id" && rest[i + 1]) ids.push(rest[++i]);
      install(ids);
      return 0;
    }
    case "uninstall":
      uninstall();
      return 0;
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "config": {
      const text = CONFIGS[rest[0] ?? ""];
      if (!text) { console.error(`Pick one: ${Object.keys(CONFIGS).join(", ")}`); return 2; }
      console.log(text);
      return 0;
    }
    case "mcp": {
      const { runMcp } = await import("./mcp.ts");
      await runMcp();
      return -1; // keep running
    }
    case "call": {
      const [tool, json] = rest;
      if (!tool) { console.error("Usage: tabbridge call <tool> ['<json args>']"); return 2; }
      let args = {};
      try { args = json ? JSON.parse(json) : {}; } catch { console.error("The arguments must be JSON."); return 2; }
      const name = process.env.TABBRIDGE_CLIENT || "cli";
      const client = new BridgeClient(name);
      let send: Record<string, any> = args;
      let result;
      if (tool === "browsers") result = await browsersTool(client, args);
      else {
        if (tool === "file_upload") {
          const prepared = prepareUpload(args);
          if (isResult(prepared)) { console.log(JSON.stringify(prepared, null, 2)); return 1; }
          send = prepared;
        }
        result = new GuideRecorder(name).record(tool, args, await client.call(tool, send));
      }
      client.close();
      // Images are saved to the guide; printing their base64 would flood the terminal.
      const printable = { ...result, content: result.content.map((c) => c.type === "image" ? { type: "image", mimeType: c.mimeType, bytes: Math.round(c.data.length * 0.75) } : c) };
      console.log(JSON.stringify(printable, null, 2));
      return result.isError ? 1 : 0;
    }
    case "tools":
      for (const t of TOOLS) console.log(`${t.name.padEnd(18)} ${t.description.split(". ")[0]}`);
      return 0;
    case "--version": case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exit(code); },
  (err) => { console.error(err?.message ?? err); process.exit(1); },
);
