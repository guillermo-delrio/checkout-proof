import { useIndex } from "./data";
import { Link, usePath } from "./router";
import { LightboxProvider } from "./components";
import { Overview } from "./pages/Overview";
import { Target } from "./pages/Target";
import { Scan } from "./pages/Scan";
import { Run } from "./pages/Run";

// Phone nav labels: four links fit at 360 px only with short names.
const SHORT: Record<string, string> = { "simple-clothing-store": "Clothing store" };
const Label = ({ long, short }: { long: string; short: string }) => long === short ? <>{long}</> : <><span className="long">{long}</span><span className="short">{short}</span></>;

export function App() {
  const path = usePath();
  const { data: index } = useIndex();
  const slug = path.match(/^\/proof\/([^/]+)/)?.[1];
  const run = path.match(/^\/run\/([\w-]+)$/)?.[1];
  const page = slug ? <Target slug={slug} /> : run ? <Run id={run} /> : path.startsWith("/scan") ? <Scan /> : <Overview />;
  const cur = (p: string) => (p === "/" ? path === "/" : path.startsWith(p)) ? "page" : undefined;
  return (
    <LightboxProvider>
      <header className="top">
        <div className="wrap">
          <Link to="/" className="brand" aria-label="Checkout Proof, overview">
            <span className="brand-mark"><svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6L15.5 6.5" stroke="currentColor" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            Checkout Proof
          </Link>
          <nav className="nav" aria-label="Pages">
            <Link to="/" aria-current={cur("/")}>Overview</Link>
            {index?.targets.map((t) => <Link key={t.slug} to={`/proof/${t.slug}`} aria-current={cur(`/proof/${t.slug}`)}><Label long={t.name} short={SHORT[t.name] ?? t.name} /></Link>)}
            <Link to="/scan" aria-current={cur("/scan")}><Label long="Scan a repo" short="Scan" /></Link>
          </nav>
        </div>
      </header>
      <main key={path}>{page}</main>
      <footer className="foot">
        <div className="wrap">
          <div>
            <b style={{ color: "var(--ink)" }}>Checkout Proof</b> · an entry for the PayPal AI Hackathon, 2026.
            <br />Every run on this site used the PayPal sandbox. No real money moved, and no buyer data is shown: the sandbox buyer's login is masked in every screenshot.
          </div>
          <div>
            The upgrades and fix rounds were run by Claude; this site shows their recorded evidence. The scan box and the live re-run use deterministic code only, so no model decides a verdict.
            {index?.exportedAt && <><br />Evidence exported {index.exportedAt.slice(0, 16).replace("T", " ")} UTC.</>}
          </div>
        </div>
      </footer>
    </LightboxProvider>
  );
}
