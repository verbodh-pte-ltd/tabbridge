// Builds store/tabbridge-<version>.zip for the Chrome Web Store: extension/dist without the
// development "key" (the store rejects a manifest that carries one and assigns its own id).
// With --unpacked: store/tabbridge-extension-<version>.zip WITH the key, for people who unzip it and
// Load unpacked (the key keeps the id the host trusts). That one goes on the GitHub release.
// A tiny zip writer, so no zip tool or dependency is needed on any platform.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "extension", "dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) throw new Error("Run npm run build first.");

const unpacked = process.argv.includes("--unpacked");
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
if (!unpacked) delete manifest.key;

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

const entries = [];
const chunks = [];
let offset = 0;
for (const file of files) {
  const name = path.relative(dist, file).split(path.sep).join("/");
  const data = name === "manifest.json" ? Buffer.from(JSON.stringify(manifest, null, 2)) : fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  chunks.push(local, nameBuf, packed);
  entries.push({ nameBuf, crc, packed: packed.length, size: data.length, offset });
  offset += local.length + nameBuf.length + packed.length;
}
const central = [];
for (const e of entries) {
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(8, 10); c.writeUInt32LE(0, 12); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.packed, 20);
  c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.offset, 42);
  central.push(c, e.nameBuf);
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.join(root, "store"), { recursive: true });
const out = path.join(root, "store", unpacked ? `tabbridge-extension-${manifest.version}.zip` : `tabbridge-${manifest.version}.zip`);
fs.writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]));
console.log(`${path.relative(root, out)}: ${entries.length} files, ${Math.round(fs.statSync(out).size / 1024)} KB, ${unpacked ? "with the dev key (for Load unpacked)" : "no \"key\" in the manifest (for the store)"}`);
