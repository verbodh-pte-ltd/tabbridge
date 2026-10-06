// The two questions TabBridge asks the user: "may this agent use this site?" and
// "may this agent do this risky thing?". Each opens a small approval window.

import { getSettings, getSites, setSite } from "./settings.ts";

export type Answer = "once" | "always" | "block" | "allow" | "deny";

export interface Approval {
  id: string;
  kind: "site" | "action";
  client: string;
  origin: string;
  detail: string;
}

const WAIT_MS = 120_000;
const pending = new Map<string, { approval: Approval; done: (a: Answer) => void; windowId?: number }>();

// Sites allowed "once" last for the agent's session only.
const allowedOnce = new Map<string, Set<string>>();

export const RISKY = /\b(send|submit|buy|pay|purchase|order|checkout|check out|delete|remove|destroy|publish|post|transfer|confirm|sign|approve|merge|deploy|unsubscribe|cancel subscription)\b/i;

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
  if (rule === "block") return `The user blocked TabBridge on ${origin}. Don't try this site again.`;
  if (rule === "allow" || allowedOnce.get(session)?.has(origin)) return null;
  if (!(await getSettings()).askNewSites) return null;

  const answer = await ask({ kind: "site", client, origin, detail: url ?? origin });
  if (answer === "always") { await setSite(origin, "allow"); return null; }
  if (answer === "once") {
    allowedOnce.set(session, (allowedOnce.get(session) ?? new Set()).add(origin));
    return null;
  }
  if (answer === "block") await setSite(origin, "block");
  return `The user did not allow ${client} to use ${origin}. Don't retry it.`;
}

export async function checkRisky(client: string, url: string | undefined, what: string): Promise<string | null> {
  if (!RISKY.test(what) || !(await getSettings()).confirmRisky) return null;
  const answer = await ask({ kind: "action", client, origin: originOf(url) ?? url ?? "", detail: what });
  return answer === "allow" ? null : `The user did not allow this: ${what}. Don't retry it another way.`;
}

export function endSession(session: string): void {
  allowedOnce.delete(session);
}

async function ask(request: Omit<Approval, "id">): Promise<Answer> {
  const id = crypto.randomUUID();
  const approval = { ...request, id };
  return new Promise<Answer>(async (resolve) => {
    const deny: Answer = request.kind === "site" ? "block" : "deny";
    let finished = false;
    const done = (answer: Answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const entry = pending.get(id);
      pending.delete(id);
      if (entry?.windowId !== undefined) chrome.windows.remove(entry.windowId).catch(() => {});
      chrome.notifications.clear(`approval-${id}`).catch(() => {});
      resolve(answer);
    };
    // No answer in time is a no, but a timed-out site question doesn't block the site for good.
    const timer = setTimeout(() => done(request.kind === "site" ? ("deny" as Answer) : deny), WAIT_MS);
    pending.set(id, { approval, done });
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approve.html?id=${id}`),
      type: "popup",
      width: 440,
      height: 340,
      focused: true,
    });
    const entry = pending.get(id);
    if (entry) entry.windowId = win?.id;
    if ((await getSettings()).notify) {
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

chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of pending.values()) {
    if (entry.windowId === windowId) entry.done(entry.approval.kind === "site" ? ("deny" as Answer) : "deny");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "approval_get") {
    reply(pending.get(message.id)?.approval ?? null);
  } else if (message?.type === "approval_answer") {
    pending.get(message.id)?.done(message.answer);
    reply(true);
  }
});
