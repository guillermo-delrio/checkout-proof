// Exports the evidence (latest proof runs, loop logs, upgrade diffs, scans) into static JSON + screenshots for the
// web gallery: web/public/data/. Run before `npm run build` in web/ (npm run export-web).
//
// Disclosure gate: names come from web/targets.config.json. With "names": "alias" (or CP_NAMES=alias) every target
// name and repo URL is replaced by its alias in all exported strings. Screenshots still show the shop's own UI, so
// alias mode also drops screenshots unless "aliasKeepsShots" is true.
//
// Scrubbing: every string passes env.scrub() (client ID, secret, buyer/merchant e-mail and password, tokens), then a
// final check fails the export if any .env value or an e-mail other than the harness's fake buyer@example.com is
// left. Shop logs, PayPal call logs and model transcripts are not exported.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { OUT, ROOT, scrub } from "../src/env.ts";
import { formatMoney, parseMoney } from "../src/money/money.ts";
import { SCENARIOS } from "../src/prove/scenarios.ts";
import { scanDir, type Finding } from "../src/scan/scan.ts";
import { TARGETS } from "../src/targets/index.ts";
import type { RunResult, ScenarioResult } from "../src/prove/runner.ts";
import { fillBlocks, readmeBlocks, scenarioBlocks } from "../web/src/claims.ts";

const WEB = path.join(ROOT, "web");
const DEST = path.join(WEB, "public", "data");
// Everything is written to NEXT and swapped in only when the whole export (checks included) succeeded, so a failed
// export leaves the last good data in place.
const NEXT = path.join(WEB, "public", "data-next");
const config = JSON.parse(fs.readFileSync(path.join(WEB, "targets.config.json"), "utf8"));
const aliasMode = (process.env.CP_NAMES ?? config.names) === "alias";

// ---------- curated copy (claims are checked against the data below; the export fails if they drift) ----------
// `code` is the defect's internal ID (spikes/s3-defects): used for checks here, never shown on a card. `assumed` says
// what part of a story was not observed (shown on the card).
interface Story { headline: (r: ScenarioResult) => string; code?: string; assumed?: string }
const STORIES: Record<string, Record<string, Story>> = {
  expressCart: {
    "cancel-shrink": { code: "E1", headline: (r) => `The buyer paid ${cap(r)}. The shop marked the ${eur(r.shopTotal)} order Paid, with all 8 items in it.` },
    duplicate: { code: "E7", headline: () => "One reload of PayPal's return page crashed the shop process for every customer." },
    "lost-response": { code: "E8", headline: (r) => `The buyer was charged ${cap(r)}. The shop crashed, came back without PayPal credentials, and never marked the order paid.` },
    "pending-simulated": { code: "E2", headline: () => "A pending payment, which is not yet money, was marked Paid." },
  },
  "simple-clothing-store": {
    unapproved: { code: "D1", headline: (r) => `The buyer never approved anything. The shop confirmed the ${eur(r.shopTotal)} order anyway.` },
    currency: { code: "D2", headline: (r) => `A tampered checkout paid ${cap(r)}. The shop confirmed its ${eur(r.shopTotal)} order.` },
    "lost-response": { code: "D3", headline: (r) => `The buyer was charged ${cap(r)}, but the order was never confirmed.` },
    "two-tabs": { headline: (r) => `Two tabs, one order: the buyer was charged twice (${eur(r.paypal.flatMap((p) => p.captures).map((c) => formatMoney(c.amount)).join(" + "))}).` },
    happy: { code: "D7", headline: (r) => `With its Printful hand-off switched on, every paid order stayed unconfirmed: the buyer was charged ${cap(r)}, the order stayed a ${r.shopAfter}.`, assumed: "Assumed: Printful's real reply to this call was not seen. A local stand-in answered with the 404 Printful's API docs describe for an unknown order ID." },
  },
};
// "85.00 EUR" → "€85.00" in headlines.
const eur = (s?: string) => (s ?? "").replace(/(-?[\d.]+) EUR/g, "€$1");
const cap = (r: ScenarioResult) => eur(r.paypal.flatMap((p) => p.captures).filter((c) => c.status === "COMPLETED").map((c) => formatMoney(c.amount)).join(" + ")) || "nothing";

// The shop's own word for "paid", per target.
const PAID: Record<string, string[]> = { expressCart: ["Paid", "Approved", "Approved - Processing", "Completed", "Shipped"], "simple-clothing-store": ["pending"] };

