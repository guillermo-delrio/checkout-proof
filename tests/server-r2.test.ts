// Review r2, part A2: two kinds of live run, caps opened in slices, bounded store reads, runs that survive a closed
// tab or a stopped instance.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Rerun, ORIGINAL_SCENARIOS } from "../server/rerun.ts";
import { MemoryStore } from "../server/store.ts";

const fakeSpawn = () => { const p: any = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => p.emit("close", 1); return p; };
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("watch the original lose money (judge r2 #2)", () => {
  it("runs the original's two scenarios with refunds after, has its own caps, and shares the one slot", async () => {
    let proc: any, args: string[] = [], env: any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 1, expected: 18, original: { dailyGlobal: 1, dailyPerVisitor: 1, expected: 2 }, spawnImpl: ((_c: any, a: any, o: any) => { args = a; env = o.env; return (proc = fakeSpawn()); }) as any });
    const o = await r.start("v1", "original") as any;
    expect(o.ok).toBe(true);
    expect(o.job).toMatchObject({ kind: "original", expectedVerdict: "FAIL", expected: 2 });
    expect(args).toEqual(expect.arrayContaining(["--variant", "original", "--only", ORIGINAL_SCENARIOS.join(",")]));
    expect(env.CP_REFUND_AFTER).toBe("1");
    expect(env.CP_WEBHOOK_LIVE).toBeUndefined();
    expect(r.webhookTarget).toBeNull();                    // the original has no webhook route
    expect(await r.start("v2", "upgraded")).toMatchObject({ code: "busy" });
    proc.emit("close", 1); await settle();
    expect(await r.start("v2", "original")).toMatchObject({ code: "daily-cap" });
    const up = await r.start("v1", "upgraded");            // the upgraded run's caps are counted apart
    expect(up.ok).toBe(true);
    proc.emit("close", 1); await settle();
    const st = await r.status("v1");
    expect(st.kinds.original).toMatchObject({ leftToday: 0, expectedVerdict: "FAIL" });
    expect(st.kinds.upgraded).toMatchObject({ leftToday: 1, leftForYou: 0, expectedVerdict: "PASS" });
    const h = await r.history();
    expect(h.byKind.original.done + h.byKind.upgraded.done).toBe(0); // both failed (fake process)
    expect(h.runs.map((x) => x.kind).sort()).toEqual(["original", "upgraded"]);
  });
});

describe("daily caps open in slices of the UTC day (sceptic r2 N3)", () => {
  it("three addresses cannot spend the day at 00:00", async () => {
    let now = Date.parse("2026-10-20T00:05:00Z");
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "local", dailyGlobal: 6, dailyPerVisitor: 1, expected: 18, slices: 4, now: () => now, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    for (const v of ["a", "b"]) { expect((await r.start(v)).ok).toBe(true); proc.emit("close", 1); await settle(); }
    const third = await r.start("c");
    expect(third).toMatchObject({ code: "slice-cap" });
    expect((third as any).error).toMatch(/06:00 UTC/);
    expect((await r.status("c")).kinds.upgraded).toMatchObject({ leftToday: 4, leftNow: 0, nextSliceAt: "2026-10-20T06:00:00.000Z" });
    now = Date.parse("2026-10-20T18:00:00Z");
    expect(r.openNow(6)).toEqual({ open: 6, nextAt: null });
    expect((await r.start("c")).ok).toBe(true); proc.emit("close", 1);
  });
  it("caps of 3 and 6 in 4 slices (review r3 A2; the deploy since 28 Oct is in \"judges only\") open 1/2/3/3 and 2/3/5/6", () => {
    let now = 0;
    const r = new Rerun({ root: "/x", mode: "local", dailyGlobal: 3, dailyPerVisitor: 1, expected: 18, slices: 4, now: () => now });
    const at = (h: string, daily: number) => { now = Date.parse(`2026-11-02T${h}:00Z`); return r.openNow(daily).open; };
    expect(["00:05", "06:00", "12:00", "18:00", "23:59"].map((h) => at(h, 3))).toEqual([1, 2, 3, 3, 3]);
    expect(["00:05", "06:00", "12:00", "18:00"].map((h) => at(h, 6))).toEqual([2, 3, 5, 6]);
  });
});

