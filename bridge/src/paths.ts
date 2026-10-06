import os from "node:os";
import path from "node:path";

/** Everything TabBridge keeps on disk lives here. TABBRIDGE_HOME overrides it (tests use that). */
export function homeDir(): string {
  return process.env.TABBRIDGE_HOME || path.join(os.homedir(), ".tabbridge");
}

/** Where the host listens for agents: a named pipe on Windows, a socket file elsewhere. */
export function pipePath(): string {
  if (process.env.TABBRIDGE_PIPE) return process.env.TABBRIDGE_PIPE;
  if (process.platform === "win32") {
    const user = (os.userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\tabbridge-${user}`;
  }
  return path.join(homeDir(), "bridge.sock");
}

export const tokenPath = () => path.join(homeDir(), "token");
export const logPath = () => path.join(homeDir(), "host.log");
