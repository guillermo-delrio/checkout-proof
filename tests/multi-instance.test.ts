// 21 Oct incident (job b20d1503): Cloud Run ran a second instance next to the one running a live re-run. PayPal's
// deliveries went to the second one (no shop there), a client looping on ?wait=20 spun against it (answered at once),
// and the run's instance was stopped. Two server instances here share one in-memory store, as two Cloud Run
// instances share Firestore.
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { Rerun } from "../server/rerun.ts";
import { MemoryStore } from "../server/store.ts";
import { createServer } from "../server/index.ts";

const fakeSpawn = () => { const p: any = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}; return p; };
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const open: http.Server[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });
const verified = async (_h: any, raw: string) => { const e = JSON.parse(raw); return { status: "verified" as const, http: 200 as const, eventId: e.id, eventType: e.event_type }; };
const PP = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "tx-1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-10-21T07:28:00Z" };

async function twoInstances(extra: Partial<ConstructorParameters<typeof Rerun>[0]> = {}) {
  const store = new MemoryStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-multi-"));
  const shopGot: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const shop = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { shopGot.push({ headers: req.headers, body: b }); res.writeHead(200); res.end("{}"); }); });
  open.push(shop);
  const shopUrl = `${await listen(shop)}/api/paypal/webhook`;
  let proc: any;
  const opts = { root, mode: "cloud", dailyGlobal: 6, dailyPerVisitor: 1, expected: 18, store, shopWebhookUrl: shopUrl, deliveryPollMs: 20, remotePollMs: 50, ...extra };
  const ra = new Rerun({ ...opts, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
  const rb = new Rerun({ ...opts, spawnImpl: (() => { throw new Error("B runs nothing"); }) as any });
  const a = createServer({ rerun: ra, verify: verified }), b = createServer({ rerun: rb, verify: verified });
  open.push(a, b);
  return { store, root, shopGot, ra, rb, urlA: await listen(a), urlB: await listen(b), proc: () => proc };
}

describe("a second instance during a live run (21 Oct)", () => {
  it("a delivery verified on instance B reaches the shop on instance A, once, byte for byte, and is kept for the replay", async () => {
    const t = await twoInstances();
    const started = await t.ra.start("v1") as any;
    expect(started.ok).toBe(true);
    const raw = '{"id":"WH-77",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"}}';
    const r = await fetch(`${t.urlB}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json", ...PP, cookie: "not=forwarded" }, body: raw });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "verified", stored: true });
    const stored = await t.store.listDeliveries(started.job.id, 0);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ eventId: "WH-77", type: "PAYMENT.CAPTURE.COMPLETED", resourceId: "CAP-1", headers: PP, raw });
    for (let i = 0; i < 100 && t.shopGot.length === 0; i++) await settle(20);
    expect(t.shopGot).toHaveLength(1);
    expect(t.shopGot[0].body).toBe(raw);
    expect(t.shopGot[0].headers["paypal-transmission-sig"]).toBe("sig");
    expect(t.shopGot[0].headers.cookie).toBeUndefined();
    const kept = JSON.parse(fs.readFileSync(path.join(t.root, "out", "webhook-deliveries", started.job.id, "WH-77.json"), "utf8"));
    expect(kept).toEqual({ headers: PP, raw });
    await settle(200);                                   // later polls overlap the window but never hand it over twice
    expect(t.shopGot).toHaveLength(1);
    // A delivery that reaches A itself still goes straight to the shop.
    const r2 = await fetch(`${t.urlA}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json", ...PP }, body: raw.replace("WH-77", "WH-78") });
    expect(await r2.json()).toMatchObject({ status: "verified", shop: 200 });
    expect(t.shopGot).toHaveLength(2);
    t.proc().emit("close", 1);
  });

  it("with no run going, a delivery is only acknowledged (nothing stored)", async () => {
    const t = await twoInstances();
    const r = await fetch(`${t.urlB}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json", ...PP }, body: '{"id":"WH-1","event_type":"X"}' });
    expect(await r.json()).not.toHaveProperty("stored");
  });

  it("?wait=N on the instance that does not run the job waits (re-reading the saved record), and answers on progress", async () => {
    const t = await twoInstances();
    const { job } = await t.ra.start("v1") as any;
    await settle(20);
    let t0 = Date.now();
    let r = await fetch(`${t.urlB}/api/rerun/${job.id}?wait=1`);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);   // honoured, not answered at once
    expect((await r.json()).state).toBe("running");
    // Progress written by A as a scenario finishes is visible on B within the wait.
    t0 = Date.now();
    const pending = fetch(`${t.urlB}/api/rerun/${job.id}?wait=3`);
    await settle(200);
    t.proc().stdout.write("PASS happy\n");
    r = await pending;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect((await r.json()).progress).toEqual([{ id: "happy", verdict: "PASS" }]);
    t.proc().emit("close", 1);
  });

  it("an interrupted run gives the visitor's run (and the day's) back in one write, and says so", async () => {
    const t = await twoInstances();
    const { job } = await t.ra.start("v1") as any;
    expect(await t.ra.start("v1")).toMatchObject({ ok: false });
    const day = `rerun-${new Date().toISOString().slice(0, 10)}`;
    expect(await t.store.read(day)).toEqual({ global: 1, v1: 1 });
    t.proc().stdout.write("PASS happy\n"); await settle();
    await t.ra.interrupt();
    expect(await t.store.read(day)).toEqual({ global: 0, v1: 0 });
    const saved = await t.store.getJob(job.id) as any;
    expect(saved).toMatchObject({ state: "interrupted", refunded: true, progress: [{ id: "happy", verdict: "PASS" }] });
    expect(saved.error).toMatch(/does not count against today's re-runs/);
    expect((await t.rb.status("v1")).kinds.upgraded.leftForYou).toBe(1);
    t.proc().emit("close", 1);
    await settle();
    expect((await t.ra.start("v1")).ok).toBe(true);        // the visitor can run again
  });

  it("the server's hold answers its headers at once, so the holder knows which instance it reached", async () => {
    const t = await twoInstances();
    let token = "";
    const tokenFetch = (async (u: string) => { token = new URL(u).searchParams.get("t")!; return new Promise(() => {}); }) as any;
    const r = new Rerun({ root: t.root, mode: "cloud", dailyGlobal: 6, dailyPerVisitor: 1, expected: 18, store: new MemoryStore(), holdUrl: (id, tk) => `https://svc/api/rerun/${id}/hold?t=${tk}`, fetchImpl: tokenFetch, spawnImpl: ((..._a: any[]) => fakeSpawn()) as any });
    const s = createServer({ rerun: r, verify: verified }); open.push(s);
    const url = await listen(s);
    const { job } = await r.start("v") as any;
    await settle();
    const ac = new AbortController();
    const held = await fetch(`${url}/api/rerun/${job.id}/hold?t=${token}`, { signal: ac.signal });
    expect(held.status).toBe(200);                       // headers out while the run goes on
    expect((await fetch(`${t.urlB}/api/rerun/${job.id}/hold?t=${token}`)).status).toBe(404); // another instance: at once
    ac.abort();
  });
});
