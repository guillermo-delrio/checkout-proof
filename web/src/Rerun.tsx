import { useEffect, useRef, useState } from "react";
import { Arrow, fmt, plainReason } from "./components";
import { Link } from "./router";
import { asset, LIVE_URL, STATIC } from "./env";

// API shapes: PROGRESS.md "Review r2, part A2 … shapes for B2". Older servers send no `kinds`, `kind` or `cause`; the
// page then offers the upgraded re-run only and says to keep the tab open.
type Kind = "upgraded" | "original";
interface KindStatus { leftToday: number; leftForYou: number; leftNow?: number; nextSliceAt?: string | null; caps: { daily: number; perVisitor: number }; expected?: number; expectedVerdict?: "PASS" | "FAIL" }
interface Status { enabled: boolean; mode: string; judgesOnly?: boolean; busy: boolean; runningJob: string | null; leftToday: number; leftForYou: number; caps: { daily: number; perVisitor: number }; kinds?: Record<Kind, KindStatus> }
interface Result { id: string; title: string; verdict: string; reasons: string[]; cause?: "shop" | "harness" | "paypal"; notes?: string[]; paypal: { orderId: string; status: string; captures: { id: string; amount: string; status: string }[] }[] }
interface Job { id: string; kind?: Kind; expectedVerdict?: "PASS" | "FAIL"; state: "running" | "done" | "failed" | "interrupted"; startedAt?: string; progress: { id: string; verdict: string; cause?: string }[]; expected: number; error?: string; commit?: string; results?: Result[]; refunded?: boolean }
interface Tally { [verdict: string]: number }
interface History { saved: number; done: number; tally: Tally; runs: { id: string; state: string; startedAt: string; kind?: Kind; tally?: Tally }[]; byKind?: Record<Kind, { done: number; tally: Tally }> }

const ORIGINAL_IDS = ["two-tabs", "currency"];
// The judges' code: from a ?judge= link (then dropped from the address bar) or typed once, and kept in this browser.
const CODE_KEY = "cp-judge-code";
function initialCode(): string {
  try {
    const u = new URL(window.location.href), q = u.searchParams.get("judge");
    if (q) { localStorage.setItem(CODE_KEY, q); u.searchParams.delete("judge"); window.history.replaceState(null, "", u.toString()); return q; }
    return localStorage.getItem(CODE_KEY) ?? "";
  } catch { return ""; }
}
const keepCode = (c: string) => { try { if (c) localStorage.setItem(CODE_KEY, c); else localStorage.removeItem(CODE_KEY); } catch { /* private window */ } };

const causeLabel = (c?: string) => (c === "paypal" ? "PayPal's sandbox was slow" : c === "harness" ? "our test harness" : "");

export function Rerun({ scenarioIds }: { scenarioIds: string[] }) {
  return STATIC ? <StaticRerun /> : <LiveRerun scenarioIds={scenarioIds} />;
}

