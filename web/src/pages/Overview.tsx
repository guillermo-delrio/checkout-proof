import { useIndex, useTarget, POPULATION } from "../data";
import { Link } from "../router";
import { Arrow, Chip, Receipt, SectionHead, Sim, cleanTitle, fmt } from "../components";
import type { IndexData, TargetData } from "../types";
import { armFacts, bestCatch, bugCounts, laterFacts, plainArmSentences } from "../claims";
import { CatchCard } from "../CatchCard";
import { LiveDemo } from "../Rerun";
import { STATIC } from "../env";

const RERUN = "/proof/simple-clothing-store#rerun";

export function Overview() {
  const { data: index, error } = useIndex();
  if (error) return <div className="wrap loading">Evidence not exported yet: run <code>npm run export-web</code>. ({error})</div>;
  if (!index) return <div className="wrap loading">Loading the evidence…</div>;
  const hero = index.targets.find((t) => t.failures.some((f) => f.code === "E1")) ?? index.targets[0];
  return (
    <>
      <Hero index={index} heroSlug={hero?.slug} />
      <AiCatch index={index} />
      <AiEarns index={index} />
      <ProofWall index={index} />
      <HowItWorks />
      <Problem />
    </>
  );
}

function Hero({ index, heroSlug }: { index: IndexData; heroSlug?: string }) {
  const { data: t } = useTarget(heroSlug ?? "");
  const hero = t?.scenarios.find((s) => s.id === t.heroId);
  const cell = hero?.modes[0].before;
  const after = hero?.modes[0].after;
  const { bugs, runs } = bugCounts(index);
  const paid = fmt(cell?.paypal.flatMap((p) => p.captures).find((c) => c.status === "COMPLETED")?.amount);
  return (
    <section className="wrap hero">
      <div className="hero-text">
        <p className="kicker">AI agent · PayPal sandbox proof</p>
        <h1>An AI upgrades PayPal checkouts. The sandbox <em>proves</em> it.</h1>
        <p className="lede">
          Checkout Proof's agent moves real open-source shops to PayPal's current SDKs. Then it runs each shop's own checkout against the PayPal sandbox: a real sandbox buyer, declined payments, lost responses, tampered orders.
          <span className="lede-more"> Whatever loses money goes back to the agent until the proof is green. Each verdict comes with PayPal's own record of the sandbox order.</span>
        </p>
      </div>
      <div className="hero-cta">
        {STATIC ? <LiveDemo what="Re-run the upgraded clothing store, or watch the original lose money, in the PayPal sandbox" /> : <>
        <div className="cta-row">
          <Link to={RERUN} className="btn">Re-run the upgraded clothing store <Arrow /></Link>
          <Link to={RERUN} className="btn red">Watch the original lose money <Arrow /></Link>
        </div>
        <p className="small muted hero-cta-note">Live in the PayPal sandbox, fresh order IDs, no model deciding. Expect green in several minutes, red in 1–2. Live runs are open to the hackathon's judges; every saved run is open to all.</p>
        </>}
        <p className="small hero-links">{heroSlug && <Link to={`/proof/${heroSlug}`}>See the recorded evidence <Arrow /></Link>}<Link to="/scan">Scan a repo <Arrow /></Link></p>
      </div>
      {cell && t ? (
        <Receipt
          className="hero-receipt"
          cell={cell}
          title={<><span><b>Before the upgrade</b> · {t.name}</span><Chip v="FAIL" /></>}
          lead={<>The buyer paid {paid}. The shop marked a {fmt(cell.shopTotal)} order paid.</>}
          foot={after?.verdict === "PASS" ? <span className="ok-foot">After the upgrade: fixed ✓</span> : undefined}
        />
      ) : <div className="receipt" style={{ minHeight: 260 }} />}
      <p className="small muted hero-stats">
        {index.targets.length} real open-source shops · {bugs} money bugs found in the sandbox ({runs} failing runs){index.targets.every((x) => x.tally.after.fail === 0 && x.tally.after.inconclusive === 0) ? " · all fixed by the upgrade and re-proved in the sandbox" : ""}
      </p>
    </section>
  );
}

