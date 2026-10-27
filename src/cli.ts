#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { OUT, mkdirp } from "./env.ts";
import { scanDir, formatFindings } from "./scan/scan.ts";
import { prove } from "./prove/prove.ts";
import type { Variant } from "./targets/types.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, dflt?: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
const positional = rest.filter((x, i) => !x.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

async function main() {
  if (cmd === "scan") {
    const dir = path.resolve(positional[0] || ".");
    const f = scanDir(dir);
    console.log(formatFindings(f));
    const outFile = path.join(mkdirp(path.join(OUT, "scan")), `${path.basename(dir)}.json`);
    fs.writeFileSync(outFile, JSON.stringify(f, null, 2));
    console.log(`\n${f.filter((x) => x.kind === "deprecated").length} deprecated, ${f.filter((x) => x.kind === "risk").length} risk → ${path.relative(process.cwd(), outFile)}`);
  } else if (cmd === "prove") {
    const only = flag("only")?.split(",");
    const run = await prove(positional[0], (flag("variant", "original") as Variant), only, rest.includes("--rebuild"), flag("mode"));
    const fails = run.results.filter((r) => r.verdict === "FAIL").length;
    console.log(`\n${run.results.length - fails} of ${run.results.length} not failing; report: out/${run.runDir}/REPORT.md`);
  } else if (cmd === "mutate") {
    // cp mutate <name>: the shop fix taken out on purpose; the named scenarios must turn FAIL (src/prove/mutations.ts).
    const { mutationByName, prepareMutant } = await import("./prove/mutations.ts");
    const { targetDef } = await import("./targets/index.ts");
    const m = mutationByName(positional[0]);
    process.env.CP_ARM = prepareMutant(m);
    process.env.CP_MUTATION = JSON.stringify({ name: m.name, description: m.description, scenarios: m.scenarios });
    const modes = flag("mode")?.split(",") ?? m.modes ?? [targetDef(m.target).modes[0]];
    let red = 0, total = 0;
    for (const mode of modes) {
      const run = await prove(m.target, "upgraded", m.scenarios, false, mode);
      for (const r of run.results) { total++; if (r.verdict === "FAIL") red++; }
      console.log(`mutation ${m.name} (${mode}): ${run.results.map((r) => `${r.id} ${r.verdict}`).join(", ")} → out/${run.runDir}`);
    }
    console.log(red === total ? `mutation ${m.name}: caught (${red}/${total} FAIL)` : `mutation ${m.name}: NOT caught by every scenario (${red}/${total} FAIL)`);
    if (red !== total) process.exit(2);
  } else if (cmd === "upgrade" || cmd === "loop" || cmd === "pack" || cmd === "extend") {
    const { upgradeCmd, loopCmd, packCmd, extendCmd } = await import("./upgrade/upgrade.ts");
    if (cmd === "upgrade") await upgradeCmd(positional[0], rest);
    else if (cmd === "loop") await loopCmd(positional[0], Number(flag("max", "3")), flag("only")?.split(","), flag("from-runs")?.split(","));
    else if (cmd === "extend") await extendCmd(positional[0], positional[1]);
    else await packCmd(positional[0]);
  } else {
    console.log("usage: cp scan <dir> | prove <target> [--variant original|upgraded] [--mode demo|production (simple-clothing-store)] [--only a,b] [--rebuild] | upgrade <target> | loop <target> [--max 3] [--from-runs <runDir>,<runDir>] | pack <target> | extend simple-clothing-store webhook | mutate <name> [--mode m1,m2]");
    process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
