// One session per connected agent.
// By default every agent works in one shared "TabBridge" tab group (Settings can give each agent
// its own group). Either way an agent may only use the tabs it opened, plus any tab the user
// drags into the group; it can't use another agent's tabs.

import { whenTabsEditable } from "./retry.ts";
import * as agentWindow from "./agent-window.ts";
import { getSettings } from "./settings.ts";

export interface Session {
  session: string;
  client: string;
  groupId?: number;      // own group, when groups are per agent
  activeTab?: number;
  tabs: Set<number>;     // tabs this agent opened
}

const sessions = new Map<string, Session>();
let sharedGroupId: number | undefined;
// Chrome offers 9 fixed group colours. Orange is the closest to VerBodh's warm sunrise gold.
export const BRAND_COLOR: `${chrome.tabGroups.Color}` = "orange";
const COLORS: `${chrome.tabGroups.Color}`[] = ["orange", "blue", "purple", "cyan", "green", "pink", "yellow", "red"];
const CHECK = " ✓";
let connected = false;

/** "TabBridge ✓" while the bridge is connected; the plain name when it isn't. */
export function groupTitle(name: string): string {
  return connected ? name + CHECK : name;
}

/** Marks every TabBridge tab group as connected or not. Called when the native connection opens or drops. */
export async function setConnected(on: boolean): Promise<void> {
  connected = on;
  for (const g of await chrome.tabGroups.query({})) {
    const base = (g.title ?? "").replace(/ ✓$/, "");
    if (base === "TabBridge" || base.startsWith("TabBridge · ")) {
      await whenTabsEditable(() => chrome.tabGroups.update(g.id, { title: groupTitle(base) })).catch(() => {});
    }
  }
}

export function openSession(session: string, client: string): Session {
  const s = sessions.get(session) ?? { session, client, tabs: new Set<number>() };
  s.client = client;
  sessions.set(session, s);
  return s;
}

export function getSession(session: string): Session {
  return sessions.get(session) ?? openSession(session, "agent");
}

export function closeSession(session: string): Session | undefined {
  const s = sessions.get(session);
  sessions.delete(session);
  return s;
}

export function allSessions(): Session[] {
  return [...sessions.values()];
}

async function liveGroup(id: number | undefined): Promise<number | undefined> {
  if (id === undefined) return undefined;
  try {
    await chrome.tabGroups.get(id);
    return id;
  } catch {
    return undefined; // the user ungrouped or closed every tab in it
  }
}

async function groupFor(s: Session): Promise<number | undefined> {
  if ((await getSettings()).sharedGroup) return (sharedGroupId = await liveGroup(sharedGroupId));
  return (s.groupId = await liveGroup(s.groupId));
}

function ownedByOther(s: Session, tabId: number): boolean {
  return allSessions().some((o) => o !== s && o.tabs.has(tabId));
}

/** The tabs this agent may use. */
export async function groupTabs(s: Session): Promise<chrome.tabs.Tab[]> {
  const group = await groupFor(s);
  if (group === undefined) {
    s.tabs.clear();
    return [];
  }
  const tabs = (await chrome.tabs.query({ groupId: group })).filter((t) => !ownedByOther(s, t.id!));
  const live = new Set(tabs.map((t) => t.id!));
  for (const id of s.tabs) if (!live.has(id)) s.tabs.delete(id);
  return tabs;
}

// Two agents opening their first tab together would each create the shared group, and one group would be lost.
let grouping: Promise<unknown> = Promise.resolve();

export function addToGroup(s: Session, tabId: number): Promise<void> {
  const run = grouping.then(() => addToGroupNow(s, tabId));
  grouping = run.catch(() => {});
  return run;
}

async function addToGroupNow(s: Session, tabId: number): Promise<void> {
  s.tabs.add(tabId);
  const settings = await getSettings();
  const shared = settings.sharedGroup;
  const tab = await chrome.tabs.get(tabId);
  let existing = await groupFor(s);
  // A group in another window (the agent window setting changed) would pull this tab out of its window.
  if (existing !== undefined && (await chrome.tabGroups.get(existing)).windowId !== tab.windowId) existing = undefined;
  if (existing !== undefined) {
    await whenTabsEditable(() => chrome.tabs.group({ groupId: existing, tabIds: [tabId] }));
    return;
  }
  const id = await whenTabsEditable(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
  if (shared) {
    sharedGroupId = id;
    await whenTabsEditable(() => chrome.tabGroups.update(id, { title: groupTitle("TabBridge"), color: BRAND_COLOR, collapsed: false }));
  } else {
    s.groupId = id;
    const color = COLORS[allSessions().indexOf(s) % COLORS.length] ?? "blue";
    await whenTabsEditable(() => chrome.tabGroups.update(id, { title: groupTitle(`TabBridge · ${s.client}`), color, collapsed: false }));
  }
}

/** The tab a call acts on: the one asked for, or the last selected. */
export async function resolveTab(s: Session, tabId?: number): Promise<chrome.tabs.Tab> {
  const tabs = await groupTabs(s);
  if (!tabs.length) throw new Error("This agent has no tabs yet. Call navigate with a URL to open one.");
  // With no choice made yet, take the tab used most recently: a one-shot `tabbridge call` then
  // carries on where the previous call left off.
  const recent = [...tabs].sort((x, y) => ((y as any).lastAccessed ?? 0) - ((x as any).lastAccessed ?? 0))[0];
  const want = tabId ?? s.activeTab ?? recent.id;
  const tab = tabs.find((t) => t.id === want);
  if (!tab) {
    if (tabId !== undefined) {
      throw new Error(`Tab ${tabId} isn't one of this agent's TabBridge tabs, or was closed. Call tabs_list.`);
    }
    s.activeTab = recent.id;
    return recent;
  }
  s.activeTab = tab.id;
  return tab;
}

/** A tab the user handed to the agents (right-click "Send to my agent"): into the shared group, owned by no one. */
export async function shareTab(tabId: number): Promise<boolean> {
  if (!(await getSettings()).sharedGroup) return false;
  for (const s of allSessions()) s.tabs.delete(tabId);
  sharedGroupId = await liveGroup(sharedGroupId);
  if (sharedGroupId !== undefined) {
    await whenTabsEditable(() => chrome.tabs.group({ groupId: sharedGroupId, tabIds: [tabId] }));
  } else {
    // With the agent window on, the handed tab moves into it, so the group never pulls agent tabs out.
    const useWindow = (await getSettings()).agentWindow;
    if (useWindow && (await agentWindow.existing()) === undefined) await agentWindow.open(tabId);
    const windowId = useWindow ? await agentWindow.existing() : undefined;
    const created = await whenTabsEditable(() => chrome.tabs.group({ tabIds: [tabId], ...(windowId !== undefined ? { createProperties: { windowId } } : {}) }));
    sharedGroupId = created;
    await whenTabsEditable(() => chrome.tabGroups.update(created, { title: groupTitle("TabBridge"), color: BRAND_COLOR, collapsed: false }));
  }
  return true;
}
