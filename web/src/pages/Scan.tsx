import { useEffect, useState, type FormEvent } from "react";
import { useIndex } from "../data";
import { Arrow, Check, SectionHead } from "../components";
import { FindingList } from "./Target";
import type { ScanResult } from "../types";
import { LiveDemo } from "../Rerun";
import { STATIC } from "../env";

export function Scan() {
  const { data: index } = useIndex();
  const [url, setUrl] = useState(() => new URLSearchParams(window.location.search).get("repo") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ScanResult | null>(null);

  useEffect(() => { document.title = "Scan a repo · Checkout Proof"; return () => { document.title = "Checkout Proof"; }; }, []);

  async function run(target: string) {
    if (!target.trim()) return;
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json", "X-CP": "1" }, body: JSON.stringify({ url: target }) });
      const body = await r.json().catch(() => ({ error: `The server answered HTTP ${r.status}.` }));
      if (!r.ok) setErr(body.error ?? `HTTP ${r.status}`);
      else { setRes(body); window.history.replaceState({}, "", `/scan?repo=${encodeURIComponent(target)}`); }
    } catch { setErr("Could not reach the scan server."); }
    setBusy(false);
  }
  const submit = (e: FormEvent) => { e.preventDefault(); run(url); };
  const examples = (index?.targets ?? []).map((t) => t.repo).filter(Boolean) as string[];
  const blob = (f: { file: string; line: number }) => res?.commit ? `https://github.com/${res.repo}/blob/${res.commit}/${f.file.split("/").map(encodeURIComponent).join("/")}#L${f.line}` : null;
  // v5 ("upgrade") and deprecated pieces share a panel; counts come from the findings, so a new kind cannot be lost.
  const dep = res?.findings.filter((f) => f.kind !== "risk") ?? [];
  const nUpgrade = res?.findings.filter((f) => f.kind === "upgrade").length ?? 0;
  const nDeprecated = res?.findings.filter((f) => f.kind === "deprecated").length ?? 0;
  const risk = res?.findings.filter((f) => f.kind === "risk") ?? [];

  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
      <div className="wrap" style={{ padding: 0 }}>
        <SectionHead kicker="Scan box" title="Is this repo on PayPal's old checkout?">
          <p>Paste a public GitHub repo. The server downloads its archive (up to 25 MB), reads the files in memory and runs the same static rules as the upgrader's first step. It never runs the repo's code and never calls a model.</p>
          <p className="small muted" style={{ marginTop: 10 }}>It reports three things: PayPal pieces with a newer version available (JS SDK v5, which PayPal still fully supports; v6 is the newer SDK), pieces PayPal has deprecated, and patterns that can lose money.</p>
        </SectionHead>
        {STATIC ? <LiveDemo what="The scan box" /> : (
        <div className="scanbox">
          <form onSubmit={submit}>
            <label className="sr-only" htmlFor="repo">GitHub repo address</label>
            <input id="repo" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" autoComplete="off" spellCheck={false} inputMode="url" />
            <button className="btn" disabled={busy || !url.trim()}>{busy ? "Scanning…" : "Scan"} {!busy && <Arrow />}</button>
          </form>
          {examples.length > 0 && (
            <div className="examples"><span className="muted">Try:</span>{examples.map((e) => <button key={e} type="button" onClick={() => { setUrl(e); run(e); }}>{e.replace("https://github.com/", "")}</button>)}</div>
          )}
          {err && <div className="notice err" role="alert">{err}</div>}
          {busy && <div className="notice info">Fetching the archive from GitHub and reading it. Large repos take up to 20 seconds.</div>}
        </div>
        )}

        {res && (
          <div aria-live="polite">
            <div className="result-head">
              <h3><code style={{ fontSize: "0.85em" }}>{res.repo}</code>{res.commit && <span className="muted small"> at <code>{res.commit.slice(0, 7)}</code></span>}</h3>
              <div className="counts">
                {nUpgrade > 0 && <span className="chip SIM">{nUpgrade} v6 available</span>}
                {nDeprecated > 0 && <span className="chip SIM">{nDeprecated} deprecated</span>}
                <span className="chip FAIL">{risk.length} risky</span>
                <span className="chip NA">{res.filesScanned} files read</span>
                {res.cached && <span className="chip NA">cached</span>}
              </div>
            </div>
            {res.findings.length === 0 ? (
              <div className="scanbox"><div className="empty-ok"><Check /> No JS SDK v5, deprecated PayPal piece or known risky pattern found.</div><p className="small muted" style={{ margin: 0 }}>The rules look for JS SDK v5 (script, buttons, <code>@paypal/react-paypal-js</code>, <code>@paypal/paypal-js</code>), <code>paypal-rest-sdk</code>, <code>@paypal/checkout-server-sdk</code>, the v1 Payments API, <code>application_context</code>, and money patterns: browser-side create or capture, no capture-status check, no currency check, captures without <code>PayPal-Request-Id</code>.</p></div>
            ) : (
              <div className="duo">
                <div className="panel">
                  <div className="panel-head"><h3>PayPal pieces to upgrade</h3><span className="small muted">{dep.length}</span></div>
                  {dep.length ? <FindingList items={dep} link={blob} /> : <p className="small muted">None.</p>}
                </div>
                <div className="panel">
                  <div className="panel-head"><h3>Risky money patterns</h3><span className="small muted">{risk.length}</span></div>
                  {risk.length ? <FindingList items={risk} link={blob} /> : <p className="small muted">None.</p>}
                  <p className="tiny muted" style={{ marginBottom: 0 }}>A risky pattern is a lead, not a verdict: only a sandbox proof run shows whether money is actually lost.</p>
                </div>
              </div>
            )}
            {res.truncated && <div className="notice info">This repo has more files than the scan box reads; the results cover the first 40,000.</div>}
          </div>
        )}
      </div>
    </section>
  );
}
