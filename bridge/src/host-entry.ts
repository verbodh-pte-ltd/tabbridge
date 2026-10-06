// Entry point Chrome runs (through the launcher written by `tabbridge install`).
// Bundled on its own, with no dependencies, so it can be copied out of the npm cache.
import { runHost } from "./host.ts";

runHost({ input: process.stdin, output: process.stdout }).catch(() => process.exit(1));
