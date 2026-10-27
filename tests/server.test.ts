import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseRepoUrl, scanTarGz, scanInWorker, fetchCapped, ScanError } from "../server/scan-repo.ts";
import { readTar } from "../server/tar.ts";
import { RateLimiter, TtlCache, visitorKey } from "../server/limits.ts";
import { MemoryStore, FirestoreStore } from "../server/store.ts";
import { verifyWebhook, webhookConfig, forwardToShop, keepDelivery, _resetTokenCache } from "../server/webhook.ts";
import { Rerun } from "../server/rerun.ts";

// A tiny ustar writer for fixtures.
function header(name: string, size: number, type = "0") {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257); h.write("00", 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tar(files: { name: string; body: string; type?: string }[]) {
  return Buffer.concat([...files.flatMap((f) => [header(f.name, Buffer.byteLength(f.body), f.type), pad(Buffer.from(f.body))]), Buffer.alloc(1024)]);
}
function pax(path: string) { const rec = (k: string, v: string) => { let s = ` ${k}=${v}\n`; let n = s.length + 1; n = String(n + s.length).length + s.length; return `${n}${s}`; }; return rec("path", path); }

describe("parseRepoUrl", () => {
  it("accepts the usual forms", () => {
    expect(parseRepoUrl("https://github.com/mrvautin/expressCart")).toEqual({ owner: "mrvautin", repo: "expressCart", ref: undefined });
    expect(parseRepoUrl("github.com/a-b/c.d.git")).toEqual({ owner: "a-b", repo: "c.d", ref: undefined });
    expect(parseRepoUrl("https://www.github.com/o/r/tree/feature/x")).toEqual({ owner: "o", repo: "r", ref: "feature/x" });
    expect(parseRepoUrl("git@github.com:o/r.git")).toEqual({ owner: "o", repo: "r", ref: undefined });
    expect(parseRepoUrl("o/r")).toEqual({ owner: "o", repo: "r", ref: undefined });
  });
  it("rejects anything that is not a GitHub repo", () => {
    for (const s of ["https://gitlab.com/o/r", "https://github.com/o", "http://evil.com/github.com/o/r", "https://github.com/o/r/tree/../../x", "https://github.com/o/..", "file:///etc/passwd", "a".repeat(400)]) expect(parseRepoUrl(s), s).toBeNull();
  });
});

describe("tar + scan", () => {
  const files = [
    { name: "owner-repo-abc1234/package.json", body: '{"dependencies":{"paypal-rest-sdk":"^1.8.1"}}' },
    { name: "owner-repo-abc1234/views/pay.html", body: '<script src="https://www.paypal.com/sdk/js?client-id=x"></script>\n<script>paypal.Buttons({})</script>' },
    { name: "owner-repo-abc1234/node_modules/x/index.js", body: 'require("paypal-rest-sdk")' },
    { name: "owner-repo-abc1234/lib/link", body: "", type: "2" },
  ];
  it("finds deprecated pieces with file:line, skips node_modules and links, reads the commit", () => {
    const r = scanTarGz(zlib.gzipSync(tar(files)), { repo: "owner/repo", ref: "HEAD" });
    expect(r.commit).toBe("abc1234");
    expect(r.findings.map((f) => `${f.rule}@${f.file}:${f.line}`).sort()).toEqual(["rest-sdk-v1@package.json:1", "v5-buttons@views/pay.html:2", "v5-script@views/pay.html:1"]);
    expect(r.counts).toEqual({ upgrade: 2, deprecated: 1, risk: 0 });
  });
  it("reads pax long paths", () => {
    const long = "owner-repo-abc1234/" + "d/".repeat(60) + "pay.js";
    const t = tar([{ name: "PaxHeader", body: pax(long), type: "x" }, { name: "short", body: "paypal.Buttons({})" }]);
    expect([...readTar(t, { maxFiles: 10, maxFileBytes: 1000 })][0].path).toBe(long);
  });
  // Review r3, A1: the live scan runs in a worker the server terminates on time, so it never blocks the event loop.
  it("scans in a worker with the same result, and stops a scan that runs too long", async () => {
    const tgz = zlib.gzipSync(tar(files));
    const r = await scanInWorker(tgz, { repo: "owner/repo", ref: "HEAD" });
    expect(r.counts).toEqual({ upgrade: 2, deprecated: 1, risk: 0 });
    await expect(scanInWorker(tgz, { repo: "owner/repo", ref: "HEAD" }, 1)).rejects.toMatchObject({ code: "timeout" });
    const bomb = zlib.gzipSync(Buffer.alloc(130 * 1024 * 1024));
    await expect(scanInWorker(bomb, { repo: "o/r", ref: "HEAD" })).rejects.toMatchObject({ code: "too-large" });
  }, 30_000);
  it("refuses an archive that unpacks too large", () => {
    const bomb = zlib.gzipSync(Buffer.alloc(130 * 1024 * 1024));
    expect(() => scanTarGz(bomb, { repo: "o/r", ref: "HEAD" })).toThrow(ScanError);
  });
});

describe("fetchCapped", () => {
  const fakeFetch = (status: number, chunks: number, size: number, len?: number) => (async () => ({
    status, ok: status < 400, headers: new Headers(len ? { "content-length": String(len) } : {}),
    body: (async function* () { for (let i = 0; i < chunks; i++) yield new Uint8Array(size); })(),
  })) as any;
  it("stops at the byte cap even without a content-length", async () => {
    await expect(fetchCapped("https://x", 1000, 1000, fakeFetch(200, 10, 300))).rejects.toMatchObject({ code: "too-large" });
  });
  it("trusts a large content-length up front", async () => {
    await expect(fetchCapped("https://x", 1000, 1000, fakeFetch(200, 0, 0, 5000))).rejects.toMatchObject({ code: "too-large" });
  });
  it("maps 404 to not-found", async () => {
    await expect(fetchCapped("https://x", 1000, 1000, fakeFetch(404, 0, 0))).rejects.toMatchObject({ code: "not-found" });
  });
  it("returns the body under the cap", async () => {
    expect((await fetchCapped("https://x", 1000, 1000, fakeFetch(200, 2, 100))).length).toBe(200);
  });
});

describe("limits", () => {
  it("rate limiter enforces each window", () => {
    let t = 0;
    const l = new RateLimiter([{ limit: 2, ms: 60_000 }, { limit: 3, ms: 86_400_000 }], () => t);
    expect(l.take("a").ok).toBe(true); expect(l.take("a").ok).toBe(true);
    expect(l.take("a")).toMatchObject({ ok: false, retryAfterS: 60 });
    expect(l.take("b").ok).toBe(true);
    t = 61_000; expect(l.take("a").ok).toBe(true);
    t = 130_000; expect(l.take("a").ok).toBe(false); // daily window full
  });
  it("cache expires", () => {
    let t = 0;
    const c = new TtlCache<number>(1000, 10, () => t);
    c.set("k", 1); expect(c.get("k")).toBe(1);
    t = 1001; expect(c.get("k")).toBeUndefined();
  });
});

describe("webhook verification fails closed", () => {
  const env = { PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "id-123456", PAYPAL_CLIENT_SECRET: "secret-123456", PAYPAL_WEBHOOK_ID: "WH-1" };
  const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-10-17T10:00:00Z" };
  const body = JSON.stringify({ id: "WH-EV-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} });
  const paypal = (verification: string) => (async (url: string, init: any) => {
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    expect(init.body).toContain('"webhook_id":"WH-1"');
    expect(init.body).toContain(`"webhook_event":${body}`);
    return new Response(JSON.stringify({ verification_status: verification }), { status: 200 });
  }) as any;
  it("reports not configured without a webhook ID", async () => {
    expect(webhookConfig({ ...env, PAYPAL_WEBHOOK_ID: "" })).toEqual({ configured: false, missing: ["PAYPAL_WEBHOOK_ID"] });
    expect(await verifyWebhook(headers, body, { ...env, PAYPAL_WEBHOOK_ID: "" }, paypal("SUCCESS"))).toMatchObject({ status: "not-configured", http: 503 });
  });
  it("refuses a live environment", async () => {
    expect(await verifyWebhook(headers, body, { ...env, PAYPAL_ENVIRONMENT: "live" }, paypal("SUCCESS"))).toMatchObject({ status: "not-configured" });
  });
  it("rejects missing headers, foreign cert URLs and non-events", async () => {
    expect(await verifyWebhook({ ...headers, "paypal-transmission-sig": undefined }, body, env, paypal("SUCCESS"))).toMatchObject({ status: "rejected" });
    expect(await verifyWebhook({ ...headers, "paypal-cert-url": "https://evil.example/paypal.com/cert" }, body, env, paypal("SUCCESS"))).toMatchObject({ status: "rejected" });
    expect(await verifyWebhook(headers, "{}", env, paypal("SUCCESS"))).toMatchObject({ status: "rejected" });
  });
  it("accepts only PayPal's SUCCESS", async () => {
    expect(await verifyWebhook(headers, body, env, paypal("SUCCESS"))).toMatchObject({ status: "verified", eventType: "PAYMENT.CAPTURE.COMPLETED" });
    expect(await verifyWebhook(headers, body, env, paypal("FAILURE"))).toMatchObject({ status: "rejected" });
    expect(await verifyWebhook(headers, body, env, (async () => { throw new Error("net"); }) as any)).toMatchObject({ status: "error" });
  });
  it("fetches the OAuth token once for a burst of deliveries", async () => {
    _resetTokenCache();
    let tokens = 0, verifies = 0;
    const f = (async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) { tokens++; return new Response(JSON.stringify({ access_token: "tok", expires_in: 32400 }), { status: 200 }); }
      verifies++; return new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 });
    }) as any;
    for (let i = 0; i < 5; i++) expect(await verifyWebhook(headers, body, env, f)).toMatchObject({ status: "rejected" });
    expect([tokens, verifies]).toEqual([1, 5]);
  });
});