// The fix-loop story per target and arm, from the loop logs. Steps a harness note marks as not the shop's are kept
// but labelled, so the story stays honest.
const ARMS: Record<string, { arm: string; label: string; prompt: string }[]> = {
  "simple-clothing-store": [
    { arm: "", label: "Full prompt", prompt: "Migration plus the proof contract and the money rules (bind each PayPal order to one shop order, check capture status, amount and currency, idempotent capture)." },
    { arm: "plain", label: "Plain prompt", prompt: "Migrate only: move to JS SDK v6 and @paypal/paypal-server-sdk, keep the proof contract. No money rules. Anything it gets right about money comes from the model or from the evidence fed back to it." },
  ],
  expressCart: [
    { arm: "", label: "Full prompt", prompt: "Migration plus the proof contract and the money rules (bind each PayPal order to one shop order, check capture status, amount and currency, idempotent capture)." },
    { arm: "plain", label: "Plain prompt", prompt: "Migrate only: move to Orders v2, JS SDK v6 and @paypal/paypal-server-sdk, keep the proof contract. No money rules. Anything it gets right about money comes from the model or from the evidence fed back to it." },
  ],
};

// ---------- helpers ----------
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const latest = (target: string, key: string): RunResult | null => {
  const f = path.join(OUT, "runs", target, `latest-${key}.json`);
  if (!fs.existsSync(f)) return null;
  const { runDir } = readJson(f);
  const run = readJson(path.join(runDir, "results.json"));
  // A mutation test runs modified code on purpose (a money check removed); it is never a commit's result (review r2).
  if (run.mutation) throw new Error(`${f} points at a mutation test (${run.mutation.name}): prove the real commit again`);
  return completeRun(target, run);
};
// A scenario a local run could not produce (the webhook scenario needs real PayPal deliveries, which reach only the
// hosted listener) comes from a live re-run on Cloud Run of the SAME commit, saved from GET /api/rerun/:id as
// out/runs/<target>/live-<variant>-<mode>.json. Anything still missing is N/A with the adapter's reason.
function liveFor(target: string, run: RunResult) {
  // Candidates: out/runs/<target>/live-<variant>-<mode>.json, and for the re-run target every saved job in out/live/
  // (GET /api/rerun/:id; a job of kind "original" is the original shop's demo, never the upgraded one's).
  const files = [path.join(OUT, "runs", target, `live-${run.variant}-${run.mode}.json`)];
  const liveDir = path.join(OUT, "live");
  if (config.targets[target]?.rerun && run.variant === "upgraded" && run.mode === (TARGETS[target].modes[0] ?? run.mode) && fs.existsSync(liveDir))
    files.push(...fs.readdirSync(liveDir).filter((f) => /^job-[\w-]+\.json$/.test(f)).map((f) => path.join(liveDir, f)));
  const live = files.filter((f) => fs.existsSync(f)).map((f) => ({ f, j: readJson(f) }))
    .filter(({ j }) => j.state === "done" && Array.isArray(j.results) && (j.kind ?? "upgraded") !== "original" && !j.mutation);
  if (!live.length) return null;
  const match = live.filter(({ j }) => j.commit === run.commit).sort((a, b) => String(b.j.finishedAt).localeCompare(String(a.j.finishedAt)))[0];
  if (match) return match.j;
  // Review r2 (sceptic N6): a live run of another commit used to drop silently to N/A. Say so loudly instead.
  const msg = `${target} ${run.variant}-${run.mode}: live runs exist (${live.map(({ f, j }) => `${path.basename(f)}@${j.commit}`).join(", ")}) but none is of the after commit ${run.commit}. Save a live re-run of ${run.commit} (GET /api/rerun/<id> → out/runs/${target}/live-${run.variant}-${run.mode}.json).`;
  if (process.env.CP_EXPORT_ALLOW_NO_LIVE === "1") { console.warn("WARNING " + msg + " Continuing: live-only scenarios show N/A."); return null; }
  throw new Error(msg);
}
function completeRun(target: string, run: RunResult): RunResult {
  const live = run.variant === "original" ? null : liveFor(target, run);
  const unsupported = TARGETS[target].adapter(run.variant as any, path.join(OUT, "tmp-export"), run.mode).unsupported;
  const ids = (TARGETS[target].adapter(run.variant as any, path.join(OUT, "tmp-export"), run.mode).scenarios ?? SCENARIOS).map((x) => x.id);
  const results = [...run.results];
  for (const id of ids) {
    const i = results.findIndex((r) => r.id === id);
    const l = live ? live.results.find((r: any) => r.id === id && r.verdict !== "N/A") : null;
    if (l && (i < 0 || results[i].verdict === "N/A")) {
      const r = { ...l, ppLog: [], calls: l.calls ?? [], notes: [`Live re-run on Cloud Run, ${String(live.finishedAt).slice(0, 16).replace("T", " ")} UTC (commit ${live.commit}): real PayPal webhook deliveries.`, ...(l.notes ?? [])], paypal: l.paypal.map((p: any) => ({ ...p, captures: p.captures.map((c: any) => ({ ...c, amount: parseMoney(...(c.amount.split(" ") as [string, string])) })) })) };
      if (i < 0) results.push(r); else results[i] = r;
    } else if (i < 0 && unsupported[id]) {
      const sc = SCENARIOS.find((x) => x.id === id);
      results.push({ id, title: sc?.title ?? id, ref: sc?.ref ?? "", expect: sc?.expect ?? "", verdict: "N/A", reasons: [unsupported[id]], paypal: [], calls: [], notes: [], ppLog: [], seconds: 0 });
    }
  }
  return { ...run, results };
}
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

