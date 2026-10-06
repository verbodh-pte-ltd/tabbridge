// The service worker: keeps the native connection to the TabBridge host open and runs tool calls.
// An open native messaging port also keeps this worker alive.

import { HOST_NAME, PROTOCOL_VERSION, type HostToExtension } from "../../bridge/src/shared/protocol.ts";
import { setUpMenus } from "./capture.ts";
import { endSession } from "./permissions.ts";
import { allSessions, closeSession, getSession, groupTabs, openSession } from "./sessions.ts";
import type { Status } from "./settings.ts";
import { runTool } from "./tools.ts";

let port: chrome.runtime.Port | null = null;
let retryMs = 1000;
let status: Status = { connected: false, sessions: [] };

async function publish(patch: Partial<Status> = {}): Promise<void> {
  const sessions = await Promise.all(allSessions().map(async (s) => ({
    session: s.session, client: s.client, tabs: (await groupTabs(s)).length,
  })));
  status = { ...status, ...patch, sessions };
  await chrome.storage.session.set({ status });
  await chrome.action.setBadgeText({ text: status.connected ? (sessions.length ? String(sessions.length) : "") : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: status.connected ? "#2f6f4e" : "#b3261e" });
}

function connect(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err: any) {
    scheduleRetry(err?.message);
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message;
    port = null;
    for (const s of allSessions()) { closeSession(s.session); endSession(s.session); }
    scheduleRetry(why);
  });
  port.postMessage({ type: "ready", version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION });
  retryMs = 1000;
  publish({ connected: true, error: undefined });
}

function scheduleRetry(why?: string): void {
  const error = why && /not found|not registered|Specified native messaging host/i.test(why)
    ? "The TabBridge host isn't installed. Run: npx tabbridge install"
    : why;
  publish({ connected: false, error });
  setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 30_000);
}

async function onMessage(message: HostToExtension): Promise<void> {
  if (message.type === "session_open") {
    openSession(message.session, message.client);
    publish();
  } else if (message.type === "session_close") {
    closeSession(message.session);
    endSession(message.session);
    publish();
  } else if (message.type === "call") {
    const result = await runTool(getSession(message.session), message.tool, message.args);
    port?.postMessage({ type: "result", id: message.id, result });
    publish();
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { setUpMenus(); connect(); });
chrome.runtime.onStartup.addListener(setUpMenus);
// If Chrome ever stops the worker, the alarm brings it back and reconnects.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "reconnect") { retryMs = 1000; connect(); reply(true); }
});
connect();
