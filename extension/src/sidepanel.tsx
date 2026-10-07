// The side panel: TabBridge's live console, laid out like Claude's side panel (an icon row, a
// quiet empty state, a rounded composer docked at the bottom). Chrome draws the bar above it
// with the extension's name, pin and close. TabBridge has no AI model, so this isn't a chat:
// it shows each step your agents take in this browser, asks its questions here while it's
// open, and sends your notes (and the page, with +) to your agent, which reads them with
// user_captures. The ⏩ button is YOLO mode: ask nothing.
import { ArrowUp, CircleCheck, CircleX, Eraser, FastForward, FileText, LoaderCircle, Plus, RefreshCw, Settings, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Step } from "./activity.ts";
import { Questions, useLive, useYolo } from "./pane/shared.tsx";
import type { Status } from "./settings.ts";
import { cn } from "./ui/utils.ts";

function IconButton({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn("inline-flex size-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:opacity-40 [&_svg]:size-[18px]", className)}
      {...props}
    />
  );
}

function TopRow({ status, hasSteps }: { status: Status | null; hasSteps: boolean }) {
  const connected = status?.connected ?? false;
  const agents = status?.sessions.map((s) => s.client) ?? [];
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-primary" : "bg-destructive")} />
        <span className="truncate">
          {!status ? "" : !connected ? "Not connected" : agents.length ? agents.join(", ") : "Connected · no agent yet"}
        </span>
      </span>
      <IconButton label="Reconnect" onClick={() => void chrome.runtime.sendMessage({ type: "reconnect" })}><RefreshCw /></IconButton>
      <IconButton label="Clear the activity" disabled={!hasSteps} onClick={() => void chrome.storage.session.set({ activity: [] })}><Eraser /></IconButton>
      <IconButton label="Settings and sites" onClick={() => chrome.runtime.openOptionsPage()}><Settings /></IconButton>
    </div>
  );
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StepRow({ step, showClient }: { step: Step; showClient: boolean }) {
  const Icon = step.state === "running" ? LoaderCircle : step.state === "failed" ? CircleX : CircleCheck;
  const tone = step.state === "running" ? "animate-spin text-muted-foreground" : step.state === "failed" ? "text-destructive" : "text-primary";
  return (
    <li className="flex gap-2.5 px-4 py-1.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-label={step.state} />
      <div className="min-w-0 flex-1">
        <p className="m-0 break-words">{step.summary}</p>
        {step.error && <p className="m-0 text-xs break-words text-destructive">{step.error}</p>}
      </div>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
        {showClient && <>{step.client} · </>}{time(step.time)}
      </span>
    </li>
  );
}

function Empty({ status }: { status: Status | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <img src="icons/icon128.png" alt="" className="size-16 opacity-20 grayscale" />
      <p className="m-0 max-w-60 text-muted-foreground">
        {status && !status.connected
          ? "TabBridge can't reach its helper. Run npx tabbridge install, then Reconnect."
          : "When an agent uses this browser, each step shows here as it happens."}
      </p>
    </div>
  );
}

function Feed({ steps, children }: { steps: Step[]; children?: React.ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [steps.length]);
  const clients = new Set(steps.map((s) => s.client));
  return (
    <>
      <ol className="m-0 list-none py-2 pl-0">
        {steps.map((s) => <StepRow key={s.id} step={s} showClient={clients.size > 1} />)}
      </ol>
      {children}
      <div ref={end} />
    </>
  );
}

function Composer({ status }: { status: Status | null }) {
  const [note, setNote] = useState("");
  const [attach, setAttach] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [yolo, setYolo] = useYolo();
  const box = useRef<HTMLTextAreaElement>(null);
  const agent = status?.sessions.at(-1)?.client;
  const canSend = !sending && (!!note.trim() || attach);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const r = await chrome.runtime.sendMessage({ type: "send_note", note, attachPage: attach })
      .catch((e) => ({ ok: false, error: e?.message }));
    setSending(false);
    if (r?.ok) {
      setNote("");
      setAttach(false);
      setResult({ ok: true, text: `Sent${r.attached ? " with the page" : ""}. Ask your agent to check what you sent from TabBridge.` });
    } else {
      setResult({ ok: false, text: `Not sent: ${r?.error ?? "TabBridge didn't answer."}` });
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3">
      {result && <p className={cn("m-0 px-1 pb-2 text-xs", result.ok ? "text-muted-foreground" : "text-destructive")}>{result.text}</p>}
      <form
        className="grid gap-1 rounded-2xl border bg-card px-3 pt-3 pb-2 shadow-sm focus-within:border-ring/60"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
        onClick={(e) => { if (e.target === e.currentTarget) box.current?.focus(); }}
      >
        {attach && (
          <span className="flex w-fit items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs">
            <FileText className="size-3.5" /> This page
            <button type="button" aria-label="Don't attach the page" onClick={() => setAttach(false)} className="ml-0.5 cursor-pointer border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </span>
        )}
        <textarea
          ref={box}
          value={note}
          rows={1}
          onChange={(e) => { setNote(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Send a note to your agent"
          aria-label="Note to your agent"
          className="field-sizing-content max-h-40 min-h-6 w-full resize-none border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 pt-1">
          <IconButton label={attach ? "The page goes with your note" : "Attach this page"} onClick={() => setAttach(!attach)} className={cn(attach && "text-foreground")}>
            <Plus />
          </IconButton>
          <IconButton
            label={yolo ? "YOLO mode is on: agents don't ask. Click to turn off." : "YOLO mode: let agents go ahead without asking"}
            aria-pressed={yolo}
            onClick={() => setYolo(!yolo)}
            className={cn("size-7 border border-solid", yolo ? "border-warning/50 bg-warning/15 text-warning hover:bg-warning/20 hover:text-warning" : "border-border")}
          >
            <FastForward className="!size-4" />
          </IconButton>
          <span className="ml-auto truncate pr-1 text-xs text-muted-foreground">
            {yolo && <span className="font-medium text-warning">YOLO · </span>}
            {agent ? <>to <span className="font-medium text-foreground">{agent}</span></> : "no agent connected"}
          </span>
          <button
            type="submit"
            aria-label="Send to your agent"
            disabled={!canSend}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-primary text-primary-foreground transition-opacity disabled:cursor-default disabled:bg-muted-foreground/40"
          >
            {sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}

function Console() {
  const { status, approvals, steps } = useLive();
  const busy = steps.length > 0 || approvals.length > 0;
  return (
    <main className="flex h-screen flex-col bg-background">
      <TopRow status={status} hasSteps={steps.length > 0} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {busy ? (
          <Feed steps={steps}>
            {approvals.length > 0 && <div className="border-t"><Questions approvals={approvals} /></div>}
          </Feed>
        ) : (
          <Empty status={status} />
        )}
      </div>
      <Composer status={status} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Console />);
