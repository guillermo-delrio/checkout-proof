import { useEffect, useState } from "react";
import { useTarget } from "../data";
import { Link } from "../router";
import { Arrow, Check, Chip, Inline, Receipt, SectionHead, Shot, Sim, cleanTitle, fmt, mockLabel, plainReason } from "../components";
import { Rerun } from "../Rerun";
import { armFacts, asClause, catchOf, failPhrases, laterFacts, laterSentence } from "../claims";
import { CatchCard } from "../CatchCard";
import type { Arm, Cell, Finding, LoopStep, Scenario, TargetData } from "../types";

/** Phones (under 760 px): long lists fold behind one-line summaries (review r3: evidence pages were 11-16k px tall at
 * 390). Wide screens keep the full layout, which the demo video replays at 1280 px. */
const narrow = () => typeof window !== "undefined" && !window.matchMedia("(min-width: 760px)").matches;
const hashIs = (id: string) => typeof window !== "undefined" && window.location.hash === `#${id}`;

export function Target({ slug }: { slug: string }) {
  const { data: t, error } = useTarget(slug);
  useEffect(() => {
    if (!t) return;
    document.title = `${t.name} · Checkout Proof`;
    const h = window.location.hash.slice(1);
    if (h) requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView());
    return () => { document.title = "Checkout Proof"; };
  }, [t]);
  if (error) return <div className="wrap loading">No evidence for “{slug}”. <Link to="/">Back to the overview</Link></div>;
  if (!t) return <div className="wrap loading">Loading the evidence…</div>;
  return (
    <>
      <Header t={t} />
      {t.rerun ? (
        <section className="block" id="rerun"><div className="wrap">
          <Rerun scenarioIds={t.scenarios.map((x) => x.id)} />
        </div></section>
      ) : (
        <div className="wrap"><p className="small muted rerun-pointer">Live re-runs use simple-clothing-store: expressCart needs MongoDB, which the hosted server does not run. <Link to="/proof/simple-clothing-store#rerun">Re-run that shop <Arrow /></Link></p></div>
      )}
      <Failures t={t} />
      <Diff t={t} />
      {t.heroId && <HeroTimeline t={t} />}
      <Scenarios t={t} />
      <Loop t={t} />
      <Mutations t={t} />
      <section className="block"><div className="wrap prose" style={{ maxWidth: 820 }}>
        <p className="kicker">How these rows were produced</p>
        <p><Inline text={t.runsNote} /></p>
        {narrow() ? <details className="more"><summary>The harness and the runs behind each column</summary>
          <p className="small muted"><Inline text={t.harnessNote} /></p>
          <p className="small muted">Runs: before {t.runs.before.map((r) => `${r.mode} at ${r.commit} (${r.at.slice(0, 16).replace("T", " ")} UTC)`).join(", ")}; after {t.runs.after.map((r) => `${r.mode} at ${r.commit} (${r.at.slice(0, 16).replace("T", " ")} UTC)`).join(", ")}.</p>
        </details> : <>
        <p className="small muted"><Inline text={t.harnessNote} /></p>
        <p className="small muted">Runs: before {t.runs.before.map((r) => `${r.mode} at ${r.commit} (${r.at.slice(0, 16).replace("T", " ")} UTC)`).join(", ")}; after {t.runs.after.map((r) => `${r.mode} at ${r.commit} (${r.at.slice(0, 16).replace("T", " ")} UTC)`).join(", ")}.</p>
        </>}
      </div></section>
    </>
  );
}

