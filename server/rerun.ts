// Live proof runs from the site. No model calls: each spawns `cp prove`, which only drives a shop, the sandbox buyer
// and PayPal's sandbox. Two kinds share one slot (one proof at a time across instances) and have their own caps:
//   upgraded: the upgraded simple-clothing-store (demo mode), every scenario. Expected: green.
//   original: "watch the original lose money": the original simple-clothing-store (demo mode), scenarios two-tabs and
//             currency only (~1-2 min). Expected: both FAIL. Every capture is refunded afterwards (CP_REFUND_AFTER).
//
// CP_RERUN=local (this machine) or CP_RERUN=cloud (the Cloud Run image, which carries both built work copies,
// Playwright's headless Chromium and the sandbox buyer from Secret Manager) enables it. Anything else answers
// "coming in M4".
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { MemoryStore, utcDay, type Store, type Delivery } from "./store.ts";
import { keepDelivery, forwardToShop, paypalHeaders } from "./webhook.ts";
import { TtlCache, MINUTE } from "./limits.ts";
import { scrub } from "../src/env.ts";

export type Kind = "upgraded" | "original";
export type JobState = "running" | "done" | "failed" | "interrupted";
export interface RerunScenario { id: string; title: string; ref?: string; expect?: string; verdict: string; reasons: string[]; cause?: string; paypal: { orderId: string; status: string; captures: { id: string; status: string; amount: string }[] }[]; shopOrderId?: string; shopBefore?: string; shopAfter?: string; seconds: number; notes?: string[]; calls?: { step: string; http: number }[]; timeline?: { t: number; step: string }[] }
export interface RerunJob { id: string; kind: Kind; state: JobState; startedAt: string; finishedAt?: string; progress: { id: string; verdict: string }[]; expected: number; expectedVerdict: "PASS" | "FAIL"; results?: RerunScenario[]; error?: string; commit?: string; heldByServer?: boolean; refunded?: boolean }

const money = (m: { minor: number; currency: string }) => `${(m.minor / 100).toFixed(2)} ${m.currency}`;

export interface KindCaps { dailyGlobal: number; dailyPerVisitor: number; expected: number }
export interface RerunOptions {
  root: string; mode: string; dailyGlobal: number; dailyPerVisitor: number; expected: number;
  original?: KindCaps;                 // caps of "watch the original lose money" (default: 6/day, 2 per visitor)
  slices?: number;                     // the daily caps open in this many equal slices of the UTC day (1 = all at 00:00)
  // Judges only (28 Oct, owner): with a code set, a run starts only with that code (given to the judges in Devpost's
  // private testing instructions); everyone else sees the saved runs. `monthly`: a hard cap per kind and calendar
  // month (the EUR 2 budget is monthly too), counted in the store like the daily caps, so a leaked code is bounded.
  judgeCode?: string;
  monthly?: Partial<Record<Kind, number>>;
  spawnImpl?: typeof spawn; shopWebhookUrl?: string; store?: Store; now?: () => number;
  // Cloud Run gives an instance CPU only while a request is open. When set, the server keeps one request to itself
  // open through the service's public URL for as long as a run goes on, so a run finishes even if the tab is closed.
  holdUrl?: (jobId: string, token: string) => string;
  fetchImpl?: typeof fetch;
  deliveryPollMs?: number;             // how often the running instance looks for deliveries another instance stored (2 s)
  remotePollMs?: number;               // how often a long poll on an instance that does not run the job re-reads it (5 s)
}

const LEASE = "rerun", STALL_MS = 16 * 60_000;
/** How long one held request lasts: longer than any run (the process is stopped at 15 min), shorter than the service's
 *  request timeout (ops/deploy.sh --timeout 1200). */
