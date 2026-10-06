// Starts a throwaway Chrome profile and loads the unpacked extension through the DevTools
// protocol (Extensions.loadUnpacked). Branded Chrome ignores --load-extension since v137;
// this is the route it still allows, and it needs --remote-debugging-pipe.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  win32: [
    `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
};

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = (CANDIDATES[process.platform] ?? []).find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH.");
  return found;
}

export async function launch(extensionDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tabbridge-live-"));
  const child = spawn(findChrome(), [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const out = child.stdio[3];
  const inn = child.stdio[4];
  let nextId = 1;
  const waiting = new Map();
  let pending = "";
  inn.on("data", (chunk) => {
    pending += chunk.toString();
    let at;
    while ((at = pending.indexOf("\0")) >= 0) {
      const msg = JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
      if (msg.id && waiting.has(msg.id)) {
        const { resolve, reject } = waiting.get(msg.id);
        waiting.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
      }
    }
  });

  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });

  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extensionDir });

  async function close() {
    await cdp("Browser.close").catch(() => {});
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
    // Chrome can hold profile files for a moment after exit; a leftover temp folder is harmless.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* left in temp */ }
  }

  /** Waits for a TabBridge approval window and clicks the button with this text. */
  async function answerApproval(buttonText, timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const { targetInfos } = await cdp("Target.getTargets");
      const target = targetInfos.find((t) => t.type === "page" && t.url.includes(`${extensionId}/approve.html`));
      if (target) {
        const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        for (let i = 0; i < 40; i++) {
          const { result } = await cdp("Runtime.evaluate", {
            expression: `(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent === ${JSON.stringify(buttonText)}); if (!b) return document.getElementById("title")?.textContent || ""; b.click(); return "clicked"; })()`,
            returnByValue: true,
          }, sessionId);
          if (result.value === "clicked") return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`Approval window had no "${buttonText}" button`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`No approval window appeared within ${timeoutMs} ms`);
  }

  async function approvalOpen() {
    const { targetInfos } = await cdp("Target.getTargets");
    return targetInfos.some((t) => t.url.includes(`${extensionId}/approve.html`));
  }

  /** Runs an expression inside the extension (an extension page), for settings and tab groups. */
  let extSession = null;
  async function extEval(expression) {
    if (!extSession) {
      const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html`, background: true, newWindow: false });
      ({ sessionId: extSession } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
      await new Promise((r) => setTimeout(r, 500));
    }
    const { result, exceptionDetails } = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, extSession);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  return { cdp, extensionId, close, answerApproval, approvalOpen, extEval };
}
