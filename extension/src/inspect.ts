// What DevTools shows, as tools: Elements, Network details, Application (storage, cookies,
// IndexedDB, cache, service workers, manifest), Performance and Security, plus one-call
// page_report for "something is wrong on this page". Also the right-click captures.
//
// Secret values (cookies, auth headers, token-like storage keys) are hidden unless the user turns
// on "Let agents read secret values" in Settings.

import type { ToolResult } from "../../bridge/src/shared/protocol.ts";
import { textResult } from "../../bridge/src/shared/protocol.ts";
import * as cdp from "./cdp.ts";
import type { Session } from "./sessions.ts";
import { getSettings } from "./settings.ts";
import { agent, page, untrusted, usable } from "./tools.ts";

type Args = Record<string, any>;
type Handler = (s: Session, a: Args) => Promise<ToolResult>;

const SECRET_NAME = /token|secret|auth|session|sess|passw|jwt|apikey|api[-_]?key|bearer|csrf|xsrf|sid\b|cookie|credential|private/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);
const hidden = (value: string) => `(hidden, ${value.length} characters; the user can allow secret values in TabBridge settings)`;

async function showSecrets(): Promise<boolean> {
  return (await getSettings()).showSecrets;
}

function headers(h: Record<string, string> | undefined, secrets: boolean): string {
  if (!h || !Object.keys(h).length) return "  (none captured)";
  return Object.entries(h)
    .map(([k, v]) => `  ${k}: ${!secrets && SECRET_HEADER.test(k) ? hidden(String(v)) : cut(String(v), 300)}`)
    .join("\n");
}

