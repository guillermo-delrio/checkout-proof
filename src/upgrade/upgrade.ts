// upgrade / loop / pack for a target. The model edits; the harness builds, runs, judges and commits.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OUT, ROOT, mkdirp, scrub } from "../env.ts";
import { scanDir, formatFindings } from "../scan/scan.ts";
import { targetDef } from "../targets/index.ts";
import { runClaude } from "./claude.ts";
import { fixPrompt, webhookPrompt } from "./prompts.ts";
import { prove } from "../prove/prove.ts";
import { writePack, writeVideoSummary } from "../evidence/pack.ts";
import type { RunResult } from "../prove/runner.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Checkout Proof", "-c", "user.email=checkout-proof@localhost", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const arm = () => (process.env.CP_ARM ? "-" + process.env.CP_ARM : "");
const loopLogFile = (target: string) => path.join(OUT, "runs", target, `loop-log${arm()}.json`);
const readLoopLog = (target: string): any[] => { try { return JSON.parse(fs.readFileSync(loopLogFile(target), "utf8")); } catch { return []; } };
const appendLoopLog = (target: string, e: any) => fs.writeFileSync(loopLogFile(target), JSON.stringify([...readLoopLog(target), { ...e, at: new Date().toISOString() }], null, 2));

function commitAll(cwd: string, msg: string) {
  git(cwd, "add", "-A");
  try { git(cwd, "commit", "-q", "-m", msg); } catch { /* nothing to commit */ }
  return git(cwd, "rev-parse", "--short", "HEAD").trim();
}

export async function upgradeCmd(target: string, args: string[]) {
  const t = targetDef(target);
  const orig = t.workDirFor("original");
  const dir = t.workDirFor("upgraded");
  if (!fs.existsSync(orig)) throw new Error(`no original work copy at ${orig}; run prove ${target} --variant original first`);
  if (fs.existsSync(dir)) {
    if (!args.includes("--fresh")) throw new Error(`${dir} exists; pass --fresh to start over`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Start from the original work copy (dependencies already installed with --ignore-scripts), minus build output.
  execFileSync("cp", ["-a", orig, dir]);
  for (const b of t.dropOnCopy) fs.rmSync(path.join(dir, b), { recursive: true, force: true });
  if (!fs.existsSync(path.join(dir, ".gitignore")) || !fs.readFileSync(path.join(dir, ".gitignore"), "utf8").includes("node_modules")) fs.appendFileSync(path.join(dir, ".gitignore"), "\nnode_modules/\n");
  t.configureUpgraded?.(dir); // local run settings go into the baseline, so the diff holds only the model's work
  git(dir, "init", "-q");
  const upstream = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(OUT, "targets", target) }).toString().trim();
  const base = commitAll(dir, `baseline: upstream ${upstream}`);
  const findings = scanDir(dir);
  const logDir = mkdirp(path.join(OUT, "runs", target, `model${arm()}`));
  console.log(`upgrade: baseline ${base}; ${findings.length} findings; running ${"claude -p"} (this takes a while)`);
  const prompt = args.includes("--plain") ? t.plainPrompt(findings) : t.upgradePrompt(findings);
  const r = await runClaude(dir, prompt, logDir, "upgrade", { effort: "high", budgetUsd: 10 });
  const head = commitAll(dir, `upgrade: JS SDK v6 + @paypal/paypal-server-sdk (model ${r.ok ? "finished" : "stopped"})`);
  appendLoopLog(target, { step: args.includes("--plain") ? "upgrade (plain prompt: migrate only)" : "upgrade", baseline: base, commit: head, ok: r.ok, costUsd: r.costUsd, turns: r.turns, durationS: r.durationS, skills: r.skills, tools: r.tools, transcript: r.transcript, summary: scrub(r.result).slice(0, 4000) });
  console.log(`upgrade ${r.ok ? "done" : "FAILED"} → ${head} · ${r.turns} turns · ${r.durationS}s · plan-equivalent $${r.costUsd?.toFixed(2)} · skills: ${r.skills.join(", ") || "none"}`);
  console.log(scrub(r.result).slice(0, 2500));
}

