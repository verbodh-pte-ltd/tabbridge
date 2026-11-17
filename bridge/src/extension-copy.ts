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

/** True when `dir` is an empty folder or an earlier copy of this extension: the only things this command may replace. */
function mayReplace(dir: string): boolean {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  if (fs.readdirSync(dir).length === 0) return true;
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).name).startsWith("TabBridge");
  } catch {
    return false;
  }
}

/**
 * Copies `from` to `to`. The copy goes to a temporary name first, the old folder is moved aside, the new one is renamed
 * in, and only then is the old one deleted, so a failed copy or a failed delete never leaves a half folder at `to`.
 */
export function copyExtension({ from, to }: { from: string; to: string }): CopyResult {
  // The only folder this command may remove is one named "extension" that is empty or an earlier copy.
  if (path.basename(to) !== "extension") throw new Error(`TabBridge only writes to a folder named "extension", not ${to}.`);
  const version = versionOf(from);
  if (!version) throw new Error(`The extension is missing from ${from}. Run "npm run build" first, or install the package again.`);

  const replaced = fs.existsSync(to) || fs.lstatSync(to, { throwIfNoEntry: false }) !== undefined;
  if (replaced && !mayReplace(to)) {
    throw new Error(`${to} is not a TabBridge extension folder (it is a file, a link, or holds other files), so TabBridge leaves it alone. Move or remove it, then run this command again.`);
  }
  const previous = replaced ? versionOf(to) : undefined;

  // The home folder also holds the host token and pipe: if this command makes it first, it stays private, as install() makes it.
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const temp = `${to}.new-${process.pid}`;
  const old = `${to}.old-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  try {
    fs.cpSync(from, temp, { recursive: true });
    if (replaced) fs.renameSync(to, old);
    try {
      fs.renameSync(temp, to);
    } catch (err) {
      if (replaced) fs.renameSync(old, to); // put the earlier copy back
      throw err;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  try {
    fs.rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A folder Chrome or a scanner still holds: the new copy is in place, and the next run clears this one.
  }
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
