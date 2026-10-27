import fs from "node:fs";
import path from "node:path";
import { OUT, mkdirp, requireSandbox } from "../env.ts";
import { execFileSync } from "node:child_process";
import { gitHead } from "../targets/simple-clothing-store.ts";
import { targetDef } from "../targets/index.ts";
import { runProof, type RunResult } from "./runner.ts";
import { writeRunReport } from "../evidence/pack.ts";
import type { Variant } from "../targets/types.ts";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export async function prove(target: string, variant: Variant, only?: string[], rebuild = false, mode?: string): Promise<RunResult> {
  const t = targetDef(target);
  mode ??= t.modes[0];
  if (!t.modes.includes(mode)) throw new Error(`${target} has modes ${t.modes.join(", ")}`);
  requireSandbox();
  // Two runs of one target and variant share its ports: an overlapping run once turned harness errors into reds
  // (17 Oct, a8a0129). One run at a time per target and variant; a lock left by a dead process is taken over.
  const release = takeLock(target, variant);
  try { return await proveLocked(t, target, variant, mode, only, rebuild); } finally { release(); }
}

export function takeLock(target: string, variant: Variant): () => void {
  const file = path.join(mkdirp(path.join(OUT, "runs", target)), `.prove-${variant}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => { try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.rmSync(file); } catch {} };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch (k: any) { alive = k?.code === "EPERM"; }
      if (alive && pid !== process.pid) throw new Error(`harness: another proof of ${target} (${variant}) is running (pid ${pid}); wait for it, or remove ${path.relative(process.cwd(), file)} if it is gone`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`harness: could not take ${file}`);
}

async function proveLocked(t: ReturnType<typeof targetDef>, target: string, variant: Variant, mode: string, only: string[] | undefined, rebuild: boolean): Promise<RunResult> {
  const runDir = mkdirp(path.join(OUT, "runs", target, `${stamp()}-${variant}${variant === "upgraded" && process.env.CP_ARM ? "-" + process.env.CP_ARM : ""}-${mode}`));
  const a = t.adapter(variant, runDir, mode);
  console.log(`prove ${target} (${variant}, ${mode} mode) → ${path.relative(process.cwd(), runDir)}`);
  await a.prepare({ rebuild });
  // The original work copy has no git of its own: name the upstream commit it was copied from.
  const up = gitHead(path.join(OUT, "targets", target));
  // A mutation test (src/prove/mutations.ts) runs modified code: its record says so, never just the commit.
  const mutation = process.env.CP_MUTATION ? JSON.parse(process.env.CP_MUTATION) : undefined;
  const head = gitDescribe(a.workDir);
  const run = await runProof(a, runDir, only, head ? (mutation ? `${head.replace(/-dirty$/, "")}+mutation:${mutation.name}` : head) : up && `upstream ${up}`, mutation);
  writeRunReport(run, runDir);
  // A partial run (--only) never replaces the full run that pack reads; nor does a web "re-run proof" (CP_NO_LATEST).
  if (!only && !process.env.CP_NO_LATEST) fs.writeFileSync(path.join(OUT, "runs", target, `latest-${variant}${variant === "upgraded" && process.env.CP_ARM ? "-" + process.env.CP_ARM : ""}-${mode}.json`), JSON.stringify({ runDir }));
  return run;
}


// The work copy's commit, with "-dirty" when it holds uncommitted changes (review r2 N9: a run of edited code must not
// read as the commit's result). The Cloud Run image has no .git: its .cp-commit names the commit it was staged from.
export function gitDescribe(dir: string): string | undefined {
  const head = gitHead(dir);
  if (!head || !fs.existsSync(path.join(dir, ".git"))) return head;
  try { return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir }).toString().trim() ? `${head}-dirty` : head; } catch { return head; }
}
