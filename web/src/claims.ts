// Every number the site and the README state about the runs, computed from the exported data (web/public/data), so
// the two cannot drift apart (review r2 B2.2). Pure: no React, no fetch. Used by the pages, by
// scripts/export-web-data.ts (which writes the README's generated blocks) and by tests/readme-numbers.test.ts (which
// fails when README.md no longer matches the data).
import type { Catch, IndexData, LaterProof, LoopStep, TargetData } from "./types.ts";

/** "480.00 EUR" → "€480.00" for display; leaves anything else alone. */
export function fmt(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  return s.split(" + ").map((x) => {
    const m = x.match(/^(-?[\d.]+) ([A-Z]{3})$/);
    if (!m) return x;
    const sym: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
    return sym[m[2]] ? `${sym[m[2]]}${m[1]}` : `${m[1]} ${m[2]}`;
  }).join(" + ");
}

/** A scenario title without internal codes: "Cancel at PayPal, … (E1)" → "Cancel at PayPal, …". */
export const cleanTitle = (t: string) => t.replace(/\s*\((SIMULATED[^)]*|[A-Z]\d+)\)\s*$/, "").replace(/\s*\(SIMULATED:[^)]*\)/, "");

/** The money rules' verdict reasons, in plain English for a card. Unknown shapes only lose their internal codes. */
export function plainReason(r: string | undefined | null): string {
  if (!r) return "";
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^shop marked order \S+ paid; PayPal captured ([\d.]+ [A-Z]{3}), shop total is ([\d.]+ [A-Z]{3})/))) {
    const [cap, tot] = [m[1], m[2]];
    const [cv, cc] = cap.split(" "), [tv, tc] = tot.split(" ");
    const gap = cc === tc && Number(tv) > Number(cv) ? ` ${fmt(`${(Number(tv) - Number(cv)).toFixed(2)} ${tc}`)} short.` : cc !== tc ? " A different currency." : "";
    return `Paid in the shop: ${fmt(tot)}. Captured by PayPal: ${fmt(cap)}.${gap}`;
  }
  if ((m = r.match(/^shop marked order \S+ paid; PayPal shows no completed capture: \S+ ([A-Z_]+)/))) return `The shop marked the order paid, but PayPal holds no completed payment for it${m[1] === "CREATED" ? ": the buyer never approved the PayPal order" : m[1] === "APPROVED" ? ": the PayPal order was approved, never captured" : ""}.`;
  if ((m = r.match(/^buyer was charged \(([^)]*)\) but shop order \S+ is not confirmed/))) {
    const amounts = [...m[1].matchAll(/([\d.]+ [A-Z]{3})/g)].map((x) => fmt(x[1]));
    return `The buyer was charged ${amounts.join(" + ")}, and the shop never confirmed the order.`;
  }
  if ((m = r.match(/^(\d+) completed captures for shop order/))) return `The buyer was charged ${m[1] === "2" ? "twice" : `${m[1]} times`} for one order.`;
  if (/^shop process exited/.test(r)) return "The shop process crashed: the whole shop went down for every customer.";
  if (/^the refusal carries no payer_action_url/.test(r)) return "The shop did not send the buyer to PayPal's own payer-action link after PayPal asked for a buyer step.";
  if ((m = r.match(/^expected order \S+ paid once; it is (\w+)/))) return `The shop never marked the paid order paid (it stayed ${/^[aeiou]/.test(m[1]) ? "an" : "a"} ${m[1]}).`;
  // Unknown shapes: drop internal codes, and raw URLs (review r3: sandbox links filled a card).
  return r.replace(/\s*\((I|E|D)\d+\)\s*$/, "").replace(/\s*\([^()]*https?:\/\/[^()]*\)/g, "").replace(/https?:\/\/\S+/g, "a link");
}

/** Distinct money bugs and the failing runs behind them, across all shops (the hero line and the cards agree). */
export function bugCounts(index: IndexData) {
  return { bugs: index.targets.reduce((n, x) => n + x.failures.length, 0), runs: index.targets.reduce((n, x) => n + x.tally.before.fail, 0) };
}

