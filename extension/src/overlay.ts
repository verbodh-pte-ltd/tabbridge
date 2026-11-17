// The extension's side of the overlay: the light yellow edge and the pointer on a tab an agent controls.
// The page script (overlay-page.ts) keeps the state and expires itself after 3 seconds without a call,
// so a restart of this worker or a dropped connection cannot leave the edge on.
// Nothing here may fail a tool: a page that refuses scripts (chrome:// pages, the Web Store) just shows no overlay.

import { getSettings } from "./settings.ts";

const controlled = new Set<number>();
chrome.tabs.onRemoved.addListener((tabId) => controlled.delete(tabId));

/** How long the pointer is given to travel before the click lands, so the person can see it. */
export const POINTER_MS = 220;

type Command = "touch" | "point" | "suspend" | "resume" | "stop";

async function run(tabId: number, command: Command, args: unknown[], install: boolean): Promise<void> {
  const exec = () => chrome.scripting.executeScript({
    target: { tabId },
    func: (c: string, a: unknown[]) => {
      const o = (globalThis as any).__tbOverlay;
      return o ? Promise.resolve((o as any)[c](...a)).then(() => true) : false;
    },
    args: [command, args],
  });
  let [first] = await exec();
  if (!first?.result && install) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay-page.js"] });
    [first] = await exec();
  }
}

/** True when the command ran. False when the overlay is off or the page refused it: the tool carries on either way. */
async function safely(tabId: number, command: Command, args: unknown[] = [], install = false): Promise<boolean> {
  try {
    if (!(await getSettings()).overlay) return false;
    await run(tabId, command, args, install);
    if (command === "stop") controlled.delete(tabId);
    else if (install) controlled.add(tabId);
    return true;
  } catch {
    return false;
  }
}

/** The agent used this tab: show the edge, restart its idle time. */
export const touch = (tabId: number) => safely(tabId, "touch", [], true);

/** The agent moves, clicks, hovers, drags or scrolls at this point (viewport pixels). */
export const point = (tabId: number, x: number, y: number, kind: "click" | "hover" | "drag" | "scroll") => safely(tabId, "point", [x, y, kind], true);

/** Hides the overlay until released. Holds nest, so two captures at once never show it. */
export const hold = (tabId: number) => safely(tabId, "suspend");
export const release = (tabId: number) => safely(tabId, "resume");

/** Runs a capture with the overlay hidden, so the agent's screenshot shows the page alone. */
export async function hidden<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
  await hold(tabId);
  try {
    return await capture();
  } finally {
    await release(tabId);
  }
}

/** The bridge dropped: turn every overlay off. */
export async function stopAll(): Promise<void> {
  await Promise.all([...controlled].map((tabId) => safely(tabId, "stop")));
}
