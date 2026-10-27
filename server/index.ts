// Checkout Proof web server: serves the built gallery (web/dist) and three APIs. No model calls anywhere.
//   POST /api/scan             {url}  public GitHub repo → static scan findings (rate-limited, cached)
//   GET  /api/rerun            status of the live runs;  POST /api/rerun {kind} → start;  GET /api/rerun/:id → job
//   GET  /api/rerun/:id/hold   the server's own held request while a run goes on (needs the run's token)
//   POST /api/webhooks/paypal  PayPal webhook, verified with verify-webhook-signature; fails closed; during a re-run,
//                              forwarded to the shop under test, which verifies and applies it itself
//   GET  /api/webhooks/paypal  {configured, missing, recent: counts by event type}
//   GET  /api/rerun/history    the saved live runs (summaries) and their tally: what the site's live counts may say
//   GET  /api/health
// Binds 127.0.0.1 unless HOST is set; the Cloud Run image sets HOST=0.0.0.0 (ops/Dockerfile, ops/deploy.sh).
import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseRepoUrl, scanRepo, ScanError, type ScanResult } from "./scan-repo.ts";
import { RateLimiter, TtlCache, MINUTE, HOUR, visitorKey } from "./limits.ts";
import { verifyWebhook, webhookConfig, type WebhookOutcome } from "./webhook.ts";
import { makeStore, utcDay, type Store } from "./store.ts";
import { Rerun, HOLD_MS } from "./rerun.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const DIST = path.join(ROOT, "web", "dist");
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const num = (k: string, d: number) => Number(process.env[k] || d);

// ---- limits ----
// Daily caps live in the store (Firestore on Cloud Run): they survive restarts, deploys and extra instances. The
// in-memory limiters in front of them only shape bursts and keep a flood from turning into store reads and writes.
export const store: Store = makeStore();
const SCAN_PER_MIN = num("CP_SCAN_PER_MIN", 4), SCAN_PER_DAY = num("CP_SCAN_PER_DAY", 30), SCAN_GLOBAL_PER_DAY = num("CP_SCAN_GLOBAL_PER_DAY", 600);
const scanPerIp = new RateLimiter([{ limit: SCAN_PER_MIN, ms: MINUTE }]);
const scanBurst = new RateLimiter([{ limit: num("CP_SCAN_GLOBAL_PER_MIN", 20), ms: MINUTE }]);
const scanCache = new TtlCache<ScanResult>(HOUR, 300);
const inflight = new Map<string, Promise<ScanResult>>();
// At most this many archives unpacked at once (each holds up to ~75 MB while it is read): the rest get 429.
const SCAN_SLOTS = num("CP_SCAN_CONCURRENT", 2);
let scanning = 0;
// CP_PUBLIC_URL (Cloud Run): the service's own address. While a run goes on, the server holds one request to itself
// through it, so the instance keeps its CPU when the visitor closes the tab (request-based billing; see PROGRESS).
const PUBLIC_URL = (process.env.CP_PUBLIC_URL || "").replace(/\/$/, "");
const defaultRerun = new Rerun({
  root: ROOT, mode: process.env.CP_RERUN || "off", dailyGlobal: num("CP_RERUN_DAILY", 10), dailyPerVisitor: num("CP_RERUN_PER_VISITOR", 2), expected: num("CP_RERUN_EXPECTED", 18), store,
  original: { dailyGlobal: num("CP_ORIGINAL_DAILY", 6), dailyPerVisitor: num("CP_ORIGINAL_PER_VISITOR", 2), expected: 2 },
  slices: num("CP_RERUN_SLICES", 1),
  // CP_JUDGE_CODE (Secret Manager on Cloud Run): live runs for the judges only. CP_*_MONTHLY: hard caps per month.
  ...(process.env.CP_JUDGE_CODE ? { judgeCode: process.env.CP_JUDGE_CODE } : {}),
  monthly: { ...(process.env.CP_RERUN_MONTHLY ? { upgraded: num("CP_RERUN_MONTHLY", 0) } : {}), ...(process.env.CP_ORIGINAL_MONTHLY ? { original: num("CP_ORIGINAL_MONTHLY", 0) } : {}) },
  ...(PUBLIC_URL ? { holdUrl: (id: string, t: string) => `${PUBLIC_URL}/api/rerun/${id}/hold?t=${t}` } : {}),
});
const clientIp = (req: http.IncomingMessage) => {
  // Cloud Run appends the caller's address to any X-Forwarded-For the caller sent, so only the last entry is real
  // (the first one is whatever the visitor typed). Trust it only when told we are behind that proxy.
  if (process.env.CP_TRUST_PROXY === "1") { const f = String(req.headers["x-forwarded-for"] || "").split(",").pop()!.trim(); if (f) return f; }
  return req.socket.remoteAddress || "unknown";
};