const names: [string, string][] = [];
const rename = (s: string) => { if (!aliasMode) return s; for (const [from, to] of names) s = s.split(from).join(to); return s; };
const clean = <T>(x: T): T => JSON.parse(rename(JSON.stringify(scrub(x))));

const shotFrom = new Map<string, string>();
function copyShot(target: string, runDir: string, rel: string | undefined, tag: string): string | undefined {
  if (!rel || (aliasMode && !config.aliasKeepsShots)) return undefined;
  const src = path.join(OUT, runDir, rel);
  if (!fs.existsSync(src)) return undefined;
  let name = `${tag}-${path.basename(rel)}`.replace(/[^A-Za-z0-9._-]/g, "_");
  // Two runs can share variant, mode, scenario and shop order id (the plain and money-rules arms both number from
  // 9000001): the second run's file gets its run's hash, so it never overwrites the first one's picture.
  const key = `${slugOf(target)}/${name}`;
  if (shotFrom.has(key) && shotFrom.get(key) !== src) name = name.replace(/(\.\w+)$/, `-${createHash("sha1").update(runDir).digest("hex").slice(0, 6)}$1`);
  shotFrom.set(`${slugOf(target)}/${name}`, src);
  const dst = path.join(NEXT, "shots", slugOf(target), name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return `data/shots/${slugOf(target)}/${name}`;
}
const slugOf = (t: string) => (aliasMode ? config.targets[t].aliasSlug : t.toLowerCase());

function cell(target: string, run: RunResult, r: ScenarioResult | undefined, tag: string) {
  if (!r) return null;
  const debugIds = [...new Set(r.ppLog.map((l: any) => l?.debugId).filter(Boolean))].slice(0, 4);
  // Real PayPal-Mock-Response codes only; a dropped response is the harness's own simulation (older runs logged it
  // as the pseudo-code DROPPED_RESPONSE), listed under `harness`.
  const mocked = [...new Set(r.ppLog.flatMap((l: any) => [l?.mocked]).filter((c: any) => c && c !== "DROPPED_RESPONSE"))];
  const harness = [...new Set(r.ppLog.flatMap((l: any) => (l?.dropped || l?.mocked === "DROPPED_RESPONSE" ? ["harness: response dropped after PayPal processed the call"] : [])))];
  return {
    verdict: r.verdict, reasons: r.reasons, cause: (r as any).cause ?? null, simulated: r.simulated ?? null, seconds: r.seconds,
    shopOrderId: r.shopOrderId ?? null, shopTotal: r.shopTotal ?? null, shopBefore: r.shopBefore ?? null, shopAfter: r.shopAfter ?? null,
    shopPaid: r.shopAfter ? PAID[target].includes(r.shopAfter) : null,
    paypal: r.paypal.map((p) => ({ orderId: p.orderId, status: p.status, captures: p.captures.map((c) => ({ id: c.id, status: c.status, amount: formatMoney(c.amount) })) })),
    calls: r.calls.map((c) => ({ step: c.step, http: c.http })),
    mocked, harness, debugIds, notes: r.notes,
    screenshot: copyShot(target, run.runDir, r.screenshot, `${run.variant}-${run.mode}`),
    timeline: r.timeline?.map((t) => ({ t: t.t, step: t.step, shot: copyShot(target, run.runDir, t.shot, `${run.variant}-${run.mode}`) })) ?? null,
  };
}

function diffSummary(dir: string, excludes: string[]) {
  const base = git(dir, "rev-list", "--max-parents=0", "HEAD").trim();
  const ex = excludes.map((x) => `:(exclude)${x}`);
  const files = git(dir, "diff", "--numstat", base, "HEAD", "--", ".", ...ex).trim().split("\n").filter(Boolean).map((l) => {
    const [a, d, file] = l.split("\t");
    return { file, added: Number(a) || 0, removed: Number(d) || 0 };
  });
  const commits = git(dir, "log", "--format=%h %s", `${base}..HEAD`).trim().split("\n").filter(Boolean).reverse();
  return { files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0), commits };
}

