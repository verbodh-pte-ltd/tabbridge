// Two wire formats.
// Native messaging (Chrome ↔ host): each message is a 4-byte little-endian length, then UTF-8 JSON.
// Local pipe (host ↔ agents): one JSON object per line.

export function encodeNative(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Feeds chunks in, calls onMessage once per complete native message. */
export function nativeDecoder(onMessage: (message: any) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) return;
      const body = buffer.subarray(4, 4 + size).toString("utf8");
      buffer = buffer.subarray(4 + size);
      onMessage(JSON.parse(body));
    }
  };
}

export function encodeLine(message: unknown): string {
  return JSON.stringify(message) + "\n";
}

export function lineDecoder(onMessage: (message: any) => void): (chunk: Buffer | string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (line) onMessage(JSON.parse(line));
    }
  };
}
