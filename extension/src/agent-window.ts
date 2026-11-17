// The window an agent's tabs live in, so its calls never take the focus of the person's own window.
// One window per Chrome, shared by the agents; Chrome opens it behind the focused window, on the right of
// the screen. Its id is kept in session storage, because this worker can restart in the middle of a session.

import * as cdp from "./cdp.ts";
import { whenTabsEditable } from "./retry.ts";

const KEY = "agentWindow";
const SHARE = 0.38; // of the screen's work area, on the right
let opening: Promise<{ windowId: number; tab: chrome.tabs.Tab }> | undefined;

/** The agent window, if it is open. */
export async function existing(): Promise<number | undefined> {
  const saved = (await chrome.storage.session.get(KEY))[KEY] as number | undefined;
  if (saved === undefined) return undefined;
  try {
    await chrome.windows.get(saved);
    return saved;
  } catch {
    await chrome.storage.session.remove(KEY); // the person closed it
    return undefined;
  }
}

/** A window of the person's own to open a tab in: a normal window that is not the agent window. */
export async function personWindow(): Promise<number | undefined> {
  const agent = await existing();
  const others = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((w) => w.id !== agent);
  return (others.find((w) => w.focused) ?? others[0])?.id;
}

/**
 * Opens the agent window, without focus, and returns a tab in it that belongs to this caller alone.
 * With a tab id, that tab moves into the window instead of a blank one. Callers that arrive while the
 * window is still opening wait for it and then get a tab of their own: two agents never share a tab.
 */
export async function open(tabId?: number): Promise<chrome.tabs.Tab> {
  if (opening) {
    const { windowId } = await opening;
    return inWindow(windowId, tabId);
  }
  const made = create(tabId);
  opening = made;
  try {
    return (await made).tab;
  } finally {
    opening = undefined;
  }
}

async function inWindow(windowId: number, tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId === undefined) return whenTabsEditable(() => chrome.tabs.create({ windowId, url: "about:blank", active: true }));
  return whenTabsEditable(() => chrome.tabs.move(tabId, { windowId, index: -1 })).then((moved) => (Array.isArray(moved) ? moved[0]! : moved));
}

async function create(tabId?: number): Promise<{ windowId: number; tab: chrome.tabs.Tab }> {
  const win = await chrome.windows.create(tabId === undefined ? { url: "about:blank", focused: false } : { tabId, focused: false });
  const tab = win?.tabs?.[0];
  if (win?.id === undefined || tab?.id === undefined) throw new Error("Chrome did not open a window for the agent. Try again.");
  await chrome.storage.session.set({ [KEY]: win.id });
  await place(win.id, tab.id).catch(() => {}); // an odd screen leaves Chrome's own size
  return { windowId: win.id, tab };
}

/** Puts the window on the right of the work area. The tab reports the screen: no extra permission. */
async function place(windowId: number, tabId: number): Promise<void> {
  const { result } = await cdp.send(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify({ l: screen.availLeft, t: screen.availTop, w: screen.availWidth, h: screen.availHeight })",
    returnByValue: true,
  });
  // A page can change what the screen reports (the tab may be one the person sent): trust only sane numbers.
  const area = JSON.parse(result.value) as { l: number; t: number; w: number; h: number };
  const sane = [area.l, area.t, area.w, area.h].every((n) => Number.isFinite(n)) && area.w >= 600 && area.h >= 400 && area.w <= 20_000 && area.h <= 20_000;
  if (!sane) return;
  const width = Math.round(area.w * SHARE);
  await chrome.windows.update(windowId, { left: Math.round(area.l + area.w - width), top: Math.round(area.t), width, height: Math.round(area.h) });
}
