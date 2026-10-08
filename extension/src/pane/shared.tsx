// Pieces the toolbar pane and the side panel share. Flat sections split by thin lines:
// no card inside a card (owner's call).
import { CircleCheck, CircleX, FastForward, RefreshCw, Settings } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Step } from "../activity.ts";
import type { Answer, Approval } from "../permissions.ts";
import { getSettings, getStatus, type Status } from "../settings.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";

/** Live status, questions and steps, kept in step with storage.session. */
export function useLive(): { status: Status | null; approvals: Approval[]; steps: Step[] } {
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    const load = async () => {
      setStatus(await getStatus());
      const { approvals, activity } = await chrome.storage.session.get(["approvals", "activity"]);
      setApprovals((approvals ?? []) as Approval[]);
      setSteps((activity ?? []) as Step[]);
    };
    load();
    chrome.storage.session.onChanged.addListener(load);
    return () => chrome.storage.session.onChanged.removeListener(load);
  }, []);
  return { status, approvals, steps };
}

/** YOLO mode (ask nothing), kept in step with the settings. */
export function useYolo(): [boolean, (on: boolean) => void] {
  const [yolo, setYoloState] = useState(false);
  useEffect(() => {
    const load = () => getSettings().then((s) => setYoloState(s.yolo));
    load();
    chrome.storage.local.onChanged.addListener(load);
    return () => chrome.storage.local.onChanged.removeListener(load);
  }, []);
  return [yolo, (on) => void chrome.runtime.sendMessage({ type: "set_yolo", on })];
}

export function YoloRow() {
  const [yolo, setYolo] = useYolo();
  return (
    <label className="flex cursor-pointer items-center gap-2.5 border-b px-4 py-2.5 select-none">
      <FastForward className={`size-4 shrink-0 ${yolo ? "text-warning" : "text-muted-foreground"}`} />
      <span className="flex-1">
        <span className="block font-medium">YOLO mode</span>
        <span className="block text-xs text-muted-foreground">{yolo ? "Agents go ahead without asking you." : "Off: you're asked before risky clicks."}</span>
      </span>
      <Switch checked={yolo} onCheckedChange={setYolo} aria-label="YOLO mode" />
    </label>
  );
}

export function answer(id: string, value: Answer): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: "approval_answer", id, answer: value });
}

export function Header({ status, children }: { status: Status | null; children?: ReactNode }) {
  const connected = status?.connected ?? false;
  return (
    <header className="flex items-center gap-2 border-b px-4 py-3">
      <img src="icons/icon32.png" alt="" className="size-5" />
      <h1 className="m-0 text-base font-semibold">TabBridge</h1>
      {status && (
        <Badge variant={connected ? "secondary" : "destructive"} className="ml-auto">
          {connected ? <CircleCheck className="text-primary" /> : <CircleX />}
          {connected ? "Connected" : "Not connected"}
        </Badge>
      )}
      {children}
    </header>
  );
}

export function Questions({ approvals, onAnswered }: { approvals: Approval[]; onAnswered?: () => void }) {
  return (
    <>
      {approvals.map((a, i) => (
        <div key={a.id} className="border-b">
          <ApprovalCard
            approval={a}
            position={approvals.length > 1 ? `${i + 1} of ${approvals.length}` : undefined}
            autoFocus={i === 0}
            onAnswer={(value) => { onAnswered?.(); void answer(a.id, value); }}
            onYolo={() => { onAnswered?.(); void chrome.runtime.sendMessage({ type: "set_yolo", on: true }); }}
          />
        </div>
      ))}
    </>
  );
}

export function NotConnected({ status }: { status: Status | null }) {
  if (!status || status.connected) return null;
  return (
    <section className="grid gap-1 border-b px-4 py-3 text-destructive">
      <p className="m-0 flex items-center gap-2 font-medium"><CircleX className="size-4" /> Can't reach the TabBridge helper</p>
      <p className="m-0 text-muted-foreground">
        {status.error ?? "It isn't running on this computer."} Run <code className="font-mono text-xs">npx @verbodhpteltd/tabbridge install</code>, then Reconnect.
      </p>
    </section>
  );
}

export function Agents({ status }: { status: Status | null }) {
  if (!status) return null;
  return (
    <section className="grid gap-1.5 px-4 py-3">
      <h2 className="m-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">Connected agents</h2>
      {status.sessions.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {status.sessions.map((s) => (
            <li key={s.session} className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{s.client}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{s.tabs} tab{s.tabs === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted-foreground">{status.connected ? "None yet. Agents on this computer can connect." : "None."}</p>
      )}
    </section>
  );
}

export function Actions({ children }: { children?: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 border-t px-4 py-3">
      <Button variant="outline" size="sm" onClick={() => void chrome.runtime.sendMessage({ type: "reconnect" })}>
        <RefreshCw /> Reconnect
      </Button>
      <Button variant="outline" size="sm" onClick={() => chrome.runtime.openOptionsPage()}>
        <Settings /> Settings and sites
      </Button>
      {children}
    </div>
  );
}
