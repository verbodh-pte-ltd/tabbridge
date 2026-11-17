// The state of the overlay on a controlled tab: on while an agent works, off after an idle time.
// Pure, so a test can drive it with a fake clock. The page script (overlay-page.ts) runs it with real timers.

export interface OverlayState {
  /** The agent used the tab: show, and restart the idle time. */
  touch(): void;
  /** Hide for a moment, for a screenshot. Calls nest. */
  suspend(): void;
  resume(): void;
  /** Off at once. */
  stop(): void;
  readonly visible: boolean;
}

interface Options {
  idleMs: number;
  onChange: (visible: boolean) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

export function createOverlayState(opts: Options): OverlayState {
  let active = false;
  let suspended = 0;
  let timer: unknown;
  let shown = false;

  const update = () => {
    const next = active && suspended === 0;
    if (next === shown) return;
    shown = next;
    opts.onChange(next);
  };
  const clear = () => {
    if (timer !== undefined) opts.clearTimer(timer);
    timer = undefined;
  };

  return {
    touch() {
      active = true;
      clear();
      timer = opts.setTimer(() => { timer = undefined; active = false; update(); }, opts.idleMs);
      update();
    },
    suspend() { suspended++; update(); },
    resume() { suspended = Math.max(0, suspended - 1); update(); },
    stop() { clear(); active = false; suspended = 0; update(); },
    get visible() { return shown; },
  };
}