// Cost endpoints (re-run, scan) answer only our own page: a same-origin browser request (Sec-Fetch-Site, Origin),
// with JSON and our custom header. A custom header forces a CORS preflight, which this server never grants, so a
// third-party page cannot spend the caps from its visitors' browsers (a plain <form> POST can send neither).
export function sameOriginJson(req: http.IncomingMessage): string | null {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return "cross-site request";
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(String(origin)).host !== req.headers.host) return "cross-origin request"; } catch { return "bad Origin"; } }
  if (req.headers["x-cp"] !== "1") return "missing X-CP header";
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return "Content-Type must be application/json";
  return null;
}

function send(res: http.ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(s);
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > max) { reject(new Error("too-large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webp": "image/webp" };
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let u: string;
  try { u = decodeURIComponent(new URL(req.url || "/", "http://x").pathname); } catch { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("Bad request."); }
  let file = path.normalize(path.join(DIST, u));
  if (!file.startsWith(DIST)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html"); // SPA routes
  if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("web/dist not built: cd web && npm run build"); }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff" });
  fs.createReadStream(file).pipe(res);
}

async function handleScan(req: http.IncomingMessage, res: http.ServerResponse) {
  let url = "";
  try { url = String(JSON.parse(await readBody(req, 4096)).url || ""); } catch { return send(res, 400, { error: "Send {\"url\": \"https://github.com/owner/repo\"}." }); }
  const ref = parseRepoUrl(url);
  if (!ref) return send(res, 400, { error: "That is not a public GitHub repo address. Try https://github.com/owner/repo." });
  // GitHub names are case-insensitive; git refs are not.
  const key = `${ref.owner}/${ref.repo}`.toLowerCase() + `@${ref.ref ?? "HEAD"}`;
  const cached = scanCache.get(key);
  if (cached) return send(res, 200, { ...cached, cached: true });
  const ip = clientIp(req);
  const lim = scanPerIp.take(visitorKey(ip));
  if (!lim.ok) return send(res, 429, { error: `Too many scans from your address. Try again in ${lim.retryAfterS} s.` }, { "Retry-After": String(lim.retryAfterS) });
  if (!scanBurst.take("all").ok) return send(res, 429, { error: "The scan box is busy. Try again in a minute." }, { "Retry-After": "60" });
  let p = inflight.get(key);
  if (!p) {
    if (scanning >= SCAN_SLOTS) return send(res, 429, { error: "The scan box is busy with other repos. Try again in a few seconds." }, { "Retry-After": "10" });
    scanning++;  // held from here, so requests arriving during the store call cannot pass the slot check too
    let t;
    try { t = await store.take(`scan-${utcDay()}`, { global: SCAN_GLOBAL_PER_DAY, [visitorKey(ip)]: SCAN_PER_DAY }); }
    catch (e: any) { scanning--; console.error(`scan cap store: ${e?.message ?? e}`); return send(res, 503, { error: "The scan box cannot check its daily limit right now. Try again later." }); }
    if (!t.ok) { scanning--; return send(res, 429, { error: t.over === "global" ? "The scan box has reached today's limit. Try again after 00:00 UTC." : "You have used today's scans from your address. Try again after 00:00 UTC." }); }
    p = scanRepo(ref);
    inflight.set(key, p);
    p.finally(() => { inflight.delete(key); scanning--; }).catch(() => {});
  }
  try {
    const r = await p;
    scanCache.set(key, r);
    send(res, 200, { ...r, cached: false });
  } catch (e: any) {
    if (e instanceof ScanError) return send(res, e.code === "not-found" ? 404 : e.code === "too-large" ? 413 : e.code === "timeout" ? 504 : 502, { error: e.message, code: e.code });
    send(res, 500, { error: "The scan failed." });
  }
}

export interface ServerOptions {
  rerun: Rerun;
  /** PayPal's verification (tests pass a stand-in); default: verify-webhook-signature with this process's credentials. */
  verify?: (headers: http.IncomingHttpHeaders, raw: string, allowCall: () => boolean) => Promise<WebhookOutcome>;
}

/** One server instance: Cloud Run may run two at once (21 Oct), sharing only the store. */
export function createServer(o: ServerOptions) {
const rerun = o.rerun;
const verify = o.verify ?? ((h: http.IncomingHttpHeaders, raw: string, allowCall: () => boolean) => verifyWebhook(h, raw, process.env, fetch, allowCall));
const rerunPerIp = new RateLimiter([{ limit: 10, ms: MINUTE }]);
// PayPal delivers from a few addresses and retries a backlog in bursts (one 429 at 60/min on 18 Oct). Each POST that
// passes the header checks costs one PayPal call (verify-webhook-signature; the token is cached), so the instance
// also has an overall cap: with at most 3 instances (the project's quota), never more than 3 × this per minute.
const webhookPerIp = new RateLimiter([{ limit: num("CP_WEBHOOK_PER_MIN", 240), ms: MINUTE }]);
const webhookAll = new RateLimiter([{ limit: num("CP_WEBHOOK_GLOBAL_PER_MIN", 120), ms: MINUTE }]);
// The store-backed GETs (status, history, a run by id): a flood is answered from memory or refused here, never
// turned into Firestore reads (review r2, sceptic N3). The page polls a run at most every few seconds.
const readPerVisitor = new RateLimiter([{ limit: num("CP_READ_PER_MIN", 30), ms: MINUTE }]);
const readAll = new RateLimiter([{ limit: num("CP_READ_GLOBAL_PER_MIN", 600), ms: MINUTE }]);
const readLimited = (req: http.IncomingMessage) => !readPerVisitor.take(visitorKey(clientIp(req))).ok || !readAll.take("all").ok;
const recentEvents: { id: string; type: string; at: string; deliveries: number; shop?: number[] }[] = [];


async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse) {
  const lim = webhookPerIp.take(clientIp(req));
  if (!lim.ok) return send(res, 429, { status: "rejected", why: "rate limited" });
  let raw = "";
  try { raw = await readBody(req, 256 * 1024); } catch { return send(res, 413, { status: "rejected", why: "body too large" }); }
  const out = await verify(req.headers, raw, () => webhookAll.take("all").ok);
  if (out.status === "verified") {
    // PayPal retries a delivery until it gets a 2xx, and can resend it: the same event ID is listed once.
    let e = recentEvents.find((x) => x.id === out.eventId);
    const duplicate = !!e;
    if (!e) { e = { id: out.eventId, type: out.eventType, at: new Date().toISOString(), deliveries: 0 }; recentEvents.unshift(e); recentEvents.length = Math.min(recentEvents.length, 50); }
    e.deliveries++;
    // During a re-run the shop under test gets every verified delivery (repeats too) on its own route: directly when
    // this instance runs it, else through the store (the running instance picks it up within seconds).
    let d;
    try { d = await rerun.deliver(req.headers, raw, out.eventId, out.eventType); }
    catch (err: any) { console.error(`webhook ${out.eventId}: could not keep the delivery (${err?.message ?? err})`); return send(res, 503, { ...out, duplicate, why: "could not keep the event yet" }); }
    if (d.via === "shop") {
      (e.shop ??= []).push(d.shop);
      // The shop failing (or unreachable) means the event was not handled: answer 503 so PayPal delivers it again.
      if (d.shop === 0 || d.shop >= 500) return send(res, 503, { ...out, duplicate, shop: d.shop, why: "the shop could not take the event yet" });
      return send(res, 200, { ...out, duplicate, shop: d.shop });
    }
    return send(res, 200, { ...out, duplicate, ...(d.via === "store" ? { stored: true } : {}) });
  }
  send(res, out.http, out);
}

return http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const p = url.pathname;
  try {
    // Unannounced URL: keep it out of search engines until the owner says it is public (CP_NOINDEX=0 lifts it).
    if (process.env.CP_NOINDEX !== "0") res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (p === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(process.env.CP_NOINDEX !== "0" ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n"); }
    // `client`: a short hash of the address the caps see, to check the proxy setup without exposing the address.
    if (p === "/api/health") return send(res, 200, { ok: true, client: createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 8), store: store.kind });
    if (req.method === "POST" && (p === "/api/scan" || p === "/api/rerun")) {
      const why = sameOriginJson(req);
      if (why) return send(res, 403, { error: "This endpoint only answers the Checkout Proof page itself.", why });
    }
    if (p === "/api/scan" && req.method === "POST") return await handleScan(req, res);
    const hold = p.match(/^\/api\/rerun\/([0-9a-f-]{36})\/hold$/);
    if (hold && req.method === "GET") {
      // The server's own request (not limited: it carries the run's secret token, or it is answered at once). Headers
      // go out at once, so the holder learns within a second whether it reached the instance running the job.
      const t = String(url.searchParams.get("t") || "");
      if (!rerun.canHold(hold[1], t)) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/plain" }); res.flushHeaders();
      await rerun.hold(hold[1], t, HOLD_MS);
      return res.end("done\n");
    }
    if ((p === "/api/rerun" || p === "/api/rerun/history" || /^\/api\/rerun\/[0-9a-f-]{36}$/.test(p)) && req.method === "GET" && readLimited(req))
      return send(res, 429, { error: "Too many requests. Try again in a minute.", code: "burst" }, { "Retry-After": "30" });
    if (p === "/api/rerun" && req.method === "GET") return send(res, 200, await rerun.status(visitorKey(clientIp(req))));
    if (p === "/api/rerun/history" && req.method === "GET") return send(res, 200, await rerun.history());
    if (p === "/api/rerun" && req.method === "POST") {
      if (!rerunPerIp.take(visitorKey(clientIp(req))).ok) return send(res, 429, { error: "Too many requests. Try again in a minute.", code: "burst" });
      let kind: unknown = "upgraded", code: unknown;
      try { const b = await readBody(req, 1024); if (b.trim()) { const j = JSON.parse(b); kind = j.kind ?? "upgraded"; code = j.code; } } catch { return send(res, 400, { error: "Send {\"kind\": \"upgraded\"} or {\"kind\": \"original\"}.", code: "bad-body" }); }
      if (kind !== "upgraded" && kind !== "original") return send(res, 400, { error: "kind must be \"upgraded\" or \"original\".", code: "bad-kind" });
      const r = await rerun.start(visitorKey(clientIp(req)), kind, code);
      return r.ok ? send(res, 202, r.job) : send(res, r.http, { error: r.error, code: r.code });
    }
    const m = p.match(/^\/api\/rerun\/([0-9a-f-]{36})$/);
    if (m && req.method === "GET") {
      const wait = Math.min(Number(url.searchParams.get("wait") || 0), 25) * 1000;
      const j = wait > 0 ? await rerun.waitAny(m[1], wait) : await rerun.find(m[1]);
      return j ? send(res, 200, j) : send(res, 404, { error: "No such run." });
    }
    if (p === "/api/webhooks/paypal" && req.method === "POST") return await handleWebhook(req, res);
    if (p === "/api/webhooks/paypal" && req.method === "GET") { const c = webhookConfig(process.env); const byType: Record<string, number> = {}; for (const e of recentEvents) byType[e.type] = (byType[e.type] ?? 0) + 1; return send(res, 200, { configured: c.configured, missing: c.missing, recent: byType }); }
    if (p.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    serveStatic(req, res);
  } catch (e: any) {
    console.error(`${req.method} ${p}: ${e?.message ?? e}`);
    if (!res.headersSent) send(res, e?.name === "StoreError" || e instanceof Error && /firestore/.test(e.message) ? 503 : 500, { error: "Server error." });
  }
});
}

export const server = createServer({ rerun: defaultRerun });

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, HOST, () => console.log(`checkout-proof web on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} · re-run proof: ${defaultRerun.enabled ? `on (${process.env.CP_RERUN})` : "off (M4)"} · webhook: ${webhookConfig(process.env).configured ? "configured" : "not configured"}`));
  // Cloud Run sends SIGTERM and allows 10 s: a running job is saved as interrupted (and given back) before the exit.
  const bye = () => { void defaultRerun.interrupt().finally(() => { defaultRerun.stop(); server.close(); process.exit(0); }); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
}
