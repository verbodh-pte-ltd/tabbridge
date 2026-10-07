// Every tool an agent can call. Names and arguments match bridge/src/shared/tools.ts.

import { whenTabsEditable } from "./retry.ts";
import type { ToolResult } from "../../bridge/src/shared/protocol.ts";
import { textResult } from "../../bridge/src/shared/protocol.ts";
import * as cdp from "./cdp.ts";
import { parseKeys } from "./keys.ts";
import { checkRisky, checkSite } from "./permissions.ts";
import { ACTION_HANDLERS } from "./actions.ts";
import { INSPECT_HANDLERS } from "./inspect.ts";
import { addToGroup, groupTabs, resolveTab, type Session } from "./sessions.ts";

type Args = Record<string, any>;
type Handler = (s: Session, a: Args) => Promise<ToolResult>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function untrusted(source: string | undefined, text: string): string {
  const safe = text.replaceAll("</untrusted-page-content>", "</untrusted-page-content​>");
  return `<untrusted-page-content source="${source ?? ""}">\n${safe}\n</untrusted-page-content>`;
}

export const page = (tab: chrome.tabs.Tab, text: string) => textResult(untrusted(tab.url, text));

export async function agent<T>(tabId: number, method: string, ...args: unknown[]): Promise<T> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page-agent.js"] });
  const [first] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m: string, a: unknown[]) => (globalThis as any).__tabbridge[m](...a),
    args: [method, args],
  });
  return first?.result as T;
}

async function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  const until = Date.now() + timeoutMs;
  let tab = await chrome.tabs.get(tabId);
  while (tab.status !== "complete" && Date.now() < until) {
    await sleep(200);
    tab = await chrome.tabs.get(tabId);
  }
  return tab;
}

/** A tab the agent may act on, on a site the user allowed. */
export async function usable(s: Session, a: Args): Promise<chrome.tabs.Tab> {
  const tab = await resolveTab(s, a.tabId);
  const refused = await checkSite(s.session, s.client, tab.url || tab.pendingUrl);
  if (refused) throw new Refused(refused);
  return tab;
}

export class Refused extends Error {}

/** Mouse and keyboard events only land in the tab in front, so input tools bring theirs forward. */
export async function foreground(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.active) {
    await whenTabsEditable(() => chrome.tabs.update(tab.id!, { active: true }));
    await sleep(150);
  }
}

function normaliseUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

/** After starting a navigation: wait for it to begin, then for the page to finish loading. */
async function waitForNavigation(tabId: number, fromUrl: string | undefined): Promise<chrome.tabs.Tab> {
  const until = Date.now() + 1500;
  let tab = await chrome.tabs.get(tabId);
  while (tab.status === "complete" && tab.url === fromUrl && Date.now() < until) {
    await sleep(100);
    tab = await chrome.tabs.get(tabId);
  }
  return waitForLoad(tabId);
}

/** A new tab in the agent's group. It starts blank so console and network are captured from the first request. */
async function openTab(s: Session, url?: string): Promise<chrome.tabs.Tab> {
  if (url) {
    const refused = await checkSite(s.session, s.client, url);
    if (refused) throw new Refused(refused);
  }
  const tab = await whenTabsEditable(() => chrome.tabs.create({ url: "about:blank", active: true }));
  await addToGroup(s, tab.id!);
  s.activeTab = tab.id;
  await cdp.attach(tab.id!).catch(() => {});
  if (!url) return tab;
  await whenTabsEditable(() => chrome.tabs.update(tab.id!, { url }));
  return waitForNavigation(tab.id!, "about:blank");
}

async function settle(tabId: number): Promise<void> {
  await sleep(350);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading") await waitForLoad(tabId, 10_000);
}

function mouseModifiers(text: unknown): number {
  const bits: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
  return String(text ?? "").split(/[+\s]+/).filter(Boolean).reduce((m, k) => m | (bits[k.toLowerCase()] ?? 0), 0);
}

const describe = (info: any) =>
  [info.role || info.tag, info.label ? `"${info.label}"` : ""].filter(Boolean).join(" ");

