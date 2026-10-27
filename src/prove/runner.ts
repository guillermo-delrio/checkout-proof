import fs from "node:fs";
import path from "node:path";
import { OUT, mkdirp, scrub } from "../env.ts";
import { getTruthJson } from "../paypal/truth.ts";
import { truthFromAny, asPending, asTold, verdict, type PayPalTruth, type ShopState } from "../money/verdict.ts";
import { formatMoney } from "../money/money.ts";
import { getBrowser, closeBrowser, startReturnServer } from "../buyer/buyer.ts";
import { SCENARIOS, HarnessError } from "./scenarios.ts";
import { call as pp } from "../paypal/truth.ts";
import type { Adapter, ShopCall } from "../targets/types.ts";

export interface ScenarioResult {
  id: string; title: string; ref: string; expect: string;
  verdict: "PASS" | "FAIL" | "N/A" | "INCONCLUSIVE"; reasons: string[]; attempts?: number;
  shopOrderId?: string; shopTotal?: string; shopBefore?: string; shopAfter?: string;
  paypal: PayPalTruth[]; calls: ShopCall[]; notes: string[];
  ppLog: any[]; screenshot?: string; seconds: number; error?: string;
  simulated?: string; timeline?: { t: number; step: string; shot?: string }[];
  // Who a FAIL or INCONCLUSIVE is on: the shop (FAIL), our harness or PayPal's sandbox (INCONCLUSIVE).
  cause?: "shop" | "harness" | "paypal";
}
export interface Mutation { name: string; description: string; scenarios: string[] }
export interface RunResult { target: string; variant: string; mode: string; commit?: string; startedAt: string; runDir: string; results: ScenarioResult[]; mutation?: Mutation }

const readLog = (file: string, from: number) => {
  if (!fs.existsSync(file)) return { lines: [], size: from };
  const buf = fs.readFileSync(file);
  return { lines: buf.subarray(from).toString().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } }), size: buf.length };
};

// Playwright's own errors (a sandbox page that did not load, a selector that timed out) come from driving the browser:
// the harness's side, like a buyer timeout.
export const isBrowserError = (e: any) => e?.name === "TimeoutError" || /^(page|locator|frame|browserContext|browser|elementHandle|browserType)\.\w+:/.test(String(e?.message ?? ""));

// After an exception: did the shop's process die (its fault), or is it still answering (the harness's)?
async function shopCrashed(a: Adapter): Promise<string | undefined> {
  if (a.ensureUp) return a.ensureUp().catch(() => "the shop could not be restarted");
  try { await fetch(a.baseUrl, { signal: AbortSignal.timeout(5000) }); return undefined; } catch { return "shop process stopped answering"; }
}

// CP_REFUND_AFTER=1 (the live "watch the original lose money" run): every capture a scenario left COMPLETED is
// refunded once PayPal's record is read, so the sandbox buyer gets the money back. The verdict is already taken.
async function refundAll(ppOrders: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ppOrders) {
    const g = await pp("GET", `/v2/checkout/orders/${id}`);
    for (const c of (g.json?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []).filter((c: any) => c.status === "COMPLETED")) {
      const rf = await pp("POST", `/v2/payments/captures/${c.id}/refund`, {}, { "PayPal-Request-Id": `cp-refund-${c.id}` });
      out.push(`harness refunded ${c.id} (${c.amount?.value} ${c.amount?.currency_code}) after the verdict: HTTP ${rf.status}, refund ${rf.json?.id} ${rf.json?.status}`);
    }
  }
  return out;
}