async function evaluate<T = any>(tabId: number, expression: string): Promise<T> {
  const out = await cdp.send(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
  return out.result?.value as T;
}

/** A DevTools handle (objectId) for an element named by ref or CSS selector. */
export async function elementHandle(tabId: number, a: Args): Promise<string> {
  let selector = a.selector ? String(a.selector) : "";
  if (a.ref) {
    const nonce = crypto.randomUUID();
    const ok = await agent<boolean>(tabId, "mark", String(a.ref), nonce);
    if (!ok) throw new Error(`No element ${a.ref} on the page any more. Call read_page or find for fresh refs.`);
    selector = `[data-tabbridge-inspect="${nonce}"]`;
  }
  if (!selector) throw new Error("Give a ref (from read_page or find) or a CSS selector.");
  const out = await cdp.send(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
  if (a.ref) await agent(tabId, "unmark");
  if (!out.result?.objectId) throw new Error(`Nothing matches ${selector}.`);
  return out.result.objectId;
}

async function callOn<T = any>(tabId: number, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
  const out = await cdp.send(tabId, "Runtime.callFunctionOn", {
    objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
  return out.result?.value as T;
}

const STYLE_PROPS = ["display", "position", "visibility", "opacity", "z-index", "pointer-events", "overflow",
  "width", "height", "margin", "padding", "color", "background-color", "font-size", "font-family", "font-weight",
  "border", "transform", "cursor"];

// ── storage pieces, reused by page_report ──────────────────────────────────────────────────────

async function webStorage(tabId: number, kind: "localStorage" | "sessionStorage", secrets: boolean): Promise<string> {
  const entries = await evaluate<[string, string][]>(tabId,
    `(() => { try { return Object.entries(${kind}); } catch (e) { return [["(blocked)", String(e)]]; } })()`);
  if (!entries.length) return "  (empty)";
  return entries.map(([k, v]) => `  ${k} = ${!secrets && SECRET_NAME.test(k) ? hidden(v) : cut(JSON.stringify(v), 300)}`).join("\n");
}

async function cookies(tab: chrome.tabs.Tab, secrets: boolean): Promise<string> {
  const { cookies: list } = await cdp.send(tab.id!, "Network.getCookies", { urls: [tab.url] });
  if (!list.length) return "  (none)";
  return list.map((c: any) => {
    const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite && `SameSite=${c.sameSite}`, c.session ? "session" : `expires ${new Date(c.expires * 1000).toISOString()}`].filter(Boolean).join(", ");
    return `  ${c.name} (${c.domain}${c.path}) ${flags} value=${secrets ? cut(c.value, 200) : hidden(c.value)}`;
  }).join("\n");
}

async function indexedDb(tab: chrome.tabs.Tab): Promise<string> {
  const securityOrigin = new URL(tab.url!).origin;
  const { databaseNames } = await cdp.send(tab.id!, "IndexedDB.requestDatabaseNames", { securityOrigin }).catch(() => ({ databaseNames: [] }));
  if (!databaseNames.length) return "  (none)";
  const lines: string[] = [];
  for (const databaseName of databaseNames.slice(0, 10)) {
    const { databaseWithObjectStores: db } = await cdp.send(tab.id!, "IndexedDB.requestDatabase", { securityOrigin, databaseName });
    lines.push(`  ${db.name} (version ${db.version})`);
    for (const store of db.objectStores.slice(0, 20)) {
      const meta = await cdp.send(tab.id!, "IndexedDB.getMetadata", { securityOrigin, databaseName, objectStoreName: store.name }).catch(() => null);
      lines.push(`    store ${store.name}: ${meta ? `${meta.entriesCount} entries` : "?"}, key ${JSON.stringify(store.keyPath?.string ?? store.keyPath?.array ?? "")}`);
    }
  }
  return lines.join("\n");
}

async function cacheStorage(tab: chrome.tabs.Tab): Promise<string> {
  const securityOrigin = new URL(tab.url!).origin;
  const { caches } = await cdp.send(tab.id!, "CacheStorage.requestCacheNames", { securityOrigin }).catch(() => ({ caches: [] }));
  if (!caches.length) return "  (none)";
  const lines: string[] = [];
  for (const c of caches.slice(0, 10)) {
    const { cacheDataEntries, returnCount } = await cdp.send(tab.id!, "CacheStorage.requestEntries", { cacheId: c.cacheId, skipCount: 0, pageSize: 10 })
      .catch(() => ({ cacheDataEntries: [], returnCount: 0 }));
    lines.push(`  ${c.cacheName}: ${returnCount} entries`);
    for (const e of cacheDataEntries) lines.push(`    ${e.requestURL}`);
  }
  return lines.join("\n");
}

async function serviceWorkers(tabId: number): Promise<string> {
  const regs = await evaluate<any[]>(tabId, `navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(rs => rs.map(r => ({
    scope: r.scope, active: r.active && r.active.scriptURL, state: r.active && r.active.state, waiting: !!r.waiting, installing: !!r.installing }))) : []`);
  if (!regs.length) return "  (none)";
  return regs.map((r) => `  ${r.scope}  script ${r.active ?? "(none active)"} ${r.state ?? ""}${r.waiting ? ", an update is waiting" : ""}${r.installing ? ", installing" : ""}`).join("\n");
}

async function manifest(tabId: number): Promise<string> {
  const m = await cdp.send(tabId, "Page.getAppManifest").catch(() => null);
  if (!m?.url) return "  No manifest detected.";
  const errors = (m.errors ?? []).map((e: any) => `  error: ${e.message}`).join("\n");
  let summary = "";
  try {
    const d = JSON.parse(m.data);
    summary = `  name: ${d.name ?? d.short_name ?? "(none)"}, start_url: ${d.start_url ?? "(none)"}, display: ${d.display ?? "(none)"}, icons: ${(d.icons ?? []).length}`;
  } catch { summary = "  (could not parse the manifest)"; }
  return `  ${m.url}\n${summary}${errors ? `\n${errors}` : ""}`;
}

// ── performance and security, reused by page_report ────────────────────────────────────────────

async function performance(tabId: number): Promise<string> {
  await cdp.send(tabId, "Performance.enable").catch(() => {});
  const { metrics } = await cdp.send(tabId, "Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x: any) => [x.name, x.value]));
  const web = await evaluate<any>(tabId, `new Promise(resolve => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    let lcp = 0, cls = 0;
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
    const res = performance.getEntriesByType("resource");
    setTimeout(() => resolve({
      ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp: fcp && fcp.startTime, lcp, cls,
      resources: res.length, bytes: res.reduce((t, r) => t + (r.transferSize || 0), 0),
      slowest: res.sort((a, b) => b.duration - a.duration).slice(0, 5).map(r => [Math.round(r.duration), r.name]),
    }), 300);
  })`);
  const ms = (v: number | undefined) => (v ? `${Math.round(v)} ms` : "n/a");
  return [
    `  Time to first byte ${ms(web.ttfb)} · First contentful paint ${ms(web.fcp)} · Largest contentful paint ${ms(web.lcp)}`,
    `  Layout shift (CLS) ${web.cls.toFixed(3)} · DOM ready ${ms(web.dcl)} · Load ${ms(web.load)}`,
    `  ${web.resources} resources, ${Math.round(web.bytes / 1024)} KB transferred · ${m.Nodes} DOM nodes · JS heap ${Math.round((m.JSHeapUsedSize ?? 0) / 1048576)} MB`,
    `  Script ${Math.round((m.ScriptDuration ?? 0) * 1000)} ms · Layout ${Math.round((m.LayoutDuration ?? 0) * 1000)} ms · Style ${Math.round((m.RecalcStyleDuration ?? 0) * 1000)} ms`,
    ...(web.slowest.length ? ["  Slowest resources:", ...web.slowest.map(([d, n]: [number, string]) => `    ${d} ms  ${n}`)] : []),
  ].join("\n");
}

const SECURITY_HEADERS = ["content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"];

function security(tab: chrome.tabs.Tab): string {
  const entries = cdp.networkEntries(tab.id!);
  const doc = [...entries].reverse().find((e) => e.type === "Document" && e.url.split("#")[0] === (tab.url ?? "").split("#")[0])
    ?? [...entries].reverse().find((e) => e.type === "Document");
  const lines: string[] = [];
  const https = tab.url?.startsWith("https:");
  lines.push(`  Connection: ${https ? "HTTPS" : tab.url?.startsWith("http:") ? "HTTP, not encrypted" : "not a web page"}`);
  if (!doc) {
    lines.push("  The page's own response wasn't captured (TabBridge attached after it loaded). navigate with url \"reload\", then ask again.");
    return lines.join("\n");
  }
  const sd = doc.security;
  if (sd) {
    lines.push(`  ${sd.protocol} · ${sd.cipher} · certificate for ${sd.subjectName} from ${sd.issuer}`);
    lines.push(`  valid ${new Date(sd.validFrom * 1000).toISOString().slice(0, 10)} to ${new Date(sd.validTo * 1000).toISOString().slice(0, 10)}${sd.validTo * 1000 < Date.now() ? "  ← EXPIRED" : ""}`);
  }
  const h = Object.fromEntries(Object.entries(doc.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of SECURITY_HEADERS) lines.push(`  ${name}: ${h[name] ? cut(String(h[name]), 160) : "missing"}`);
  const mixed = https ? entries.filter((e) => e.url.startsWith("http:")) : [];
  lines.push(`  Mixed content (http:// loaded by an https page): ${mixed.length ? mixed.slice(0, 5).map((e) => e.url).join(", ") : "none seen"}`);
  return lines.join("\n");
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────

export const INSPECT_HANDLERS: Record<string, Handler> = {
  async inspect_element(s, a) {
    const tab = await usable(s, a);
    const objectId = await elementHandle(tab.id!, a);
    const props: string[] = Array.isArray(a.styles) && a.styles.length ? a.styles : STYLE_PROPS;
    const info = await callOn(tab.id!, objectId, `function (props) {
      const cs = getComputedStyle(this), r = this.getBoundingClientRect();
      return {
        tag: this.tagName.toLowerCase(),
        attrs: [...this.attributes].filter(x => x.name !== "data-tabbridge-inspect").map(x => [x.name, x.value]),
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        styles: props.map(p => [p, cs.getPropertyValue(p)]),
        html: this.outerHTML.replace(/ data-tabbridge-inspect="[^"]*"/, ""),
        text: (this.innerText || "").slice(0, 300),
      };
    }`, [props]);
    const { listeners } = await cdp.send(tab.id!, "DOMDebugger.getEventListeners", { objectId }).catch(() => ({ listeners: [] }));
    const types = [...new Set(listeners.map((l: any) => l.type))];
    return page(tab, [
      `<${info.tag}> at x ${info.box.x}, y ${info.box.y}, ${info.box.width}×${info.box.height}`,
      `Attributes:\n${info.attrs.map(([k, v]: string[]) => `  ${k}="${cut(v, 200)}"`).join("\n") || "  (none)"}`,
      `Computed styles:\n${info.styles.map(([k, v]: string[]) => `  ${k}: ${v}`).join("\n")}`,
      `Event listeners on it: ${types.length ? types.join(", ") : "none directly on this element (it may rely on a parent's)"}`,
      `Text: ${info.text || "(none)"}`,
      `HTML:\n${cut(info.html, Number(a.maxHtml) || 4000)}`,
    ].join("\n\n"));
  },

  async network_request(s, a) {
    const tab = await usable(s, a);
    const all = cdp.networkEntries(tab.id!);
    let entry = typeof a.index === "number" ? all[a.index] : undefined;
    if (!entry && a.url) {
      const re = new RegExp(String(a.url), "i");
      entry = [...all].reverse().find((e) => re.test(e.url));
    }
    if (!entry) return textResult("No such request. Call network_requests for the list and its [numbers].", true);
    const secrets = await showSecrets();
    const lines = [
      `${entry.method} ${entry.url}`,
      `Status: ${entry.failed ? `FAILED ${entry.failed}` : `${entry.status ?? "pending"} ${entry.statusText ?? ""}`} · type ${entry.type ?? "?"} · ${entry.mimeType ?? ""}`,
      `Time: ${entry.durationMs ?? "?"} ms · size ${entry.size ?? "?"} bytes · ${entry.protocol ?? ""}${entry.fromCache ? " · from cache" : ""}`,
      `Request headers:\n${headers(entry.requestHeaders, secrets)}`,
      `Response headers:\n${headers(entry.responseHeaders, secrets)}`,
    ];
    if (entry.postData) lines.push(`Request body:\n${cut(entry.postData, 5000)}`);
    if (a.body !== false && entry.status) {
      const body = await cdp.send(tab.id!, "Network.getResponseBody", { requestId: entry.id }).catch(() => null);
      if (!body) lines.push("Response body: not available (Chrome drops it after a navigation, or it was a redirect).");
      else lines.push(body.base64Encoded ? `Response body: binary, ${body.body.length} base64 characters` : `Response body:\n${cut(body.body, Number(a.maxBody) || 20_000)}`);
    }
    return page(tab, lines.join("\n"));
  },

  async storage(s, a) {
    const tab = await usable(s, a);
    const kind = String(a.kind ?? "all");
    const secrets = await showSecrets();
    const parts: [string, () => Promise<string>][] = [
      ["Local storage", () => webStorage(tab.id!, "localStorage", secrets)],
      ["Session storage", () => webStorage(tab.id!, "sessionStorage", secrets)],
      ["Cookies", () => cookies(tab, secrets)],
      ["IndexedDB", () => indexedDb(tab)],
      ["Cache storage", () => cacheStorage(tab)],
      ["Service workers", () => serviceWorkers(tab.id!)],
      ["Manifest", () => manifest(tab.id!)],
      ["Storage used", async () => {
        const e = await evaluate<any>(tab.id!, "navigator.storage && navigator.storage.estimate()");
        return e ? `  ${Math.round(e.usage / 1024)} KB of ${Math.round(e.quota / 1048576)} MB` : "  (unknown)";
      }],
    ];
    const keyOf: Record<string, string> = {
      local: "Local storage", session: "Session storage", cookies: "Cookies", indexeddb: "IndexedDB",
      cache: "Cache storage", service_workers: "Service workers", manifest: "Manifest",
    };
    const chosen = kind === "all" ? parts : parts.filter(([name]) => name === keyOf[kind]);
    if (!chosen.length) return textResult(`kind must be one of: all, ${Object.keys(keyOf).join(", ")}`, true);
    const out: string[] = [];
    for (const [name, fn] of chosen) out.push(`${name}:\n${await fn().catch((e) => `  (could not read: ${e.message})`)}`);
    return page(tab, out.join("\n\n"));
  },

  async performance(s, a) {
    const tab = await usable(s, a);
    return page(tab, `Performance:\n${await performance(tab.id!)}`);
  },

  async security(s, a) {
    const tab = await usable(s, a);
    return page(tab, `Security:\n${security(tab)}`);
  },

  async page_report(s, a) {
    const tab = await usable(s, a);
    return page(tab, await report(tab));
  },

  async user_captures(_s, a) {
    const { captures = [] } = await chrome.storage.session.get("captures") as { captures?: Capture[] };
    if (a.clear !== false) await chrome.storage.session.set({ captures: [] });
    if (!captures.length) {
      return textResult("Nothing sent yet. The user can right-click a page or an element and choose \"Send to my agent (TabBridge)\".");
    }
    return textResult(captures.map((c, i) => untrusted(c.url, [
      `Capture ${i + 1}, ${new Date(c.time).toLocaleString()}: ${c.what} in tab ${c.tabId}${c.shared ? " (now in the TabBridge group, so you can use it)" : ""}`,
      c.element ? `Element: ${c.element}` : "",
      c.report,
    ].filter(Boolean).join("\n"))).join("\n\n"));
  },
};

/** Everything an agent usually needs to start on a broken page, in one call. */
export async function report(tab: chrome.tabs.Tab): Promise<string> {
  const id = tab.id!;
  await cdp.attach(id);
  const errors = cdp.consoleEntries(id).filter((e) => e.level === "error" || e.level === "warn").slice(-20);
  const failed = cdp.networkEntries(id).filter((e) => e.failed || (e.status ?? 0) >= 400).slice(-20);
  const counts = await evaluate<any>(id, `(() => { const n = (s) => { try { return Object.keys(s).length; } catch { return "?"; } };
    return { local: n(localStorage), session: n(sessionStorage), forms: document.forms.length, frames: frames.length }; })()`).catch(() => null);
  const sections = [
    `Page: ${tab.title ?? ""} — ${tab.url ?? ""}`,
    `Console errors and warnings (${errors.length}):\n${errors.map((e) => `  [${e.level}] ${cut(e.text, 400)}${e.url ? `  (${e.url})` : ""}`).join("\n") || "  none seen"}`,
    `Failed requests (${failed.length}):\n${failed.map((e) => `  [${cdp.networkEntries(id).indexOf(e)}] ${e.method} ${e.failed ? `FAILED ${e.failed}` : e.status} ${e.url}`).join("\n") || "  none seen"}`,
    `Performance:\n${await performance(id).catch((e) => `  (could not read: ${e.message})`)}`,
    `Security:\n${security(tab)}`,
    counts ? `Storage: ${counts.local} local storage keys, ${counts.session} session storage keys · ${counts.forms} forms · ${counts.frames} frames` : "",
    "TabBridge only sees console messages and requests from after it attached to the tab. If these look empty, reload the page and ask again.",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export interface Capture {
  time: number;
  tabId: number;
  url: string;
  what: string;
  element?: string;
  report: string;
  shared: boolean;
}

