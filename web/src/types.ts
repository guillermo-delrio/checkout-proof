export type Verdict = "PASS" | "FAIL" | "N/A" | "INCONCLUSIVE";

export interface Capture { id: string; status: string; amount: string }
export interface PayPalOrder { orderId: string; status: string; captures: Capture[] }

export interface Cell {
  verdict: Verdict; reasons: string[]; cause?: "shop" | "harness" | "paypal" | null; simulated: string | null; seconds: number;
  shopOrderId: string | null; shopTotal: string | null; shopBefore: string | null; shopAfter: string | null; shopPaid: boolean | null;
  paypal: PayPalOrder[]; calls: { step: string; http: number }[]; mocked: string[]; harness?: string[]; debugIds: string[]; notes: string[];
  screenshot?: string; timeline: { t: number; step: string; shot?: string }[] | null;
}

export interface Scenario { id: string; title: string; ref: string; expect: string; modes: { mode: string; before: Cell | null; after: Cell | null }[] }
export interface Tally { pass: number; fail: number; na: number; inconclusive: number; total: number }
// `code` is an internal defect ID, never shown. `sameCause` lists the scenario runs (in `mode`) that fail only because of
// this one defect; the gallery counts them once. `assumed` says what part of the story was not observed.
export interface Failure { id: string; code?: string; mode: string; headline: string; assumed?: string | null; sameCause?: string[]; simulated: string | null; afterVerdict: Verdict | null; crop?: { src: string; caption: string } }
export interface Finding { rule: string; kind: "upgrade" | "deprecated" | "risk"; file: string; line: number; text: string; why: string }

export type LoopStep =
  | { kind: "prove"; step: string; commit: string; at: string; pass: number; fail: { id: string; reason: string }[]; buildError: boolean; note: string | null; harness?: boolean }
  | { kind: "upgrade" | "fix"; step: string; commit: string; at: string; turns: number | null; seconds: number | null; skills: string[]; summary: string; note: string | null; harness?: boolean };

/** A side arm's final code proved on scenarios added after its loop ended; never fed back to the model (export: laterProof). */
export interface LaterProof {
  commit: string; at: string; added: string[];
  modes: { mode: string; pass: number; na: number; inconclusive: number; total: number; fail: { id: string; title: string; simulated: boolean; reason: string }[] }[];
}
export interface Arm { arm: string; label: string; prompt: string; steps: LoopStep[]; later?: LaterProof | null }

/** A proof that caught a shop failure, the model's fix from that evidence alone, and the next proof (export: catches()). */
export interface Catch {
  arm: string; failId: string; failMode: string | null;
  after: { step: string; commit: string; byHand: boolean } | null;
  red: { commit: string; at: string; pass: number; fail: { id: string; reason: string }[]; cell: Cell | null; cells?: Record<string, Cell> };
  fix: { step: string; commit: string; at: string; turns: number | null; seconds: number | null; costUsd: number | null; summary: string };
  green: { commit: string; at: string; pass: number; fail: number; inconclusive?: number; harnessNote: string | null; cell: Cell | null };
}
/** A run of deliberately modified code (a money check removed): shows the proof can fail; never a commit's result. */
export interface Mutation { name: string; description: string; commit: string; at: string; mode: string; results: { id: string; title: string; verdict: Verdict; reason: string }[] }

export interface TargetData {
  slug: string; name: string; rerun: boolean; repo: string | null; blurb: string; beforeNote?: string | null; modeNote?: string | null; shotNote?: string | null; stack: { before: string; after: string };
  intro: string; runsNote: string; harnessNote: string; modes: string[];
  runs: { before: { mode: string; commit: string; at: string }[]; after: { mode: string; commit: string; at: string }[] };
  tally: { before: Tally; after: Tally };
  failures: Failure[]; heroId: string | null; scenarios: Scenario[];
  diff: { files: { file: string; added: number; removed: number }[]; added: number; removed: number; commits: string[] };
  scan: { before: Finding[]; after: Finding[] };
  arms: Arm[];
  catches?: Catch[];
  mutations?: Mutation[];
}

export interface IndexData {
  exportedAt: string; aliasMode: boolean;
  targets: { slug: string; name: string; repo: string | null; blurb: string; stack: { before: string; after: string }; tally: { before: Tally; after: Tally }; failures: Failure[] }[];
}

export interface ScanResult {
  repo: string; ref: string; commit: string | null; scannedAt: string; filesSeen: number; filesScanned: number; truncated: boolean;
  findings: Finding[]; counts: { upgrade: number; deprecated: number; risk: number }; cached: boolean;
}
