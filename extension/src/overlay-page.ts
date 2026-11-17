// Injected into a tab an agent controls, in the extension's own world: the page's scripts cannot see
// its globals. It draws a light yellow edge on the viewport and a pointer, inside a closed shadow root.
// Everything is built with createElement and style properties, never markup, so a page's content
// security policy cannot block it. Nothing in it takes a click, and it reads nothing from the page.

import { createOverlayState } from "./overlay-state.ts";

const YELLOW = "#F5E27A";
const INK = "#1b211d";
const IDLE_MS = 3000;
const MOVE_MS = 250;
const SVG = "http://www.w3.org/2000/svg";

type Style = Record<string, string>;
const apply = (el: HTMLElement | SVGElement, style: Style) => {
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v, "important");
};

function install(): void {
  const g = globalThis as any;
  if (g.__tbOverlay) return;

  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let host: HTMLElement | undefined;
  let edge: HTMLElement | undefined;
  let pointer: SVGElement | undefined;
  let ring: HTMLElement | undefined;
  let moved = false;

  function build(): void {
    host = document.createElement("tabbridge-overlay");
    // A popover sits in the top layer: a transform on the page's root cannot move it, and it can stay above a full-screen element.
    host.setAttribute("popover", "manual");
    apply(host, { all: "initial", position: "fixed", inset: "0", width: "100vw", height: "100vh", margin: "0", padding: "0", border: "0",
      background: "transparent", overflow: "visible", "max-width": "none", "max-height": "none",
      "z-index": "2147483647", "pointer-events": "none", display: "none", contain: "layout style" });
    const root = host.attachShadow({ mode: "closed" });

    edge = document.createElement("div");
    apply(edge, { position: "fixed", inset: "0", "pointer-events": "none", "box-sizing": "border-box",
      "box-shadow": `inset 0 0 0 3px ${YELLOW}, inset 0 0 16px rgba(245, 226, 122, 0.4)` });

    pointer = document.createElementNS(SVG, "svg");
    pointer.setAttribute("width", "22");
    pointer.setAttribute("height", "26");
    pointer.setAttribute("viewBox", "0 0 22 26");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.7 15 L18 15 Z");
    path.setAttribute("fill", YELLOW);
    path.setAttribute("stroke", INK);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    pointer.append(path);
    apply(pointer, { position: "fixed", left: "0", top: "0", "pointer-events": "none", display: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))" });

    ring = document.createElement("div");
    apply(ring, { position: "fixed", left: "0", top: "0", width: "28px", height: "28px", "margin-left": "-14px", "margin-top": "-14px",
      "border-radius": "50%", border: `3px solid ${YELLOW}`, "box-sizing": "border-box", "pointer-events": "none", opacity: "0" });

    root.append(edge, pointer, ring);
  }

  /** The page may have removed the host: put it back, and bring it to the top of the top layer again. */
  function ensure(): void {
    if (!host) build();
    if (!host!.isConnected) (document.documentElement ?? document).append(host!);
    try { host!.hidePopover?.(); } catch { /* not showing */ }
    try { host!.showPopover?.(); } catch { /* an old Chrome keeps the fixed position */ }
  }

  const state = createOverlayState({
    idleMs: IDLE_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as number),
    onChange: (visible) => {
      if (visible) ensure();
      if (host) host.style.setProperty("display", visible ? "block" : "none", "important");
    },
  });

  g.__tbOverlay = {
    touch(): void {
      state.touch();
      if (state.visible) ensure(); // the page may have removed the host
    },
    point(x: number, y: number, kind: string): void {
      state.touch();
      ensure();
      if (!pointer || !ring) return;
      pointer.style.setProperty("display", "block", "important");
      const move = reduced() || !moved ? "none" : `transform ${MOVE_MS}ms ease-out`;
      pointer.style.setProperty("transition", move, "important");
      pointer.style.setProperty("transform", `translate(${x - 2}px, ${y - 2}px)`, "important");
      ring.style.setProperty("transform", `translate(${x}px, ${y}px)`, "important");
      moved = true;
      if (kind === "click" && !reduced()) {
        ring.animate([{ opacity: 1, scale: "0.4" }, { opacity: 0, scale: "1.6" }], { duration: 450, easing: "ease-out", delay: MOVE_MS });
      }
    },
    /** Hide for a screenshot. Resolves once the page had time to draw without the overlay. */
    suspend(): Promise<void> {
      state.suspend();
      return new Promise((resolve) => setTimeout(resolve, 40));
    },
    resume(): void {
      state.resume();
    },
    stop(): void {
      state.stop();
    },
    /** What is on the page now, for the live test. Read-only, and reachable only from the extension's world. */
    report() {
      const tip = pointer && moved ? pointer.getBoundingClientRect() : null;
      return {
        visible: state.visible,
        attached: !!host?.isConnected,
        edgeWidth: edge ? Math.round(edge.getBoundingClientRect().width) : 0,
        pointer: tip ? { x: Math.round(tip.left) + 2, y: Math.round(tip.top) + 2 } : null,
      };
    },
  };
}

install();
