// In-memory rate limits and a small TTL cache, per instance. They only shape bursts (per minute) and keep floods from
// reaching the durable store: every daily cap that matters (re-runs, scans) is counted in server/store.ts, which a
// restart, a deploy or a second instance does not reset. A restart empties these, so they are never the only bound.
import { createHash } from "node:crypto";

/** The key a visitor is counted under: an IPv4 address, or an IPv6 address's /48 (a household or a server gets a whole
 *  /64, and a free tunnel broker hands out /48s, 65,536 /64s each: review r3 A3). Hashed, so no address is stored. */
export function visitorKey(ip: string): string {
  let a = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (a.includes(":")) {
    a = a.split("%")[0];
    const [head, tail = ""] = a.split("::");
    const h = head ? head.split(":") : [], t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
    const full = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    a = full.slice(0, 3).map((x) => (parseInt(x || "0", 16) || 0).toString(16)).join(":") + "::/48";
  }
  return "v_" + createHash("sha256").update(a).digest("hex").slice(0, 16);
}

export interface Window { limit: number; ms: number }

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windows: Window[], private now: () => number = Date.now) {}
  /** Records a hit if every window has room; otherwise returns the seconds until the tightest one frees up. */
  take(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const longest = Math.max(...this.windows.map((w) => w.ms));
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < longest);
    for (const w of this.windows) {
      const inWin = list.filter((x) => t - x < w.ms);
      if (inWin.length >= w.limit) {
        this.hits.set(key, list);
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((inWin[0] + w.ms - t) / 1000)) };
      }
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.delete(this.hits.keys().next().value!);
    return { ok: true };
  }
  remaining(key: string): number[] {
    const t = this.now();
    const list = this.hits.get(key) ?? [];
    return this.windows.map((w) => Math.max(0, w.limit - list.filter((x) => t - x < w.ms).length));
  }
}

export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 500, private now: () => number = Date.now) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < this.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, { v, exp: this.now() + this.ttlMs });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

export const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