describe("re-run proof", () => {
  const fakeSpawn = () => { const p: any = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => p.emit("close", 1); return p; };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  it("answers coming-m4 when not switched on", async () => {
    const r = new Rerun({ root: "/x", mode: "off", dailyGlobal: 5, dailyPerVisitor: 2, expected: 11 });
    expect(await r.start("ip")).toMatchObject({ ok: false, code: "coming-m4", http: 503 });
  });
  it("runs one at a time and enforces both caps", async () => {
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "local", dailyGlobal: 2, dailyPerVisitor: 1, expected: 11, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    const a = await r.start("ip1"); expect(a.ok).toBe(true);
    expect(await r.start("ip2")).toMatchObject({ code: "busy" });
    proc.stdout.write("PASS happy   \n");
    proc.emit("close", 1); await settle();
    expect(r.get((a as any).job.id)).toMatchObject({ state: "failed", progress: [{ id: "happy", verdict: "PASS" }] });
    expect(await r.start("ip1")).toMatchObject({ code: "visitor-cap" });
    expect((await r.start("ip2")).ok).toBe(true); proc.emit("close", 1); await settle();
    expect(await r.start("ip3")).toMatchObject({ code: "daily-cap" });
  });
  it("keeps the caps, the slot and the saved results across a restart or a second instance (shared store)", async () => {
    const store = new MemoryStore();
    let proc: any;
    const mk = () => new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 1, expected: 11, store, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    const first = mk(), second = mk();
    const a = await first.start("v1"); expect(a.ok).toBe(true);
    expect(await second.start("v2")).toMatchObject({ code: "busy" });  // the other instance holds the slot
    proc.emit("close", 1); await settle();
    const restarted = mk();  // a fresh process: in-memory state gone, the store's counts are not
    expect(await restarted.status("v1")).toMatchObject({ leftToday: 1, leftForYou: 0, busy: false });
    expect(await restarted.start("v1")).toMatchObject({ code: "visitor-cap" });
    expect(await restarted.find((a as any).job.id)).toMatchObject({ state: "failed" });
    expect((await restarted.history()).saved).toBe(1);
  });
  it("a retried scenario's INCONCLUSIVE attempt is not posted as its result", async () => {
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "local", dailyGlobal: 2, dailyPerVisitor: 2, expected: 11, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    const a = await r.start("ip") as any;
    proc.stdout.write("INCONCLUSIVE happy  buyer timed out\n     retrying happy (harness problem, not the shop's)\nPASS happy\n");
    await settle();
    expect(r.get(a.job.id)!.progress).toEqual([{ id: "happy", verdict: "PASS" }]);
    proc.emit("close", 1);
  });
  it("long poll returns on progress, and cloud mode is on", async () => {
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 2, expected: 11, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    const a = await r.start("ip1") as any; expect(a.ok).toBe(true);
    const t0 = Date.now();
    const w = r.wait(a.job.id, 5000);
    setTimeout(() => proc.stdout.write("PASS happy\n"), 50);
    expect((await w)!.progress).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    proc.emit("close", 1);
  });
});

