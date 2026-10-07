// Right-click menu: "Send this page / this element to my agent (TabBridge)".
// The capture waits in session storage until an agent calls user_captures.

import { agent } from "./tools.ts";
import { report, type Capture } from "./inspect.ts";
import { shareTab } from "./sessions.ts";
import { getSettings } from "./settings.ts";

const KEEP = 20;

async function saveCapture(capture: Capture): Promise<void> {
  const { captures = [] } = await chrome.storage.session.get("captures") as { captures?: Capture[] };
  await chrome.storage.session.set({ captures: [...captures, capture].slice(-KEEP) });
}

// The side panel's "Send to my agent" box: a note, with the current page if the user asks.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== "send_note") return;
  (async () => {
    const note = String(message.note ?? "").trim().slice(0, 4000);
    let tab: chrome.tabs.Tab | undefined;
    if (message.attachPage) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const page = tab?.id && /^https?:|^file:/.test(tab.url ?? "");
    await saveCapture({
      time: Date.now(),
      note: note || undefined,
      what: page ? (note ? "a note and the page" : "the page") : "a note",
      ...(page ? { tabId: tab!.id, url: tab!.url, report: await report(tab!), shared: await shareTab(tab!.id!).catch(() => false) } : { shared: false }),
    });
    return { ok: true, attached: !!page };
  })().then(reply, (err) => reply({ ok: false, error: err?.message ?? String(err) }));
  return true;
});

export function setUpMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tb-element", title: "Send this element to my agent (TabBridge)", contexts: ["all"] });
    chrome.contextMenus.create({ id: "tb-page", title: "Send this page to my agent (TabBridge)", contexts: ["page", "frame"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;
  try {
    const element = info.menuItemId === "tb-element"
      ? (await agent<string | null>(tab.id, "rightClicked").catch(() => null)) ?? undefined
      : undefined;
    const shared = await shareTab(tab.id).catch(() => false);
    const capture: Capture = {
      time: Date.now(),
      tabId: tab.id,
      url: tab.url,
      what: element ? "an element" : "the page",
      element,
      report: await report(tab),
      shared,
    };
    await saveCapture(capture);
    if ((await getSettings()).notify) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Sent to your agent",
        message: `Ask your agent to check what you sent from TabBridge (${capture.what} on ${new URL(tab.url).host}).`,
      });
    }
  } catch (err: any) {
    chrome.notifications.create({
      type: "basic", iconUrl: "icons/icon128.png", title: "TabBridge couldn't capture this page",
      message: err?.message ?? String(err),
    });
  }
});
