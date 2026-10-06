// Every screenshot an agent takes is saved into a step-by-step guide, in the project the agent
// works in:  <project>/tabbridge/<NN>-<topic>/<NN>-<step>.jpg  plus  README.md
// The actions between two screenshots (went to…, clicked…, typed…) become that step's text.
//
// TABBRIDGE_OUTPUT moves the folder; TABBRIDGE_GUIDE=0 turns the guide off.

import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "./shared/protocol.ts";

const REUSE_MS = 30 * 60_000;   // a new guide starts after 30 minutes without a screenshot

export function slug(text: string, max = 50): string {
  const s = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/g, "")) || "page";
}

const two = (n: number) => String(n).padStart(2, "0");
const plain = (text: string) => text.replace(/<\/?untrusted-page-content[^>]*>/g, "").replace(/\s+/g, " ").trim();

export class GuideRecorder {
  private root: string;
  private client: string;
  private folder: string | null = null;
  private actions: string[] = [];

  constructor(client: string, root = process.env.TABBRIDGE_OUTPUT || path.join(process.cwd(), "tabbridge")) {
    this.client = client;
    this.root = root;
  }

  /** Typing in several pieces reads as one step: "Typed 12 characters" + "Typed 5" = "Typed 17". */
  private note(action: string): void {
    const typed = /^Typed (\d+) characters$/;
    const last = this.actions.at(-1);
    if (last && typed.test(last) && typed.test(action)) {
      this.actions[this.actions.length - 1] = `Typed ${Number(last.match(typed)![1]) + Number(action.match(typed)![1])} characters`;
    } else {
      this.actions.push(action);
    }
  }

  setClient(client: string): void {
    this.client = client;
  }

  static enabled(): boolean {
    return process.env.TABBRIDGE_GUIDE !== "0";
  }

  /** Called after every tool call. Returns the result to give the agent. */
  record(tool: string, args: Record<string, any>, result: ToolResult): ToolResult {
    const meta = result.content.find((c) => c.type === "text" && c.text.startsWith("tabbridge-meta "));
    const content = result.content.filter((c) => c !== meta);
    if (result.isError) return { ...result, content };
    if (tool === "gif_record" && args.action === "stop") return this.recording(args, result, content, meta);
    if (tool !== "screenshot") {
      const action = describe(tool, args, result);
      if (action) this.note(action);
      return { ...result, content };
    }
    const image = content.find((c) => c.type === "image");
    if (!image || image.type !== "image" || !GuideRecorder.enabled()) return { ...result, content };
    let page = { title: "", url: "" };
    try { page = JSON.parse((meta as any).text.slice("tabbridge-meta ".length)); } catch { /* no meta: older extension */ }
    try {
      const saved = this.save(image.data, page, args.caption ? String(args.caption) : "");
      return { ...result, content: [...content, { type: "text", text: `Saved to the guide: ${saved}` }] };
    } catch (err: any) {
      return { ...result, content: [...content, { type: "text", text: `(Could not save the screenshot to the guide: ${err.message})` }] };
    }
  }

  /** A finished GIF is always saved (even with the screenshot guide off), and never sent to the agent: it is large. */
  private recording(args: Record<string, any>, result: ToolResult, content: ToolResult["content"], meta: any): ToolResult {
    const gif = content.find((c) => c.type === "image" && c.mimeType === "image/gif");
    if (!gif || gif.type !== "image") return { ...result, content };
    let page = { title: "", url: "" };
    try { page = JSON.parse(meta.text.slice("tabbridge-meta ".length)); } catch { /* no meta */ }
    try {
      const folder = this.guideFolder(page);
      const n = stepCount(folder) + 1;
      const title = args.name ? String(args.name) : `Recording of ${page.title || hostOf(page.url) || "the tab"}`;
      const file = `${two(n)}-${slug(title)}.gif`;
      fs.writeFileSync(path.join(folder, file), Buffer.from(gif.data, "base64"));
      const done = this.actions.length ? this.actions.map((a) => `- ${a}`).join("\n") + "\n\n" : "";
      fs.appendFileSync(path.join(folder, "README.md"), `## Step ${n}: ${title}\n\n${done}![Step ${n}: ${title}](${file})\n\n`);
      this.actions = [];
      const rel = path.relative(process.cwd(), path.join(folder, file)) || file;
      return { content: [...content.filter((c) => c !== gif), { type: "text", text: `Saved the recording: ${rel}` }] };
    } catch (err: any) {
      return { content: [...content.filter((c) => c !== gif), { type: "text", text: `(Could not save the recording: ${err.message})` }], isError: true };
    }
  }

