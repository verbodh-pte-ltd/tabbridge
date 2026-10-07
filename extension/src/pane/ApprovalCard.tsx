// One question TabBridge is waiting on: "may this agent use this site?" or "may it do this risky
// thing?". A flat section (no card, no boxed alert): the pane, the side panel and the fallback
// window all show it the same way.
import { Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Answer, Approval } from "../permissions.ts";
import { Button } from "../ui/button.tsx";

function useSecondsLeft(expiresAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Props {
  approval: Approval;
  /** "1 of 2" when more than one question waits. */
  position?: string;
  /** Focus the safe button: a stray Enter must never approve a risky action. */
  autoFocus?: boolean;
  onAnswer: (answer: Answer) => void;
  /** "Allow, and stop asking": switches YOLO mode on, which allows this and what else waits. */
  onYolo?: () => void;
}

export function ApprovalCard({ approval, position, autoFocus, onAnswer, onYolo }: Props) {
  const left = useSecondsLeft(approval.expiresAt);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) safe.current?.focus();
  }, [autoFocus]);

  const site = approval.kind === "site";
  return (
    <section data-approval={approval.id} className="grid gap-3 border-l-2 border-l-primary px-4 py-3">
      <div className="grid gap-0.5">
        <div className="flex items-start gap-2">
          {site ? <Globe className="mt-0.5 size-4 shrink-0 text-primary" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />}
          <h2 className="m-0 flex-1 text-[15px] font-semibold leading-snug">
            {site ? `Let ${approval.client} use this site?` : `Let ${approval.client} do this?`}
          </h2>
          {position && <span className="shrink-0 text-xs text-muted-foreground">{position}</span>}
        </div>
        <p className="m-0 pl-6 break-all text-muted-foreground">{approval.origin}</p>
      </div>

      {site ? (
        <p className="m-0 text-muted-foreground">It wants to read and act on this site in its TabBridge tabs, signed in as you.</p>
      ) : (
        <div className="grid gap-1.5">
          <code className="font-mono text-[13px] break-words">{approval.detail}</code>
          <p className="m-0 flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            It looks like it sends, buys, deletes or publishes something.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {site ? (
          <>
            <Button ref={safe} onClick={() => onAnswer("once")}>Allow once</Button>
            <Button variant="outline" onClick={() => onAnswer("always")}>Always allow</Button>
            <Button variant="ghost" className="col-span-2 text-destructive hover:text-destructive" onClick={() => onAnswer("block")}>
              Block this site
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onAnswer("allow")}>Allow</Button>
            <Button ref={safe} variant="outline" onClick={() => onAnswer("deny")}>Don't allow</Button>
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{site ? `No answer in ${clock(left)} means not this time.` : `No answer in ${clock(left)} counts as no.`}</span>
        {onYolo && (
          <button type="button" onClick={onYolo} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-foreground underline-offset-2 hover:underline">
            Allow, and stop asking
          </button>
        )}
      </div>
    </section>
  );
}