function Header({ t }: { t: TargetData }) {
  return (
    <section className="wrap t-hero">
      <div className="crumbs"><Link to="/">Overview</Link> / evidence</div>
      <p className="kicker">Evidence pack</p>
      <h1 style={{ fontSize: "clamp(34px, 5vw, 56px)" }}>{t.name}</h1>
      <p className="lede" style={{ maxWidth: "62ch" }}>{t.blurb}{t.repo && <> <a href={t.repo} className="small" rel="noreferrer noopener" target="_blank">Source on GitHub</a></>}</p>
      {(() => {
        const notes = <>
          {t.modeNote && t.modes.length > 1 && <p className="small muted" style={{ maxWidth: "62ch" }}>{t.modeNote}</p>}
          {t.beforeNote && <p className="small muted" style={{ maxWidth: "62ch" }}>{t.beforeNote}</p>}
        </>;
        if (!(t.modeNote && t.modes.length > 1) && !t.beforeNote) return null;
        return narrow() ? <details className="more"><summary>{t.modes.length > 1 ? "Two modes, and how the original was driven" : "How the original was driven"}</summary>{notes}</details> : notes;
      })()}
      <div className="stackline">
        <div>
          <div className="k">Before</div>
          <div className="v">{t.stack.before}</div>
          <div className="score"><span className="chip FAIL">{t.failures.length} money bug{t.failures.length === 1 ? "" : "s"}</span><span className="chip FAIL">{t.tally.before.fail} failing run{t.tally.before.fail === 1 ? "" : "s"}</span><span className="chip PASS">{t.tally.before.pass} pass</span>{t.tally.before.na > 0 && <span className="chip NA">{t.tally.before.na} not applicable</span>}</div>
        </div>
        <div className="arrow"><Arrow /></div>
        <div>
          <div className="k">After</div>
          <div className="v">{t.stack.after}</div>
          <div className="score"><span className="chip PASS">{t.tally.after.pass} of {t.tally.after.total - t.tally.after.na} pass</span>{t.tally.after.fail > 0 && <span className="chip FAIL">{t.tally.after.fail} fail</span>}{t.tally.after.na > 0 && <span className="chip NA">{t.tally.after.na} not applicable</span>}</div>
        </div>
      </div>
    </section>
  );
}

const cellOf = (t: TargetData, id: string, mode: string, side: "before" | "after") => t.scenarios.find((s) => s.id === id)?.modes.find((m) => m.mode === mode)?.[side] ?? null;