describe("webhook deliveries reach the shop under test", () => {
  it("forwards PayPal's headers and the raw body unchanged", async () => {
    let seen: any;
    const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.REFUNDED"}';
    const status = await forwardToShop("http://127.0.0.1:3302/api/paypal/webhook", { "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.paypal.com/c", "x-forwarded-for": "1.2.3.4", cookie: "a=b" }, raw, (async (url: string, init: any) => { seen = { url, init }; return new Response("{}", { status: 200 }); }) as any);
    expect(status).toBe(200);
    expect(seen.init.body).toBe(raw);
    expect(seen.init.headers).toEqual({ "Content-Type": "application/json", "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.paypal.com/c" });
    expect(await forwardToShop("http://x", {}, raw, (async () => { throw new Error("down"); }) as any)).toBe(0);
  });
  it("keeps the first delivery of each event, byte for byte, for the replay check", async () => {
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-")), "job");
    keepDelivery(dir, "WH-1", { "paypal-transmission-sig": "first", cookie: "x" }, '{"id":"WH-1" }');
    keepDelivery(dir, "WH-1", { "paypal-transmission-sig": "second" }, "{}");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "WH-1.json"), "utf8"))).toEqual({ headers: { "paypal-transmission-sig": "first" }, raw: '{"id":"WH-1" }' });
  });
  it("has a target only while a re-run is going, and cloud runs get the live webhook scenario", async () => {
    let proc: any, env: any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 2, expected: 12, spawnImpl: ((_c: any, _a: any, o: any) => { env = o.env; return (proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} })); }) as any });
    expect(r.webhookTarget).toBeNull();
    expect((await r.start("ip")).ok).toBe(true);
    expect(r.webhookTarget).toMatchObject({ url: "http://127.0.0.1:3302/api/paypal/webhook" });
    expect(env.CP_WEBHOOK_LIVE).toBe("1");
    expect(env.CP_WEBHOOK_LOG).toBe(r.webhookTarget!.logDir);
    proc.emit("close", 1);
    expect(r.webhookTarget).toBeNull();
  });
  it("local runs mark the webhook scenario N/A instead of waiting for deliveries that go elsewhere", async () => {
    const { scsAdapter } = await import("../src/targets/simple-clothing-store.ts");
    const prev = process.env.CP_WEBHOOK_LIVE; delete process.env.CP_WEBHOOK_LIVE;
    expect(scsAdapter("upgraded", "/tmp/x").unsupported.webhook).toMatch(/hosted listener/);
    process.env.CP_WEBHOOK_LIVE = "1";
    expect(scsAdapter("upgraded", "/tmp/x").unsupported.webhook).toBeUndefined();
    expect(scsAdapter("original", "/tmp/x").unsupported.webhook).toMatch(/no webhook handling/);
    if (prev === undefined) delete process.env.CP_WEBHOOK_LIVE; else process.env.CP_WEBHOOK_LIVE = prev;
  });
});