type Prove = Extract<LoopStep, { kind: "prove" }>;
export function armFacts(t: TargetData, arm: string) {
  const a = t.arms.find((x) => x.arm === arm);
  if (!a) return null;
  // The first full proof (an early partial run with --only is skipped).
  const proves = a.steps.filter((s) => s.kind === "prove" && !s.harness) as Prove[];
  const full = Math.max(0, ...proves.map((p) => p.pass + p.fail.length));
  const first = proves.find((p) => p.pass + p.fail.length === full);
  const isGreen = (s: LoopStep) => s.kind === "prove" && s.fail.length === 0 && s.pass === full && !s.buildError;
  const gi = a.steps.findIndex(isGreen);
  const fixes = a.steps.filter((s) => s.kind === "fix");
  // Fix rounds that answered real shop failures; rounds spent on harness problems are not counted.
  const roundsToGreen = gi < 0 ? -1 : a.steps.slice(0, gi).filter((s) => s.kind === "fix" && !s.harness).length;
  // Harness rounds in which the model still changed code (a new commit): the green code is not only the shop-fix output.
  const harnessRounds = gi < 0 ? 0 : a.steps.slice(0, gi).filter((s, i, xs) => s.kind === "fix" && s.harness && s.commit !== xs.slice(0, i).reverse().find((p) => p.commit)?.commit).length;
  return { a, first, green: gi >= 0 ? (a.steps[gi] as Prove) : null, roundsToGreen, harnessRounds, fixes };
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const scenarioOf = (id: string) => id.replace(/ \(.*\)$/, "");

/** One short phrase per money failure of a proof step, from its verdict reasons (deduplicated across modes). */
/** A failPhrases() phrase as a clause: "charged the buyer twice" takes "the shop" as subject; the others carry their own. */
export const asClause = (p: string) => (/^(marked|charged|confirmed|accepted|kept|lost|forgot|sent)\b/.test(p) ? `the shop ${p}` : p);

export function failPhrases(t: TargetData, fails: { id: string; reason: string }[]): string[] {
  const out: string[] = [];
  for (const f of fails) {
    const title = t.scenarios.find((s) => s.id === scenarioOf(f.id))?.title ?? "";
    let m: RegExpMatchArray | null, p: string;
    if ((m = f.reason.match(/PayPal captured ([\d.]+ [A-Z]{3}), shop total is ([\d.]+ [A-Z]{3})/)))
      p = `marked a ${fmt(m[2])} order paid for ${fmt(m[1])}${/^Foreign PayPal order/.test(title) ? " from a PayPal order that was not its own" : ""}`;
    else if ((m = f.reason.match(/^(\d+) completed captures/))) p = `charged the buyer ${m[1] === "2" ? "twice" : `${m[1]} times`} for one order${scenarioOf(f.id) === "two-tabs" ? " from two tabs" : ""}`;
    else p = plainReason(f.reason).replace(/\.$/, "").replace(/^The /, "the ");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}`);

/** The catch an arm's fix loop made after the arm's first proof: red, a model fix, then no shop failure. */
export const catchOf = (t: TargetData, arm: string, commit?: string): Catch | undefined => (t.catches ?? []).find((c) => c.arm === arm && (!commit || c.red.commit === commit));

/** The best AI moment: a model fix of a real double charge (or any money failure) the proof caught. */
export function bestCatch(targets: TargetData[]): { t: TargetData; c: Catch } | null {
  const all = targets.flatMap((t) => (t.catches ?? []).map((c) => ({ t, c })));
  return pickCatch(all);
}
export const isDoubleCharge = (c: Catch) => (c.red.cell?.paypal.flatMap((p) => p.captures).filter((x) => x.status === "COMPLETED").length ?? 0) > 1;
function pickCatch<T extends { c: Catch }>(all: T[]): T | null {
  const charged = (c: Catch) => (c.red.cell?.paypal.flatMap((p) => p.captures).filter((x) => x.status === "COMPLETED").length ?? 0) > 1;
  return all.find(({ c }) => c.arm === "" && charged(c)) ?? all.find(({ c }) => charged(c)) ?? all[0] ?? null;
}

// Scenarios whose verdict reasons don't read well as a phrase: what the failure means, said once per scenario.
const LATER_PHRASE: Record<string, string> = {
  "payer-action": "answered a capture PayPal refused with PAYER_ACTION_REQUIRED as if it had worked",
  "capture-refused": "confirmed an order whose capture PayPal refused (TRANSACTION_REFUSED)",
  "restart-approved": "lost an approved payment when the shop restarted before the capture",
  "restart-pending": "forgot a payment in progress when the shop restarted, and let the buyer pay again",
};

/** The plain arm's result on scenarios added after its loop ended (null when there is none, or nothing failed). */
export function laterFacts(t: TargetData, arm = "plain"): (LaterProof & { fails: number; pass: number; runs: number; ids: string[]; phrases: string[] }) | null {
  const l = t.arms.find((x) => x.arm === arm)?.later;
  if (!l) return null;
  const fails = l.modes.flatMap((m) => m.fail);
  const ids = [...new Set(fails.map((f) => f.id))];
  const phrases: string[] = [];
  for (const f of fails) {
    const p = LATER_PHRASE[f.id] ?? failPhrases(t, [f])[0];
    if (!phrases.includes(p)) phrases.push(p);
  }
  return { ...l, fails: fails.length, pass: l.modes.reduce((n, m) => n + m.pass, 0), runs: l.modes.reduce((n, m) => n + m.total - m.na, 0), ids, phrases };
}

/** One sentence: what the later scenarios found in an arm's final code. */
export function laterSentence(t: TargetData, arm = "plain"): string | null {
  const l = laterFacts(t, arm);
  if (!l || !l.fails) return null;
  const sim = l.modes.flatMap((m) => m.fail).filter((f) => f.simulated && !LATER_PHRASE[f.id]).length;
  const scope = `${l.ids.length === l.added.length ? (l.added.length === 2 ? "both" : `all ${l.added.length}`) : `${l.ids.length} of the ${l.added.length}`}${l.modes.length > 1 ? `, in each of its ${l.modes.length} modes` : ""}`;
  return `Scenarios added on ${day(l.at)} were never fed back to the plain upgrade, and its final code fails ${scope} (${l.fails} of ${l.runs} sandbox runs on the larger suite): it ${list(l.phrases)}${sim ? ` (${sim === l.fails ? "both PayPal answers simulated" : "PayPal's answer simulated"})`.replace("both", l.fails === 2 ? "both" : "all") : ""}.`;
}

/** A catch's green run as the card shows it: reds the export marks as the harness's (harnessNote) count as
 *  inconclusive, not as fails (the data keeps them as recorded). Watch round 114: "21 of 22 pass" read as one shop
 *  failure. The catch card and the README's plain-arm sentence both print `line`. */
export function greenCounts(c: Catch) {
  const harnessRed = c.green.fail > 0 && !!c.green.harnessNote;
  const inc = (c.green.inconclusive ?? 0) + (harnessRed ? c.green.fail : 0);
  const fail = harnessRed ? 0 : c.green.fail;
  const incShort = harnessRed && /buyer tim/i.test(c.green.harnessNote ?? "") ? " (sandbox timeout)" : "";
  const line = `${c.green.pass} pass${inc > 0 ? `, ${inc} inconclusive${incShort}` : ""}, ${fail} fail`;
  return { harnessRed, inc, fail, n: c.green.pass + fail + inc, incShort, line };
}

/** What the plain-prompt arm did, per shop, in plain sentences. The home page and the README both print these. */
export function plainArmSentences(targets: TargetData[]): string[] {
  const out: string[] = [];
  const safe: TargetData[] = [];
  for (const t of targets) {
    const plain = armFacts(t, "plain"), full = armFacts(t, "");
    if (!plain?.first) continue;
    const first = plain.first;
    const total = first.pass + first.fail.length;
    const later = laterSentence(t);
    if (first.fail.length === 0) {
      if (later) out.push(`On ${t.name} ${full?.first && full.first.fail.length === 0 && full.first.pass === total ? `both upgrades passed all ${total} sandbox runs at their first proof` : `the plain upgrade passed all ${total} sandbox runs at its first proof`} (${day(first.at)}). ${later}`);
      else if (full?.first && full.first.fail.length === 0) safe.push(t); else out.push(`On ${t.name} the plain upgrade passed all ${total} sandbox runs at its first proof (${day(first.at)}).`);
      continue;
    }
    const c = catchOf(t, "plain", first.commit);
    let s = `On ${t.name} the plain upgrade failed ${first.fail.length} of ${total} sandbox runs at its first proof (${day(first.at)}): it ${list(failPhrases(t, first.fail))}.`;
    if (c) {
      s += ` The failing evidence went back to the model with no rules added. After one fix round (${c.fix.turns} turns, ${c.fix.seconds} s): ${greenCounts(c).line}.`;
    }
    if (later) s += ` ${later}`;
    out.push(s);
  }
  if (safe.length) out.push(`On ${safe.map((t) => t.name).join(" and ")} both upgrades were money-safe at the first proof.`);
  return out;
}

/** "28 of 29 pass (1 not applicable)": N/A runs are left out of the total they are counted against. */
export function afterLine(t: { tally: TargetData["tally"] }) {
  const a = t.tally.after, applicable = a.total - a.na;
  return `${a.pass} of ${applicable} pass${a.fail ? `, ${a.fail} fail` : ""}${a.inconclusive ? `, ${a.inconclusive} inconclusive` : ""}${a.na ? ` (${a.na} not applicable)` : ""}`;
}

/** The README's results table, one row per shop. Headlines are the exported bug cards' own. */
export function resultsTable(index: IndexData, stars: Record<string, string> = {}): string {
  const rows = index.targets.map((t) => {
    const name = t.repo ? `[${t.name}](${t.repo})${stars[t.slug] ? ` (${stars[t.slug]})` : ""}` : t.name;
    const runs = t.tally.before.fail;
    const before = `${t.failures.length} money bug${t.failures.length === 1 ? "" : "s"} (${runs} failing run${runs === 1 ? "" : "s"}), for example: ${(t.failures[0]?.headline ?? "").replace(/\|/g, "\\|")}`;
    return `| ${name} | ${before} | ${afterLine(t)} |`;
  });
  return ["| Shop | Before the upgrade | After |", "|---|---|---|", ...rows].join("\n");
}

const afterFails = (index: IndexData) => index.targets.reduce((n, t) => n + t.tally.after.fail, 0);

/** The generated README blocks, by name: `<!-- generated:NAME -->…<!-- /generated:NAME -->`. */
export function readmeBlocks(index: IndexData, targets: TargetData[]): Record<string, string> {
  const ordered = index.targets.map((x) => targets.find((t) => t.slug === x.slug)!).filter(Boolean);
  const { bugs, runs } = bugCounts(index);
  const best = bestCatch(ordered);
  const blocks: Record<string, string> = {
    "plain-arm": `**The plain-prompt test.** Each shop was upgraded twice: once from a plain upgrade request with no money rule, once with our money rules in the prompt. ${plainArmSentences(ordered).join(" ")} Only the sandbox proof could tell the cases apart.`,
    results: `${index.targets.length} shops, ${bugs} money bugs found in the sandbox (${runs} failing runs before the upgrade); ${afterFails(index) === 0 ? "none fails after it" : `${afterFails(index)} scenario runs still fail after it`}.\n\n${resultsTable(index, { expresscart: "about 2.2k ★" })}`,
  };
  if (best) {
    const { t, c } = best;
    blocks["ai-catch"] = `**The proof caught ${isDoubleCharge(c) ? "a real double charge" : "a real money bug"}, and Claude fixed it from the evidence alone.** On ${t.name}, ${c.after?.byHand ? `after a hand edit (${c.after.commit}), the next proof` : `the proof at ${c.red.commit}`} found that the shop ${list(failPhrases(t, c.red.fail))} (${c.red.cell?.paypal.flatMap((p) => p.captures).map((x) => x.id).join(", ") || "see the evidence page"}). The proof sent that evidence back to Claude: ${c.fix.step}, ${c.fix.turns} turns, ${c.fix.seconds} s, commit ${c.fix.commit}. The next proof passed ${c.green.pass} of ${c.green.pass + c.green.fail}.`;
  }
  return blocks;
}

/** SCENARIOS.md's "what runs today" list, per shop, from the exported scenario table. */
export function scenarioBlocks(index: IndexData, targets: TargetData[]): Record<string, string> {
  const lines = index.targets.map((x) => targets.find((t) => t.slug === x.slug)!).filter(Boolean).map((t) => {
    const runs = t.scenarios.map((s) => {
      const after = s.modes.map((m) => m.after?.verdict).filter(Boolean);
      const live = s.modes.some((m) => m.after?.notes?.some((n) => /^Live re-run on Cloud Run/.test(n)));
      const na = after.length > 0 && after.every((v) => v === "N/A");
      return `\`${s.id}\` (${s.ref}${na ? ", not applicable here" : live ? ", live re-run only" : ""})`;
    });
    return `- **${t.name}** (${t.modes.length > 1 ? `${t.modes.join(" and ")} mode` : "one mode"}), ${t.scenarios.length} scenarios: ${runs.join(", ")}.`;
  });
  return { "runs-today": lines.join("\n") };
}

/** Replaces each generated block in a markdown text; throws if a block's markers are missing. */
export function fillBlocks(text: string, blocks: Record<string, string>, file = "README.md"): string {
  for (const [name, body] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`);
    if (!re.test(text)) throw new Error(`${file} has no <!-- generated:${name} --> block`);
    text = text.replace(re, `$1\n${body}\n$2`);
  }
  return text;
}
