// Chrome's debugger API (the DevTools protocol): input, screenshots, console and network.
// Chrome shows a "TabBridge started debugging this browser" bar while a tab is attached.

const attached = new Set<number>();
const consoleLog = new Map<number, ConsoleEntry[]>();
const networkLog = new Map<number, Map<string, NetworkEntry>>();
const KEEP = 500;

export interface ConsoleEntry { level: string; text: string; url?: string; time: number }
export interface NetworkEntry {
  id: string; method: string; url: string; type?: string; time: number;
  status?: number; statusText?: string; failed?: string; mimeType?: string;
  requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>;
  postData?: string; durationMs?: number; size?: number; protocol?: string; security?: any; fromCache?: boolean;
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err: any) {
    // Already attached by us after a service worker restart: carry on. Anything else is real.
    if (!/already attached/i.test(err?.message ?? "")) throw new Error(debuggerError(err));
  }
  attached.add(tabId);
  await send(tabId, "Runtime.enable");
  await send(tabId, "Log.enable").catch(() => {});
  await send(tabId, "Network.enable").catch(() => {});
  await send(tabId, "Page.enable").catch(() => {});
}

export async function send<T = any>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (!attached.has(tabId)) await attach(tabId);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (err: any) {
    if (/not attached|detached/i.test(err?.message ?? "")) {
      attached.delete(tabId);
      await attach(tabId);
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }
    throw new Error(debuggerError(err));
  }
}

function debuggerError(err: any): string {
  const msg = err?.message ?? String(err);
  if (/another debugger|already attached/i.test(msg)) {
    return "Chrome DevTools or another extension is debugging this tab. Close DevTools on this tab and try again.";
  }
  if (/chrome:\/\/|chrome-extension:|Cannot access/i.test(msg)) {
    return "Chrome doesn't let extensions control this page (chrome:// pages, the Web Store and other extensions' pages).";
  }
  return msg;
}

export function consoleEntries(tabId: number): ConsoleEntry[] {
  return consoleLog.get(tabId) ?? [];
}

export function networkEntries(tabId: number): NetworkEntry[] {
  return [...(networkLog.get(tabId)?.values() ?? [])];
}

export function clearConsole(tabId: number): void { consoleLog.delete(tabId); }
export function clearNetwork(tabId: number): void { networkLog.delete(tabId); }

function pushConsole(tabId: number, entry: ConsoleEntry): void {
  const list = consoleLog.get(tabId) ?? [];
  list.push(entry);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  consoleLog.set(tabId, list);
}

function stringify(arg: any): string {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.unserializableValue ?? arg.type;
}

// One-off waits (drag-and-drop) and screencast receivers (GIF recording), per tab.
const waiters: { tabId: number; method: string; done: (params: any) => void }[] = [];
export const frameSinks = new Map<number, (data: string, timestamp: number) => void>();

/** Resolves with the next event of this kind on the tab, or null after timeoutMs. */
export function nextEvent(tabId: number, method: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const w = { tabId, method, done: (p: any) => { clearTimeout(timer); resolve(p); } };
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(null); }, timeoutMs);
    waiters.push(w);
  });
}

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const now = Date.now();
  const waiting = waiters.findIndex((w) => w.tabId === tabId && w.method === method);
  if (waiting >= 0) waiters.splice(waiting, 1)[0].done(params);
  if (method === "Page.screencastFrame") {
    chrome.debugger.sendCommand({ tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    frameSinks.get(tabId)?.(params.data, (params.metadata?.timestamp ?? now / 1000) * 1000);
    return;
  }
  if (method === "Runtime.consoleAPICalled") {
    pushConsole(tabId, {
      level: params.type === "warning" ? "warn" : params.type,
      text: (params.args ?? []).map(stringify).join(" "),
      url: params.stackTrace?.callFrames?.[0]?.url,
      time: now,
    });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails ?? {};
    pushConsole(tabId, { level: "error", text: d.exception?.description ?? d.text ?? "Uncaught error", url: d.url, time: now });
  } else if (method === "Log.entryAdded") {
    const e = params.entry ?? {};
    pushConsole(tabId, { level: e.level === "warning" ? "warn" : e.level, text: e.text, url: e.url, time: now });
  } else if (method === "Network.requestWillBeSent") {
    const map = networkLog.get(tabId) ?? new Map();
    map.set(params.requestId, {
      id: params.requestId, method: params.request.method, url: params.request.url, type: params.type, time: now,
      requestHeaders: params.request.headers, postData: params.request.postData,
    });
    if (map.size > KEEP) map.delete(map.keys().next().value);
    networkLog.set(tabId, map);
  } else if (method === "Network.responseReceived") {
    const entry = networkLog.get(tabId)?.get(params.requestId);
    if (entry) {
      const r = params.response;
      Object.assign(entry, {
        status: r.status, statusText: r.statusText, mimeType: r.mimeType, responseHeaders: r.headers,
        protocol: r.protocol, security: r.securityDetails, fromCache: r.fromDiskCache || r.fromServiceWorker,
      });
      if (params.type) entry.type = params.type;
    }
  } else if (method === "Network.loadingFinished") {
    const entry = networkLog.get(tabId)?.get(params.requestId);
    if (entry) { entry.durationMs = now - entry.time; entry.size = params.encodedDataLength; }
  } else if (method === "Network.loadingFailed") {
    const entry = networkLog.get(tabId)?.get(params.requestId);
    if (entry) entry.failed = params.errorText;
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  consoleLog.delete(tabId);
  networkLog.delete(tabId);
});