function loopStory(target: string, arm: string) {
  const f = path.join(OUT, "runs", target, `loop-log${arm ? "-" + arm : ""}.json`);
  if (!fs.existsSync(f)) return null;
  const log: any[] = readJson(f);
  // A step is the harness's, not the shop's, when its note says so, when a prove round produced no verdicts (the
  // shop never started for a harness reason), or when a fix round answered such a round.
  let prevHarness = false;
  const harness = log.map((e) => {
    const own = /harness/i.test(e.note ?? "") || !!e.harnessError || (e.step.startsWith("prove") && !e.buildError && !(e.pass?.length) && !(e.fail?.length));
    const h = e.step.startsWith("fix") ? own || prevHarness : own;
    if (e.step.startsWith("prove")) prevHarness = own;
    return h;
  });
  // A build failure that the next fix round found to be the harness's (port clash) is the harness's too.
  for (let i = 0; i < log.length; i++) if (log[i].buildError && [log[i - 1], log[i + 1]].some((n) => n?.step.startsWith("fix") && /harness/i.test(n.note ?? ""))) harness[i] = true;
  const steps: any[] = log.map((e, i) => ({ ...stepOf(e), harness: harness[i] }));
  // The story ends at the first green full proof. After it, re-runs of the same commit are counted, and later changes
  // (a model extension, a hand fix, a fix round) are listed with their proofs; none of them is shown as a step.
  // "Full" is per commit: scenarios were added over time (22 scenario runs on 17 Oct, 28 after review r1).
  const proves = steps.filter((s) => s.kind === "prove");
  const fullAt = (c: string) => Math.max(0, ...proves.filter((s) => s.commit === c).map((s) => s.pass + s.fail.length));
  for (const p of proves) if (p.pass + p.fail.length > 0 && p.pass + p.fail.length < fullAt(p.commit)) p.note = p.note ?? `partial run (${p.pass + p.fail.length} of ${fullAt(p.commit)} scenario runs)`;
  const g = steps.findIndex((s) => s.kind === "prove" && !s.buildError && s.fail.length === 0 && s.pass > 0 && s.pass === fullAt(s.commit));
  if (g >= 0 && g < steps.length - 1) {
    const sameCommit = (i: number) => steps[i].commit === steps[g].commit;
    const laterIdx = steps.map((s, i) => (i > g && s.kind === "prove" && sameCommit(i) ? i : -1)).filter((i) => i >= 0);
    const bad = laterIdx.filter((i) => steps[i].fail.length > 0);
    // Rounds the plan's usage limit stopped (`void`: no change) say so, not "fix round n" (review r3, O5).
    const changes = steps.map((s, i) => (i > g && s.kind !== "prove" ? (log[i]?.void ? `${s.step}: stopped at the usage limit, no change` : `${s.step}${log[i]?.byHand && !/by hand/.test(s.step) ? " (by hand)" : ""} → ${s.commit}`) : "")).filter(Boolean);
    const changeProofs = steps.filter((s, i) => i > g && s.kind === "prove" && !sameCommit(i));
    const notes: string[] = steps[g].note ? [String(steps[g].note).replace(/\.$/, "")] : [];
    if (laterIdx.length) {
      // Say what the reds of later re-runs were, from their own results (not a fixed story): review r1 K1.
      const why = bad.map((i) => explainReds(target, log[i].runDir ?? []));
      const n = (k: "buyer" | "error" | "shop") => why.reduce((t, w) => t + w[k], 0);
      const parts = [n("buyer") && `${n("buyer")} sandbox-buyer approval timeouts`, n("error") && `${n("error")} harness errors (${[...new Set(why.flatMap((w) => w.samples))].join("; ")})`].filter(Boolean);
      const overlap = why.some((w) => w.overlap);
      notes.push(`Later re-runs of this commit: ${laterIdx.length}` + (bad.length
        ? `; ${bad.length} had reds: ${parts.join(" and ")}${overlap ? ", while another proof of this shop ran on the same ports" : ""}${n("shop") ? `, plus ${n("shop")} not explained by the harness` : ", none from the shop"}. The harness now reports such errors as inconclusive${overlap ? " and runs one proof per shop at a time" : ""}`
        : "") + " (loop log)");
    }
    if (changes.length) {
      const reds = changeProofs.filter((s) => s.fail.length).map((s) => `${s.commit}: ${s.fail.map((f: any) => f.id).join(", ")}`);
      const last = changeProofs[changeProofs.length - 1];
      const lastInc = last ? verdictCount(log[steps.indexOf(last)]?.runDir, "INCONCLUSIVE") : 0;
      notes.push(`Changed since: ${changes.join("; ")}. ${changeProofs.length} later full proof${changeProofs.length === 1 ? "" : "s"}${reds.length ? `; red in ${reds.join("; ")}` : ""}${last ? `; the latest (${last.commit}) ${last.fail.length ? "has reds" : `is green, ${last.pass} pass${lastInc ? `, ${lastInc} inconclusive (the harness's)` : ""}, 0 fail`}` : ""} (loop log)`);
    }
    steps.length = g + 1;
    if (notes.length) steps[g].note = notes.join(". ") + ".";
  }
  return steps;
}

// Classifies the non-PASS results of the runs of one loop-log step: the sandbox buyer timing out, harness code
// failing (connection errors, unexpected answers), or neither (counted against the shop). `overlap`: another run of
// the same target was going at the same time (run folders are named by start time; results.json by end time).
function explainReds(target: string, runDirs: string[]) {
  const out = { buyer: 0, error: 0, shop: 0, samples: [] as string[], overlap: false };
  const span = (dir: string) => {
    const m = path.basename(dir).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const f = path.join(OUT, dir, "results.json");
    if (!m || !fs.existsSync(f)) return null;
    return [Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`), Date.parse(readJson(f).startedAt)] as const;
  };
  const all = fs.readdirSync(path.join(OUT, "runs", target)).filter((d) => /^\d{4}-/.test(d)).map((d) => `runs/${target}/${d}`);
  for (const dir of runDirs) {
    const f = path.join(OUT, dir, "results.json");
    if (!fs.existsSync(f)) continue;
    const mine = span(dir);
    if (mine && all.some((o) => o !== dir && (() => { const s = span(o); return s && s[0] < mine[1] && s[1] > mine[0]; })())) out.overlap = true;
    for (const r of readJson(f).results as ScenarioResult[]) {
      if (r.verdict === "PASS" || r.verdict === "N/A") continue;
      const text = [...r.reasons, ...r.notes].join(" ");
      if (/buyer could not approve|buyer: failed|sandbox buyer/.test(text)) out.buyer++;
      else if (r.verdict === "INCONCLUSIVE" || /^(scenario error|harness):/.test(r.reasons[0] ?? "")) { out.error++; out.samples.push((r.reasons[0] ?? "").replace(/^(scenario error|harness): /, "").replace(/\s*\(.*$/, "").slice(0, 80)); }
      else out.shop++;
    }
  }
  return out;
}
// The moments the proof caught a shop failure and the model fixed it from the evidence alone (review r2 B2.3): a proof
// with shop failures (not the harness's), then a model fix round (not by hand), then the next proof with no shop
// failure. Read from the whole loop log, including steps after the story's first green.
const verdictCount = (dirs: string[] | string | undefined, v: string) => [dirs ?? []].flat().reduce((n, d) => {
  const rf = path.join(OUT, d, "results.json");
  return fs.existsSync(rf) ? n + (readJson(rf) as RunResult).results.filter((x) => x.verdict === v).length : n;
}, 0);
function catches(target: string, arm: string) {
  const f = path.join(OUT, "runs", target, `loop-log${arm ? "-" + arm : ""}.json`);
  if (!fs.existsSync(f)) return [];
  // Rounds stopped by the usage limit changed nothing and only repeated a proof: a catch skips them (review r3, O5).
  const log: any[] = (readJson(f) as any[]).filter((e) => !e.void);
  const isHarness = (e: any) => /harness/i.test(e.note ?? "") || !!e.harnessError;
  const out: any[] = [];
  for (let i = 0; i < log.length; i++) {
    const red = log[i];
    if (!red.step.startsWith("prove") || red.buildError || !(red.fail?.length) || isHarness(red) || red.superseded) continue;
    const j = log.findIndex((e, k) => k > i && e.step.startsWith("fix"));
    if (j < 0 || log[j].byHand || isHarness(log[j]) || log.slice(i + 1, j).some((e) => e.step.startsWith("prove"))) continue;
    const k = log.findIndex((e, n) => n > j && e.step.startsWith("prove") && !e.buildError && (e.pass?.length ?? 0) > 0);
    if (k < 0 || log.slice(j + 1, k).some((e) => e.step.startsWith("fix"))) continue;
    const green = log[k];
    if ((green.fail?.length ?? 0) > 0 && !isHarness(green)) continue;
    // The red run's evidence, for the first failing scenario: PayPal's orders and captures as the proof recorded them.
    // The card shows one failing scenario's records: prefer one where money moved and the shop got it wrong (review r3:
    // a payer-action refusal showed two matching records under a red verdict).
    const shown = red.fail.find((x: any) => /charged|captured|completed captures/.test(x.reasons?.[0] ?? "")) ?? red.fail[0];
    const failId = String(shown.id).replace(/ \(.*\)$/, "");
    const failMode = (String(shown.id).match(/\((\w+) mode\)/) ?? [])[1];
    const runAt = (dirs: string[] | string | undefined, id = failId) => {
      for (const d of [dirs ?? []].flat()) {
        const rf = path.join(OUT, d, "results.json");
        if (!fs.existsSync(rf)) continue;
        const run: RunResult = readJson(rf);
        if (failMode && run.mode !== failMode) continue;
        const r = run.results.find((x) => x.id === id);
        if (r) return cell(target, run, r, `catch-${path.basename(d)}`);
      }
      return null;
    };
    const prev = log[i - 1];
    out.push({
      arm, failId, failMode: failMode ?? null,
      after: prev && !prev.step.startsWith("prove") ? { step: prev.step, commit: prev.commit, byHand: !!prev.byHand } : null,
      red: { commit: red.commit, at: red.at, pass: red.pass?.length ?? 0, fail: red.fail.map((x: any) => ({ id: x.id, reason: x.reasons?.[0] ?? "" })), cell: runAt(red.runDir),
        // Every other failing scenario's record too (same mode), so a page can show a chosen one (gallery 2: the plain
        // arm's EUR 1.00 capture, scenario "amount").
        cells: Object.fromEntries([...new Set<string>(red.fail.map((x: any) => String(x.id).replace(/ \(.*\)$/, "")))].filter((id) => id !== failId).map((id) => [id, runAt(red.runDir, id)]).filter(([, c]) => c)) },
      fix: { step: log[j].step, commit: log[j].commit, at: log[j].at, turns: log[j].turns ?? null, seconds: log[j].durationS ?? null, costUsd: log[j].costUsd ?? null, summary: firstParagraphs(log[j].summary ?? "") },
      // INCONCLUSIVE runs are in neither pass nor fail of the loop log: count them from the run records, so the card's
      // "x of n" adds up with the red run's total (review r3: "28 pass, 6 fail" next to "32 of 32").
      green: { commit: green.commit, at: green.at, pass: green.pass?.length ?? 0, fail: green.fail?.length ?? 0, inconclusive: verdictCount(green.runDir, "INCONCLUSIVE"), harnessNote: (green.fail?.length ?? 0) > 0 || verdictCount(green.runDir, "INCONCLUSIVE") > 0 ? green.note ?? null : null, cell: runAt(green.runDir) },
    });
  }
  return out;
}

// Mutation tests: runs of deliberately modified code (a money check removed), recorded with `mutation` by the runner.
// They show the proof can fail; they are never a commit's result (review r2, sceptic N9).
function mutations(target: string) {
  const dir = path.join(OUT, "runs", target);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => /^\d{4}-/.test(d) && fs.existsSync(path.join(dir, d, "results.json"))).flatMap((d) => {
    const run = readJson(path.join(dir, d, "results.json"));
    if (!run.mutation) return [];
    const ids: string[] = run.mutation.scenarios ?? run.results.map((r: any) => r.id);
    return [{ name: run.mutation.name, description: run.mutation.description, commit: run.commit, at: run.startedAt, mode: run.mode,
      results: run.results.filter((r: any) => ids.includes(r.id)).map((r: any) => ({ id: r.id, title: r.title, verdict: r.verdict, reason: (r.reasons ?? []).find((x: string) => !/^SIMULATED/.test(x)) ?? r.reasons?.[0] ?? "" })) }];
  });
}

// A side arm's final code proved again on scenarios added after its loop ended (19 Oct: restarts, refusals, payer
// action, own-order money checks). Those failures were never fed back to the model, so they are not loop steps: the
// site and README show them as the arm's result on the larger suite. The main arm's latest runs are already the
// "after" column, so only side arms (plain) get one.
function laterProof(target: string, arm: string, modes: string[]) {
  if (!arm) return null;
  const f = path.join(OUT, "runs", target, `loop-log-${arm}.json`);
  if (!fs.existsSync(f)) return null;
  const log: any[] = readJson(f);
  const last = log[log.length - 1];
  const finalCommit = [...log].reverse().find((e) => !e.step.startsWith("prove"))?.commit ?? last.commit;
  const runs = modes.map((m) => {
    const p = path.join(OUT, "runs", target, `latest-upgraded-${arm}-${m}.json`);
    if (!fs.existsSync(p)) return null;
    const run: RunResult & { mutation?: unknown } = readJson(path.join(readJson(p).runDir, "results.json"));
    if (run.mutation || String(run.commit).replace(/-dirty$/, "") !== finalCommit || !(run.startedAt > last.at)) return null;
    return run;
  }).filter(Boolean) as RunResult[];
  if (!runs.length) return null;
  // Only a larger suite is news: a re-run of the same scenarios is already summed up in the loop's notes.
  const loopIds = new Set(log.flatMap((e) => [...(e.pass ?? []), ...(e.fail ?? []).map((x: any) => x.id)]).map((id: string) => id.replace(/ \(.*\)$/, "")));
  if (!runs.some((r) => r.results.some((x) => !loopIds.has(x.id) && x.verdict !== "N/A"))) return null;
  return {
    commit: finalCommit, at: runs.map((r) => r.startedAt).sort()[0],
    added: [...new Set(runs.flatMap((r) => r.results.filter((x) => !loopIds.has(x.id) && x.verdict !== "N/A").map((x) => x.id)))],
    modes: runs.map((r) => ({
      mode: r.mode, pass: r.results.filter((x) => x.verdict === "PASS").length, na: r.results.filter((x) => x.verdict === "N/A").length,
      inconclusive: r.results.filter((x) => x.verdict === "INCONCLUSIVE").length, total: r.results.length,
      fail: r.results.filter((x) => x.verdict === "FAIL").map((x) => ({ id: x.id, title: x.title, simulated: !!x.simulated, reason: x.reasons.find((s) => !/^SIMULATED/.test(s)) ?? x.reasons[0] ?? "" })),
    })),
  };
}

function stepOf(e: any) {
  return e.step.startsWith("prove")
    ? { kind: "prove", step: e.step, commit: e.commit, at: e.at, pass: e.pass?.length ?? 0, fail: (e.fail ?? []).map((x: any) => ({ id: x.id, reason: x.reasons?.[0] ?? "" })), buildError: !!e.buildError, note: e.note ?? null }
    : { kind: e.step.startsWith("fix") ? "fix" : "upgrade", step: e.step, commit: e.commit, at: e.at, byHand: !!e.byHand, turns: e.turns ?? null, seconds: e.durationS ?? null, skills: e.skills ?? [], summary: firstParagraphs(e.summary ?? ""), note: e.note ?? null };
}
const firstParagraphs = (s: string) => s.split(/\n\s*\n/).slice(0, 3).join("\n\n").slice(0, 1400);

function scanRows(dir: string): Finding[] { return fs.existsSync(dir) ? scanDir(dir) : []; }

// ---------- export ----------
fs.rmSync(NEXT, { recursive: true, force: true });
fs.mkdirSync(NEXT, { recursive: true });
process.on("exit", (code) => { if (code) fs.rmSync(NEXT, { recursive: true, force: true }); });
for (const [t, c] of Object.entries<any>(config.targets)) names.push([c.repo, c.aliasRepo ?? "a public GitHub repo"], [t, c.alias]);
names.sort((a, b) => b[0].length - a[0].length);

const index: any[] = [];
const exported: any[] = [];
const crops: { src: string; dst: string; rows: { x: number; y: number; w: number; h: number }[][] }[] = [];
for (const [target, c] of Object.entries<any>(config.targets)) {
  const def = TARGETS[target];
  const modes = def.modes;
  const before = modes.map((m) => latest(target, `original-${m}`)).filter(Boolean) as RunResult[];
  const after = modes.map((m) => latest(target, `upgraded-${m}`)).filter(Boolean) as RunResult[];
  if (!before.length || !after.length) { console.log(`skip ${target}: no runs`); continue; }
  const ids = [...new Set([...before, ...after].flatMap((r) => r.results.map((x) => x.id)))];
  const scenarios = ids.map((id) => {
    const any = [...before, ...after].flatMap((r) => r.results).find((x) => x.id === id)!;
    return {
      id, title: any.title, ref: any.ref, expect: any.expect,
      modes: modes.map((m) => {
        const b = before.find((r) => r.mode === m), a = after.find((r) => r.mode === m);
        return { mode: m, before: b && cell(target, b, b.results.find((x) => x.id === id), "b"), after: a && cell(target, a, a.results.find((x) => x.id === id), "a") };
      }),
    };
  });
  // Money-losing failures before, in the order of the curated stories (the hero first).
  const failures = Object.entries(STORIES[target] ?? {}).flatMap(([id, s]) => before.flatMap((run) => {
    const r = run.results.find((x) => x.id === id && x.verdict === "FAIL");
    if (!r) return [];
    // D7 is only a production-mode story; skip duplicates of other stories.
    if (s.code === "D7" && run.mode !== "production") return [];
    if (s.code !== "D7" && modes.length > 1 && run.mode !== "demo") return [];
    // D7 is one defect behind every production-mode "charged but not confirmed" failure: list those runs under it so
    // the gallery counts one bug, not six (review r1, sceptic C4).
    const sameCause = s.code === "D7" ? run.results.filter((x) => x.verdict === "FAIL" && x.reasons.some((m) => /is not confirmed/.test(m))).map((x) => x.id) : undefined;
    return [{ id, code: s.code, mode: run.mode, headline: s.headline(r), assumed: s.assumed ?? null, sameCause, simulated: r.simulated ?? null, afterVerdict: after.find((a) => a.mode === run.mode)?.results.find((x) => x.id === id)?.verdict ?? null }];
  }));
  // Readable thumbnails (review r2 B2.4): each bug card's order-page screenshot is cut down to the rows that prove it
  // (status badge, total), at 1:1 pixel scale. Regions per shop in web/targets.config.json "shotCrop".
  for (const f of failures as any[]) {
    const shot = scenarios.find((x) => x.id === f.id)?.modes.find((m) => m.mode === f.mode)?.before?.screenshot;
    if (!shot || !c.shotCrop) continue;
    const name = `crop-${path.basename(shot)}`;
    crops.push({ src: path.join(NEXT, shot.replace(/^data\//, "")), dst: path.join(NEXT, "shots", slugOf(target), name), rows: c.shotCrop.rows });
    f.crop = { src: `data/shots/${slugOf(target)}/${name}`, caption: c.shotCrop.caption };
  }
  if (target === "expressCart" && !/€85\.00.*€480\.00/.test(failures.find((f) => f.code === "E1")?.headline ?? "")) throw new Error("E1 story lost its amounts");
  const hero = target === "expressCart" ? scenarios.find((s) => s.id === "cancel-shrink") : null;
  const tally = (runs: RunResult[]) => { const rs = runs.flatMap((r) => r.results); return { pass: rs.filter((x) => x.verdict === "PASS").length, fail: rs.filter((x) => x.verdict === "FAIL").length, na: rs.filter((x) => x.verdict === "N/A").length, inconclusive: rs.filter((x) => x.verdict === "INCONCLUSIVE").length, total: rs.length }; };
  const arms = (ARMS[target] ?? []).map((a) => ({ ...a, steps: loopStory(target, a.arm), later: laterProof(target, a.arm, modes) })).filter((a) => a.steps?.length);
  const upDir = def.workDirFor("upgraded");
  const data = clean({
    slug: slugOf(target), name: aliasMode ? c.alias : target, rerun: !!c.rerun, repo: aliasMode ? null : c.repo, blurb: c.blurb, beforeNote: c.beforeNote ?? null, modeNote: c.modeNote ?? null, shotNote: c.shotCrop?.note ?? null, stack: { before: def.beforeLabel, after: def.afterLabel },
    intro: def.intro, runsNote: def.runsNote, harnessNote: def.harnessNote, modes,
    runs: { before: before.map((r) => ({ mode: r.mode, commit: r.commit, at: r.startedAt })), after: after.map((r) => ({ mode: r.mode, commit: r.commit, at: r.startedAt })) },
    tally: { before: tally(before), after: tally(after) },
    failures, heroId: hero?.id ?? null, scenarios,
    diff: diffSummary(upDir, def.diffExcludes),
    scan: { before: scanRows(def.workDirFor("original")), after: scanRows(upDir) },
    arms,
    catches: (ARMS[target] ?? []).flatMap((a) => catches(target, a.arm)),
    mutations: mutations(target),
  });
  fs.writeFileSync(path.join(NEXT, `${data.slug}.json`), JSON.stringify(data, null, 1));
  exported.push(data);
  index.push({ slug: data.slug, name: data.name, repo: data.repo, blurb: data.blurb, stack: data.stack, tally: data.tally, failures: data.failures, order: c.order ?? 9 });
  console.log(`${target}: ${scenarios.length} scenarios, ${failures.length} money stories, ${arms.length} arms → ${data.slug}.json`);
}
index.sort((a, b) => a.order - b.order);
const indexData = { exportedAt: new Date().toISOString(), aliasMode, targets: index };
fs.writeFileSync(path.join(NEXT, "index.json"), JSON.stringify(indexData, null, 1));

// ---------- thumbnail crops (headless Chromium from playwright: draws the regions onto a canvas) ----------
if (crops.length) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const c of crops) {
      const png: string = await page.evaluate(async ({ data, rows }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const gap = 24, pad = 8;
        const W = Math.max(...rows.map((r) => r.reduce((n, s) => n + s.w, 0) + gap * (r.length - 1))) + pad * 2;
        const H = rows.reduce((n, r) => n + Math.max(...r.map((s) => s.h)), 0) + pad * (rows.length + 1);
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const g = cv.getContext("2d")!;
        g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
        let y = pad;
        for (const r of rows) {
          let x = pad;
          for (const s of r) { g.drawImage(img, s.x, s.y, s.w, s.h, x, y, s.w, s.h); x += s.w + gap; }
          y += Math.max(...r.map((s) => s.h)) + pad;
        }
        return cv.toDataURL("image/png").split(",")[1];
      }, { data: fs.readFileSync(c.src).toString("base64"), rows: c.rows });
      fs.writeFileSync(c.dst, Buffer.from(png, "base64"));
    }
  } finally { await browser.close(); }
  console.log(`${crops.length} thumbnail crops`);
}

// ---------- leak check ----------
const env = fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "";
const values = env.split("\n").map((l) => l.split("=").slice(1).join("=").trim()).filter((v) => v.length >= 6 && v !== "sandbox");
for (const f of fs.readdirSync(NEXT).filter((x) => x.endsWith(".json"))) {
  const s = fs.readFileSync(path.join(NEXT, f), "utf8");
  for (const v of values) if (s.includes(v)) throw new Error(`leak check: an .env value is in ${f}`);
  const emails = (s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter((e) => !/^(buyer@example\.com|owner@test\.com|checkout-proof@localhost)$/.test(e));
  if (emails.length) throw new Error(`leak check: e-mail addresses in ${f}: ${[...new Set(emails)].length}`);
  if (/eyJ[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9]/.test(s)) throw new Error(`leak check: token-like string in ${f}`);
}
fs.rmSync(DEST, { recursive: true, force: true });
fs.renameSync(NEXT, DEST);
console.log(`leak check ok → ${path.relative(ROOT, DEST)}${aliasMode ? " (alias names)" : ""}`);

// README numbers come from the same data and the same functions as the site (web/src/claims.ts); the test
// tests/readme-numbers.test.ts fails when they drift. Alias mode leaves the README alone (it names the real shops).
if (!aliasMode) {
  for (const [file, blocks] of [["README.md", readmeBlocks(indexData as any, exported)], ["SCENARIOS.md", scenarioBlocks(indexData as any, exported)]] as const) {
    const f = path.join(ROOT, file);
    const before = fs.readFileSync(f, "utf8");
    const after = fillBlocks(before, blocks, file);
    if (after !== before) { fs.writeFileSync(f, after); console.log(`${file}: generated blocks updated`); }
  }
}


