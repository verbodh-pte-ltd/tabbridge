// The input and capture tools added to match Claude in Chrome: hover, drag, zoom, file_upload, gif_record.

import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { ToolResult } from "../../bridge/src/shared/protocol.ts";
import { textResult } from "../../bridge/src/shared/protocol.ts";
import * as cdp from "./cdp.ts";
import { elementHandle } from "./inspect.ts";
import { checkRisky } from "./permissions.ts";
import type { Session } from "./sessions.ts";
import { agent, foreground, Refused, sleep, untrusted, usable } from "./tools.ts";

type Args = Record<string, any>;
type Handler = (s: Session, a: Args) => Promise<ToolResult>;

/** Where on screen a ref or an x/y is, plus what is there. */
async function point(tabId: number, ref?: string, x?: number, y?: number): Promise<any> {
  if (ref) {
    const info: any = await agent(tabId, "refInfo", String(ref), true);
    if (!info.ok) throw new Error(info.error);
    return info;
  }
  if (typeof x === "number" && typeof y === "number") return agent(tabId, "pointInfo", x, y);
  throw new Error("Give a ref, or both x and y.");
}

const describe = (info: any) => [info.role || info.tag, info.label ? `"${info.label}"` : ""].filter(Boolean).join(" ") || `${info.x},${info.y}`;

// GIF recordings in progress, per tab.
const recordings = new Map<number, { frames: { data: string; t: number }[]; every: number; last: number; started: number }>();
const MAX_FRAMES = 300;

async function encodeGif(frames: { data: string; t: number }[], endTime: number): Promise<string> {
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${frames[i].data}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const palette = quantize(data, 256);
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endTime, frames[i].t + 1000);
    const delay = Math.min(Math.max(Math.round(next - frames[i].t), 60), 3000);
    gif.writeFrame(applyPalette(data, palette), bitmap.width, bitmap.height, { palette, delay });
  }
  gif.finish();
  const bytes: Uint8Array = gif.bytes();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const ACTION_HANDLERS: Record<string, Handler> = {
  async hover(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    const info = await point(tab.id!, a.ref, a.x, a.y);
    await cdp.send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
    await sleep(300);
    return textResult(`Hovering over ${untrusted(tab.url, describe(info))}.`);
  },

  async drag(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    const id = tab.id!;
    const from = await point(id, a.fromRef, a.fromX, a.fromY);
    const to = await point(id, a.toRef, a.toX, a.toY);
    // HTML drag-and-drop doesn't start from synthetic mouse events alone: let Chrome hand us the
    // drag, then drop it ourselves. Plain mouse-drag widgets just see the mouse moves.
    await cdp.send(id, "Input.setInterceptDrags", { enabled: true });
    const intercepted = cdp.nextEvent(id, "Input.dragIntercepted", 1500);
    try {
      await cdp.send(id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await cdp.send(id, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await cdp.send(id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await sleep(16);
      }
      const drag = await Promise.race([intercepted, sleep(300).then(() => null)]);
      if (drag) {
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await cdp.send(id, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: drag.data });
        }
      }
      await cdp.send(id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    } finally {
      await cdp.send(id, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
    }
    await sleep(300);
    return textResult(`Dragged ${untrusted(tab.url, describe(from))} to ${untrusted(tab.url, describe(to))}.`);
  },

  async zoom(s, a) {
    const tab = await usable(s, a);
    const [x0, x1] = [Math.min(a.x0, a.x1), Math.max(a.x0, a.x1)];
    const [y0, y1] = [Math.min(a.y0, a.y1), Math.max(a.y0, a.y1)];
    const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
    const vp = (await cdp.send(tab.id!, "Page.getLayoutMetrics")).cssVisualViewport;
    const dpr = (await cdp.send(tab.id!, "Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true })).result.value || 1;
    const factor = Math.min(4, Math.max(1, 1200 / width));
    const shot = await cdp.send(tab.id!, "Page.captureScreenshot", {
      format: "png",
      clip: { x: vp.pageX + x0, y: vp.pageY + y0, width, height, scale: factor / dpr },
    });
    return {
      content: [
        { type: "image", data: shot.data, mimeType: "image/png" },
        { type: "text", text: `Region ${x0},${y0} to ${x1},${y1}, enlarged ${factor.toFixed(1)}×.` },
      ],
    };
  },

  async file_upload(s, a) {
    const tab = await usable(s, a);
    const paths: string[] = Array.isArray(a.paths) ? a.paths : [];
    if (!paths.length) return textResult("file_upload needs paths.", true);
    const names = paths.map((p) => p.split(/[\\/]/).pop()).join(", ");
    const refused = await checkRisky(s.client, tab.url, `upload ${names} from this computer`);
    if (refused) throw new Refused(refused);
    const objectId = await elementHandle(tab.id!, a);
    const isFileInput = await cdp.send(tab.id!, "Runtime.callFunctionOn", {
      objectId, functionDeclaration: "function () { return this instanceof HTMLInputElement && this.type === 'file'; }", returnByValue: true,
    });
    if (!isFileInput.result?.value) return textResult("That element isn't a file field. Use find with \"file\" or \"upload\", or read_page, to get the file field's ref.", true);
    await cdp.send(tab.id!, "DOM.setFileInputFiles", { files: paths, objectId });
    return textResult(`Attached ${names}.`);
  },

  async gif_record(s, a) {
    const tab = await usable(s, a);
    const id = tab.id!;
    if (a.action === "start") {
      if (recordings.has(id)) return textResult("Already recording this tab. Call gif_record with action stop first.", true);
      const fps = Math.min(Math.max(Number(a.fps) || 4, 1), 10);
      const rec = { frames: [] as { data: string; t: number }[], every: 1000 / fps, last: 0, started: Date.now() };
      recordings.set(id, rec);
      cdp.frameSinks.set(id, (data, t) => {
        if (t - rec.last < rec.every || rec.frames.length >= MAX_FRAMES) return;
        rec.last = t;
        rec.frames.push({ data, t });
      });
      await cdp.send(id, "Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
      return textResult(`Recording tab ${id} at ${fps} frames a second (up to ${MAX_FRAMES} frames). Call gif_record with action stop when done.`);
    }
    const rec = recordings.get(id);
    if (!rec) return textResult("This tab isn't being recorded. Call gif_record with action start first.", true);
    await cdp.send(id, "Page.stopScreencast").catch(() => {});
    cdp.frameSinks.delete(id);
    recordings.delete(id);
    if (!rec.frames.length) return textResult("No frames were captured: the page didn't change on screen while recording.", true);
    const data = await encodeGif(rec.frames, Date.now());
    const seconds = Math.round((Date.now() - rec.started) / 1000);
    return {
      content: [
        { type: "image", data, mimeType: "image/gif" },
        { type: "text", text: `Recorded ${rec.frames.length} frames over ${seconds} s.` },
        { type: "text", text: `tabbridge-meta ${JSON.stringify({ title: tab.title ?? "", url: tab.url ?? "" })}` },
      ],
    };
  },
};