  private save(base64: string, page: { title: string; url: string }, caption: string): string {
    const folder = this.guideFolder(page);
    const steps = stepCount(folder);
    const n = steps + 1;
    const title = caption || page.title || hostOf(page.url) || `Step ${n}`;
    const file = `${two(n)}-${slug(title)}.jpg`;
    fs.writeFileSync(path.join(folder, file), Buffer.from(base64, "base64"));

    const readme = path.join(folder, "README.md");
    const done = this.actions.length ? this.actions.map((a) => `- ${a}`).join("\n") + "\n\n" : "";
    const where = page.url ? `Page: ${page.title ? `${page.title} — ` : ""}${page.url}\n\n` : "";
    fs.appendFileSync(readme, `## Step ${n}: ${title}\n\n${done}${where}![Step ${n}: ${title}](${file})\n\n`);
    this.actions = [];
    return path.relative(process.cwd(), path.join(folder, file)) || file;
  }

  private guideFolder(page: { title: string; url: string }): string {
    if (this.folder && fs.existsSync(this.folder) && Date.now() - fs.statSync(path.join(this.folder, "README.md")).mtimeMs < REUSE_MS) {
      return this.folder;
    }
    fs.mkdirSync(this.root, { recursive: true });
    // A one-shot `tabbridge call` from the same client carries on its recent guide.
    const existing = fs.readdirSync(this.root).filter((f) => /^\d+-/.test(f)).sort();
    const latest = existing.at(-1);
    if (latest && !this.folder) {
      const readme = path.join(this.root, latest, "README.md");
      if (fs.existsSync(readme) && Date.now() - fs.statSync(readme).mtimeMs < REUSE_MS &&
          fs.readFileSync(readme, "utf8").includes(`client: ${this.client} -->`)) {
        return (this.folder = path.join(this.root, latest));
      }
    }
    const next = existing.reduce((m, f) => Math.max(m, parseInt(f, 10) || 0), 0) + 1;
    const topic = page.title || hostOf(page.url) || "browser-session";
    this.folder = path.join(this.root, `${two(next)}-${slug(topic)}`);
    fs.mkdirSync(this.folder, { recursive: true });
    const when = new Date();
    const date = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}:${two(when.getMinutes())}`;
    fs.writeFileSync(path.join(this.folder, "README.md"),
      `# ${topic}\n\n<!-- tabbridge guide, client: ${this.client} -->\nRecorded by TabBridge on ${date}, driven by ${this.client}. One step per screenshot, in order.\n\n`);
    return this.folder;
  }
}

function stepCount(folder: string): number {
  return fs.readdirSync(folder).filter((f) => /^\d+-.*\.(jpg|gif)$/.test(f)).length;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function describe(tool: string, args: Record<string, any>, result: ToolResult): string | null {
  const text = plain(result.content.filter((c) => c.type === "text").map((c: any) => c.text).join(" "));
  switch (tool) {
    case "navigate": return ["back", "forward", "reload"].includes(args.url) ? `Went ${args.url === "reload" ? "and reloaded the page" : args.url}` : `Opened ${args.url}`;
    case "tab_create": return args.url ? `Opened ${args.url} in a new tab` : "Opened a new tab";
    case "click": return text.replace(/\s*\.$/, "").replace(/\s+"/g, ' "').trim();
    case "type": return `Typed ${String(args.text ?? "").length} characters`;
    case "key": return `Pressed ${args.keys}`;
    case "form_input": return text.replace(/\s*\.$/, "").replace(/ \(e\d+\)/, "");
    case "scroll": return args.ref ? `Scrolled to ${args.ref}` : `Scrolled ${args.direction ?? "down"}`;
    case "tab_select": return `Switched to tab ${args.tabId}`;
    case "hover": return args.ref ? `Hovered over ${args.ref}` : `Hovered at ${args.x},${args.y}`;
    case "drag": return text.replace(/\.$/, "");
    case "file_upload": return `Attached ${(args.paths ?? []).map((p: string) => path.basename(p)).join(", ")}`;
    case "gif_record": return args.action === "start" ? "Started recording" : null;
    case "page_report": return "Checked the page with page_report";
    case "resize_window": return `Resized the window to ${args.width}×${args.height}`;
    default: return null;   // reading tools change nothing on screen
  }
}