export const HOLD_MS = 17 * 60_000;
export const ORIGINAL_SCENARIOS = ["two-tabs", "currency"];
const tallyOf = (results: { verdict: string }[] = []) => results.reduce<Record<string, number>>((t, r) => { const k = r.verdict.replace("/", ""); t[k] = (t[k] ?? 0) + 1; return t; }, {});
const HISTORY_TTL = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Deliveries kept per job by an instance that does not run it (PayPal's retries included): a backlog cannot turn
// into unbounded store writes.
const MAX_STORED_DELIVERIES = 300, FORWARD_TRIES = 5, DELIVERY_OVERLAP_MS = 15_000;

export class Rerun {
  private jobs = new Map<string, RerunJob>();
  private current: { job: RerunJob; proc: ChildProcess; token: string; visitor: string; day: string; month: string | null } | null = null;
  readonly store: Store;
  private statusCache: { at: number; day: string; counts: Record<Kind, Record<string, number>>; holder: string | null } | null = null;
  private historyCache: { at: number; value: Awaited<ReturnType<Rerun["loadHistory"]>> } | null = null;
  private fullJobs = new TtlCache<RerunJob>(10 * MINUTE, 50);
  // A running job read from the store (another instance runs it): shared by every waiting request for 3 s.
  private remoteJobs = new TtlCache<RerunJob>(3_000, 20);
  private remoteReads = new Map<string, Promise<RerunJob | undefined>>();
  private holderCache: { at: number; v: string | null } | null = null;
  private storedFor = new Map<string, number>();
  private saving = new Map<string, Promise<void>>();
  private now: () => number;
  constructor(private o: RerunOptions) {
    this.store = o.store ?? new MemoryStore();
    this.now = o.now ?? Date.now;
  }
  get enabled() { return this.o.mode === "local" || this.o.mode === "cloud"; }
  private caps(kind: Kind): KindCaps {
    return kind === "original" ? (this.o.original ?? { dailyGlobal: 6, dailyPerVisitor: 2, expected: ORIGINAL_SCENARIOS.length }) : { dailyGlobal: this.o.dailyGlobal, dailyPerVisitor: this.o.dailyPerVisitor, expected: this.o.expected };
  }
  private dayDoc(kind: Kind) { return `${kind === "original" ? "original" : "rerun"}-${utcDay(this.now())}`; }
  private monthDoc(kind: Kind) { return `${kind === "original" ? "original" : "rerun"}-month-${utcDay(this.now()).slice(0, 7)}`; }
  get judgesOnly() { return !!this.o.judgeCode; }
  /** A code check that takes the same time whatever the guess (both sides hashed to one length). */
  codeOk(code: unknown) {
    if (!this.o.judgeCode) return true;
    const h = (x: string) => createHash("sha256").update(x.trim().toUpperCase()).digest();
    return typeof code === "string" && timingSafeEqual(h(code), h(this.o.judgeCode));
  }
  /** How many of the day's runs are open by now: the cap opens in `slices` equal steps over the UTC day, so a few
   *  addresses cannot spend a whole day at 00:00 (review r2, sceptic N3). */
  openNow(daily: number): { open: number; nextAt: string | null } {
    const slices = Math.max(1, this.o.slices ?? 1);
    const t = this.now(), dayStart = Date.parse(utcDay(t) + "T00:00:00Z"), len = 86_400_000 / slices;
    const k = Math.min(slices - 1, Math.floor((t - dayStart) / len));
    const open = Math.min(daily, Math.ceil((daily * (k + 1)) / slices));
    return { open, nextAt: k + 1 < slices ? new Date(dayStart + (k + 1) * len).toISOString() : null };
  }
  // The daily caps and the one-at-a-time slot live in the store, so a restart, a deploy or a second instance sees the
  // same counts. Status reads are cached for 10 s per instance (a page load costs no write and at most three reads).
  async status(visitorKey: string) {
    if (this.current && this.now() - Date.parse(this.current.job.startedAt) > STALL_MS) this.current.proc.kill("SIGKILL");
    const day = utcDay(this.now());
    if (!this.statusCache || this.statusCache.day !== day || this.now() - this.statusCache.at > 10_000) {
      const [up, orig, holder] = await Promise.all([this.store.read(this.dayDoc("upgraded")), this.store.read(this.dayDoc("original")), this.store.leaseHolder(LEASE)]);
      this.statusCache = { at: this.now(), day, counts: { upgraded: up, original: orig }, holder };
    }
    const { counts, holder } = this.statusCache;
    const running = this.current?.job.id ?? holder;
    const kindStatus = (kind: Kind) => {
      const c = this.caps(kind), used = counts[kind].global ?? 0, slice = this.openNow(c.dailyGlobal);
      const leftToday = Math.max(0, c.dailyGlobal - used), leftNow = Math.max(0, slice.open - used);
      return { leftToday, leftForYou: Math.max(0, c.dailyPerVisitor - (counts[kind][visitorKey] ?? 0)), leftNow, nextSliceAt: leftNow === 0 && leftToday > 0 ? slice.nextAt : null, caps: { daily: c.dailyGlobal, perVisitor: c.dailyPerVisitor, resets: "00:00 UTC" }, expected: c.expected, expectedVerdict: kind === "original" ? "FAIL" : "PASS" };
    };
    const up = kindStatus("upgraded");
    return {
      enabled: this.enabled, mode: this.o.mode,
      busy: !!running, runningJob: running, runningKind: this.current?.job.kind ?? null, judgesOnly: this.judgesOnly,
      leftToday: up.leftToday, leftForYou: up.leftForYou,
      caps: up.caps,
      kinds: { upgraded: up, original: kindStatus("original") },
      store: this.store.kind,
    };
  }
  private async loadHistory(limit: number) {
    const rows: Record<string, any>[] = (await this.store.listJobs(limit)).map((r: Record<string, any>) => {
      // A run whose instance died without a word: still "running" long after any run can last.
      const k = { ...r, kind: r.kind ?? "upgraded" };
      return r.state === "running" && this.now() - Date.parse(String(r.startedAt)) > STALL_MS + 2 * MINUTE && r.id !== this.current?.job.id ? { ...k, state: "interrupted" } : k;
    });
    const by = (kind: Kind) => {
      const done = rows.filter((r) => r.state === "done" && (r.kind ?? "upgraded") === kind);
      const tally = done.reduce<Record<string, number>>((t, r) => { for (const [k, v] of Object.entries((r.tally ?? {}) as Record<string, number>)) t[k] = (t[k] ?? 0) + v; return t; }, {});
      return { done: done.length, tally };
    };
    const up = by("upgraded");
    // `done` and `tally` count the upgraded shop only: the original's expected reds never mix into the green counts.
    return { runs: rows, saved: rows.length, done: up.done, tally: up.tally, byKind: { upgraded: up, original: by("original") } };
  }
  /** Saved live runs, newest first: what the site's live-run counts are allowed to say. Cached 60 s per instance
   *  (one Firestore read per saved job, so a flood of page loads must not reach the store). */
  async history(limit = 50) {
    if (!this.historyCache || this.now() - this.historyCache.at > HISTORY_TTL) this.historyCache = { at: this.now(), value: await this.loadHistory(limit) };
    return this.historyCache.value;
  }
  get(id: string) { return this.jobs.get(id); }
  /** The job holding the proof slot on any instance (cached 5 s: one store read per 5 s however many ask). */
  private async holder(): Promise<string | null> {
    if (!this.holderCache || this.now() - this.holderCache.at > 5_000) this.holderCache = { at: this.now(), v: await this.store.leaseHolder(LEASE) };
    return this.holderCache.v;
  }
  /** A job from this instance, or one saved by any instance. Only ids the saved history lists are read from the
   *  store (an unknown id costs no read); finished jobs are cached, since they never change. */
  async find(id: string): Promise<RerunJob | undefined> {
    const mine = this.jobs.get(id);
    if (mine) return mine;
    const cached = this.fullJobs.get(id);
    if (cached) return cached;
    let h = await this.history().catch(() => undefined);
    // A miss reloads the history only for the run going on now (just started on another instance, so not yet in this
    // instance's cached history). Unknown ids never do: review r3 A4, a script of made-up ids cost a reload every 10 s.
    if (h && !h.runs.some((r) => r.id === id) && this.historyCache && this.now() - this.historyCache.at > 2_000 && (await this.holder().catch(() => null)) === id) { this.historyCache = null; h = await this.history().catch(() => undefined); }
    if (!h?.runs.some((r) => r.id === id)) return undefined;
    const recent = this.remoteJobs.get(id);
    if (recent) return recent;
    let p = this.remoteReads.get(id);
    if (!p) {
      p = (async () => {
        const raw = (await this.store.getJob(id).catch(() => undefined)) as RerunJob | undefined;
        if (!raw) return undefined;
        let j: RerunJob = { ...raw, kind: raw.kind ?? "upgraded", expectedVerdict: raw.expectedVerdict ?? "PASS" };
        // An instance that died without a word leaves "running" behind: past any run's length it is interrupted.
        if (j.state === "running" && this.now() - Date.parse(j.startedAt) > STALL_MS + 2 * MINUTE) j = { ...j, state: "interrupted", error: "The server stopped during this run. Scenarios that had finished are listed." };
        if (j.state !== "running") this.fullJobs.set(id, j); else this.remoteJobs.set(id, j);
        return j;
      })().finally(() => this.remoteReads.delete(id));
      this.remoteReads.set(id, p);
    }
    return p;
  }
  /** Long poll from any instance: on the one running the job it answers on progress (in memory); elsewhere it re-reads
   *  the saved record every few seconds (shared, cached reads) and answers on new progress, the end, or after `ms`.
   *  Either way it never answers a running job at once, so a client looping on it cannot spin (21 Oct incident). */
  async waitAny(id: string, ms: number): Promise<RerunJob | undefined> {
    if (this.jobs.has(id)) return this.wait(id, ms);
    const t0 = Date.now();
    let j = await this.find(id);
    if (!j || j.state !== "running") return j;
    const seen = j.progress?.length ?? 0, step = this.o.remotePollMs ?? 5_000;
    for (let left = ms - (Date.now() - t0); left > 0; left = ms - (Date.now() - t0)) {
      await sleep(Math.min(step, left));
      j = (await this.find(id)) ?? j;
      if (j.state !== "running" || (j.progress?.length ?? 0) !== seen) return j;
    }
    return j;
  }
  // Where verified PayPal deliveries go while a re-run's shop is up (the upgraded simple-clothing-store's own
  // webhook route on its demo port); null between runs and during the original's runs (it has no webhook route).
  // logDir: each verified delivery is also kept there (PayPal's headers and the raw body, inside the container only),
  // so a scenario can replay a genuine delivery byte for byte: a replay PayPal's verification still accepts.
  /** A verified PayPal delivery, on whichever instance PayPal reached. The instance running an upgraded job passes it
   *  straight to its shop. Any other instance stores it under the running job (the lease holder) and the running
   *  instance picks it up within seconds (pullDeliveries); with nothing running it is only acknowledged. */
  async deliver(headers: Record<string, string | string[] | undefined>, raw: string, eventId: string, type: string): Promise<{ via: "shop"; shop: number } | { via: "store"; job: string } | { via: "none" }> {
    const t = this.webhookTarget;
    if (t) {
      try { keepDelivery(t.logDir, eventId, headers, raw); } catch { /* the replay check reports a missing file */ }
      return { via: "shop", shop: await forwardToShop(t.url, headers, raw, this.o.fetchImpl ?? fetch) };
    }
    if (this.current) return { via: "none" };   // this instance runs the original, which has no webhook route
    const job = await this.holder();
    if (!job) return { via: "none" };
    const n = this.storedFor.get(job) ?? 0;
    if (n >= MAX_STORED_DELIVERIES) return { via: "none" };
    this.storedFor.set(job, n + 1);
    if (this.storedFor.size > 50) this.storedFor.delete(this.storedFor.keys().next().value!);
    const h = paypalHeaders(headers);
    let resourceId = "";
    try { resourceId = String(JSON.parse(raw)?.resource?.id ?? ""); } catch { /* verified bodies are JSON */ }
    const id = `${this.now()}-${(h["paypal-transmission-id"] || eventId).replace(/[^\w-]/g, "_").slice(0, 80)}`;
    await this.store.putDelivery(job, { id, at: this.now(), eventId, type, resourceId, headers: h, raw });
    return { via: "store", job };
  }
  /** On the instance running an upgraded job: passes deliveries another instance stored to the shop, each once (a
   *  failed hand-over is tried again, up to 5 times). One store query every 2 s while the run goes on. */
  private pullDeliveries(job: RerunJob) {
    if (job.kind !== "upgraded") return;
    const tries = new Map<string, number>();   // id -> failed tries; -1 once the shop took it
    let since = Date.parse(job.startedAt) - 60_000, warned = 0;
    void (async () => {
      while (job.state === "running") {
        await sleep(this.o.deliveryPollMs ?? 2_000);
        const t = this.current?.job === job ? this.webhookTarget : null;
        if (!t || job.state !== "running") break;
        try {
          const list: Delivery[] = await this.store.listDeliveries(job.id, since);
          let oldestOpen = Infinity, newest = since;
          for (const d of list) {
            newest = Math.max(newest, d.at);
            const n = tries.get(d.id) ?? 0;
            if (n < 0 || n >= FORWARD_TRIES) continue;
            try { keepDelivery(t.logDir, d.eventId, d.headers, d.raw); } catch { /* reported by the replay check */ }
            const shop = await forwardToShop(t.url, d.headers, d.raw, this.o.fetchImpl ?? fetch);
            if (shop > 0 && shop < 500) tries.set(d.id, -1);
            else { tries.set(d.id, n + 1); if (n + 1 < FORWARD_TRIES) oldestOpen = Math.min(oldestOpen, d.at); }
          }
          // Next query: from the oldest delivery still to hand over, or a short overlap before the newest seen (a write
          // from another instance can land a little late); the seen ids keep each hand-over to one.
          since = Math.max(since, Math.min(oldestOpen - 1, newest - DELIVERY_OVERLAP_MS));
        } catch (e: any) {
          if (this.now() - warned > MINUTE) { warned = this.now(); console.error(`re-run ${job.id}: could not read stored deliveries (${e?.message ?? e})`); }
        }
      }
    })();
  }
  get webhookTarget() { return this.current && this.current.job.kind === "upgraded" ? { url: this.o.shopWebhookUrl ?? "http://127.0.0.1:3302/api/paypal/webhook", logDir: this.deliveryDir(this.current.job.id) } : null; }
  private deliveryDir(jobId: string) { return path.join(this.o.root, "out", "webhook-deliveries", jobId); }
  // Long poll: resolves when the job reports progress or finishes, or after `ms`. On Cloud Run (request-based
  // billing) the instance only gets CPU while a request is open: the page keeps one open, and so does the server.
  wait(id: string, ms: number, untilDone = false): Promise<RerunJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return Promise.resolve(job);
    const seen = job.progress.length;
    return new Promise((resolve) => {
      const t0 = this.now();
      const tick = () => {
        if (job.state !== "running" || (!untilDone && job.progress.length !== seen) || this.now() - t0 >= ms) return resolve(job);
        setTimeout(tick, 250);
      };
      tick();
    });
  }
  /** The server's own held request (GET /api/rerun/:id/hold?t=…): answered when the run ends or after `ms`. Anyone
   *  without the run's token gets nothing held. */
  canHold(id: string, token: string) { return !!this.current && this.current.job.id === id && this.current.token === token; }
  async hold(id: string, token: string, ms: number): Promise<boolean> {
    if (!this.canHold(id, token)) return false;
    await this.wait(id, ms, true);
    return true;
  }
  // One held request for the whole run (the service's request timeout is longer than any run). On 21 Oct a run was
  // lost in the gap between two 280 s holds: a second instance had appeared, the re-opened hold went to it, and Cloud
  // Run stopped the run's instance, idle for that moment. So: the holder answers its headers at once (2xx = held here,
  // 404 = it reached another instance, tried again in 1 s), and the affinity cookie from a held answer is sent on
  // every later hold, so they reach this instance.
  private keepCpu(job: RerunJob, token: string) {
    if (!this.o.holdUrl) return;
    const url = this.o.holdUrl(job.id, token), f = this.o.fetchImpl ?? fetch;
    job.heldByServer = true;
    let cookie = "", misses = 0;
    void (async () => {
      while (job.state === "running") {
        const t0 = this.now();
        let held = false;
        try {
          const r = await f(url, { signal: AbortSignal.timeout(HOLD_MS + 60_000), ...(cookie ? { headers: { cookie } } : {}) });
          held = r.status >= 200 && r.status < 300;
          if (held) {
            const set = (r.headers as any)?.getSetCookie?.() as string[] | undefined;
            if (set?.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
            await r.arrayBuffer().catch(() => {});   // the held body ends when the run does
          }
        } catch { /* re-opened below */ }
        misses = held ? 0 : misses + 1;
        if (job.state === "running" && this.now() - t0 < 5_000) await sleep(held || misses < 10 ? 1_000 : 5_000); // never spin
      }
    })();
  }

  async start(visitorKey: string, kind: Kind = "upgraded", judgeCode?: unknown): Promise<{ ok: true; job: RerunJob } | { ok: false; http: number; error: string; code: string }> {
    if (!this.enabled) return { ok: false, http: 503, code: "coming-m4", error: "Re-run proof is not switched on in this deployment yet (milestone 4)." };
    if (!this.codeOk(judgeCode)) return { ok: false, http: 403, code: "judges-only", error: judgeCode ? "That judge code is not right. It is in the submission's testing instructions." : "Live runs are open to the hackathon's judges, with the code in the submission's testing instructions. Every saved run is linked below." };
    const busy = { ok: false as const, http: 409, code: "busy", error: "A proof is already running. Watch it, or try again in a few minutes." };
    if (this.current) return busy;
    const st = await this.status(visitorKey);
    if (st.busy) return busy;
    const caps = this.caps(kind), ks = st.kinds[kind];
    const what = kind === "original" ? "runs of the original" : "re-runs";
    const visitorCap = { ok: false as const, http: 429, code: "visitor-cap", error: `You have used your ${caps.dailyPerVisitor} ${what} for today (the count resets at 00:00 UTC).` };
    const dailyCap = { ok: false as const, http: 429, code: "daily-cap", error: `Today's ${caps.dailyGlobal} ${what} are used up. The cap resets at 00:00 UTC.` };
    const sliceCap = () => ({ ok: false as const, http: 429, code: "slice-cap", error: `The ${what} open so far today are used up; the next one opens at ${this.openNow(caps.dailyGlobal).nextAt?.slice(11, 16)} UTC.` });
    if (ks.leftForYou <= 0) return visitorCap;
    if (ks.leftToday <= 0) return dailyCap;
    if (ks.leftNow <= 0) return sliceCap();
    const id = randomUUID();
    // The slot first (lapses after the stall limit if this instance dies), then both counts in one atomic write.
    if (!(await this.store.lease(LEASE, id, this.now() + STALL_MS + 60_000))) return busy;
    if (this.current) { await this.store.release(LEASE, id); return busy; }
    const open = this.openNow(caps.dailyGlobal).open;
    const t = await this.store.take(this.dayDoc(kind), { global: open, [visitorKey]: caps.dailyPerVisitor }).catch((e) => { this.store.release(LEASE, id).catch(() => {}); throw e; });
    this.statusCache = null;
    if (!t.ok) {
      await this.store.release(LEASE, id);
      return t.over !== "global" ? visitorCap : open < caps.dailyGlobal ? sliceCap() : dailyCap;
    }
    const monthly = this.o.monthly?.[kind];
    if (monthly !== undefined) {
      const m = await this.store.take(this.monthDoc(kind), { global: monthly }).catch(() => ({ ok: false }));
      if (!m.ok) {
        await this.store.give(this.dayDoc(kind), ["global", visitorKey]).catch(() => {});
        await this.store.release(LEASE, id);
        return { ok: false, http: 429, code: "month-cap", error: `This month's ${monthly} ${what} are used up (the demo's budget). Every saved run is linked below.` };
      }
    }
    const job: RerunJob = { id, kind, state: "running", startedAt: new Date(this.now()).toISOString(), progress: [], expected: caps.expected, expectedVerdict: kind === "original" ? "FAIL" : "PASS" };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 200) this.jobs.delete(this.jobs.keys().next().value!);
    const sp = this.o.spawnImpl ?? spawn;
    const args = kind === "original"
      ? ["--import", "tsx", "src/cli.ts", "prove", "simple-clothing-store", "--variant", "original", "--mode", "demo", "--only", ORIGINAL_SCENARIOS.join(",")]
      : ["--import", "tsx", "src/cli.ts", "prove", "simple-clothing-store", "--variant", "upgraded", "--mode", "demo"];
    const env = kind === "original"
      ? { ...process.env, CP_NO_LATEST: "1", CP_ARM: "", CP_REFUND_AFTER: "1" }
      : { ...process.env, CP_NO_LATEST: "1", CP_ARM: "", ...(this.o.mode === "cloud" ? { CP_WEBHOOK_LIVE: "1" } : {}), CP_WEBHOOK_LOG: this.deliveryDir(job.id) };
    const proc = sp(process.execPath, args, { cwd: this.o.root, env, stdio: ["ignore", "pipe", "pipe"] });
    const token = randomUUID();
    this.current = { job, proc, token, visitor: visitorKey, day: this.dayDoc(kind), month: monthly !== undefined ? this.monthDoc(kind) : null };
    this.historyCache = null;
    // Saved as "running" at once: a run lost to a dead instance still leaves a record (review r2, sceptic N7).
    void this.persist(job);
    this.keepCpu(job, token);
    this.pullDeliveries(job);
    let buf = "", runDir = "";
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = line.match(/^(PASS|FAIL|N\/A|INCONCLUSIVE)\s+(\S+)/);
        if (m) job.progress.push({ id: m[2], verdict: m[1] });
        // "retrying <id>" follows an INCONCLUSIVE attempt on its own line: that attempt is not the scenario's result.
        const retry = line.match(/^\s+retrying (\S+)/);
        if (retry && job.progress.at(-1)?.id === retry[1]) job.progress.pop();
        // Progress saved as each scenario finishes (one write each), so any instance can show it.
        if (m || retry) void this.persist(job);
        const r = line.match(/report: out\/(.+)\/REPORT\.md/);
        if (r) runDir = r[1];
      }
    });
    // Keep the last few KB of output for the server log when a run fails (scrubbed of credentials first).
    let tail = "";
    const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    proc.stdout!.on("data", keep);
    proc.stderr!.on("data", keep);
    const timer = setTimeout(() => proc.kill("SIGTERM"), 15 * 60_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (this.current?.job === job) this.current = null;
      this.statusCache = null; this.historyCache = null;
      if (job.state === "interrupted") return; // already saved by interrupt()
      job.finishedAt = new Date(this.now()).toISOString();
      try {
        if (!runDir) throw new Error("no report");
        const run = JSON.parse(fs.readFileSync(path.join(this.o.root, "out", runDir, "results.json"), "utf8"));
        job.commit = run.commit;
        job.results = run.results.map((r: any) => ({
          id: r.id, title: r.title, ref: r.ref, expect: r.expect, verdict: r.verdict, reasons: r.reasons, cause: r.cause, shopOrderId: r.shopOrderId, shopBefore: r.shopBefore, shopAfter: r.shopAfter, seconds: r.seconds,
          // Already scrubbed by the runner; sandbox IDs and steps only (the evidence a visitor checks the verdict by).
          notes: r.notes, calls: (r.calls ?? []).map((c: any) => ({ step: c.step, http: c.http })), timeline: r.timeline?.map((t: any) => ({ t: t.t, step: t.step })),
          paypal: r.paypal.map((p: any) => ({ orderId: p.orderId, status: p.status, captures: p.captures.map((c: any) => ({ id: c.id, status: c.status, amount: money(c.amount) })) })),
        }));
        job.state = "done";
      } catch {
        job.state = "failed";
        console.error(`re-run ${job.id} failed (exit ${code}):\n${scrub(tail)}`);
        job.error = code === 0 ? "The run finished without a report." : "The proof run stopped before it finished. Nothing was charged outside the sandbox.";
      }
      void this.persist(job).finally(() => this.store.release(LEASE, job.id).catch(() => {}));
    });
    return { ok: true, job };
  }
  // Every live run is saved whole (verdicts, reasons, sandbox order and capture IDs, steps), so the counts the site
  // states rest on stored results, not on memory. Failures to save are logged, never fatal to the run.
  // Writes of one job go one after another, each with the job as it is then: a late progress write can never land
  // after (and overwrite) the final one.
  persist(job: RerunJob): Promise<void> {
    const write = () => {
      const summary = { id: job.id, kind: job.kind, state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, commit: job.commit ?? null, mode: this.o.mode, tally: tallyOf(job.results), scenarios: job.results?.length ?? 0, expectedVerdict: job.expectedVerdict };
      return this.store.putJob(job.id, summary, JSON.parse(JSON.stringify(job))).catch((e) => console.error(`re-run ${job.id}: could not save the result (${e?.message ?? e})`));
    };
    const p = (this.saving.get(job.id) ?? Promise.resolve()).then(write);
    this.saving.set(job.id, p);
    void p.then(() => { if (this.saving.get(job.id) === p) this.saving.delete(job.id); });
    return p;
  }
  /** SIGTERM (Cloud Run gives 10 s): the running job is saved as interrupted, with what it had, before the exit. */
  async interrupt() {
    const c = this.current;
    if (!c) return;
    c.job.state = "interrupted";
    c.job.finishedAt = new Date(this.now()).toISOString();
    c.job.error = "The server stopped during this run (a deploy or a scale-down). Nothing was charged outside the sandbox; scenarios that had finished are listed. This run was given back: it does not count against today's re-runs.";
    c.job.refunded = true;
    c.proc.kill("SIGTERM");
    // The visitor got no result through no fault of theirs: their run and the day's are given back in one atomic write.
    const refund = Promise.all([this.store.give(c.day, ["global", c.visitor]), c.month ? this.store.give(c.month, ["global"]) : null]).then(() => { this.statusCache = null; }, (e) => {
      console.error(`re-run ${c.job.id}: could not give the run back (${e?.message ?? e})`);
      c.job.refunded = false; c.job.error = c.job.error!.replace(/ This run was given back.*$/, "");
    });
    await Promise.race([refund.then(() => this.persist(c.job)).then(() => this.store.release(LEASE, c.job.id)).catch(() => {}), sleep(7000)]);
  }
  stop() { this.current?.proc.kill("SIGTERM"); }
}
