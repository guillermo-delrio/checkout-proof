// Evidence pack: results table per run, original vs upgraded side by side, and a PR body. Local files only.
import fs from "node:fs";
import path from "node:path";
import { formatMoney } from "../money/money.ts";
import type { RunResult, ScenarioResult } from "../prove/runner.ts";

const ppCell = (r: ScenarioResult) =>
  r.paypal.map((t) => `\`${t.orderId}\` ${t.status}${t.captures.map((c) => `<br>capture \`${c.id}\` ${c.status} ${formatMoney(c.amount)}`).join("")}`).join("<br>") || "—";
const debugIds = (r: ScenarioResult) => [...new Set(r.ppLog.map((l: any) => l?.debugId).filter(Boolean))].slice(0, 4).map((d) => `\`${d}\``).join(" ");
const mocked = (r: ScenarioResult) => [...new Set(r.ppLog.flatMap((l: any) => [l?.mocked, l?.rewritten && `SIMULATED ${l.rewritten}`]).filter(Boolean))].join(", ");
const esc = (s: string) => s.replace(/\|/g, "\\|");

export function runTable(run: RunResult): string {
  const rows = run.results.map((r) =>
    `| ${r.verdict === "PASS" ? "PASS" : r.verdict === "N/A" ? "n/a" : r.verdict === "INCONCLUSIVE" ? "inconclusive" : "**FAIL**"} | ${r.id} (${r.ref}) | ${r.shopOrderId ? `${r.shopOrderId}: ${r.shopTotal}, ${r.shopBefore} → **${r.shopAfter}**` : "—"} | ${ppCell(r)} | ${mocked(r) || "—"} | ${debugIds(r) || "—"} | ${esc(r.reasons.join("; ") || "all invariants hold")} |`);
  return ["| Verdict | Scenario | Shop order (before → after) | PayPal truth (GET order) | Mock | Debug IDs | Why |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

export function writeRunReport(run: RunResult, runDir: string) {
  const pass = run.results.filter((r) => r.verdict === "PASS").length;
  const fail = run.results.filter((r) => r.verdict === "FAIL").length;
  const md = [`# Proof run: ${run.target} (${run.variant}, ${run.mode} mode${run.commit ? ", " + run.commit : ""})`, "", `${run.startedAt} · ${pass} pass, ${fail} fail, ${run.results.length - pass - fail} n/a · sandbox only`, "", runTable(run), "",
    "## Steps per scenario", "", ...run.results.flatMap((r) => [`### ${r.id}: ${r.title}`, "", ...r.calls.map((c) => `- ${c.step} → ${c.http || "not called"}${c.body !== undefined ? " `" + JSON.stringify(c.body).slice(0, 200) + "`" : ""}`), ...r.notes.map((n) => `- note: ${n}`), r.screenshot ? `- screenshot: \`${r.screenshot}\`` : "", ""])].join("\n");
  fs.writeFileSync(path.join(runDir, "REPORT.md"), md);
}

export interface PackLabels { before: string; after: string; intro: string; runs: string; harness: string }

export function writePack(target: string, original: RunResult[], upgraded: RunResult[], outDir: string, extra: { diffStat: string; loopLog: string[]; scanBefore: string; scanAfter: string; labels: PackLabels }) {
  const L = extra.labels;
  fs.mkdirSync(outDir, { recursive: true });
  const all = [...original, ...upgraded];
  const keys = [...new Set(all.flatMap((run) => run.results.map((r) => `${r.id}|${run.mode}`)))];
  const find = (runs: RunResult[], key: string) => { const [id, mode] = key.split("|"); return runs.find((x) => x.mode === mode)?.results.find((r) => r.id === id); };
  const cell = (r?: ScenarioResult) => !r ? "—" : `${r.verdict === "FAIL" ? "**FAIL**" : r.verdict === "N/A" ? "n/a" : r.verdict === "INCONCLUSIVE" ? "inconclusive" : "PASS"}${r.simulated ? " (simulated)" : ""}${r.shopOrderId ? ` · shop ${r.shopAfter}` : ""}${r.paypal.length ? " · " + r.paypal.map((t) => `\`${t.orderId}\` ${t.captures.map((c) => `${c.status} ${formatMoney(c.amount)}`).join("+") || t.status}`).join(", ") : ""}${r.verdict === "FAIL" ? "<br>" + esc(r.reasons[0] ?? "") : ""}`;
  const oneMode = new Set(all.map((r) => r.mode)).size === 1;
  const compare = [oneMode ? `| Scenario | ${L.before} | ${L.after} |` : `| Scenario | Mode | ${L.before} | ${L.after} |`, oneMode ? "|---|---|---|" : "|---|---|---|---|",
    ...keys.map((k) => { const [id, mode] = k.split("|"); const r = find(original, k) ?? find(upgraded, k); return `| ${id} (${r?.ref}) |${oneMode ? "" : ` ${mode} |`} ${cell(find(original, k))} | ${cell(find(upgraded, k))} |`; })].join("\n");
  const tally = (runs: RunResult[]) => { const rs = runs.flatMap((r) => r.results); const inc = rs.filter((r) => r.verdict === "INCONCLUSIVE").length; return `${rs.filter((r) => r.verdict === "PASS").length} pass, ${rs.filter((r) => r.verdict === "FAIL").length} fail, ${rs.filter((r) => r.verdict === "N/A").length} n/a${inc ? `, ${inc} inconclusive` : ""}`; };
  const body = [
    `## Upgrade PayPal checkout to JS SDK v6 and @paypal/paypal-server-sdk, with sandbox proof`, "",
    L.intro, "",
    L.runs, "",
    `Before: ${tally(original)}. After: ${tally(upgraded)}.`, "",
    compare, "",
    "### What changed", "", "```", extra.diffStat.trim(), "```", "",
    "### How it was produced", "", ...extra.loopLog.map((l) => `- ${l}`), "",
    "### Scan before", "", extra.scanBefore, "", "### Scan after", "", extra.scanAfter, "",
    `${L.harness} Full per-scenario tables with debug IDs are in the run reports listed in EVIDENCE.md.`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "PR-BODY.md"), body);
  fs.writeFileSync(path.join(outDir, "EVIDENCE.md"), [`# Evidence: ${target}`, "", compare, "", ...all.map((r) => `- ${r.variant}, ${r.mode} mode${r.commit ? " at " + r.commit : ""}: \`out/${r.runDir}/REPORT.md\``), ...all.map((r) => `\n## ${r.variant}, ${r.mode} mode\n\n${runTable(r)}`)].join("\n"));
  return body;
}

