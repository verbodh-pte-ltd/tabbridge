// Injected into a page (isolated world, so the page's own scripts can't see it).
// Gives elements short refs (e1, e2…) the agent can point at, and reads labels and text.

interface Info {
  ok: boolean;
  error?: string;
  x?: number;
  y?: number;
  tag?: string;
  role?: string;
  label?: string;
  inForm?: boolean;
  submitLabel?: string;
  editable?: boolean;
  covered?: boolean;
}

(() => {
  const g = globalThis as any;
  if (g.__tabbridge) return;

  const refs = new Map<string, WeakRef<Element>>();
  const known = new WeakMap<Element, string>();
  let next = 1;

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "gridcell",
  ]);

  function refOf(el: Element): string {
    let ref = known.get(el);
    if (!ref || refs.get(ref)?.deref() !== el) {
      ref = `e${next++}`;
      known.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function byRef(ref: string): Element | null {
    const el = refs.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  }

  function role(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return "";
  }

  function clean(text: string | null | undefined, max = 80): string {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function label(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.trim()) return clean(text);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const lbl = el.labels?.[0]?.textContent;
      if (lbl?.trim()) return clean(lbl);
      if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
      const ph = el.getAttribute("placeholder");
      if (ph) return clean(ph);
    }
    if (el instanceof HTMLImageElement) return clean(el.alt);
    const text = (el as HTMLElement).innerText ?? el.textContent;
    if (text?.trim()) return clean(text);
    return clean(el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  }

  function visible(el: Element): boolean {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function describe(el: Element, r: string): string {
    const parts = [`[${refOf(el)}] ${r}`];
    if (r === "heading") parts[0] += `(${el.tagName[1]})`;
    const name = label(el);
    if (name) parts.push(JSON.stringify(name));
    if (el instanceof HTMLAnchorElement && el.getAttribute("href")) parts.push(`→ ${clean(el.getAttribute("href"), 100)}`);
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") parts.push(el.checked ? "checked" : "unchecked");
      else if (el.type !== "password" && el.value) parts.push(`value=${JSON.stringify(clean(el.value, 60))}`);
      else if (el.type === "password" && el.value) parts.push("value=(hidden)");
    }
    if (el instanceof HTMLTextAreaElement && el.value) parts.push(`value=${JSON.stringify(clean(el.value, 60))}`);
    if (el instanceof HTMLSelectElement) parts.push(`selected=${JSON.stringify(clean(el.selectedOptions[0]?.text ?? "", 60))}`);
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    return parts.join(" ");
  }

  function* walk(root: Element | ShadowRoot): Generator<Element> {
    const kids = root instanceof Element ? root.children : root.children;
    for (const el of Array.from(kids)) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
      yield* walk(el);
    }
  }

  function readPage(filter: string, scope: string | undefined, max: number): string {
    const root = scope ? byRef(scope) : document.body;
    if (!root) return `No element ${scope} on the page any more. Call read_page again for fresh refs.`;
    const lines: string[] = [];
    let total = 0;
    for (const el of walk(root)) {
      const r = role(el);
      const keep = INTERACTIVE_ROLES.has(r) ||
        (filter === "all" && (r === "heading" || r === "img" || ["P", "LI", "TD", "TH", "LABEL"].includes(el.tagName)));
      if (!keep || !visible(el)) continue;
      if (filter === "all" && ["P", "LI", "TD", "TH", "LABEL"].includes(el.tagName) && !r) {
        if (el.querySelector("a,button,input,select,textarea,p,li")) continue;
        const text = clean((el as HTMLElement).innerText, 160);
        if (!text) continue;
        total++;
        if (lines.length < max) lines.push(`text ${JSON.stringify(text)}`);
        continue;
      }
      if (r === "heading" && filter !== "all") continue;
      total++;
      if (lines.length < max) lines.push(describe(el, r));
    }
    const head = `${document.title} — ${location.href}`;
    if (!lines.length) return `${head}\n(no ${filter === "all" ? "" : "interactive "}elements found)`;
    const more = total > lines.length ? `\n… ${total - lines.length} more. Use find, or read_page with a ref to narrow it.` : "";
    return `${head}\n${lines.join("\n")}${more}`;
  }

  function find(query: string, max: number): string {
    const q = query.toLowerCase();
    const hits: string[] = [];
    const textHits: string[] = [];
    for (const el of walk(document.body)) {
      if (!visible(el)) continue;
      const r = role(el);
      if (r) {
        const hay = [label(el), el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name")]
          .join(" ").toLowerCase();
        if (hay.includes(q)) hits.push(describe(el, r));
      } else {
        // Plain text (a div, a span, a heading): match on the element's own text, not its children's,
        // so the innermost element holding the words is the one returned.
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" ");
        if (own.toLowerCase().includes(q) && textHits.length < max) textHits.push(describe(el, el.tagName.toLowerCase()));
      }
      if (hits.length >= max) break;
    }
    // Controls first: "Name" should find the Name field before the word "Name" in its label.
    const all = [...hits, ...textHits].slice(0, max);
    return all.length ? all.join("\n") : `Nothing on the page matches ${JSON.stringify(query)}.`;
  }

  function formOf(el: Element): HTMLFormElement | null {
    return (el as HTMLInputElement).form ?? el.closest("form");
  }

  function submitLabel(form: HTMLFormElement | null): string {
    if (!form) return "";
    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    return btn ? label(btn) : "";
  }

  function infoFor(el: Element): Info {
    const clickable = (el.closest('a,button,[role="button"],[role="link"],input,select,textarea,summary,label') ?? el);
    const form = formOf(clickable);
    const r = clickable.getBoundingClientRect();
    return {
      ok: true,
      tag: clickable.tagName.toLowerCase(),
      role: role(clickable),
      label: label(clickable),
      inForm: !!form,
      submitLabel: submitLabel(form),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  }

  function refInfo(ref: string, scroll: boolean): Info {
    const el = byRef(ref);
    if (!el) return { ok: false, error: `No element ${ref} on the page any more. Call read_page or find for fresh refs.` };
    if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    const info = infoFor(el);
    const r = el.getBoundingClientRect();
    info.x = Math.round(r.left + r.width / 2);
    info.y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(info.x, info.y);
    info.covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
    return info;
  }

  function pointInfo(x: number, y: number): Info {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: true, x, y, label: "", tag: "", role: "" };
    const info = infoFor(el);
    info.x = x;
    info.y = y;
    return info;
  }

  function focusInfo(): Info {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: true, tag: "body", label: "" };
    const form = formOf(el);
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      role: role(el),
      label: label(el),
      inForm: !!form,
      submitLabel: submitLabel(form),
      editable: el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable,
    };
  }

  function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  }

  function formInput(ref: string, value: unknown): string {
    const el = byRef(ref);
    if (!el) return `No element ${ref} on the page any more. Call read_page or find for fresh refs.`;
    (el as HTMLElement).focus?.();
    if (el instanceof HTMLSelectElement) {
      const want = String(value).toLowerCase();
      const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
      if (!opt) return `No option ${JSON.stringify(value)}. Options: ${Array.from(el.options).map((o) => JSON.stringify(o.text.trim())).join(", ")}`;
      el.value = opt.value;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      const want = value === true || value === "true" || value === "on" || value === 1;
      if (el.checked !== want) el.click();
      return `${ref} is now ${el.checked ? "checked" : "unchecked"}.`;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNative(el, String(value));
    } else {
      return `${ref} is not a form field. For a rich text box, click it and use type.`;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Set ${ref} to ${JSON.stringify(String(value))}.`;
  }

  function pageText(max: number): string {
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    const cut = text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
    return `${document.title} — ${location.href}\n\n${cut}`;
  }

  function hasText(text: string): boolean {
    return (document.body?.innerText ?? "").includes(text);
  }

  // Inspect: tag one element so the DevTools side can find it in the page's own world.
  function mark(ref: string, nonce: string): boolean {
    const el = byRef(ref);
    if (!el) return false;
    el.setAttribute("data-tabbridge-inspect", nonce);
    return true;
  }
  function unmark(): void {
    for (const el of Array.from(document.querySelectorAll("[data-tabbridge-inspect]"))) el.removeAttribute("data-tabbridge-inspect");
  }

  // Right-click "Send to my agent": remember what was right-clicked.
  let lastRightClick: Element | null = null;
  document.addEventListener("contextmenu", (e) => {
    const target = e.composedPath()[0];
    lastRightClick = target instanceof Element ? target : null;
  }, true);

  function cssPath(el: Element): string {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement && parts.length < 6; node = node.parentElement) {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""));
    }
    return parts.join(" > ");
  }

  function rightClicked(): string | null {
    if (!lastRightClick?.isConnected) return null;
    const el = lastRightClick;
    const r = role(el) || el.tagName.toLowerCase();
    const html = el.outerHTML.length > 1500 ? el.outerHTML.slice(0, 1500) + "…" : el.outerHTML;
    return `${describe(el, r)}
  selector: ${cssPath(el)}
  html: ${html}`;
  }

  g.__tabbridge = { readPage, find, refInfo, pointInfo, focusInfo, formInput, pageText, hasText, mark, unmark, rightClicked };
})();
