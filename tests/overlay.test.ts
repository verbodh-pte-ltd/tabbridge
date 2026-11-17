// The controlled-tab overlay: on while an agent works, off after an idle time. A fake clock drives it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOverlayState } from "../extension/src/overlay-state.ts";

function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
  };
}

function make(idleMs = 3000) {
  const c = clock();
  const changes: boolean[] = [];
  const state = createOverlayState({ idleMs, onChange: (v) => changes.push(v), setTimer: c.setTimer, clearTimer: c.clearTimer });
  return { c, changes, state };
}

test("a call turns the edge on, and it goes off 3 seconds after the last call", () => {
  const { c, changes, state } = make();
  state.touch();
  assert.equal(state.visible, true);
  c.advance(2900);
  assert.equal(state.visible, true);
  c.advance(200);
  assert.equal(state.visible, false);
  assert.deepEqual(changes, [true, false]);
});

test("each call restarts the idle time", () => {
  const { c, state } = make();
  state.touch();
  c.advance(2500);
  state.touch();
  c.advance(2500);
  assert.equal(state.visible, true);
  c.advance(600);
  assert.equal(state.visible, false);
});

test("stop turns it off at once and cancels the timer", () => {
  const { c, changes, state } = make();
  state.touch();
  state.stop();
  assert.equal(state.visible, false);
  c.advance(10_000);
  assert.deepEqual(changes, [true, false]);
});

test("two overlapping hides keep it hidden until both end, and a call during a hide does not show it", () => {
  const { state } = make();
  state.touch();
  state.suspend();
  state.suspend();
  assert.equal(state.visible, false);
  state.touch();
  assert.equal(state.visible, false);
  state.resume();
  assert.equal(state.visible, false);
  state.resume();
  assert.equal(state.visible, true);
});

test("a resume with no hide does nothing", () => {
  const { state } = make();
  state.resume();
  state.touch();
  assert.equal(state.visible, true);
});