describe("store reads stay bounded (sceptic r2 N3)", () => {
  it("history is cached for a minute, and an unknown run id costs no job read", async () => {
    const store = new MemoryStore();
    let lists = 0, gets = 0;
    const counted = Object.assign(Object.create(store), { listJobs: (n: number) => { lists++; return store.listJobs(n); }, getJob: (id: string) => { gets++; return store.getJob(id); } });
    let now = Date.parse("2026-10-20T10:00:00Z");
    const r = new Rerun({ root: "/x", mode: "local", dailyGlobal: 2, dailyPerVisitor: 2, expected: 18, store: counted, now: () => now });
    for (let i = 0; i < 50; i++) await r.history();
    expect(lists).toBe(1);
    for (let i = 0; i < 50; i++) expect(await r.find("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(gets).toBe(0);
    expect(lists).toBe(1);
    now += 61_000; await r.history();
    expect(lists).toBe(2);
  });
});

describe("a run outlives a closed tab and leaves a record when the instance stops (sceptic r2 N7)", () => {
  it("is saved as running at start, and as interrupted on SIGTERM", async () => {
    const store = new MemoryStore();
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 2, expected: 18, store, spawnImpl: ((..._a: any[]) => (proc = Object.assign(fakeSpawn(), { kill: () => {} }))) as any });
    const a = await r.start("v") as any;
    await settle();
    expect(await store.getJob(a.job.id)).toMatchObject({ state: "running" });
    proc.stdout.write("PASS happy\n"); await settle();
    await r.interrupt();
    expect(await store.getJob(a.job.id)).toMatchObject({ state: "interrupted", progress: [{ id: "happy", verdict: "PASS" }] });
    expect(await store.leaseHolder("rerun")).toBeNull();
    proc.emit("close", 1); await settle();
    expect(await store.getJob(a.job.id)).toMatchObject({ state: "interrupted" }); // not overwritten as failed
  });
  it("a run still 'running' long after any run can last is listed as interrupted", async () => {
    const store = new MemoryStore();
    await store.putJob("j1", { id: "j1", state: "running", startedAt: "2026-10-20T09:00:00.000Z" }, {});
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 2, expected: 18, store, now: () => Date.parse("2026-10-20T10:00:00Z") });
    expect((await r.history()).runs[0]).toMatchObject({ id: "j1", state: "interrupted", kind: "upgraded" });
  });
  it("holds a request to itself while the run goes on; a request without the run's token is not held", async () => {
    const urls: string[] = [];
    let proc: any, release!: () => void;
    const fetchImpl = ((u: string) => { urls.push(u); return new Promise((res) => { release = () => res(new Response(null, { status: 204 })); }); }) as any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 2, dailyPerVisitor: 2, expected: 18, holdUrl: (id, t) => `https://svc/api/rerun/${id}/hold?t=${t}`, fetchImpl, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    const a = await r.start("v") as any;
    expect(a.job.heldByServer).toBe(true);
    expect(urls).toHaveLength(1);
    const token = new URL(urls[0]).searchParams.get("t")!;
    expect(await r.hold(a.job.id, "wrong", 10)).toBe(false);
    const held = r.hold(a.job.id, token, 60_000);
    let done = false; void held.then(() => (done = true));
    await settle(); expect(done).toBe(false);          // held while the run goes on
    proc.emit("close", 1);
    expect(await held).toBe(true);                      // answered when the run ends
    release();
  });
});

describe("judges only (owner, 28 Oct): a code to start a run, and hard monthly caps", () => {
  it("refuses a run without the code or with a wrong one, and says so in the status", async () => {
    let proc: any;
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 10, dailyPerVisitor: 5, expected: 18, judgeCode: "K7QX-29TM", spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    expect((await r.status("v1")).judgesOnly).toBe(true);
    expect(await r.start("v1", "upgraded")).toMatchObject({ http: 403, code: "judges-only" });
    expect(await r.start("v1", "upgraded", "wrong")).toMatchObject({ http: 403, code: "judges-only" });
    expect((await r.status("v1")).kinds.upgraded.leftToday).toBe(10);   // a refused code spends nothing
    expect((await r.start("v1", "upgraded", " k7qx-29tm ")).ok).toBe(true); // case and spaces forgiven
    proc.emit("close", 1);
  });
  it("without a code configured, anyone can start a run (local and older deploys)", async () => {
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 1, dailyPerVisitor: 1, expected: 18, spawnImpl: ((..._a: any[]) => fakeSpawn()) as any });
    expect((await r.status("v1")).judgesOnly).toBe(false);
    expect((await r.start("v1")).ok).toBe(true);
  });
  it("the monthly cap holds across days, gives the day's count back when it refuses, and resets with the month", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z"), proc: any;
    const store = new MemoryStore(() => now);
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 10, dailyPerVisitor: 10, expected: 18, monthly: { upgraded: 2 }, store, now: () => now, spawnImpl: ((..._a: any[]) => (proc = fakeSpawn())) as any });
    expect((await r.start("v1")).ok).toBe(true); proc.emit("close", 1); await settle();
    now = Date.parse("2026-11-02T10:00:00Z");
    expect((await r.start("v1")).ok).toBe(true); proc.emit("close", 1); await settle();
    expect(await r.start("v1")).toMatchObject({ http: 429, code: "month-cap" });
    expect((await store.read("rerun-2026-11-02")).global).toBe(1);        // the refused run is not counted for the day
    expect((await r.start("v1", "original")).ok).toBe(true);              // the original has no monthly cap here
    proc.emit("close", 1); await settle();
    now = Date.parse("2026-12-01T00:30:00Z");
    expect((await r.start("v1")).ok).toBe(true); proc.emit("close", 1);
  });
  it("a run lost to a stopped instance is given back to the month too", async () => {
    const store = new MemoryStore();
    const r = new Rerun({ root: "/x", mode: "cloud", dailyGlobal: 10, dailyPerVisitor: 10, expected: 18, monthly: { upgraded: 5 }, store, spawnImpl: ((..._a: any[]) => { const p = fakeSpawn(); p.kill = () => {}; return p; }) as any });
    expect((await r.start("v1")).ok).toBe(true);
    const doc = Object.keys((store as any).docs ? Object.fromEntries((store as any).docs) : {}).find((k) => k.startsWith("rerun-month-"))!;
    expect((await store.read(doc)).global).toBe(1);
    await r.interrupt();
    expect((await store.read(doc)).global).toBe(0);
  });
  it("the deploy carries the judges' caps: 10 a day each, 70 upgraded and 60 original a month, the code from Secret Manager", () => {
    const deploy = readFileSync(new URL("../ops/deploy.sh", import.meta.url), "utf8");
    for (const v of ["CP_RERUN_DAILY=10,", "CP_ORIGINAL_DAILY=10,", "CP_RERUN_MONTHLY=70,", "CP_ORIGINAL_MONTHLY=60,", "CP_RERUN_SLICES=1,"]) expect(deploy).toContain(v);
    expect(deploy).toMatch(/CP_JUDGE_CODE=CP_JUDGE_CODE:latest/);
  });
});
