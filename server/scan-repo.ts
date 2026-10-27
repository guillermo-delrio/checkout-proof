// "Scan a public repo": fetch a public GitHub repo's tarball (unauthenticated, size-capped, with a timeout), read it
// in memory and run the same static rules as `cp scan`. No code from the repo is executed, nothing touches disk, and
// no model is called.
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { repoScan, type Finding } from "../src/scan/scan.ts";
import { readTar } from "./tar.ts";

export const LIMITS = {
  maxTarGzBytes: 25 * 1024 * 1024,   // compressed download
  maxTarBytes: 50 * 1024 * 1024,     // after gunzip (with 2 scans at once, the instance's 2 GiB stays far away)
  maxFiles: 20_000,                  // regular files in the archive; more is refused (413), never half-scanned
  maxFileBytes: 2_000_000,           // same as cp scan
  timeoutMs: 20_000,
  scanMs: 15_000,                    // the scan itself, in a worker that is terminated after this (review r3, A1)
};

const SKIP = /(^|\/)(node_modules|\.git|build|dist|out|coverage|\.next|vendor)\//;

export interface RepoRef { owner: string; repo: string; ref?: string }

/** Accepts github.com URLs (https, optional www, optional /tree/<ref>), "owner/repo", or git@github.com:owner/repo.git. */
export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim();
  if (s.length > 300) return null;
  const name = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
  const repo = "[A-Za-z0-9._-]{1,100}";
  const ref = "[A-Za-z0-9._/-]{1,200}";
  let m = s.match(new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${name})/(${repo}?)(?:\\.git)?(?:/tree/(${ref}))?/?(?:[?#].*)?$`, "i"));
  if (!m) m = s.match(new RegExp(`^git@github\\.com:(${name})/(${repo}?)(?:\\.git)?$`, "i"));
  if (!m) m = s.match(new RegExp(`^(${name})/(${repo}?)$`));
  if (!m) return null;
  const r = m[2].replace(/\.git$/i, "");
  if (!r || r === "." || r === "..") return null;
  if (m[3] && m[3].includes("..")) return null;
  return { owner: m[1], repo: r, ref: m[3]?.replace(/\/$/, "") };
}

// No parameter properties: the scan worker loads this file, and Node's own type stripping may load it there.
export class ScanError extends Error {
  code: "not-found" | "too-large" | "timeout" | "upstream" | "bad-archive";
  constructor(code: ScanError["code"], msg: string) { super(msg); this.code = code; }
}

/** Downloads with a byte cap; aborts as soon as the cap is passed. */
export async function fetchCapped(url: string, maxBytes: number, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": "checkout-proof-scan" } });
    if (r.status === 404) throw new ScanError("not-found", "No public repo at that address (private repos and wrong names both look like this).");
    if (!r.ok || !r.body) throw new ScanError("upstream", `GitHub answered HTTP ${r.status}.`);
    const len = Number(r.headers.get("content-length") || 0);
    if (len > maxBytes) throw new ScanError("too-large", `The repo archive is ${(len / 1048576).toFixed(0)} MB; the scan box reads up to ${maxBytes / 1048576} MB.`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of r.body as any as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > maxBytes) { ac.abort(); throw new ScanError("too-large", `The repo archive is over ${maxBytes / 1048576} MB; the scan box reads up to that much.`); }
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  } catch (e: any) {
    if (e instanceof ScanError) throw e;
    if (ac.signal.aborted) throw new ScanError("timeout", `GitHub did not send the archive within ${timeoutMs / 1000} s.`);
    throw new ScanError("upstream", "Could not reach GitHub.");
  } finally { clearTimeout(timer); }
}

export interface ScanResult {
  repo: string; ref: string; commit: string | null; scannedAt: string;
  filesSeen: number; filesScanned: number; truncated: boolean;
  findings: Finding[]; counts: { upgrade: number; deprecated: number; risk: number };
}

/** Scans a .tar.gz buffer as GitHub's codeload serves it (one top-level "<owner>-<repo>-<sha>/" folder). */
export function scanTarGz(tgz: Buffer, label: { repo: string; ref: string }): ScanResult {
  let tar: Buffer;
  try { tar = zlib.gunzipSync(tgz, { maxOutputLength: LIMITS.maxTarBytes }); }
  catch (e: any) {
    if (String(e?.code) === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer/i.test(String(e?.message))) throw new ScanError("too-large", `The unpacked repo is over ${LIMITS.maxTarBytes / 1048576} MB.`);
    throw new ScanError("bad-archive", "GitHub's archive could not be read.");
  }
  const scan = repoScan();
  let filesSeen = 0, filesScanned = 0, commit: string | null = null;
  const meta: { comment?: string; tooManyFiles?: boolean } = {};
  for (const f of readTar(tar, { maxFiles: LIMITS.maxFiles, maxFileBytes: LIMITS.maxFileBytes, meta })) {
    filesSeen++;
    const slash = f.path.indexOf("/");
    if (commit === null) commit = (meta.comment && /^[0-9a-f]{40}$/.test(meta.comment) ? meta.comment : null) ?? (slash > 0 ? f.path.slice(0, slash).match(/-([0-9a-f]{7,40})$/)?.[1] ?? null : null);
    const rel = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    if (!rel || SKIP.test(rel) || /\.min\.js$/.test(rel)) continue;
    scan.add(rel, f.data.toString("utf8"));
    if (/\.(m?[jt]sx?|cjs|html?|hbs|ejs|vue|svelte|php)$|package\.json$/.test(rel)) filesScanned++;
  }
  if (meta.tooManyFiles) throw new ScanError("too-large", `The repo has more than ${LIMITS.maxFiles.toLocaleString("en")} files; the scan box reads up to that many.`);
  const findings = scan.done();
  const count = (k: string) => findings.filter((f) => f.kind === k).length;
  return {
    repo: label.repo, ref: label.ref, commit, scannedAt: new Date().toISOString(),
    filesSeen, filesScanned, truncated: false, findings: findings.slice(0, 500),
    counts: { upgrade: count("upgrade"), deprecated: count("deprecated"), risk: count("risk") },
  };
}

export async function scanRepo(ref: RepoRef, fetchImpl: typeof fetch = fetch): Promise<ScanResult> {
  // codeload serves the default branch for HEAD; no API call (and no API rate limit) is needed.
  const r = ref.ref ?? "HEAD";
  const url = `https://codeload.github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/tar.gz/${r.split("/").map(encodeURIComponent).join("/")}`;
  const tgz = await fetchCapped(url, LIMITS.maxTarGzBytes, LIMITS.timeoutMs, fetchImpl);
  return scanInWorker(tgz, { repo: `${ref.owner}/${ref.repo}`, ref: r });
}

/** scanTarGz in a worker thread with a hard time limit: a slow scan can never block the server's event loop. */
export function scanInWorker(tgz: Buffer, label: { repo: string; ref: string }, ms = LIMITS.scanMs): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./scan-worker.ts", import.meta.url), {
      workerData: { tgz, label }, execArgv: ["--import", "tsx"], resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const done = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); f(); w.terminate().catch(() => {}); };
    const timer = setTimeout(() => done(() => reject(new ScanError("timeout", `The scan took longer than ${ms / 1000} s and was stopped.`))), ms);
    w.once("message", (m: any) => done(() => (m.ok ? resolve(m.result) : reject(new ScanError(m.code, m.message)))));
    w.once("error", () => done(() => reject(new ScanError("bad-archive", "The scan stopped with an error."))));
    w.once("exit", () => done(() => reject(new ScanError("bad-archive", "The scan stopped with an error."))));
  });
}
