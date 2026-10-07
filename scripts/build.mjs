// Builds the bridge (bridge/dist) and the extension (extension/dist).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const r = (...p) => path.join(root, ...p);

// One version everywhere: bridge/package.json is the source.
const version = JSON.parse(fs.readFileSync(r("bridge/package.json"), "utf8")).version;
fs.writeFileSync(r("bridge/src/version.ts"),
  `// Kept in step with bridge/package.json and extension/static/manifest.json by scripts/build.mjs.\nexport const VERSION = "${version}";\n`);
const manifestFile = r("extension/static/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}

fs.rmSync(r("bridge/dist"), { recursive: true, force: true });
fs.rmSync(r("extension/dist"), { recursive: true, force: true });

const node = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" };
await build({ ...node, entryPoints: [r("bridge/src/cli.ts")], outfile: r("bridge/dist/cli.js"), packages: "external",
  banner: { js: "#!/usr/bin/env node" } });
// The host has no dependencies, so `tabbridge install` can copy this one file out of the npm cache.
await build({ ...node, entryPoints: [r("bridge/src/host-entry.ts")], outfile: r("bridge/dist/host.js") });

const web = { bundle: true, format: "esm", target: "chrome116", logLevel: "warning" };
await build({ ...web, entryPoints: ["background.ts", "popup.tsx", "sidepanel.tsx", "options.ts"].map((n) => r(`extension/src/${n}`)),
  outdir: r("extension/dist"), splitting: true, chunkNames: "chunks/[name]-[hash]", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, minify: true });
await build({ ...web, format: "iife", entryPoints: [r("extension/src/page-agent.ts")], outfile: r("extension/dist/page-agent.js") });
fs.cpSync(r("extension/static"), r("extension/dist"), { recursive: true });
// The pane and the approval window use shadcn/ui components, styled with Tailwind.
execFileSync(process.execPath, [r("node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", r("extension/src/ui/theme.css"),
  "-o", r("extension/dist/ui.css"), "--minify"], { stdio: ["ignore", "ignore", "inherit"] });

for (const f of ["README.md", "LICENSE"]) if (fs.existsSync(r(f))) fs.copyFileSync(r(f), r("bridge", f));
console.log(`built ${version}: bridge/dist, extension/dist`);
