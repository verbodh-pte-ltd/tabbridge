// The two questions TabBridge asks the user: "may this agent use this site?" and
// "may this agent do this risky thing?". Every waiting question is in storage.session
// ("approvals") and the badge counts them. They show in the side panel when it's open, else in
// the toolbar pane, which opens by itself next to the TabBridge icon. There is no separate
// window: when Chrome isn't the focused app, the pane opens as soon as it is (and a desktop
// notification says a question waits). YOLO mode (Settings.yolo) asks nothing at all.

import { getSettings, getSites, setSettings, setSite } from "./settings.ts";

export type Answer = "once" | "always" | "block" | "allow" | "deny";

export interface Approval {
  id: string;
  kind: "site" | "action";
  client: string;
  origin: string;
  detail: string;
  /** When no answer counts as no (ms since 1970); the pane shows the time left. */
  expiresAt: number;
}

const WAIT_MS = 120_000;
const pending = new Map<string, { approval: Approval; done: (a: Answer) => void }>();

// Sites allowed "once" last for the agent's session only.
const allowedOnce = new Map<string, Set<string>>();

export const RISKY = /\b(send|submit|buy|pay|purchase|order|checkout|check out|delete|remove|destroy|publish|post|transfer|confirm|sign|approve|merge|deploy|unsubscribe|cancel subscription|upload)\b/i;

/** Pages Chrome doesn't let extensions touch, plus blank pages, need no permission. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    if (u.protocol === "file:") return "file://";
    return null;
  } catch {
    return null;
  }
}

export async function checkSite(session: string, client: string, url: string | undefined): Promise<string | null> {
  const origin = originOf(url);
  if (!origin) return null;
  const rule = (await getSites())[origin];
  // A site the user blocked stays blocked, even in YOLO mode.
  if (rule === "block") return `The user blocked TabBridge on ${origin}. Don't try this site again.`;
  if (rule === "allow" || allowedOnce.get(session)?.has(origin)) return null;
  const settings = await getSettings();
  if (!settings.askNewSites || settings.yolo) return null;

  const answer = await ask({ kind: "site", client, origin, detail: url ?? origin });
  if (answer === "always") { await setSite(origin, "allow"); return null; }
  if (answer === "once" || answer === "allow") {
    allowedOnce.set(session, (allowedOnce.get(session) ?? new Set()).add(origin));
    return null;
  }
  if (answer === "block") await setSite(origin, "block");
  return `The user did not allow ${client} to use ${origin}. Don't retry it.`;
}

export async function checkRisky(client: string, tab: chrome.tabs.Tab, what: string): Promise<string | null> {
  const settings = await getSettings();
  if (!RISKY.test(what) || !settings.confirmRisky || settings.yolo) return null;
  const answer = await ask({ kind: "action", client, origin: originOf(tab.url) ?? tab.url ?? "", detail: what }, tab);
  return answer === "allow" ? null : `The user did not allow this: ${what}. Don't retry it another way.`;
}

export function endSession(session: string): void {
  allowedOnce.delete(session);
}

let onChange: () => void = () => {};
/** The service worker redraws the badge when questions come and go. */
export function onApprovalsChanged(fn: () => void): void {
  onChange = fn;
}
export function pendingCount(): number {
  return pending.size;
}

async function publishApprovals(): Promise<void> {
  await chrome.storage.session.set({ approvals: [...pending.values()].map((e) => e.approval) });
  onChange();
}

/** Opens the pane next to the TabBridge icon, unless the pane or side panel already shows the
 *  questions. False when Chrome isn't the focused app: the pane opens when it is. */
// The window to ask in: the one holding the tab the question is about.
let askWindow: number | undefined;
let openedAt = 0;

async function showPane(recheck = true): Promise<boolean> {
  const open = await chrome.runtime.getContexts?.({
    contextTypes: ["POPUP", "SIDE_PANEL"] as chrome.runtime.ContextType[],
  }).catch(() => []);
  if (open?.length) {
    // The open pane may be the one closing itself after the last answer: look again shortly,
    // so a question that arrives right then still gets a pane.
    if (recheck) setTimeout(() => { if (pending.size) void showPane(false); }, 600);
    return true;
  }
  try {
    // The pane opens in a window that has focus: bring the agent's window forward first.
    if (askWindow !== undefined) await chrome.windows.update(askWindow, { focused: true }).catch(() => {});
    openedAt = Date.now();
    await chrome.action.openPopup(askWindow !== undefined ? { windowId: askWindow } : undefined);
    return true;
  } catch {
    return false;
  }
}

async function ask(request: Omit<Approval, "id" | "expiresAt">, tab?: chrome.tabs.Tab): Promise<Answer> {
  const id = crypto.randomUUID();
  if (tab?.windowId !== undefined) askWindow = tab.windowId;
  // The question is about this tab: show it, so the user sees what they're answering.
  if (tab?.id !== undefined && !tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const approval: Approval = { ...request, id, expiresAt: Date.now() + WAIT_MS };
  return new Promise<Answer>(async (resolve) => {
    let finished = false;
    const done = (answer: Answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(id);
      chrome.notifications.clear(`approval-${id}`).catch(() => {});
      void publishApprovals();
      resolve(answer);
    };
    // No answer in time is a no, but a timed-out site question doesn't block the site for good.
    const timer = setTimeout(() => done("deny"), WAIT_MS);
    pending.set(id, { approval, done });
    await publishApprovals();
    // The notification is only for when the pane couldn't open: Chrome isn't in front.
    if (!(await showPane()) && (await getSettings()).notify) {
      chrome.notifications.create(`approval-${id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "TabBridge needs your answer",
        message: request.kind === "site" ? `${request.client} wants to use ${request.origin}.` : `${request.client} wants to: ${request.detail}`,
        requireInteraction: false,
      });
    }
  });
}

/** YOLO mode: stop asking, and allow what is already waiting. */
export async function setYolo(on: boolean): Promise<void> {
  await setSettings({ yolo: on });
  if (on) for (const entry of [...pending.values()]) entry.done(entry.approval.kind === "site" ? "once" : "allow");
}

// Back in Chrome with a question waiting: open the pane there.
// Opening the pane itself moves focus for a moment, so ignore focus changes right after it.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE && pending.size && Date.now() - openedAt > 1500) void showPane();
});
// The desktop notification brings Chrome to the front, which opens the pane.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith("approval-")) return;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (win?.id !== undefined) await chrome.windows.update(win.id, { focused: true });
  await showPane();
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "approval_answer") {
    pending.get(message.id)?.done(message.answer);
    reply(true);
  } else if (message?.type === "set_yolo") {
    setYolo(!!message.on).then(() => reply(true));
    return true;
  }
});
