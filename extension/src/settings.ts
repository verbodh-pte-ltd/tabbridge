// Settings and per-site decisions, kept in chrome.storage.local. Shared by every extension page.

export interface Settings {
  askNewSites: boolean;   // ask before an agent acts on a site for the first time
  confirmRisky: boolean;  // ask before a click or Enter that looks like send, buy, delete…
  sharedGroup: boolean;   // every agent works in one "TabBridge" group, instead of one group each
  notify: boolean;        // a desktop notification when TabBridge is waiting for an answer
  showSecrets: boolean;   // let agents read cookie values, auth headers and token-like storage
  browserName: string;    // how agents tell this Chrome apart when several run TabBridge ("" = automatic)
}

export type SiteRule = "allow" | "block";

// Granted by default; the user turns off what they don't want (Settings page).
// Two guards stay on: confirming risky actions, and hiding secret values (cookies, tokens).
export const DEFAULT_SETTINGS: Settings = { askNewSites: false, confirmRisky: true, sharedGroup: true, notify: true, showSecrets: false, browserName: "" };

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
}

export async function getSites(): Promise<Record<string, SiteRule>> {
  const { sites } = await chrome.storage.local.get("sites");
  return (sites ?? {}) as Record<string, SiteRule>;
}

export async function setSite(origin: string, rule: SiteRule | null): Promise<void> {
  const sites = await getSites();
  if (rule) sites[origin] = rule;
  else delete sites[origin];
  await chrome.storage.local.set({ sites });
}

/** The live status the popup shows. Written by the service worker to storage.session. */
export interface Status {
  connected: boolean;
  error?: string;
  sessions: { session: string; client: string; tabs: number }[];
}

export async function getStatus(): Promise<Status> {
  const { status } = await chrome.storage.session.get("status");
  return (status ?? { connected: false, sessions: [] }) as Status;
}

/** "Chrome on Windows", unless the user named this browser in Settings. */
export async function browserLabel(): Promise<string> {
  const { browserName } = await getSettings();
  if (browserName.trim()) return browserName.trim();
  const ua = (navigator as any).userAgentData;
  const brand = ua?.brands?.find((b: any) => /Chrome|Edge|Brave|Opera/.test(b.brand))?.brand?.replace("Google ", "") ?? "Chrome";
  const os = ua?.platform || (/Mac/.test(navigator.userAgent) ? "macOS" : /Win/.test(navigator.userAgent) ? "Windows" : "Linux");
  return `${brand} on ${os}`;
}
