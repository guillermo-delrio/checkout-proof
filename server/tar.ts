// Minimal tar reader (ustar, pax "path" records, GNU long names) over an in-memory buffer. Regular files only;
// nothing is written to disk and nothing is executed. Caps keep a hostile archive from costing much.
export interface TarFile { path: string; size: number; data: Buffer }
export interface TarCaps { maxFiles: number; maxFileBytes: number; meta?: { comment?: string; tooManyFiles?: boolean } }

const str = (b: Buffer, off: number, len: number) => { const s = b.subarray(off, off + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString("utf8"); };
const oct = (b: Buffer, off: number, len: number) => parseInt(str(b, off, len).trim() || "0", 8) || 0;

function paxField(data: Buffer, key: string): string | undefined {
  // records: "<len> key=value\n"
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString(), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (rec.slice(0, eq) === key) return rec.slice(eq + 1);
    i += len;
  }
  return undefined;
}

export function* readTar(buf: Buffer, caps: TarCaps): Generator<TarFile> {
  let off = 0, files = 0, longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    let name = str(h, 0, 100);
    if (prefix && str(h, 257, 6).startsWith("ustar")) name = `${prefix}/${name}`;
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, Math.min(dataStart + size, buf.length));
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") { longName = paxField(data, "path") ?? longName; continue; }
    if (type === "L") { longName = str(data, 0, data.length); continue; }
    if (type === "g") { if (caps.meta) caps.meta.comment = paxField(data, "comment"); continue; }  // GitHub puts the commit SHA here
    const p = longName ?? name; longName = undefined;
    if (type !== "0" && type !== "\0" && type !== "7") continue;  // regular files only (no links, devices)
    if (++files > caps.maxFiles) { if (caps.meta) caps.meta.tooManyFiles = true; return; }
    if (size > caps.maxFileBytes) continue;
    yield { path: p, size, data };
  }
}