// A focused second model pass on the upgraded copy (M4: webhook handling). Committed and logged like a fix round, so
// the gallery's commit list and loop log show it as the model's own step.
export async function extendCmd(target: string, what: string) {
  if (what !== "webhook" || target !== "simple-clothing-store") throw new Error("usage: extend simple-clothing-store webhook");
  const dir = targetDef(target).workDirFor("upgraded");
  const logDir = mkdirp(path.join(OUT, "runs", target, `model${arm()}`));
  const r = await runClaude(dir, webhookPrompt(), logDir, "webhook", { effort: "high", budgetUsd: 6 });
  const head = commitAll(dir, `webhook: verified PAYMENT.CAPTURE.* events change the order once (model ${r.ok ? "finished" : "stopped"})`);
  appendLoopLog(target, { step: "upgrade (webhook extension)", commit: head, ok: r.ok, costUsd: r.costUsd, turns: r.turns, durationS: r.durationS, skills: r.skills, tools: r.tools, transcript: r.transcript, summary: scrub(r.result).slice(0, 4000) });
  console.log(`webhook extension ${r.ok ? "done" : "FAILED"} → ${head} · ${r.turns} turns · ${r.durationS}s · plan-equivalent $${r.costUsd?.toFixed(2)}`);
  console.log(scrub(r.result).slice(0, 2500));
}