export async function runProof(a: Adapter, runDir: string, only?: string[], commit?: string, mutation?: Mutation): Promise<RunResult> {
  startReturnServer();
  const shotDir = mkdirp(path.join(runDir, "shots"));
  const results: ScenarioResult[] = [];
  await a.start();
  try {
    for (const s of a.scenarios ?? SCENARIOS) {
      if (only && !only.includes(s.id)) continue;
      const base = { id: s.id, title: s.title, ref: s.ref, expect: s.expect, paypal: [], calls: [], notes: [], ppLog: [], reasons: [] as string[] };
      if (a.unsupported[s.id]) { results.push({ ...base, verdict: "N/A", reasons: [a.unsupported[s.id]], seconds: 0 }); continue; }
      for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      let logPos = fs.existsSync(a.ppLogFile) ? fs.statSync(a.ppLogFile).size : 0;
      let appPos = fs.existsSync(a.appLogFile) ? fs.statSync(a.appLogFile).size : 0;
      const r: ScenarioResult = { ...base, paypal: [], calls: [], notes: [], ppLog: [], reasons: [], verdict: "FAIL", seconds: 0 };
      try {
        let orderId = "";
        if (!s.selfOrder) {
          // Setting up the shop order is the harness's step: if it throws, nothing about the shop's payment code is known.
          try {
            const o = await a.newShopOrder();
            orderId = o.id; r.shopTotal = formatMoney(o.total);
            const before: ShopState = await a.shopState(o.id);
            r.shopBefore = before.rawStatus;
          } catch (e: any) { throw new HarnessError(`could not set up a shop order: ${String(e?.message || e)}`); }
        } else r.shopBefore = "new";
        const facts = await s.run(a, orderId, shotDir);
        if (s.selfOrder) orderId = facts.shopOrderId ?? "";
        r.shopOrderId = orderId || undefined;
        await new Promise((res) => setTimeout(res, 1500)); // let async confirms settle
        const after = await a.shopState(orderId);
        if (s.selfOrder) r.shopTotal = after.rawStatus === "no order" ? undefined : formatMoney(after.total);
        r.shopAfter = after.rawStatus;
        r.calls = facts.calls; r.notes = facts.notes; r.timeline = facts.timeline;
        r.paypal = [];
        // Reading PayPal's record is the harness's step: a network error there says nothing about the shop.
        for (const id of facts.ppOrders.filter(Boolean)) {
          let g;
          try { g = await getTruthJson(id); } catch (e: any) { throw new HarnessError(`could not read PayPal's record of ${id}: ${String(e?.message || e)}`); }
          if (g.status === 200) r.paypal.push(truthFromAny(g.json));
          else r.notes.push(`GET ${id}: HTTP ${g.status}`);
        }
        if (facts.after) r.notes.push(...(await facts.after().catch((e) => [`harness clean-up failed: ${scrub(String(e?.message || e)).slice(0, 160)}`])));
        if (process.env.CP_REFUND_AFTER === "1") r.notes.push(...(await refundAll(facts.ppOrders.filter(Boolean)).catch((e) => [`harness refund failed: ${scrub(String(e?.message || e)).slice(0, 160)}`])));
        // Labelled synthetic (SCENARIOS #10b, #11b): judge against what the shop was told; keep PayPal's real record.
        const sim = facts.simulated;
        const judged = sim === "pending" ? r.paypal.map(asPending) : sim ? r.paypal.map((t) => asTold(t, sim)) : r.paypal;
        if (sim) r.simulated = sim === "pending" ? "pending" : [sim.value && `amount ${sim.value}`, sim.currency && `currency ${sim.currency}`].filter(Boolean).join(", ");
        const v = verdict({ expect: s.expect, shop: after, paypal: judged, responses: facts.calls.filter((c) => c.http > 0 && !c.step.startsWith("browser:")).map((c) => c.http), allow5xx: facts.allow5xx?.map((i) => facts.calls.filter((c, k) => k < i && c.http > 0 && !c.step.startsWith("browser:")).length), attack: facts.attack });
        r.verdict = v.verdict; r.reasons = [...v.reasons, ...(facts.extraReasons ?? [])];
        if (facts.extraReasons?.length) r.verdict = "FAIL";
        if (sim === "pending") r.reasons.unshift("SIMULATED pending capture: judged as if PayPal had answered PENDING");
        else if (sim) r.reasons.unshift(`SIMULATED ${r.simulated} on the shop's own order: judged as if PayPal had taken that`);
        // A crashed shop is a failure whatever the money says.
        if (a.ensureUp) { const c = await a.ensureUp(); if (c) { r.verdict = "FAIL"; r.reasons.push(`${c}; restarted for the next scenario`); } }
        else try { await fetch(`${a.baseUrl}/api/orders/${orderId}`); } catch { r.verdict = "FAIL"; r.reasons.push("shop process stopped answering"); }
        if (orderId) {
          r.screenshot = `shots/${s.id}-order-${orderId}.png`;
          if (a.screenshotOrder) await a.screenshotOrder(orderId, path.join(runDir, r.screenshot)).catch(() => {});
          else {
            const page = await (await getBrowser()).newPage();
            await page.goto(a.orderPageUrl(orderId)).catch(() => {});
            await page.waitForTimeout(2500);
            await page.screenshot({ path: path.join(runDir, r.screenshot), fullPage: true }).catch(() => {});
            await page.close();
          }
        }
      } catch (e: any) {
        // Review r2 (sceptic N8): an exception is the shop's FAIL by default (a 5xx or an unparsable answer from the
        // shop throws in the scenario's reads). Only the harness's own steps (buyer, PayPal record, set-up) throw
        // HarnessError, and PayPal's sandbox being slow throws PayPalSlowError: those are INCONCLUSIVE and retried.
        // A dead shop process is always the shop's.
        r.error = scrub(String(e?.stack || e)).slice(0, 600);
        const msg = scrub(String(e?.message || e));
        const crashed = await shopCrashed(a);
        if (crashed) { r.verdict = "FAIL"; r.cause = "shop"; r.reasons = [`${crashed} during the scenario (${msg.slice(0, 160)})`]; }
        else if (e instanceof HarnessError || isBrowserError(e)) { r.verdict = "INCONCLUSIVE"; r.cause = e instanceof HarnessError ? e.cause_ : "harness"; r.reasons = [e.cause_ === "paypal" ? (msg.startsWith("PayPal:") ? msg : `PayPal: ${msg}`).slice(0, 300) : `harness: ${msg.slice(0, 300)}`]; }
        else { r.verdict = "FAIL"; r.cause = "shop"; r.reasons = [`the shop's answer broke the scenario: ${msg.slice(0, 300)}`]; }
      }
      if (r.verdict === "FAIL") r.cause ??= "shop";
      const pl = readLog(a.ppLogFile, logPos); r.ppLog = pl.lines;
      const al = readLog(a.appLogFile, appPos);
      (r as any).shopLogTail = scrub(al.lines.slice(-25).map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")).slice(-3000);
      r.seconds = Math.round((Date.now() - t0) / 100) / 10;
      r.attempts = attempt;
      console.log(`${r.verdict.padEnd(4)} ${s.id.padEnd(20)} ${r.reasons.join(" | ").slice(0, 220)}`);
      if (r.verdict === "INCONCLUSIVE" && attempt < 2) { console.log(`     retrying ${s.id} (harness problem, not the shop's)`); continue; }
      results.push(scrub(r));
      break;
      }
    }
  } finally {
    await a.stop();
    await closeBrowser();
  }
  const run: RunResult = { target: a.target, variant: a.variant, mode: a.mode, commit, startedAt: new Date().toISOString(), runDir: path.relative(OUT, runDir), results, ...(mutation ? { mutation } : {}) };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(scrub(run), null, 2));
  return run;
}
