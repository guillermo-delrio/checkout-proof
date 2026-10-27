import { useEffect, useState } from "react";
import { Chip, fmt, plainReason } from "../components";
import { Link } from "../router";
import { asset, STATIC } from "../env";

// One saved live run, readable (review r3: the saved-run links opened raw JSON). Same API as the live panel.
interface Result { id: string; title: string; verdict: string; reasons: string[]; cause?: string; notes?: string[]; debugIds?: string[]; paypal: { orderId: string; status: string; captures: { id: string; amount: string; status: string }[] }[] }
interface Job { id: string; kind?: "upgraded" | "original"; state: string; startedAt?: string; finishedAt?: string; commit?: string; results?: Result[]; progress?: { id: string; verdict: string }[] }

// The read-only copy serves each saved run from a snapshot taken when it was built.
const recordUrl = (id: string) => (STATIC ? asset(`data/live/runs/${encodeURIComponent(id)}.json`) : `/api/rerun/${encodeURIComponent(id)}`);

export function Run({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(recordUrl(id)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "No saved run with this ID." : `The server answered ${r.status}.`)))).then(setJob, (e) => setErr(e.message));
  }, [id]);
  if (err) return <div className="wrap loading">{err} <Link to="/proof/simple-clothing-store#rerun">Back to the live runs</Link></div>;
  if (!job) return <div className="wrap loading">Loading the saved run…</div>;
  const original = job.kind === "original";
  const results = job.results ?? [];
  const n = (v: string) => results.filter((r) => r.verdict === v).length;
  return (
    <section className="wrap t-hero run-page">
      <div className="crumbs"><Link to="/proof/simple-clothing-store#rerun">simple-clothing-store</Link> / saved live run</div>
      <h1 style={{ fontSize: "clamp(30px, 4.4vw, 46px)" }}>{original ? "The original shop, live" : "The upgraded shop, live"}</h1>
      <p className="lede" style={{ maxWidth: "62ch" }}>
        {job.startedAt ? `Started ${job.startedAt.slice(0, 16).replace("T", " ")} UTC` : "A saved run"}{job.commit ? ` at shop commit ${job.commit}` : ""}, from a visitor's button on this site, against the PayPal sandbox.{" "}
        {job.state !== "done" ? `State: ${job.state}.` : original ? `${n("FAIL")} of ${results.length} red, as expected: the original has these bugs. The harness refunded the test captures afterwards.` : `${n("PASS")} of ${results.length} pass${n("INCONCLUSIVE") ? `, ${n("INCONCLUSIVE")} inconclusive` : ""}${n("FAIL") ? `, ${n("FAIL")} fail` : ""}.`}
      </p>
      <div className="sc-table run-table">
        {results.map((r) => {
          const why = r.verdict === "PASS" ? "" : plainReason(r.reasons[0]);
          return (
            <div className="run-row" key={r.id}>
              <div className="line"><Chip v={r.verdict} /><b>{r.title.replace(/\s*\([A-Z]\d+\)\s*$/, "")}</b></div>
              {why && <div className="why small">{why}</div>}
              {r.paypal.length > 0 && <div className="ids tiny">{r.paypal.map((p) => <div key={p.orderId}><code>{p.orderId}</code> {p.status}{p.captures.map((c) => <span key={c.id}> · <code>{c.id}</code> {c.status} {fmt(c.amount)}</span>)}</div>)}</div>}
              {(r.notes ?? []).filter((x) => /refund/i.test(x)).map((x, i) => <div key={i} className="tiny muted">{x}</div>)}
            </div>
          );
        })}
      </div>
      <p className="tiny muted">Run <code>{job.id}</code> · <a href={recordUrl(job.id)}>the saved record (JSON)</a></p>
    </section>
  );
}