function Problem() {
  const total = POPULATION.npm.reduce((s, x) => s + x.perWeek, 0);
  const dep = POPULATION.npm.filter((x) => x.deprecated).reduce((s, x) => s + x.perWeek, 0);
  const share = Math.round((dep / total) * 100);
  const colors = ["var(--fail)", "color-mix(in srgb, var(--fail) 55%, var(--surface))", "var(--pass)"];
  const maxRepos = Math.max(...POPULATION.repos.map((r) => r.count));
  return (
    <section className="block">
      <div className="wrap">
        <SectionHead kicker="The problem" title="Open source still runs PayPal's old checkout.">
          <p>PayPal has deprecated its v1 Payments SDK and <code>@paypal/checkout-server-sdk</code>; in the browser, JS SDK v6 is newer and v5 stays fully supported. PayPal's own AI tools write migration code, but none runs the shop's checkout to show the upgrade still takes money correctly.</p>
        </SectionHead>
        <div className="stats compact">
          <div className="stat"><div className="n">{share}%</div><div className="l">of PayPal Node server-SDK downloads are of deprecated packages</div><div className="s">npm downloads, week to {POPULATION.measuredOn}</div></div>
          <div className="stat"><div className="n">222</div><div className="l">popular open-source repos load the JS SDK v5 script</div><div className="s">Sourcegraph public index, a floor; forks and archives excluded</div></div>
          <div className="stat"><div className="n">0</div><div className="l">popular repos found on the v6 script</div><div className="s">same index, same day</div></div>
        </div>
        <details className="more">
        <summary>The weekly downloads and the repo counts behind these numbers</summary>
        <div className="chart" role="img" aria-label={`Weekly npm downloads: ${POPULATION.npm.map((x) => `${x.pkg} ${x.perWeek.toLocaleString("en")}`).join(", ")}`}>
          <h4>Weekly downloads of PayPal's Node server SDKs</h4>
          <div className="small muted">{dep.toLocaleString("en")} of {total.toLocaleString("en")} downloads a week are of a deprecated SDK</div>
          <div className="stack">
            {POPULATION.npm.map((x, i) => <div key={x.pkg} style={{ flexGrow: x.perWeek, background: colors[i] }} title={`${x.pkg}: ${x.perWeek.toLocaleString("en")}`} />)}
          </div>
          <div className="legend">
            {POPULATION.npm.map((x, i) => (
              <div key={x.pkg}><span className="sw" style={{ background: colors[i] }} /><code>{x.pkg}</code>{x.deprecated ? <span className="muted"> · deprecated</span> : <span className="muted"> · current</span>}<b>{x.perWeek.toLocaleString("en")}/week</b></div>
            ))}
          </div>
        </div>
        <div className="chart">
          <h4>Popular public repos by PayPal integration</h4>
          <div className="small muted">Sourcegraph public index, {POPULATION.measuredOn}; repos, not files</div>
          <div className="bars">
            {POPULATION.repos.map((r) => (
              <div className="bar-row" key={r.pattern}>
                <div>{r.pattern} <span className="muted tiny">· {r.note}</span></div>
                <div className="track"><div className="fill" style={{ width: `${(r.count / maxRepos) * 100}%`, background: /migrated|v6/.test(r.pattern + r.note) && !/v5/.test(r.pattern) ? "var(--pass)" : /deprecated/.test(r.note) ? "var(--fail)" : "var(--muted)" }} /></div>
                <div className="v">{r.count}</div>
              </div>
            ))}
          </div>
        </div>
        </details>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="block">
      <div className="wrap">
        <SectionHead kicker="How it works" title="Scan. Upgrade. Prove, and repair.">
          <p className="phone-skip">The model does the edit and the repair. Everything that decides pass or fail is deterministic code.</p>
          <p className="rule"><b>The money rule:</b> every paid order needs exactly one finished PayPal payment, for the right amount, in the right currency.</p>
        </SectionHead>
        <div className="steps">
          <div className="step">
            <h3>Scan</h3>
            <p>Static rules find what to upgrade (JS SDK v5: script, buttons, React), what PayPal has deprecated (<code>paypal-rest-sdk</code>, <code>@paypal/checkout-server-sdk</code>) and money-losing patterns, with file and line. No code runs.</p>
            <div className="tag"><span className="who-tag det">Deterministic code</span></div>
          </div>
          <div className="step">
            <h3>Upgrade</h3>
            <p><span className="ai">Claude</span> moves the shop to JS SDK v6 and <code>@paypal/paypal-server-sdk</code>, guided by PayPal's AI Toolkit skills and the APIMatic server-SDK context plugin. It never sees credentials.</p>
            <div className="tag"><span className="who-tag ai">Claude</span></div>
          </div>
          <div className="step">
            <h3>Prove and repair</h3>
            <p>The shop's own server runs against the sandbox: a real sandbox buyer, <code>PayPal-Mock-Response</code> declines, dropped responses, tampered orders. Money rules compare the shop's record with PayPal's, with sandbox IDs per verdict. Failures go back to <span className="ai">Claude</span> with the evidence until the proof is green.</p>
            <div className="tag"><span className="who-tag det">Verdicts: deterministic code</span><span className="who-tag ai">Repairs: Claude</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProofWall({ index }: { index: IndexData }) {
  return (
    <section className="block" id="wall">
      <div className="wrap">
        <SectionHead kicker="Results" title="What the original shops got wrong, and the upgrade fixed.">
          <p>Every scenario ran in the PayPal sandbox before and after the upgrade. Open a shop for the sandbox order and capture IDs behind each verdict.</p>
        </SectionHead>
        <div className="target-cards">
          {index.targets.map((t) => (
            <Link key={t.slug} to={`/proof/${t.slug}`} className="target-card">
              <div>
                <h3>{t.name}</h3>
                <p className="small muted blurb" style={{ margin: "6px 0 0" }}>{t.blurb}</p>
              </div>
              <div className="ba">
                <div><div className="k">Before</div><div className="v bad">{t.failures.length} bug{t.failures.length === 1 ? "" : "s"}</div><div className="tiny muted">money bugs, from {t.tally.before.fail} failing run{t.tally.before.fail === 1 ? "" : "s"} · {t.tally.before.pass} pass · {t.tally.before.na} not applicable</div></div>
                <span className="muted" style={{ textAlign: "center" }}><Arrow /></span>
                <div><div className="k">After</div><div className="v good">{t.tally.after.pass}/{t.tally.after.total - t.tally.after.na} pass</div><div className="tiny muted">{t.tally.after.fail} fail{t.tally.after.na ? ` · ${t.tally.after.na} not applicable` : ""}</div></div>
              </div>
              <span className="small" style={{ fontWeight: 600 }}>Open the evidence <Arrow /></span>
            </Link>
          ))}
        </div>
        {index.targets.map((t) => <WallFor key={t.slug} slug={t.slug} />)}
      </div>
    </section>
  );
}

function WallFor({ slug }: { slug: string }) {
  const { data: t } = useTarget(slug);
  if (!t) return null;
  const tiles = t.scenarios.flatMap((s) => s.modes.map((m) => ({ s, m })));
  // Runs that fail only because of one defect are shown once, as that defect (review r1: one bug, not six tiles).
  const grouped = t.failures.filter((f) => f.sameCause?.length);
  const inGroup = (id: string, mode: string) => grouped.some((g) => g.mode === mode && g.sameCause!.includes(id));
  const failed = tiles.filter(({ s, m }) => m.before?.verdict === "FAIL" && !inGroup(s.id, m.mode));
  const multi = t.modes.length > 1;
  const allFixed = failed.every(({ m }) => m.after?.verdict === "PASS") && grouped.every((g) => g.afterVerdict === "PASS");
  return (
    <details className="wall-group more">
      <summary>{t.name}: the {t.failures.length} money bug{t.failures.length === 1 ? "" : "s"}, before → after{allFixed ? ", all pass after" : ""}</summary>
      <p className="small muted" style={{ margin: "6px 0 0" }}>{t.failures.length} money bug{t.failures.length === 1 ? "" : "s"}, seen in the {failed.length + grouped.length} tiles below · {tiles.length} scenario runs in all{multi ? ` (${t.modes.join(" + ")} mode)` : ""}</p>
      <div className="wall">
        {failed.map(({ s, m }) => <Tile key={s.id + m.mode} slug={slug} s={s} m={m} multi={multi} />)}
        {grouped.map((g) => (
          <Link key={"g" + g.id} to={`/proof/${slug}#f-${g.id}`} className="tile fixed" title={g.headline}>
            <span className="t-name">{g.mode[0].toUpperCase() + g.mode.slice(1)} mode: every paid order stayed unconfirmed</span>
            <span className="t-flip"><Chip v="FAIL" /><Arrow /><Chip v={g.afterVerdict ?? "N/A"} /></span>
            <span className="tiny muted">one bug behind {g.sameCause!.length} failing runs; Printful's reply assumed</span>
          </Link>
        ))}
      </div>
      <details className="wall-more">
        <summary>Show all {tiles.length} runs, including the {tiles.length - failed.length - grouped.reduce((n, g) => n + g.sameCause!.length, 0)} that did not fail before</summary>
        <div className="wall">
          {tiles.map(({ s, m }) => <Tile key={s.id + m.mode} slug={slug} s={s} m={m} multi={multi} />)}
        </div>
      </details>
    </details>
  );
}

function Tile({ slug, s, m, multi }: { slug: string; s: TargetData["scenarios"][number]; m: TargetData["scenarios"][number]["modes"][number]; multi: boolean }) {
  const b = m.before, a = m.after;
  const fixed = b?.verdict === "FAIL" && a?.verdict === "PASS";
  const id = a?.paypal[a.paypal.length - 1]?.orderId;
  return (
    <Link to={`/proof/${slug}#sc-${s.id}`} className={`tile ${fixed ? "fixed" : ""}`} title={s.title}>
      <span className="t-name">{cleanTitle(s.title)}{multi ? <span className="muted"> · {m.mode} mode</span> : null}</span>
      <span className="t-flip">{b ? <Chip v={b.verdict} /> : <span className="chip NA">—</span>}<Arrow />{a ? <Chip v={a.verdict} /> : "—"}{(a?.simulated || b?.simulated) && <Sim />}</span>
      {id && <span className="ppid">{id}</span>}
    </Link>
  );
}

function PlainTitle({ index }: { index: IndexData }) {
  const ts = useTargets(index);
  const n = ts ? ts.filter((t) => (armFacts(t, "plain")?.first?.fail.length ?? 0) > 0 || (laterFacts(t)?.fails ?? 0) > 0).length : 0;
  if (!ts || n === 0) return <>Told only to "migrate", would the AI keep the money safe? Only the proof can tell.</>;
  // Review r3 (O7): a shop whose plain upgrade fails only against simulated PayPal answers is named as such.
  const simOnly = ts.filter((t) => (armFacts(t, "plain")?.first?.fail.length ?? 0) === 0 && (laterFacts(t)?.fails ?? 0) > 0 && laterFacts(t)!.modes.every((m) => m.fail.every((f) => f.simulated)));
  return <>Told only to "migrate", the AI shipped money bugs on {n === ts.length ? (n === 2 ? "both shops" : `all ${n} shops`) : n === 1 ? "one shop" : `${n} shops`}{simOnly.length ? ` (on ${simOnly.map((t) => t.name).join(" and ")}, against PayPal answers our harness simulated)` : ""}. The proof caught them.</>;
}

/** The plain-arm sentences come from the data (web/src/claims.ts), the same text the README prints. */
function PlainArmText({ index }: { index: IndexData }) {
  const ts = useTargets(index);
  if (!ts) return null;
  return <p>{plainArmSentences(ts).join(" ")}</p>;
}

/** All shops' evidence, once each has loaded. */
function useTargets(index: IndexData): TargetData[] | null {
  const a = useTarget(index.targets[0]?.slug ?? ""), b = useTarget(index.targets[1]?.slug ?? "");
  const all = [a.data, b.data].slice(0, index.targets.length);
  return all.every(Boolean) ? (all as TargetData[]) : null;
}

function AiCatch({ index }: { index: IndexData }) {
  const ts = useTargets(index);
  const best = ts ? bestCatch(ts) : null;
  if (!best) return null;
  return (
    <section className="block" id="ai">
      <div className="wrap">
        <SectionHead kicker="The AI's part" title={<>The proof caught a {best.c.red.cell && best.c.red.cell.paypal.flatMap((p) => p.captures).filter((x) => x.status === "COMPLETED").length > 1 ? "double charge" : "money bug"}. Claude fixed it from the evidence alone.</>}>
          <p>Deterministic code found the bug; <span className="ai">Claude</span> got only the failing evidence back, no new rules, and changed the shop's code; the same proof then passed. Recorded in {best.t.name}'s fix loop.</p>
        </SectionHead>
        <div className="home-catch"><CatchCard t={best.t} c={best.c} link /></div>
      </div>
    </section>
  );
}

function AiEarns({ index }: { index: IndexData }) {
  return (
    <section className="block">
      <div className="wrap">
        <SectionHead kicker="The plain-prompt test" title={<PlainTitle index={index} />}>
          <p>We ran each upgrade twice: once with just "migrate" in the prompt, once with our money rules added. Only the sandbox proof can tell whether an upgrade keeps the money safe.</p>
        </SectionHead>
        <details className="more">
          <summary>What each upgrade's first proof found, shop by shop</summary>
          <div className="prose" style={{ marginTop: 8 }}><PlainArmText index={index} /></div>
          <div className="duo">
            {index.targets.map((t) => <ArmSummary key={t.slug} slug={t.slug} />)}
          </div>
        </details>
      </div>
    </section>
  );
}

function ArmSummary({ slug }: { slug: string }) {
  const { data: t } = useTarget(slug);
  if (!t) return <div className="panel" />;
  const full = armFacts(t, ""), plain = armFacts(t, "plain");
  return (
    <div className="panel">
      <div className="panel-head"><h3>{t.name}</h3><Link to={`/proof/${slug}#loop`} className="small">The loop, step by step <Arrow /></Link></div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5 }}>
        <tbody>
          {[["Plain prompt: \"migrate\"", plain], ["With money rules", full]].map(([label, f]) => {
            const x = f as ReturnType<typeof armFacts>;
            return (
              <tr key={label as string} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "10px 8px 10px 0", fontWeight: 600, verticalAlign: "top" }}>{label as string}</td>
                <td style={{ padding: "10px 0", color: "var(--ink-2)" }}>
                  {!x || !x.first ? <span className="muted">not run yet</span> : (
                    <>
                      First proof: <b>{x.first.pass} pass, {x.first.fail.length} fail</b>
                      {x.first.fail.length > 0 && <div className="tiny" style={{ color: "var(--fail)", marginTop: 2 }}>{[...new Set(x.first.fail.map((f) => f.id.replace(/ \(.*\)$/, "")))].join(", ")}</div>}
                      <div className="tiny muted" style={{ marginTop: 4 }}>
                        {x.roundsToGreen === 0 ? "Green at the first proof, no fix round." : x.green ? `${x.roundsToGreen} fix round${x.roundsToGreen > 1 ? "s" : ""} on shop failures, from the evidence alone${x.harnessRounds ? `, then ${x.harnessRounds} more on test-harness problems; green at ${x.green.commit}` : ""}.` : "Not green yet."}
                      </div>
                      {label !== "With money rules" && (() => {
                        const l = laterFacts(t);
                        if (!l) return null;
                        return (
                          <div style={{ marginTop: 8 }}>
                            Scenarios added later, never fed back: <b>{l.pass} pass, {l.fails} fail</b>
                            {l.fails > 0 && <div className="tiny" style={{ color: "var(--fail)", marginTop: 2 }}>{l.ids.join(", ")}</div>}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