// Recording-friendly summary of one scenario with a timeline (expressCart E1): exact steps, timings, IDs and the
// screenshots taken at each step, for re-enacting it in front of tools/recording/.
export function writeVideoSummary(outDir: string, file: string, title: string, before?: ScenarioResult & { runDir?: string }, after?: ScenarioResult & { runDir?: string }, howTo: string[] = []) {
  const block = (label: string, r?: ScenarioResult & { runDir?: string }) => !r ? [`## ${label}`, "", "No run with a timeline yet.", ""] : [
    `## ${label}: ${r.verdict}${r.attempts && r.attempts > 1 ? ` (attempt ${r.attempts})` : ""}, ${r.seconds} s end to end`, "",
    "| t (s) | Step | Screenshot |", "|---|---|---|",
    ...(r.timeline ?? []).map((x) => `| ${x.t.toFixed(1)} | ${esc(x.step)} | ${x.shot ? `\`out/${r.runDir}/${x.shot}\`` : ""} |`), "",
    `Shop order \`${r.shopOrderId ?? "—"}\`: ${r.shopBefore} → **${r.shopAfter}**, total ${r.shopTotal ?? "—"}.`, "",
    "PayPal (sandbox) records:", "", ...r.paypal.map((t) => `- \`${t.orderId}\` ${t.status}${t.captures.map((c) => `, ${c.id.length > 20 ? "sale" : "capture"} \`${c.id}\` ${c.status} ${formatMoney(c.amount)}`).join("")}`), "",
    ...(r.reasons.length ? ["Verdict reasons:", "", ...r.reasons.map((x) => `- ${x}`), ""] : ["All money invariants hold.", ""]),
    ...r.notes.map((n) => `- note: ${n}`), "",
  ];
  fs.writeFileSync(path.join(outDir, file), [`# ${title}`, "",
    "For the video: the steps below are what the proof did, with the time each one finished (seconds from the start of the scenario). Re-enact them with tools/recording/ in this order; the screenshots show what each screen should look like. Sandbox only; the buyer login is masked.", "",
    ...(howTo.length ? ["## How to re-enact it for tools/recording/", "", ...howTo.map((x) => `- ${x}`), ""] : []),
    ...block("Before: the original shop", before), ...block("After: the upgraded shop", after)].join("\n"));
}
