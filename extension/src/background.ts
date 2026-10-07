// The service worker: keeps the native connection to the TabBridge host open and runs tool calls.
// An open native messaging port also keeps this worker alive.

import { HOST_NAME, PROTOCOL_VERSION, type HostToExtension } from "../../bridge/src/shared/protocol.ts";
import { setUpMenus } from "./capture.ts";
import { startStep } from "./activity.ts";
import { endSession, onApprovalsChanged, pendingCount } from "./permissions.ts";
import { allSessions, closeSession, getSession, groupTabs, openSession, setConnected } from "./sessions.ts";
import { browserLabel, type Status } from "./settings.ts";
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
  // The number of questions waiting for an answer, in orange; else ✓ while connected, ! when not.
  // The tooltip says the same in words.
  const asking = pendingCount();
  await chrome.action.setBadgeText({ text: asking ? String(asking) : status.connected ? "✓" : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: asking ? "#c2410c" : status.connected ? "#2f6f4e" : "#b3261e" });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  const agents = sessions.length === 1 ? "1 agent working" : `${sessions.length} agents working`;
  await chrome.action.setTitle({ title: asking
    ? `TabBridge: ${asking === 1 ? "a question waits" : `${asking} questions wait`} for your answer · click to see`
    : status.connected ? `TabBridge: connected · ${agents}` : `TabBridge: not connected · ${status.error ?? "open the popup"}` });
  await setConnected(status.connected);
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
  const ready = port;
  // The port may close before the label is ready, as it does at once when the host isn't installed.
  browserLabel().then((label) => port === ready && ready.postMessage({ type: "ready", version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION, label }));
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
    const session = getSession(message.session);
    // The side panel's live console shows each step as it runs.
    const finish = await startStep(session.client, message.tool, message.args ?? {}).catch(() => null);
    const result = await runTool(session, message.tool, message.args);
    port?.postMessage({ type: "result", id: message.id, result });
    const first = result.content.find((c) => c.type === "text");
    const error = result.isError && first?.type === "text" ? first.text : undefined;
    await finish?.(!!result.isError, error).catch(() => {});
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
onApprovalsChanged(() => void publish());
connect();

// Renaming this browser in Settings updates what agents see in the browsers tool.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const label = await browserLabel();
  port?.postMessage({ type: "label", label });
});