/** The live demo's address, as the read-only copy shows it in place of every live button. */
export function LiveDemo({ what }: { what: string }) {
  return <p className="notice info live-elsewhere">{what}: live demo at <a href={LIVE_URL}>{LIVE_URL.replace(/^https:\/\//, "")}</a>. This copy is read-only.</p>;
}

// Read-only copy: the saved live runs as they were when it was built (data/live/history.json), no buttons.
function StaticRerun() {
  const [hist, setHist] = useState<(History & { snapshotAt?: string }) | null>(null);
  useEffect(() => { fetch(asset("data/live/history.json")).then((r) => (r.ok ? r.json() : null)).then(setHist, () => setHist(null)); }, []);
  const up = hist?.byKind?.upgraded ?? (hist ? { done: hist.done, tally: hist.tally } : null);
  const orig = hist?.byKind?.original;
  const sum = (t: Tally) => Object.values(t).reduce((a, b) => a + b, 0);
  return (
    <div className="rerun">
      <div>
        <p className="kicker" style={{ color: "inherit", opacity: 0.7 }}>Live in the PayPal sandbox</p>
        <h3>Run the proof yourself.</h3>
        <LiveDemo what="Judges can re-run the upgraded shop, or watch the original lose money, with the code in the submission" />
        {hist && (up?.done || orig?.done) ? (
          <p className="small">
            Saved live runs of the upgraded shop{hist.snapshotAt ? ` up to ${hist.snapshotAt.slice(0, 16).replace("T", " ")} UTC` : ""}: {up?.done ?? 0}, {up?.tally.PASS ?? 0} of {up ? sum(up.tally) : 0} scenario results pass{up?.tally.INCONCLUSIVE ? `, ${up.tally.INCONCLUSIVE} inconclusive` : ""}{up?.tally.FAIL ? `, ${up.tally.FAIL} fail` : ""}.
            {orig?.done ? ` Of the original shop: ${orig.done}, ${orig.tally.FAIL ?? 0} of ${sum(orig.tally)} red as expected.` : ""} Each run is kept whole:{" "}
            {hist.runs.filter((r) => r.state === "done").map((r, i) => <span key={r.id}>{i ? ", " : ""}<Link to={`/run/${r.id}`}>{r.kind === "original" ? "original, " : ""}{r.startedAt.slice(0, 16).replace("T", " ")} UTC</Link></span>)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LiveRerun({ scenarioIds }: { scenarioIds: string[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hist, setHist] = useState<History | null>(null);
  const [now, setNow] = useState(Date.now());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [code, setCode] = useState(initialCode);
  const timer = useRef<number>();

  const loadStatus = () => fetch("/api/rerun").then((r) => r.json()).then((s: Status) => { setStatus(s); return s; });
  const loadHistory = () => fetch("/api/rerun/history").then((r) => (r.ok ? r.json() : null)).then(setHist).catch(() => setHist(null));

  useEffect(() => {
    loadStatus().then((s) => { if (s.runningJob) poll(s.runningJob); }).catch(() => setStatus(null));
    loadHistory();
    return () => window.clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (job?.state !== "running") return;
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, [job?.state]);

  // Long poll. Never spins: at most one request every 2 s even if the server answers at once (an older server, or
  // another instance), the server's Retry-After on 429, and 5 s after any other error (21 Oct: a tight loop got 429s).
  function poll(id: string) {
    const t0 = Date.now();
    const again = (ms: number) => { timer.current = window.setTimeout(() => poll(id), ms); };
    fetch(`/api/rerun/${id}?wait=20`).then(async (r) => {
      if (r.status === 429) return again(Math.max(5, Number(r.headers.get("Retry-After")) || 30) * 1000);
      if (!r.ok) return again(5000);
      const j: Job = await r.json();
      setJob(j);
      if (j.startedAt) setStartedAt(Date.parse(j.startedAt));
      if (j.state === "running") again(Math.max(200, 2000 - (Date.now() - t0)));
      else { loadStatus().catch(() => {}); loadHistory(); }
    }).catch(() => again(5000));
  }

  async function start(kind: Kind) {
    setErr(null);
    // JSON plus our own header: the server refuses re-runs started from any other page (cross-site requests).
    const r = await fetch("/api/rerun", { method: "POST", headers: { "Content-Type": "application/json", "X-CP": "1" }, body: JSON.stringify(status?.kinds ? { kind, ...(status.judgesOnly ? { code: code.trim() } : {}) } : {}) });
    const body = await r.json();
    if (!r.ok) { setErr(body.error); if (body.code === "judges-only") keepCode(""); return; }
    keepCode(code.trim());
    setJob({ kind, ...body });
    setStartedAt(Date.now());
    poll(body.id);
  }

  const kinds = status?.kinds;
  const running = job?.state === "running";
  const jobKind: Kind = job?.kind ?? "upgraded";
  const expectRed = (job?.expectedVerdict ?? (jobKind === "original" ? "FAIL" : "PASS")) === "FAIL";
  const done = new Map(job?.progress.map((p) => [p.id, p]) ?? []);
  const results = new Map(job?.results?.map((r) => [r.id, r]) ?? []);
  const base = jobKind === "original" ? ORIGINAL_IDS : scenarioIds;
  // The runner's own scenario list wins: any scenario it reports that this page does not know yet still gets a tile.
  const ids = !job ? scenarioIds : job.results?.length ? [...new Set([...job.results.map((r) => r.id), ...job.progress.map((p) => p.id)])] : [...new Set([...base, ...job.progress.map((p) => p.id)])];
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const k = (x: Kind): KindStatus | null => kinds?.[x] ?? (x === "upgraded" && status ? { leftToday: status.leftToday, leftForYou: status.leftForYou, caps: status.caps } : null);
  const judges = !!status?.judgesOnly;
  const canStart = (x: Kind) => { const s = k(x); return !!s && (!judges || !!code.trim()) && !running && !status?.busy && s.leftForYou > 0 && (s.leftNow ?? s.leftToday) > 0; };
  const up = hist?.byKind?.upgraded ?? (hist ? { done: hist.done, tally: hist.tally } : null);
  const orig = hist?.byKind?.original;
  const sum = (t: Tally) => Object.values(t).reduce((a, b) => a + b, 0);

  return (
    <div className="rerun">
      <div>
        <p className="kicker" style={{ color: "inherit", opacity: 0.7 }}>Live in the PayPal sandbox</p>
        <h3>Run the proof yourself, now.</h3>
        <p>Same deterministic runner as the evidence below, fresh sandbox order IDs, our own sandbox buyer. No model decides anything here.</p>
        {status?.enabled && judges && (
          <div className="judge-code">
            <p className="small" style={{ margin: 0 }}>Live runs are open to the hackathon's judges: the code is in the submission's testing instructions. Everyone else can open every saved live run below, each kept whole with PayPal's order IDs.</p>
            <label className="small">Judge code <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Judge code" /></label>
          </div>
        )}
        {status?.enabled ? (
          <div className="rerun-choices">
            <div className="rerun-choice">
              <h4>Re-run the upgraded shop <span className="chip PASS">expected: green</span></h4>
              <p className="small">Every scenario{k("upgraded")?.expected ? ` (${k("upgraded")!.expected})` : ""}: a real sandbox buyer, scripted declines and refusals, a dropped response, tampered orders, a shop restart mid-payment, and PayPal's own webhook deliveries. Several minutes, one scenario at a time.</p>
              <button className="btn" onClick={() => start("upgraded")} disabled={!canStart("upgraded")}>{running && jobKind === "upgraded" ? "Running…" : "Re-run the proof"} <Arrow /></button>
              <Left s={k("upgraded")} />
            </div>
            {kinds?.original && (
              <div className="rerun-choice red">
                <h4>Watch the original lose money <span className="chip FAIL">expected: red</span></h4>
                <p className="small">The original shop, before the upgrade, in two short scenarios: one order paid twice from two tabs, and 62 MXN accepted for a €62 order. About 1–2 minutes. <b>Red is the right result here</b>: it shows the test catches the bugs. The harness refunds the test captures afterwards.</p>
                <button className="btn" onClick={() => start("original")} disabled={!canStart("original")}>{running && jobKind === "original" ? "Running…" : "Run the original"} <Arrow /></button>
                <Left s={kinds.original} />
              </div>
            )}
            <p className="small" style={{ margin: 0, opacity: 0.85 }}>{kinds ? "You can close this tab: the run goes on and its result is saved below." : "Keep this tab open while it runs."}</p>
          </div>
        ) : status ? (
          <div className="soon"><span className="chip SIM">off here</span> Live runs are switched on only on the hosted site.</div>
        ) : null}
        {err && <div className="notice err">{err}</div>}
        {job?.state === "failed" && <div className="notice err">{job.error}</div>}
        {job?.state === "interrupted" && <div className="notice err">The server stopped in the middle of this run. What finished is saved; the run is not counted as a result.{job.refunded ? " It was given back: you can start another one." : ""}</div>}
        {running && <p className="small">{jobKind === "original" ? "Original shop" : "Upgraded shop"}: {job!.progress.length} of {job!.expected} scenarios done · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed{job!.progress.length < job!.expected ? ` · now: ${ids.find((id) => !done.has(id)) ?? "…"}` : ""}</p>}
        {job?.state === "done" && <p className="small">Done at commit {job.commit}: {job.results?.filter((r) => r.verdict === "PASS").length} of {job.results?.length} pass{expectRed ? ` (the original shop: ${job.results?.filter((r) => r.verdict === "FAIL").length} red, as expected)` : ""}.</p>}
        {hist && (up?.done || orig?.done) ? (
          <p className="small">
            Saved live runs of the upgraded shop: {up?.done ?? 0}, {up?.tally.PASS ?? 0} of {up ? sum(up.tally) : 0} scenario results pass{up?.tally.INCONCLUSIVE ? `, ${up.tally.INCONCLUSIVE} inconclusive` : ""}{up?.tally.FAIL ? `, ${up.tally.FAIL} fail` : ""}.
            {orig?.done ? ` Of the original shop: ${orig.done}, ${orig.tally.FAIL ?? 0} of ${sum(orig.tally)} red as expected.` : ""} Each run is kept whole:{" "}
            {hist.runs.filter((r) => r.state === "done").slice(0, 3).map((r, i) => <span key={r.id}>{i ? ", " : ""}<Link to={`/run/${r.id}`}>{r.kind === "original" ? "original, " : ""}{r.startedAt.slice(0, 16).replace("T", " ")} UTC</Link></span>)}.
          </p>
        ) : null}
      </div>
      <div>
        <div className={`rerun-grid${!running && !job ? " idle" : ""}`} aria-live="polite">
          {ids.map((id) => {
            const p = done.get(id), r = results.get(id);
            const v = r?.verdict ?? p?.verdict;
            const cause = r?.cause ?? p?.cause;
            const pp = r?.paypal[r.paypal.length - 1];
            return (
              <div key={id} className={`rt ${v ?? (running ? "pending" : "")}${v === "FAIL" && expectRed ? " expected" : ""}`}>
                <span>{id}</span>
                <span style={{ opacity: 0.85 }}>{v ? `${v.toLowerCase()}${v === "FAIL" && expectRed ? " (expected)" : ""}${v === "INCONCLUSIVE" && cause ? `: ${causeLabel(cause)}` : ""}` : running ? "…" : ""}{pp ? ` · ${pp.orderId}` : ""}</span>
              </div>
            );
          })}
        </div>
        {job?.state === "done" && expectRed && job.results?.filter((r) => r.verdict === "FAIL").map((r) => <LiveRed key={r.id} r={r} />)}
      </div>
    </div>
  );
}

function Left({ s }: { s: KindStatus | null }) {
  if (!s) return null;
  const later = s.leftNow === 0 && s.leftToday > 0 && s.nextSliceAt;
  return <p className="tiny" style={{ margin: "8px 0 0", opacity: 0.85 }}>{s.leftToday} of {s.caps.daily} left today · {s.leftForYou} for you{later ? ` · next one opens at ${s.nextSliceAt!.slice(11, 16)} UTC` : ""}</p>;
}

/** A red result of the original shop, in the evidence page's words: what PayPal captured, what the shop recorded. */
function LiveRed({ r }: { r: Result }) {
  const caps = r.paypal.flatMap((p) => p.captures).filter((c) => c.status === "COMPLETED");
  const refunded = (r.notes ?? []).some((n) => /refund/i.test(n));
  return (
    <div className="live-red">
      <div className="small"><b>{r.id}</b> · fail, as expected: {plainReason(r.reasons[0])}</div>
      <div className="tiny" style={{ opacity: 0.85 }}>PayPal: {caps.length ? caps.map((c) => `${c.id} ${fmt(c.amount)}`).join(" + ") : "no completed capture"}{refunded ? " · refunded by the harness afterwards" : ""}</div>
    </div>
  );
}
