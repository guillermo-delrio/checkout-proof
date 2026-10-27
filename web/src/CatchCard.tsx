import { Arrow, Check, Inline, Receipt } from "./components";
import { asClause, failPhrases, greenCounts, isDoubleCharge, scenarioOf } from "./claims";
import { Link } from "./router";
import type { Catch, TargetData } from "./types";

/** The AI's part in one picture: the proof (deterministic) goes red, Claude fixes it from that evidence alone, the proof
 * goes green. Every figure comes from the loop log via the export (catches()). */
/** "…INCONCLUSIVE (harness: why); re-proved … 18/18 (runs/…)" → " (why); re-proved 18/18 outside the loop". */
const incWhy = (note: string | null) => {
  if (!note) return "";
  const why = note.match(/\(harness: ([^)]*)\)/)?.[1];
  const again = note.match(/re-proved[^,]*?(outside the loop)?, (\d+\/\d+)/);
  return `${why ? ` (${why})` : ""}${again ? `; the same commit re-proved ${again[2]} ${again[1] ?? ""}`.trimEnd() : ""}`;
};

/** `show`: which failing scenario's record to show (default: the export's pick, `c.failId`). */
export function CatchCard({ t, c, link, show }: { t: TargetData; c: Catch; link?: boolean; show?: string }) {
  const cell = (show && c.red.cells?.[show]) || c.red.cell;
  const caps = cell?.paypal.flatMap((p) => p.captures).filter((x) => x.status === "COMPLETED") ?? [];
  // With `show`, step 1 names only that scenario's bug; the run's other bugs fold away below the record (watch
  // round 114: a card listing three bugs while the narration names one).
  const lead = show ? c.red.fail.filter((f) => scenarioOf(f.id) === show) : [];
  const rest = lead.length ? c.red.fail.filter((f) => scenarioOf(f.id) !== show) : [];
  const what = failPhrases(t, lead.length ? lead : c.red.fail);
  const inOriginal = (id: string) => t.scenarios.find((s) => s.id === id)?.modes.some((m) => m.before?.verdict === "FAIL") ?? false;
  const isNew = lead.length > 0 && !inOriginal(show!);
  const others = [...new Set(rest.map((f) => scenarioOf(f.id)))].map((id) => ({ id, phrase: asClause(failPhrases(t, rest.filter((f) => scenarioOf(f.id) === id))[0] ?? ""), old: inOriginal(id) }));
  const modes = [...new Set(c.red.fail.map((f) => f.id.match(/\((.*) mode\)$/)?.[1]).filter(Boolean))];
  const perMode = modes.length > 1 && c.red.fail.length === (others.length + 1) * modes.length;
  // Harness reds show as inconclusive (greenCounts in claims.ts; the README prints the same line).
  const { harnessRed, inc, fail, n, incShort } = greenCounts(c);
  // Phrases that start with a verb ("charged the buyer twice") take "the shop" as subject; the others carry their own.
  const found = what.map(asClause);
  return (
    <div className="catch">
      <div className="catch-step">
        <div className="by det">Deterministic code</div>
        <h3>1 · The proof goes red</h3>
        <p className="small">{c.after?.byHand ? <>After a hand edit (<code>{c.after.commit}</code>), the</> : "The"} sandbox proof at <code>{c.red.commit}</code> found that {found.join("; ")}.{!show && isDoubleCharge(c) ? ` PayPal shows ${caps.length} completed captures for one order.` : ""}{isNew && <> <span className="chip FAIL">new, not in the original</span></>}</p>
        {cell && <Receipt cell={cell} foot={`${c.red.pass} pass, ${c.red.fail.length} fail`} />}
        {others.length > 0 && (
          <details>
            <summary>{others.length === 1 ? "1 more bug" : `${others.length} more bugs`} in the same run{others.every((o) => o.old) ? `, ${others.length === 1 ? "also" : others.length === 2 ? "both" : "all"} in the original shop too` : ""}</summary>
            <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{others.map((o) => <li key={o.id}>{o.phrase[0].toUpperCase() + o.phrase.slice(1)}{others.every((x) => x.old) ? "" : o.old ? " (also in the original)" : " (new)"}.</li>)}</ul>
            {perMode && <p className="small muted">The {c.red.fail.length} fails count each of the {others.length + 1} bugs once per checkout mode ({modes.join(" and ")}).</p>}
          </details>
        )}
      </div>
      <div className="catch-arrow" aria-hidden="true"><Arrow /></div>
      <div className="catch-step">
        <div className="by ai">Claude</div>
        <h3>2 · Claude fixes it from the evidence</h3>
        <p className="small">The proof sent the failing run back with no new rules: verdict reasons, the shop's responses, PayPal's record and debug IDs. Claude changed the shop's code.</p>
        <div className="catch-fig"><b>{c.fix.turns ?? "?"}</b> turns · <b>{c.fix.seconds ?? "?"}</b> s · commit <code>{c.fix.commit}</code></div>
        {c.fix.summary && <details><summary>Claude's own report (verbatim)</summary><p className="small"><Inline text={c.fix.summary} /></p></details>}
      </div>
      <div className="catch-arrow" aria-hidden="true"><Arrow /></div>
      <div className="catch-step">
        <div className="by det">Deterministic code</div>
        <h3>3 · The proof again</h3>
        <div className="catch-fig ok"><Check /> {inc || fail ? <>{c.green.pass} pass,</> : <>{c.green.pass} of {n} pass</>}</div>
        {(inc > 0 || fail > 0) && <div className="catch-fig catch-rest">{inc > 0 && <><b className="catch-inc">{inc} inconclusive{incShort}</b>, </>}<b>{fail} fail</b></div>}
        {fail > 0 && <p className="small muted">{fail === 1 ? "The one red left was" : `The ${fail} reds left were`} the test harness's, not the shop's.</p>}
        {harnessRed && <p className="small muted">Inconclusive means neither a pass nor a fail. {c.green.fail === 1 ? "It was" : "They were"} recorded as {c.green.fail === 1 ? "a fail" : "fails"} at the time: {c.green.harnessNote}.</p>}
        {inc > 0 && !harnessRed && <p className="small muted">{inc} inconclusive: the test harness's, not the shop's{incWhy(c.green.harnessNote)}.</p>}
        <p className="small muted">Same scenarios, fresh sandbox orders, commit <code>{c.green.commit}</code>.</p>
        {link && <Link to={`/proof/${t.slug}#loop`} className="small">The whole loop, step by step <Arrow /></Link>}
      </div>
    </div>
  );
}
