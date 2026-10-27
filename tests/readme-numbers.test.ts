// The README and SCENARIOS.md state numbers about the runs. They are generated from the site's exported data by
// `npm run export-web` (web/src/claims.ts, the same functions the pages use). This test fails when the docs drift from
// web/public/data: re-run the export (review r2 B2.2: "22 of 22" in the README while the site said 28 of 28).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fillBlocks, readmeBlocks, scenarioBlocks } from "../web/src/claims.ts";
import { POPULATION } from "../web/src/population.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "web", "public", "data");
const has = fs.existsSync(path.join(DIR, "index.json"));
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe.skipIf(!has)("docs agree with the exported data", () => {
  const index = has ? JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) : null;
  const targets = has ? index.targets.map((t: any) => JSON.parse(fs.readFileSync(path.join(DIR, `${t.slug}.json`), "utf8"))) : [];
  it.skipIf(index?.aliasMode)("README's generated blocks equal what the data gives", () => {
    const readme = read("README.md");
    expect(fillBlocks(readme, readmeBlocks(index, targets))).toBe(readme);
  });
  it.skipIf(index?.aliasMode)("SCENARIOS.md's 'what runs today' equals the exported scenario table", () => {
    const doc = read("SCENARIOS.md");
    expect(fillBlocks(doc, scenarioBlocks(index, targets), "SCENARIOS.md")).toBe(doc);
  });
  it("README's population figure matches the page's", () => {
    expect(read("README.md")).toContain(`${POPULATION.repos[0].count} popular repos load JS SDK v5`);
  });
  it("README never lists a scenario that passes as 'not covered'", () => {
    const notCovered = read("README.md").split("\n").filter((l) => /not covered/i.test(l)).join(" ");
    const passing = targets.flatMap((t: any) => t.scenarios.filter((s: any) => s.modes.some((m: any) => m.after?.verdict === "PASS")).map((s: any) => s.id));
    if (passing.includes("payer-action")) expect(notCovered).not.toMatch(/PAYER_ACTION_REQUIRED/);
    if (passing.includes("webhook")) expect(notCovered).not.toMatch(/webhook/i);
  });
  // 22 Oct: the plain arms were re-proved on a larger suite outside the fix loop (19 Oct); the export read only the loop
  // logs, so the site and README kept saying "both upgrades were money-safe" on expressCart while the newer run failed.
  it("a plain arm's newer run on a larger suite reaches the exported data", () => {
    for (const t of targets) {
      const dir = path.join(ROOT, "out", "runs", t.name);
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x: string) => /^latest-upgraded-plain-/.test(x)) : []) {
        const run = JSON.parse(fs.readFileSync(path.join(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).runDir, "results.json"), "utf8"));
        const log = JSON.parse(fs.readFileSync(path.join(dir, "loop-log-plain.json"), "utf8"));
        const seen = new Set(log.flatMap((e: any) => [...(e.pass ?? []), ...(e.fail ?? []).map((x: any) => x.id)]).map((id: string) => id.replace(/ \(.*\)$/, "")));
        if (run.results.some((r: any) => !seen.has(r.id) && r.verdict !== "N/A")) expect(t.arms.find((a: any) => a.arm === "plain")?.later, `${t.name} ${f}`).toBeTruthy();
      }
    }
  });
  it("no hand-typed run tally is left outside the generated blocks", () => {
    const outside = read("README.md").replace(/<!-- generated:([\w-]+) -->[\s\S]*?<!-- \/generated:\1 -->/g, "");
    expect(outside).not.toMatch(/\b\d+ of \d+ (runs )?pass/);
    expect(outside).not.toMatch(/\b\d+ (money bugs|failing runs|sandbox runs)\b/);
  });
});
