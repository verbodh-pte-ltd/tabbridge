// Turns "Control+a", "Shift+Tab" or "Enter" into DevTools key events.

export interface KeyPress {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
  text?: string;
}

const SPECIAL: Record<string, [string, number, string?]> = {
  enter: ["Enter", 13, "\r"], return: ["Enter", 13, "\r"], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27],
  backspace: ["Backspace", 8], delete: ["Delete", 46], space: [" ", 32, " "], " ": [" ", 32, " "],
  arrowup: ["ArrowUp", 38], arrowdown: ["ArrowDown", 40], arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39],
  up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39],
  home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34], insert: ["Insert", 45],
};
for (let i = 1; i <= 12; i++) SPECIAL[`f${i}`] = [`F${i}`, 111 + i];

const MODS: Record<string, number> = {
  alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8,
};

const CODES: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", " ": "Space",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
};

export function parseKeys(keys: string): KeyPress[] {
  return keys.trim().split(/\s+/).filter(Boolean).map(parseOne);
}

function parseOne(combo: string): KeyPress {
  const parts = combo.split("+");
  // "Control++" means Control and the plus key.
  if (combo.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const main = parts.pop() ?? "";
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${m}" in "${combo}". Use Control, Shift, Alt or Meta.`);
    modifiers |= bit;
  }
  const special = SPECIAL[main.toLowerCase()];
  if (special) {
    const [key, keyCode, text] = special;
    return { key, code: CODES[key] ?? key, keyCode, modifiers, text: modifiers & ~8 ? undefined : text };
  }
  if (main.length !== 1) throw new Error(`Unknown key "${main}" in "${combo}".`);
  const upper = main.toUpperCase();
  const isLetter = /[A-Z]/.test(upper);
  const isDigit = /[0-9]/.test(main);
  const shifted = (modifiers & 8) !== 0;
  return {
    key: isLetter ? (shifted ? upper : main.toLowerCase()) : main,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${main}` : "",
    keyCode: isLetter || isDigit ? upper.charCodeAt(0) : main.charCodeAt(0),
    modifiers,
    // Only plain or shifted presses type a character; Control+a is a shortcut, not text.
    text: modifiers & ~8 ? undefined : isLetter ? (shifted ? upper : main.toLowerCase()) : main,
  };
}

/** Chrome on macOS runs no editing shortcut from a DevTools key event unless the command is named. */
export function macCommands(p: KeyPress): string[] | undefined {
  // ponytail: Select All only, the shortcut agents use to clear a field; add copy/paste/undo when a check needs them.
  const ctrlOrMeta = (p.modifiers & 6) !== 0 && (p.modifiers & 9) === 0;
  return ctrlOrMeta && p.code === "KeyA" ? ["selectAll"] : undefined;
}