describe("durable caps (A1-A3)", () => {
  it("a refused take costs nothing, and both fields move together", async () => {
    const s = new MemoryStore();
    expect((await s.take("d", { global: 2, v_a: 1 })).ok).toBe(true);
    expect(await s.take("d", { global: 2, v_a: 1 })).toMatchObject({ ok: false, over: "v_a" });
    expect(await s.read("d")).toEqual({ global: 1, v_a: 1 });
  });
  it("counts IPv6 visitors by /48 (review r3 A3; /64 before) and never stores the address", () => {
    expect(visitorKey("2001:db8:1:2:aaaa::1")).toBe(visitorKey("2001:0db8:0001:0002:ffff:1:2:3"));
    expect(visitorKey("2001:db8:1:2::1")).toBe(visitorKey("2001:db8:1:3::1"));
    expect(visitorKey("2001:db8:1:2::1")).not.toBe(visitorKey("2001:db8:2:2::1"));
    expect(visitorKey("::ffff:1.2.3.4")).toBe(visitorKey("1.2.3.4"));
    expect(visitorKey("1.2.3.4")).not.toBe(visitorKey("1.2.3.5"));
    expect(visitorKey("1.2.3.4")).toMatch(/^v_[0-9a-f]{16}$/);
  });
  it("Firestore store: atomic increments over REST, undone when over the limit; jobs saved whole", async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    const docs: Record<string, Record<string, number>> = {};
    const jobs: Record<string, any> = {};
    const f = (async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, url, body });
      expect(init.headers.Authorization).toBe("Bearer T");
      if (url.endsWith(":commit")) {
        const w = body.writes[0];
        const d = (docs[w.update.name] ??= {});
        return new Response(JSON.stringify({ writeResults: [{ transformResults: w.updateTransforms.map((t: any) => ({ integerValue: String((d[t.fieldPath] = (d[t.fieldPath] ?? 0) + Number(t.increment.integerValue))) })) }] }), { status: 200 });
      }
      const name = url.replace("https://firestore.googleapis.com/v1/", "").split("?")[0];
      if (init.method === "PATCH") { jobs[name] = body; return new Response("{}", { status: 200 }); }
      if (jobs[name]) return new Response(JSON.stringify(jobs[name]), { status: 200 });
      if (!docs[name]) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      return new Response(JSON.stringify({ fields: Object.fromEntries(Object.entries(docs[name]).map(([k, v]) => [k, { integerValue: String(v) }])) }), { status: 200 });
    }) as any;
    const s = new FirestoreStore("p", f, async () => ({ access_token: "T", expires_in: 3600 }));
    expect(await s.read("rerun-2026-10-19")).toEqual({});
    expect((await s.take("rerun-2026-10-19", { global: 1, v_x: 2 })).ok).toBe(true);
    expect(await s.take("rerun-2026-10-19", { global: 1, v_x: 2 })).toMatchObject({ ok: false, over: "global" });
    expect(await s.read("rerun-2026-10-19")).toEqual({ global: 1, v_x: 1 });
    const commit = calls.find((c) => c.url.endsWith(":commit"))!;
    expect(commit.url).toBe("https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:commit");
    expect(commit.body.writes[0]).toMatchObject({ update: { name: "projects/p/databases/(default)/documents/caps/rerun-2026-10-19", fields: {} }, updateMask: { fieldPaths: [] } });
    await s.putJob("j1", { id: "j1", state: "done", tally: { PASS: 12 } }, { id: "j1", results: [{ id: "happy", verdict: "PASS" }] });
    expect(await s.getJob("j1")).toEqual({ id: "j1", results: [{ id: "happy", verdict: "PASS" }] });
  });
});

