// `tabbridge extension`: copies the extension that comes with this package to the TabBridge home folder,
// so a person can load it once with "Load unpacked" and update it by running the command again.
// Chrome has no install from npm, and branded Chrome ignores the command-line flag for loading an extension.

import fs from "node:fs";
import path from "node:path";

export interface CopyResult {
  to: string;
  version: string;
  replaced: boolean;
  previous?: string;
}

function versionOf(dir: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Copies `from` to `to`. The copy goes to a temporary name and is renamed last, so a stop midway leaves no half folder. */
export function copyExtension({ from, to }: { from: string; to: string }): CopyResult {
  // The only folder this command may remove is one named "extension".
  if (path.basename(to) !== "extension") throw new Error(`TabBridge only writes to a folder named "extension", not ${to}.`);
  const version = versionOf(from);
  if (!version) throw new Error(`The extension is missing from ${from}. Run "npm run build" first, or install the package again.`);

  const previous = versionOf(to);
  const replaced = fs.existsSync(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const temp = `${to}.new-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(from, temp, { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(temp, to);
  return { to, version, replaced, ...(previous ? { previous } : {}) };
}

/** The words the person reads: where the folder is, and the steps in Chrome. */
export function describeCopy(done: CopyResult): string {
  if (done.replaced) {
    return [
      `TabBridge extension ${done.version} is in ${done.to}`,
      done.previous ? `It replaced version ${done.previous}.` : "It replaced the earlier copy.",
      "",
      "Open chrome://extensions and click Reload on the TabBridge card. If it is not there yet, click Load unpacked and choose the folder above.",
    ].join("\n");
  }
  return [
    `TabBridge extension ${done.version} is ready in:`,
    `  ${done.to}`,
    "",
    "Add it to Chrome once:",
    "  1. Open chrome://extensions and turn on Developer mode.",
    "  2. Click Load unpacked and choose the folder above.",
    "A managed Chrome profile may not allow this; that is set by your organisation.",
    "",
    "After an update, run this command again and click Reload on the TabBridge card.",
  ].join("\n");
}