function Failures({ t }: { t: TargetData }) {
  if (!t.failures.length) return null;
  return (
    <section className="block" id="failures">
      <div className="wrap">
        <SectionHead kicker="Before the upgrade" title={`What the original shop does with money.`}>
          <p>Each card is a money bug the original shop showed in the sandbox, with the shop's record next to PayPal's.{t.failures.every((f) => f.afterVerdict === "PASS") ? " Every one passes after the upgrade." : ""}{t.shotNote ? ` ${t.shotNote}` : ""}</p>
        </SectionHead>
        <div className="fail-list">
          {t.failures.map((f, i) => {
            const b = cellOf(t, f.id, f.mode, "before");
            const sc = t.scenarios.find((s) => s.id === f.id)!;
            const card = (
              <article className="fail-card" key={f.id + f.mode} id={`f-${f.id}`}>
                <div className="story">
                  <div className="meta"><Chip v="FAIL" />{f.simulated && <Sim />}{t.modes.length > 1 && <span className="chip code">{f.mode} mode</span>}</div>
                  <h3>{f.headline}</h3>
                  <p className="small muted" style={{ margin: 0 }}>{cleanTitle(sc.title)}{f.sameCause && f.sameCause.length > 1 ? `. The same bug failed ${f.sameCause.length} ${f.mode}-mode runs; it is counted once.` : ""}</p>
                  {f.assumed && <p className="small" style={{ margin: "8px 0 0", color: "var(--sim)" }}>{f.assumed}</p>}
                  <div className="after">After the upgrade: {f.afterVerdict === "PASS" ? <span className="chip PASS"><Check size={12} /> pass</span> : <Chip v={f.afterVerdict ?? "N/A"} />}<a href={`#sc-${f.id}`} className="small">sandbox IDs</a></div>
                  {b?.screenshot && (f.crop
                    ? <div className="crop-shot"><Shot src={f.crop.src} full={b.screenshot} natural caption={`${f.crop.caption}. Click for the whole page.`} /></div>
                    : <div style={{ marginTop: 16, maxWidth: 260 }}><Shot src={b.screenshot} caption={`Original shop: the order page after "${cleanTitle(sc.title)}"`} /></div>)}
                </div>
                {b && <Receipt cell={b} foot={plainReason(b.reasons.filter((r) => !r.startsWith("SIMULATED"))[0] ?? b.reasons[0])} />}
              </article>
            );
            // Phones: the first bug in full, the others one tap away under their headline.
            if (i === 0 || !narrow()) return card;
            return (
              <details className="fail-d" key={f.id + f.mode} open={hashIs(`f-${f.id}`)}>
                <summary><Chip v="FAIL" /><span>{f.headline}</span></summary>
                {card}
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HeroTimeline({ t }: { t: TargetData }) {
  const s = t.scenarios.find((x) => x.id === t.heroId)!;
  const b = s.modes[0].before, a = s.modes[0].after;
  const [side, setSide] = useState<"before" | "after">("before");
  const c = side === "before" ? b : a;
  return (
    <section className="block" id="hero">
      <div className="wrap">
        <SectionHead kicker="The hero run, step by step" title="Cancel, shrink the cart, pay less.">
          <p>A buyer starts a €480 checkout, cancels at PayPal, removes most of the cart and pays the €85 that is left. This is the recorded run: what the test buyer did, when, and what each screen looked like. Buyer login fields are masked in every screenshot.</p>
        </SectionHead>
        <div className="tabs" role="group" aria-label="Which shop">
          <button aria-pressed={side === "before"} onClick={() => setSide("before")}>Original shop</button>
          <button aria-pressed={side === "after"} onClick={() => setSide("after")}>Upgraded shop</button>
        </div>
        {c && (
          <div className="duo">
            <div className="panel">
              <div className="panel-head"><h3>{side === "before" ? "Original" : "Upgraded"}: {c.seconds} s end to end</h3><Chip v={c.verdict} /></div>
              <div className="timeline">
                {(c.timeline ?? []).map((x, i) => (
                  <div className="tl-item" key={i}><div className="t">{x.t.toFixed(1)} s</div><div className="s">{x.step}</div></div>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gap: 16, alignContent: "start", minWidth: 0 }}>
              <Receipt cell={c} ok={c.verdict === "PASS"} foot={c.verdict === "PASS" ? "All money rules hold: the order is paid for exactly what PayPal captured." : plainReason(c.reasons.filter((r) => !r.startsWith("SIMULATED"))[0] ?? c.reasons[0])} />
              <ShotStrip inline={narrow() ? 0 : 2} shots={(c.timeline ?? []).filter((x) => x.shot).map((x) => ({ src: x.shot!, caption: `${x.t.toFixed(1)} s · ${x.step}` }))} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A run's screenshots: the first two, the rest one click away (they made the phone page thousands of px longer). */
function ShotStrip({ shots, inline = 2 }: { shots: { src: string; caption: string }[]; inline?: number }) {
  if (!shots.length) return null;
  const grid = (xs: typeof shots) => <div className="tl-shots" style={{ marginTop: 0 }}>{xs.map((x, i) => <Shot key={i} src={x.src} caption={x.caption} />)}</div>;
  return (
    <div>
      {inline > 0 && grid(shots.slice(0, inline))}
      {shots.length > inline && <details className="more"><summary>{inline ? `${shots.length - inline} more screenshots` : `${shots.length} screenshots`} of this run</summary>{grid(shots.slice(inline))}</details>}
    </div>
  );
}

function CellView({ c, label }: { c: Cell | null; label: string }) {
  if (!c) return <div><span className="mlabel">{label}</span><span className="muted">—</span></div>;
  return (
    <div>
      <span className="mlabel">{label}</span>
      <div className="cellv">
        <div className="line"><Chip v={c.verdict} simulated={c.simulated} />{c.shopAfter && <span className="small">shop: <b>{c.shopAfter}</b>{c.shopTotal ? ` · ${fmt(c.shopTotal)}` : ""}</span>}</div>
        {c.verdict === "FAIL" && <div className="why">{plainReason(c.reasons.filter((r) => !r.startsWith("SIMULATED"))[0])}</div>}
        {c.verdict === "N/A" && <div className="small muted">{c.reasons[0]}</div>}
        {c.paypal.length > 0 && (
          <div className="ids">
            {c.paypal.map((p) => (
              <div key={p.orderId}>{p.orderId} <span className="cap">{p.status}</span>{p.captures.map((x) => <div key={x.id} className="cap">↳ {x.id} {x.status} {x.amount}</div>)}</div>
            ))}
          </div>
        )}
        {(c.mocked.length > 0 || !!c.simulated || (c.harness?.length ?? 0) > 0) && <div className="small muted">{[...mockLabel(c.mocked), ...(c.harness ?? []), ...(c.simulated ? [`simulated: PayPal's real answer rewritten to ${c.simulated === "pending" ? "PENDING" : c.simulated} by the harness`] : [])].join("; ")}</div>}
        {c.debugIds.length > 0 && <div className="tiny muted">debug IDs: <code>{c.debugIds.join(" ")}</code></div>}
        {c.screenshot && <ShotLink src={c.screenshot} caption={`Order page after the run (${c.shopOrderId ?? ""})`} />}
      </div>
    </div>
  );
}

function ShotLink({ src, caption }: { src: string; caption: string }) {
  const [open, set] = useState(false);
  return (
    <>
      <button className="shotlink" onClick={() => set(!open)}>{open ? "hide screenshot" : "screenshot"}</button>
      {open && <Shot src={src} caption={caption} />}
    </>
  );
}

function Scenarios({ t }: { t: TargetData }) {
  const [mode, setMode] = useState(t.modes[0]);
  const wide = window.matchMedia("(min-width: 760px)").matches;
  return (
    <section className="block" id="scenarios">
      <div className="wrap">
        <SectionHead kicker="Scenario table" title="Before and after, with sandbox IDs.">
          <p>Each row ran through the shop's own server against the PayPal sandbox{t.beforeNote ? " (for the original shop, our harness plays the browser half, as noted at the top)" : ""}. IDs are PayPal's: order IDs and their captures as <code>GET</code> on the order reports them. The money rules decide each verdict.</p>
        </SectionHead>
        {t.modes.length > 1 && (
          <div className="tabs" role="group" aria-label="Mode">
            {t.modes.map((m) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m} mode</button>)}
          </div>
        )}
        {(() => {
          const cellsOf = (x: Scenario) => x.modes.find((m) => m.mode === mode);
          // Shown first: what the original got wrong, and anything not green after. The rest pass on both sides or do
          // not apply; they are one click away (review r2: the table made the page 10k px tall).
          const key = (x: Scenario) => { const m = cellsOf(x); return m?.before?.verdict === "FAIL" || (!!m?.after && !["PASS", "N/A"].includes(m.after.verdict)); };
          const shown = t.scenarios.filter(key), rest = t.scenarios.filter((x) => !key(x));
          const row = (x: Scenario) => {
            const m = cellsOf(x)!;
            // Phones: one line per scenario (title, before → after); the sandbox IDs open on tap.
            if (!wide) return (
              <details className="sc-row-d" key={x.id} id={`sc-${x.id}`} open={window.location.hash === `#sc-${x.id}`}>
                <summary><span className="title">{cleanTitle(x.title)}</span><span className="t-flip">{m.before ? <Chip v={m.before.verdict} /> : <span className="chip NA">—</span>}<Arrow />{m.after ? <Chip v={m.after.verdict} /> : "—"}{(m.before?.simulated || m.after?.simulated) && <Sim />}</span></summary>
                <div className="ref"><code>{x.id}</code> · SCENARIOS {x.ref} · expect {x.expect}</div>
                <CellView c={m.before} label="Original" />
                <CellView c={m.after} label="Upgraded" />
              </details>
            );
            return (
              <div className="sc-row" key={x.id} id={`sc-${x.id}`}>
                <div><div className="title">{x.title}</div><div className="ref"><code>{x.id}</code> · SCENARIOS {x.ref} · expect {x.expect}</div></div>
                <CellView c={m.before} label="Original" />
                <CellView c={m.after} label="Upgraded" />
              </div>
            );
          };
          const head = <div className="sc-row head"><div>Scenario</div><div>{t.stack.before.split(" (")[0]} shop</div><div>{t.stack.after.split(" (")[0]} shop</div></div>;
          return (
            <>
              <div className="sc-table">{wide && head}{shown.map(row)}</div>
              {rest.length > 0 && (
                <details className="more sc-more" open={rest.some((x) => window.location.hash === `#sc-${x.id}`)}>
                  <summary>The other {rest.length} scenarios: {rest.filter((x) => cellsOf(x)?.after?.verdict === "PASS").length} pass after the upgrade{rest.some((x) => cellsOf(x)?.after?.verdict === "N/A") ? `, ${rest.filter((x) => cellsOf(x)?.after?.verdict === "N/A").length} not applicable` : ""}; none failed before</summary>
                  <div className="sc-table">{wide && head}{rest.map(row)}</div>
                </details>
              )}
            </>
          );
        })()}
      </div>
    </section>
  );
}

function Loop({ t }: { t: TargetData }) {
  if (!t.arms.length) return null;
  return (
    <section className="block" id="loop">
      <div className="wrap">
        <SectionHead kicker="The fix loop" title="What failed, what the model changed, the re-run.">
          <p>Each column is a fresh upgrade of the same original: first with just "migrate" in the prompt, then with our money rules added. The proof runs it, sends any failures back to the model with the evidence (verdict reasons, the shop's responses, PayPal's record, debug IDs), commits the fix and proves again. Rounds spent on test-harness problems, not the shop, are folded away.</p>
        </SectionHead>
        {(t.catches ?? []).filter((c) => c.arm === "").map((c, i) => narrow() ? (
          <details key={c.red.commit} className="more catch-d" style={{ marginBottom: 16 }}>
            <summary>{i ? "Also caught" : "Caught"} by the proof, fixed by Claude: {asClause(failPhrases(t, c.red.fail.slice(0, 1))[0] ?? "")}{c.red.fail.length > 1 ? ` (+${c.red.fail.length - 1} more red)` : ""}</summary>
            <CatchCard t={t} c={c} />
          </details>
        ) : (
          <div key={c.red.commit} style={{ marginBottom: 24 }}>
            <p className="kicker" style={{ marginBottom: 10 }}>Caught by the proof, fixed by Claude</p>
            <CatchCard t={t} c={c} />
          </div>
        ))}
        <div className="duo">
          {[...t.arms].sort((x, y) => (y.arm === "plain" ? 1 : 0) - (x.arm === "plain" ? 1 : 0)).map((a) => <ArmView key={a.arm || "full"} t={t} a={a} />)}
        </div>
        <PlainCatch t={t} />
      </div>
    </section>
  );
}

// The plain upgrade's own money bug (the prompt said only "migrate"), caught and fixed (review r3, judge 1; gallery 2). Below the two columns,
// so nothing the video scrolls to moves (submission/video/scenes.mjs). Shows the EUR 1.00 capture ("amount") when the
// red run has it.
function PlainCatch({ t }: { t: TargetData }) {
  const c = catchOf(t, "plain");
  if (!c) return null;
  const show = c.red.cells?.amount ? "amount" : undefined;
  // Watch round 114: "migrate" read as jargon; the narration says "a plain request to upgrade the code, with no money rule".
  const head = <>Claude's own bug, from a plain upgrade request with no money rule: caught by the proof, fixed by Claude</>;
  return narrow() ? (
    <details id="plain-catch" className="more catch-d" style={{ marginTop: 24 }}><summary>{head}</summary><CatchCard t={t} c={c} show={show} /></details>
  ) : (
    <div id="plain-catch" style={{ marginTop: 32 }}>
      <p className="kicker" style={{ marginBottom: 10 }}>{head}</p>
      <CatchCard t={t} c={c} show={show} />
    </div>
  );
}

function ArmView({ t, a }: { t: TargetData; a: Arm }) {
  const f = armFacts(t, a.arm);
  // Folded by default: rounds the harness caused, and partial proof runs. Where they sat, a one-line marker stays.
  const full = Math.max(0, ...a.steps.map((s) => (s.kind === "prove" ? s.pass + s.fail.length : 0)));
  // The proof right after a shop fix stays visible even when its one red was the harness's: it is that fix's result.
  const folded = (s: LoopStep, i = a.steps.indexOf(s)) => (s.kind === "prove" && s.pass + s.fail.length < full && !s.buildError) ||
    (!!s.harness && !(s.kind === "prove" && a.steps[i - 1]?.kind === "fix" && !a.steps[i - 1]?.harness));
  const harness = a.steps.filter(folded);
  // Review r3: a green badge sat right above "26 pass, 8 fail" on scenarios added later.
  const lateFails = a.later ? laterFacts(t, a.arm)?.fails ?? 0 : 0;
  const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches;
  const shown: (LoopStep | { gap: number; changed: number })[] = [];
  for (let i = 0; i < a.steps.length; i++) {
    if (!folded(a.steps[i])) { shown.push(a.steps[i]); continue; }
    let j = i; while (j < a.steps.length && folded(a.steps[j])) j++;
    const run = a.steps.slice(i, j);
    const changed = run.filter((s, k) => s.kind === "fix" && s.commit !== (k > 0 ? run[k - 1].commit : a.steps[i - 1]?.commit)).length;
    if (run.some((s) => s.harness)) shown.push({ gap: run.length, changed });
    i = j - 1;
  }
  return (
    <div className="panel">
      <div className="panel-head"><h3>{a.arm === "plain" ? 'Plain prompt: "migrate"' : "With money rules"}</h3>{f?.green && lateFails > 0 ? <span className="chip SIM" style={{ whiteSpace: "normal" }}>green on its first {full} scenario runs; fails {lateFails} run{lateFails === 1 ? "" : "s"} of scenarios added later</span> : f?.green ? <span className="chip PASS" style={{ whiteSpace: "normal" }}>green{f.roundsToGreen > 0 ? ` after ${f.roundsToGreen} fix round${f.roundsToGreen > 1 ? "s" : ""}${f.harnessRounds ? ` + ${f.harnessRounds} on the harness` : ""}` : " at its first proof"} ({f.green!.commit})</span> : <span className="chip NA">in progress</span>}</div>
      <p className="small muted" style={{ marginTop: 0 }}>{a.prompt}</p>
      {f && <p className="small" style={{ margin: "0 0 4px" }}>{f.first ? <>First proof: <b>{f.first.pass} pass, {f.first.fail.length} fail</b>. </> : null}{f.fixes.filter((x) => !x.harness).length} fix round{f.fixes.filter((x) => !x.harness).length === 1 ? "" : "s"} by the model on shop failures.</p>}
      {/* The step list is long on a phone: open on wide screens, one tap away on narrow ones. */}
      <details className="more" open={wide}>
        <summary>The loop, step by step ({shown.length} steps)</summary>
        <div className="loop">
          {shown.map((s, i) => "gap" in s
            ? <div key={i} className="loop-gap small muted">{s.gap} step{s.gap > 1 ? "s" : ""} on test-harness problems, folded below{s.changed ? `; the model changed code in ${s.changed} of them` : ""}.</div>
            : <LoopItem key={i} s={s} dim={false} />)}
        </div>
        {harness.length > 0 && (
          <details className="harness-steps">
            <summary>{harness.length} folded step{harness.length > 1 ? "s" : ""}: test-harness problems and partial runs, not the shop</summary>
            <div className="loop">{harness.map((s, i) => <LoopItem key={i} s={s} />)}</div>
          </details>
        )}
      </details>
      {a.later && (() => {
        const l = laterFacts(t, a.arm)!;
        return (
          <div className="loop">
            <div className="loop-step">
              <div className={`loop-dot ${l.fails ? "red" : "green"}`}>{l.fails ? "P" : <Check size={14} />}</div>
              <div className="loop-body">
                <div className="h">Proof on scenarios added later <span className="muted small">at {l.commit}</span></div>
                <div className="d">{l.pass} pass, {l.fails} fail{l.modes.length > 1 ? ` (${l.modes.map((m) => `${m.mode} mode ${m.pass}/${m.total - m.na}`).join(", ")})` : ""}</div>
                {(() => {
                  const body = <>
                    {l.fails > 0 && <ul className="fails">{l.modes.flatMap((m) => m.fail.map((x) => ({ ...x, mode: m.mode }))).filter((x, i, xs) => xs.findIndex((y) => y.id === x.id) === i).map((x) => <li key={x.id}><b>{x.id}</b>: {plainReason(x.reason)}{x.simulated ? " (simulated PayPal answer)" : ""}</li>)}</ul>}
                    <div className="note">{laterSentence(t, a.arm) ?? `Scenarios added later (${l.added.join(", ")}) all pass.`}</div>
                  </>;
                  return l.fails > 0 && narrow() ? <details className="more"><summary>Which failed, and why</summary>{body}</details> : body;
                })()}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// dim: grey out a step the harness caused. The proof right after a shop fix stays at full contrast even when its one
// red was the harness's (it is that fix's result, and the reason is in its note).
function LoopItem({ s, dim = !!s.harness }: { s: LoopStep & { harness?: boolean }; dim?: boolean }) {
  if (s.kind === "prove") {
    const green = s.fail.length === 0 && s.pass > 0 && !s.buildError;
    const cls = s.harness ? "harness" : green ? "green" : "red";
    return (
      <div className="loop-step" style={dim ? { opacity: 0.6 } : undefined}>
        <div className={`loop-dot ${cls}`}>{green && !s.harness ? <Check size={14} /> : "P"}</div>
        <div className="loop-body">
          <div className="h">Proof <span className="muted small">at {s.commit}</span>{s.harness && <span className="chip NA" style={{ marginLeft: 6 }}>harness</span>}</div>
          <div className="d">{s.buildError ? "build failed" : s.pass + s.fail.length === 0 ? "no verdicts: the shop did not start" : `${s.pass} pass, ${s.fail.length} fail`}</div>
          {s.fail.length > 0 && !s.harness && <ul className="fails">{s.fail.slice(0, 6).map((x, i) => <li key={i}><b>{x.id}</b>: {plainReason(x.reason)}</li>)}{s.fail.length > 6 && <li className="muted">and {s.fail.length - 6} more</li>}</ul>}
          {s.note && <LoopNote text={s.note} />}
        </div>
      </div>
    );
  }
  return (
    <div className="loop-step" style={dim ? { opacity: 0.6 } : undefined}>
      <div className={`loop-dot ${s.harness ? "harness" : "ai"}`}>{s.kind === "upgrade" ? "U" : "F"}</div>
      <div className="loop-body">
        <div className="h">{s.kind === "upgrade" ? "AI upgrade" : `AI fix (${s.step})`} <span className="muted small">→ {s.commit}</span>{s.harness && <span className="chip NA" style={{ marginLeft: 6 }}>harness</span>}</div>
        <div className="d">{s.turns ?? "?"} turns · {s.seconds ?? "?"} s{s.skills.length ? ` · ${s.skills.length} skill${s.skills.length > 1 ? "s" : ""} loaded` : ""}</div>
        {s.note && <div className="note">{s.note}</div>}
        {s.summary && <details><summary>The model's own report (verbatim)</summary><p><Inline text={s.summary} /></p></details>}
      </div>
    </div>
  );
}

function Diff({ t }: { t: TargetData }) {
  const max = Math.max(...t.diff.files.map((f) => f.added + f.removed), 1);
  return (
    <section className="block" id="diff">
      <div className="wrap">
        <SectionHead kicker="The change" title={`+${t.diff.added} −${t.diff.removed} lines, scanned before and after.`}>
          <p><Inline text={t.intro} /></p>
        </SectionHead>
        <div className="duo">
          <div className="panel">
            <div className="panel-head"><h3>Files changed</h3><span className="small muted">{t.diff.files.length} files · lockfiles and local config excluded</span></div>
            {(() => {
              const top = narrow() ? 3 : 6;
              const bySize = [...t.diff.files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
              const file = (f: (typeof bySize)[number]) => (
                <div className="diff-file" key={f.file}>
                  <span className="f">{f.file} <span className="muted">+{f.added} −{f.removed}</span></span>
                  <span className="bar"><span className="a" style={{ width: `${(f.added / max) * 100}%` }} /><span className="r" style={{ width: `${(f.removed / max) * 100}%` }} /></span>
                </div>
              );
              return <>
                <div className="diff-files">{bySize.slice(0, top).map(file)}</div>
                {bySize.length > top && <details className="more"><summary>{bySize.length - top} smaller files</summary><div className="diff-files">{bySize.slice(top).map(file)}</div></details>}
              </>;
            })()}
            {narrow()
              ? <details className="more"><summary>{t.diff.commits.length} commit{t.diff.commits.length === 1 ? "" : "s"} on the work copy</summary><p className="small muted" style={{ margin: 0 }}>{t.diff.commits.map((c) => <code key={c} style={{ display: "block", marginTop: 4 }}>{c}</code>)}</p></details>
              : <p className="small muted" style={{ marginBottom: 0 }}>Commits on the work copy: {t.diff.commits.map((c) => <code key={c} style={{ display: "block", marginTop: 4 }}>{c}</code>)}</p>}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Scan</h3><span className="small muted">same rules as the scan box</span></div>
            <p className="small" style={{ margin: "4px 0 0", fontWeight: 600 }}>Before: {t.scan.before.length} findings</p>
            {(() => { const k = narrow() ? 1 : 3; return <>
              <FindingList items={t.scan.before.slice(0, k)} />
              {t.scan.before.length > k && <details className="more"><summary>{t.scan.before.length - k} more findings before the upgrade</summary><FindingList items={t.scan.before.slice(k)} /></details>}
            </>; })()}
            <p className="small" style={{ margin: "18px 0 0", fontWeight: 600 }}>After</p>
            {t.scan.after.length === 0 ? <div className="empty-ok"><Check /> No JS SDK v5, deprecated PayPal piece or known risky pattern left.</div> : <>
              {t.scan.after.some((f) => f.kind === "risk") && <p className="small" style={{ margin: "4px 0 0" }}>{t.scan.after.filter((f) => f.kind === "risk").length} pattern match{t.scan.after.filter((f) => f.kind === "risk").length > 1 ? "es" : ""} on the upgraded code. Risk rules match text, so they are leads, not verdicts; the sandbox proof decides, and the upgraded shop passes {t.tally.after.pass} of {t.tally.after.total - t.tally.after.na}.</p>}
              <FindingList items={t.scan.after} checked={t.tally.after.fail === 0} />
            </>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Runs of deliberately broken code: they show the proof can fail. Never a commit's result. */
function Mutations({ t }: { t: TargetData }) {
  if (!t.mutations?.length) return null;
  // One card per mutation: the latest run; earlier runs of the same mutation become a line on it (review r3).
  const latest = [...t.mutations].sort((x, y) => y.at.localeCompare(x.at)).filter((m, i, xs) => xs.findIndex((y) => y.name === m.name) === i).sort((x, y) => x.at.localeCompare(y.at));
  const earlier = (m: (typeof latest)[number]) => t.mutations!.filter((y) => y.name === m.name && y !== m);
  const also = (m: (typeof latest)[number]) => earlier(m).map((y) => <p key={y.at} className="tiny muted" style={{ margin: "6px 0 0" }}>Also run on {y.commit.replace(/\+mutation:.*/, "")} ({y.at.slice(0, 16).replace("T", " ")} UTC): {y.results.filter((r) => r.verdict === "FAIL").length} of {y.results.length} fail.</p>);
  return (
    <section className="block" id="mutations">
      <div className="wrap">
        <SectionHead kicker="Can the proof fail?" title="Modified code (mutation tests).">
          <p>We removed a money check from the upgraded shop on purpose and proved it again. These runs are of modified code, not of any commit on the evidence above.</p>
        </SectionHead>
        <div className="duo">
          {latest.map((m) => narrow() ? (
            <details className="panel mut-d" key={m.name + m.at}>
              <summary><span className="mname">{m.name}</span><span>{m.results.filter((r) => r.verdict === "FAIL").length} of {m.results.length} fail</span></summary>
              <p className="small">{m.description}</p>
              <ul className="small" style={{ paddingLeft: 18, margin: 0, overflowWrap: "anywhere" }}>
                {m.results.map((r) => <li key={r.id}><Chip v={r.verdict} /> <b>{cleanTitle(r.title)}</b>{r.verdict === "FAIL" && r.reason ? `: ${plainReason(r.reason)}` : ""}</li>)}
              </ul>
              <p className="tiny muted" style={{ marginBottom: 0 }}>{m.mode} mode · {m.at.slice(0, 16).replace("T", " ")} UTC · based on {m.commit}</p>
              {also(m)}
            </details>
          ) : (
            <div className="panel" key={m.name + m.at}>
              <div className="panel-head"><h3>{m.name}</h3><span className="chip code">modified code</span></div>
              <p className="small" style={{ marginTop: 0 }}>{m.description}</p>
              <ul className="small" style={{ paddingLeft: 18, margin: 0, overflowWrap: "anywhere" }}>
                {m.results.map((r) => <li key={r.id}><Chip v={r.verdict} /> <b>{cleanTitle(r.title)}</b>{r.verdict === "FAIL" && r.reason ? `: ${plainReason(r.reason)}` : ""}</li>)}
              </ul>
              <p className="tiny muted" style={{ marginBottom: 0 }}>{m.mode} mode · {m.at.slice(0, 16).replace("T", " ")} UTC · based on {m.commit}</p>
              {also(m)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const KIND_LABEL = { upgrade: "v6 available", deprecated: "deprecated", risk: "risk" } as const;

/** `checked`: these risk leads are on code the sandbox proof passed, so they show as checked, not red. */
export function FindingList({ items, link, checked }: { items: Finding[]; link?: (f: Finding) => string | null; checked?: boolean }) {
  return (
    <ul className="findings">
      {items.map((f, i) => {
        const href = link?.(f);
        return (
          <li key={i} className={checked && f.kind === "risk" ? "checked" : f.kind}>
            <div className="where">{href ? <a href={href} target="_blank" rel="noreferrer noopener">{f.file}:{f.line}</a> : `${f.file}:${f.line}`} {checked && f.kind === "risk" ? <span className="chip PASS" style={{ marginLeft: 4 }}>lead · proof passes</span> : <span className={`chip ${f.kind === "risk" ? "FAIL" : "SIM"}`} style={{ marginLeft: 4 }}>{KIND_LABEL[f.kind] ?? f.kind}</span>} <span className="muted tiny">{f.rule}</span></div>
            <div className="why">{f.why}</div>
            {f.text && <div className="src">{f.text}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** A long loop-log note (later changes and re-runs of a green commit) folds behind its first clause. */
function LoopNote({ text }: { text: string }) {
  if (text.length < 280) return <div className="note">{text}</div>;
  const head = text.match(/^(Changed since|Later re-runs of this commit)/)?.[1] ?? "Details";
  return (
    <details className="note">
      <summary>{head === "Changed since" ? "Later changes and proofs of this upgrade" : head === "Details" ? "Details" : "Later re-runs of this commit"} (loop log)</summary>
      {text}
    </details>
  );
}
