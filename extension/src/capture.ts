// Right-click menu: "Send this page / this element to my agent (TabBridge)".
// The capture waits in session storage until an agent calls user_captures.

import { agent } from "./tools.ts";
import { report, type Capture } from "./inspect.ts";
import { shareTab } from "./sessions.ts";
import { getSettings } from "./settings.ts";

const KEEP = 20;

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
    const { captures = [] } = await chrome.storage.session.get("captures") as { captures?: Capture[] };
    await chrome.storage.session.set({ captures: [...captures, capture].slice(-KEEP) });
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
