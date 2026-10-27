import fs from "node:fs";
import path from "node:path";
import { LINE_RULES, FILE_RULES, REPO_RULES, CODE_FILES, PKG_FILES, PKG_RULE_IDS, type Kind } from "./rules.ts";

export interface Finding { rule: string; kind: Kind; file: string; line: number; text: string; why: string }

const SKIP = new Set(["node_modules", ".git", "build", "dist", "out", "coverage", ".next", "vendor", "public/build"]);

export function* walk(dir: string, rel = ""): Generator<string> {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !SKIP.has(r)) yield* walk(dir, r); }
    else if (e.isFile()) yield r;
  }
}

export function scanSource(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const isPkg = PKG_FILES.test(file);
  if (!isPkg && !CODE_FILES.test(file)) return out;
  if (src.length > 2_000_000 || /\.min\.js$/.test(file)) return out;
  const lines = src.split("\n");
  for (const r of LINE_RULES) {
    if (r.files && !r.files.test(file)) continue;
    if (isPkg && !PKG_RULE_IDS.includes(r.id)) continue;
    if (r.unlessFile?.(src)) continue;
    lines.forEach((l, i) => { if (r.re.test(l) && !r.unless?.test(l)) out.push({ rule: r.id, kind: r.kind, file, line: i + 1, text: l.trim().slice(0, 160), why: r.why }); });
  }
  if (!isPkg) for (const r of FILE_RULES) {
    if (r.files && !r.files.test(file)) continue;
    const line = r.test(src);
    if (line) out.push({ rule: r.id, kind: r.kind, file, line, text: lines[line - 1].trim().slice(0, 160), why: r.why });
  }
  return out;
}

/**
 * A whole-repo scan: add() each file, then done(). Some findings are withdrawn by a fact found in another file of the
 * same repo (a capture-status check in the browser answers "no capture-status check" on a pass-through server).
 * Use this, not scanSource() alone, whenever a whole repo is scanned.
 */
export function repoScan() {
  const found: Finding[] = [];
  const withdrawn = new Set<string>();
  return {
    add(file: string, src: string): void {
      found.push(...scanSource(file, src));
      if (CODE_FILES.test(file) && src.length <= 2_000_000) for (const r of REPO_RULES) if (r.withdrawIf.test(src)) withdrawn.add(r.id);
    },
    done(): Finding[] { return found.filter((f) => !withdrawn.has(f.rule)); },
  };
}

export function scanDir(dir: string): Finding[] {
  const scan = repoScan();
  for (const f of walk(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).size > 2_000_000) continue;
    scan.add(f, fs.readFileSync(full, "utf8"));
  }
  return scan.done();
}

export function formatFindings(fs_: Finding[]): string {
  if (!fs_.length) return "No JS SDK v5, deprecated PayPal piece or known risky pattern found.";
  const rows = fs_.map((f) => `| ${f.kind} | ${f.rule} | \`${f.file}:${f.line}\` | ${f.why} |`);
  return ["| Kind | Rule | Where | Why |", "|---|---|---|---|", ...rows].join("\n");
}