// fromRuns: start from saved proof runs (already in the loop log as the last prove round) instead of proving again,
// so a red that may not repeat on demand (a slow PayPal answer) still goes to the model as evidence.
export async function loopCmd(target: string, max: number, only?: string[], fromRuns?: string[]) {
  const t = targetDef(target);
  const dir = t.workDirFor("upgraded");
  const logDir = mkdirp(path.join(OUT, "runs", target, `model${arm()}`));
  const lastRound = fromRuns ? Number(String(readLoopLog(target).filter((e) => e.step?.startsWith("prove round") && !e.void).pop()?.step ?? "prove round 0").split(" ").pop()) || 0 : 0;
  for (let round = lastRound; ; round++) {
    const runs: RunResult[] = [];
    let buildError: string | undefined;
    if (fromRuns && round === lastRound) {
      for (const d of fromRuns) runs.push(JSON.parse(fs.readFileSync(path.join(OUT, d.replace(/^out\//, ""), "results.json"), "utf8")));
      console.log(`round ${round}: from saved runs ${fromRuns.join(", ")}`);
    } else try {
      // Every mode the target has (simple-clothing-store: DEMO=1 and production with the Printful stub).
      for (const [i, m] of t.modes.entries()) runs.push(await prove(target, "upgraded", only, i === 0, m));
    } catch (e: any) {
      if (String(e?.message).startsWith("harness:")) { console.log(String(e.message)); appendLoopLog(target, { step: `prove round ${round}`, harnessError: String(e.message) }); return; }
      buildError = scrub(String(e?.stderr?.toString?.() || "") + "\n" + String(e?.stack || e)).slice(-6000);
      console.log("build/start failed:\n" + buildError.slice(-1500));
    }
    const failing = runs.flatMap((r) => r.results.filter((x) => x.verdict === "FAIL").map((x) => ({ ...x, id: `${x.id} (${r.mode} mode)` })));
    if (!(fromRuns && round === lastRound)) appendLoopLog(target, { step: `prove round ${round}`, commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim(), runDir: runs.map((r) => r.runDir), pass: runs.flatMap((r) => r.results.filter((x) => x.verdict === "PASS").map((x) => `${x.id} (${r.mode})`)), fail: failing.map((r) => ({ id: r.id, reasons: r.reasons })), buildError: buildError?.slice(-1500) });
    const inconclusive = runs.flatMap((r) => r.results.filter((x) => x.verdict === "INCONCLUSIVE").map((x) => `${x.id} (${r.mode})`));
    if (!buildError && failing.length === 0) { console.log(`round ${round}: ${inconclusive.length ? "no failures; inconclusive (harness): " + inconclusive.join(", ") : "all scenarios pass"}`); return; }
    if (round >= max) { console.log(`round ${round}: ${buildError ? "build failing" : failing.length + " failing"}; stopping at --max ${max}`); return; }
    console.log(`round ${round}: asking the model to fix ${buildError ? "the build" : failing.map((f) => f.id).join(", ")}`);
    const r = await runClaude(dir, fixPrompt(round + 1, failing, buildError, t.contract, t.rules), logDir, `fix-${round + 1}`, { effort: "medium", budgetUsd: 5 });
    const before = git(dir, "rev-parse", "--short", "HEAD").trim();
    const head = commitAll(dir, `fix round ${round + 1}: ${buildError ? "build" : failing.map((f) => f.id).join(", ")}`);
    // A model run that stopped (plan usage limit, budget) and changed nothing ends the loop: proving the same code
    // again only burns sandbox time (19 Oct: three void rounds after "You've hit your session limit").
    const stalled = !r.ok && head === before;
    appendLoopLog(target, { step: `fix round ${round + 1}`, commit: head, ok: r.ok, costUsd: r.costUsd, turns: r.turns, durationS: r.durationS, skills: r.skills, tools: r.tools, transcript: r.transcript, summary: scrub(r.result).slice(0, 3000), ...(stalled ? { void: true, note: "void: the model run stopped and changed nothing" } : {}) });
    if (stalled) { console.log(`fix ${round + 1}: the model run stopped without a change (${scrub(r.result).slice(0, 200)}); stopping. Resume with --from-runs ${runs.map((x) => "out/" + x.runDir).join(",")}`); return; }
    console.log(`fix ${round + 1} → ${head} · ${r.turns} turns · ${r.durationS}s · $${r.costUsd?.toFixed(2)}\n${scrub(r.result).slice(0, 1500)}`);
  }
}

export async function packCmd(target: string) {
  const latest = (v: string): RunResult => {
    const { runDir } = JSON.parse(fs.readFileSync(path.join(OUT, "runs", target, `latest-${v}.json`), "utf8"));
    return JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
  };
  const t = targetDef(target);
  const dir = t.workDirFor("upgraded");
  const baseline = git(dir, "rev-list", "--max-parents=0", "HEAD").trim();
  const ex = t.diffExcludes.map((x) => `:(exclude)${x}`);
  const diffStat = git(dir, "diff", "--stat", baseline, "HEAD", "--", ".", ...ex);
  fs.writeFileSync(path.join(mkdirp(path.join(OUT, "evidence", target + arm())), "upgrade.diff"), scrub(git(dir, "diff", baseline, "HEAD", "--", ".", ...ex)));
  const loopLog = readLoopLog(target).map((e) => e.step.startsWith("prove")
    ? `${e.step} at ${e.commit}: ${e.buildError ? "build failed" : `${e.pass?.length ?? 0} pass, ${e.fail?.length ?? 0} fail${e.fail?.length ? " (" + e.fail.map((f: any) => f.id).join(", ") + ")" : ""}`}`
    : `${e.step} → ${e.commit}: ${e.turns ?? "?"} model turns, ${e.durationS ?? "?"} s${e.skills?.length ? ", skills " + e.skills.join(", ") : ""}`)
    .map((line, i) => { const n = readLoopLog(target)[i]?.note; return n ? `${line} (${n})` : line; });
  const body = writePack(target, t.modes.map((m) => latest(`original-${m}`)), t.modes.map((m) => latest(`upgraded${arm()}-${m}`)), path.join(OUT, "evidence", target + arm()), {
    diffStat, loopLog,
    scanBefore: formatFindings(scanDir(t.workDirFor("original"))), scanAfter: formatFindings(scanDir(dir)),
    labels: { before: t.beforeLabel, after: t.afterLabel, intro: t.intro, runs: t.runsNote, harness: t.harnessNote },
  });
  const withTimeline = (runs: RunResult[]) => runs.flatMap((r) => r.results.filter((x) => x.timeline?.length).map((x) => ({ ...x, runDir: r.runDir })));
  const vb = withTimeline(t.modes.map((m) => latest(`original-${m}`))), va = withTimeline(t.modes.map((m) => latest(`upgraded${arm()}-${m}`)));
  for (const id of new Set([...vb, ...va].map((x) => x.id)))
    writeVideoSummary(path.join(OUT, "evidence", target + arm()), `VIDEO-${id}.md`, `${target}: ${(vb.find((x) => x.id === id) ?? va.find((x) => x.id === id))!.title}`, vb.find((x) => x.id === id), va.find((x) => x.id === id), t.videoHowTo?.[id]);
  console.log(scrub(body).slice(0, 3000));
  console.log(`\n→ ${path.relative(ROOT, path.join(OUT, "evidence", target + arm()))}/PR-BODY.md (local only)`);
}