describe("cost endpoints answer only our own page (A2)", async () => {
  const { sameOriginJson } = await import("../server/index.ts");
  const req = (h: Record<string, string>) => ({ headers: { host: "cp.example", ...h } }) as any;
  const ok = { "x-cp": "1", "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://cp.example" };
  it("accepts the page's own fetch", () => { expect(sameOriginJson(req(ok))).toBeNull(); });
  it("refuses cross-site pages, plain forms and text/plain bodies", () => {
    expect(sameOriginJson(req({ ...ok, "sec-fetch-site": "cross-site" }))).toMatch(/cross-site/);
    expect(sameOriginJson(req({ ...ok, origin: "https://evil.example" }))).toMatch(/cross-origin/);
    const { "x-cp": _x, ...noHeader } = ok;
    expect(sameOriginJson(req(noHeader))).toMatch(/X-CP/);
    expect(sameOriginJson(req({ ...ok, "content-type": "text/plain" }))).toMatch(/Content-Type/);
  });
});

describe("webhook listener: forged POSTs cost no PayPal call, and verified ones have an overall budget (A3)", () => {
  const env = { PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "id-999999", PAYPAL_CLIENT_SECRET: "secret-999999", PAYPAL_WEBHOOK_ID: "WH-1" };
  const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-10-17T10:00:00Z" };
  const body = JSON.stringify({ id: "WH-EV-1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  it("refuses look-alike cert hosts and other algorithms locally", async () => {
    let n = 0; const f = (async () => { n++; return new Response("{}"); }) as any;
    expect(await verifyWebhook({ ...headers, "paypal-cert-url": "https://evil.paypal.com/c" }, body, env, f)).toMatchObject({ status: "rejected" });
    expect(await verifyWebhook({ ...headers, "paypal-auth-algo": "none" }, body, env, f)).toMatchObject({ status: "rejected" });
    expect(n).toBe(0);
  });
  it("answers 429 without calling PayPal once the budget is spent", async () => {
    _resetTokenCache();
    let n = 0; const f = (async () => { n++; return new Response("{}"); }) as any;
    expect(await verifyWebhook(headers, body, env, f, () => false)).toMatchObject({ status: "busy", http: 429 });
    expect(n).toBe(0);
  });
});

describe("scan size limits (A2)", () => {
  it("refuses a repo with too many files with too-large (413)", async () => {
    const { LIMITS } = await import("../server/scan-repo.ts");
    const many = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ name: `o-r-abc1234/f${i}.txt`, body: "" }));
    expect(() => scanTarGz(zlib.gzipSync(tar(many)), { repo: "o/r", ref: "HEAD" })).toThrow(/more than/);
  });
});