export const HANDLERS: Record<string, Handler> = {
  async tabs_list(s) {
    const tabs = await groupTabs(s);
    if (!tabs.length) return textResult("No tabs in this agent's group yet. Call tab_create.");
    const lines = tabs.map((t) => `${t.id === s.activeTab ? "*" : " "} tab ${t.id}: ${t.title ?? ""} — ${t.url ?? t.pendingUrl ?? ""}`);
    return textResult(untrusted("tabs", lines.join("\n")) + "\n(* = selected)");
  },

  async tab_create(s, a) {
    const url = a.url ? normaliseUrl(String(a.url)) : undefined;
    const tab = await openTab(s, url);
    const refused = url ? await checkSite(s.session, s.client, tab.url) : null;
    if (refused) throw new Refused(refused);
    return textResult(`Opened tab ${tab.id}${url ? `: ${untrusted(tab.url, tab.title ?? "")} ${tab.url}` : ""}.`);
  },

  async tab_select(s, a) {
    const tab = await resolveTab(s, Number(a.tabId));
    await whenTabsEditable(() => chrome.tabs.update(tab.id!, { active: true }));
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await cdp.attach(tab.id!).catch(() => {});
    return textResult(`Selected tab ${tab.id}.`);
  },

  async tab_close(s, a) {
    const tab = await resolveTab(s, Number(a.tabId));
    await whenTabsEditable(() => chrome.tabs.remove(tab.id!));
    if (s.activeTab === tab.id) s.activeTab = undefined;
    return textResult(`Closed tab ${tab.id}.`);
  },

  async navigate(s, a) {
    const where = String(a.url ?? "").trim();
    const isHistory = ["back", "forward", "reload"].includes(where);
    // No tab yet: open the agent's first one, rather than asking it to call tab_create.
    if (!isHistory && !(await groupTabs(s)).length && a.tabId === undefined) {
      const opened = await openTab(s, normaliseUrl(where));
      const refused = await checkSite(s.session, s.client, opened.url);
      if (refused) throw new Refused(refused);
      return textResult(`Opened tab ${opened.id}: ${untrusted(opened.url, opened.title ?? "")} ${opened.url}`);
    }
    const tab = await resolveTab(s, a.tabId);
    if (where === "reload") await chrome.tabs.reload(tab.id!);
    else if (isHistory) {
      const history = await cdp.send(tab.id!, "Page.getNavigationHistory");
      const entry = history.entries[history.currentIndex + (where === "back" ? -1 : 1)];
      if (!entry) return textResult(`There is no page to go ${where} to.`, true);
      await cdp.send(tab.id!, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else {
      const url = normaliseUrl(where);
      const refused = await checkSite(s.session, s.client, url);
      if (refused) throw new Refused(refused);
      await whenTabsEditable(() => chrome.tabs.update(tab.id!, { url }));
    }
    const loaded = await waitForNavigation(tab.id!, where === "reload" ? undefined : tab.url);
    const refused = await checkSite(s.session, s.client, loaded.url);  // a redirect may land elsewhere
    if (refused) throw new Refused(refused);
    return textResult(`${loaded.status === "complete" ? "Loaded" : "Still loading after 30 s"}: ${untrusted(loaded.url, loaded.title ?? "")} ${loaded.url}`);
  },

  async read_page(s, a) {
    const tab = await usable(s, a);
    return page(tab, await agent<string>(tab.id!, "readPage", a.filter === "all" ? "all" : "interactive", a.ref, 400));
  },

  async find(s, a) {
    const tab = await usable(s, a);
    return page(tab, await agent<string>(tab.id!, "find", String(a.query ?? ""), 40));
  },

  async get_page_text(s, a) {
    const tab = await usable(s, a);
    return page(tab, await agent<string>(tab.id!, "pageText", Math.max(500, Number(a.maxChars) || 20_000)));
  },

  async screenshot(s, a) {
    const tab = await usable(s, a);
    if (!tab.active) await whenTabsEditable(() => chrome.tabs.update(tab.id!, { active: true }));
    const metrics = await cdp.send(tab.id!, "Page.getLayoutMetrics");
    const vp = metrics.cssVisualViewport ?? metrics.visualViewport;
    const dpr = (await cdp.send(tab.id!, "Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true })).result.value || 1;
    const shot = await cdp.send(tab.id!, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr },
    });
    return {
      content: [
        { type: "image", data: shot.data, mimeType: "image/jpeg" },
        { type: "text", text: `Screenshot of tab ${tab.id}, ${Math.round(vp.clientWidth)}×${Math.round(vp.clientHeight)}. click and scroll take x/y in these pixels.` },
        // Read and removed by the bridge, which files the screenshot into the project's guide.
        { type: "text", text: `tabbridge-meta ${JSON.stringify({ title: tab.title ?? "", url: tab.url ?? "" })}` },
      ],
    };
  },

  async click(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    let info: any;
    if (a.ref) {
      info = await agent(tab.id!, "refInfo", String(a.ref), true);
      if (!info.ok) return textResult(info.error, true);
    } else if (typeof a.x === "number" && typeof a.y === "number") {
      info = await agent(tab.id!, "pointInfo", a.x, a.y);
    } else {
      return textResult("click needs a ref, or both x and y.", true);
    }
    const what = describe(info) || `the point ${info.x},${info.y}`;
    const refused = await checkRisky(s.client, tab, `click ${what}`);
    if (refused) throw new Refused(refused);
    const button = a.button ?? "left";
    const clicks = Math.min(Math.max(Number(a.clickCount) || 1, 1), 3);
    const modifiers = mouseModifiers(a.modifiers);
    await cdp.send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y, modifiers });
    // A double or triple click is a run of presses with a rising clickCount, as a real mouse sends.
    for (let clickCount = 1; clickCount <= clicks; clickCount++) {
      await cdp.send(tab.id!, "Input.dispatchMouseEvent", { type: "mousePressed", x: info.x, y: info.y, button, clickCount, modifiers });
      await cdp.send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseReleased", x: info.x, y: info.y, button, clickCount, modifiers });
    }
    await settle(tab.id!);
    const note = info.covered ? " Another element was on top of it, so the click may have landed on that instead." : "";
    return textResult(`Clicked ${untrusted(tab.url, what)}.${note}`);
  },

  async type(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    await cdp.send(tab.id!, "Input.insertText", { text: String(a.text ?? "") });
    return textResult(`Typed ${String(a.text ?? "").length} characters.`);
  },

  async key(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    const presses = parseKeys(String(a.keys ?? ""));
    if (presses.some((p) => p.key === "Enter")) {
      const focus: any = await agent(tab.id!, "focusInfo");
      const sends = focus.inForm || focus.editable;
      if (sends) {
        const what = focus.submitLabel ? `press Enter, which submits "${focus.submitLabel}"` : `press Enter in ${describe(focus)} (this may send it)`;
        const refused = await checkRisky(s.client, tab, focus.submitLabel ? what : `send: ${what}`);
        if (refused) throw new Refused(refused);
      }
    }
    for (const p of presses) {
      const base = { key: p.key, code: p.code, windowsVirtualKeyCode: p.keyCode, nativeVirtualKeyCode: p.keyCode, modifiers: p.modifiers };
      await cdp.send(tab.id!, "Input.dispatchKeyEvent", { ...base, type: p.text ? "keyDown" : "rawKeyDown", text: p.text, unmodifiedText: p.text });
      await cdp.send(tab.id!, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    }
    await settle(tab.id!);
    return textResult(`Pressed ${a.keys}.`);
  },

  async scroll(s, a) {
    const tab = await usable(s, a);
    await foreground(tab);
    if (a.ref) {
      const info: any = await agent(tab.id!, "refInfo", String(a.ref), true);
      return info.ok ? textResult(`Scrolled ${a.ref} into view.`) : textResult(info.error, true);
    }
    const amount = Number(a.amount) || 600;
    const dir = a.direction ?? "down";
    const vp = (await cdp.send(tab.id!, "Page.getLayoutMetrics")).cssVisualViewport;
    const x = typeof a.x === "number" ? a.x : vp.clientWidth / 2;
    const y = typeof a.y === "number" ? a.y : vp.clientHeight / 2;
    await cdp.send(tab.id!, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y,
      deltaX: dir === "left" ? -amount : dir === "right" ? amount : 0,
      deltaY: dir === "up" ? -amount : dir === "down" ? amount : 0,
    });
    await sleep(250);
    return textResult(`Scrolled ${dir} ${amount}px.`);
  },

  async form_input(s, a) {
    const tab = await usable(s, a);
    return textResult(await agent<string>(tab.id!, "formInput", String(a.ref), a.value));
  },

  async javascript(s, a) {
    const tab = await usable(s, a);
    const code = String(a.code ?? "");
    const run = (expression: string) => cdp.send(tab.id!, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true,
    });
    let out = await run(code);
    const err = out.exceptionDetails?.exception?.description ?? "";
    if (out.exceptionDetails && /Illegal return|await is only valid/i.test(err)) out = await run(`(async () => {\n${code}\n})()`);
    if (out.exceptionDetails) {
      const msg = out.exceptionDetails.exception?.description ?? out.exceptionDetails.text;
      return textResult(`The script threw: ${msg}`, true);
    }
    const value = out.result?.value;
    let text = value === undefined ? (out.result?.description ?? "undefined") : JSON.stringify(value, null, 2);
    if (text.length > 50_000) text = text.slice(0, 50_000) + "\n… (cut at 50000 characters)";
    return page(tab, text);
  },

  async console_messages(s, a) {
    const tab = await usable(s, a);
    await cdp.attach(tab.id!);
    const re = a.pattern ? new RegExp(String(a.pattern), "i") : null;
    let list = cdp.consoleEntries(tab.id!);
    if (a.onlyErrors) list = list.filter((e) => e.level === "error");
    if (re) list = list.filter((e) => re.test(e.text));
    list = list.slice(-(Number(a.limit) || 50));
    if (a.clear) cdp.clearConsole(tab.id!);
    if (!list.length) return textResult("No console messages yet (TabBridge only sees messages from after it attached to the tab).");
    return page(tab, list.map((e) => `[${e.level}] ${e.text}${e.url ? `  (${e.url})` : ""}`).join("\n"));
  },

  async network_requests(s, a) {
    const tab = await usable(s, a);
    await cdp.attach(tab.id!);
    const re = a.pattern ? new RegExp(String(a.pattern), "i") : null;
    let list = cdp.networkEntries(tab.id!);
    if (re) list = list.filter((e) => re.test(e.url));
    list = list.slice(-(Number(a.limit) || 50));
    if (a.clear) cdp.clearNetwork(tab.id!);
    if (!list.length) return textResult("No requests yet (TabBridge only sees requests from after it attached to the tab).");
    const all = cdp.networkEntries(tab.id!);
    return page(tab, list.map((e) => `[${all.indexOf(e)}] ${e.method} ${e.failed ? `FAILED ${e.failed}` : e.status ?? "…"} ${e.url}`).join("\n") +
      "\nFor headers, timing and the response body: network_request with that [number].");
  },

  async wait_for(s, a) {
    const ms = Math.min(Number(a.ms) || 30_000, 30_000);
    if (!a.text) {
      await sleep(ms);
      return textResult(`Waited ${ms} ms.`);
    }
    const tab = await usable(s, a);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await agent<boolean>(tab.id!, "hasText", String(a.text)).catch(() => false)) {
        return textResult(`The text appeared.`);
      }
      await sleep(300);
    }
    return textResult(`The text did not appear within ${ms} ms.`, true);
  },

  async downloads(_s, a) {
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: Math.min(Number(a.limit) || 10, 50) });
    if (!items.length) return textResult("No downloads yet.");
    return textResult(untrusted("downloads", items.map((d) =>
      `${d.state === "complete" ? "done" : d.state === "interrupted" ? `failed (${d.error})` : `${Math.round((d.bytesReceived / (d.totalBytes || 1)) * 100)}%`}  ${d.filename || "(no file yet)"}  ← ${d.finalUrl || d.url}`).join("\n")));
  },

  async resize_window(s, a) {
    const tab = await resolveTab(s, a.tabId);
    const win = await chrome.windows.update(tab.windowId, { state: "normal", width: Math.round(a.width), height: Math.round(a.height) });
    const note = Math.abs((win.width ?? 0) - Math.round(a.width)) > 20 ? " Chrome has a minimum window width (about 500 px), so it may be wider than asked." : "";
    return textResult(`Window is now ${win.width}×${win.height}.${note}`);
  },
};

export async function runTool(s: Session, tool: string, args: Args): Promise<ToolResult> {
  const handler = HANDLERS[tool] ?? INSPECT_HANDLERS[tool] ?? ACTION_HANDLERS[tool];
  if (!handler) return textResult(`TabBridge has no tool called ${tool}. Update the extension and the bridge to the same version.`, true);
  try {
    return await handler(s, args ?? {});
  } catch (err: any) {
    return textResult(err?.message ?? String(err), true);
  }
}
