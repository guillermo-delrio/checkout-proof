import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Cell, Verdict } from "./types";
import { cleanTitle, fmt, plainReason } from "./claims";
import { asset } from "./env";
export { cleanTitle, fmt, plainReason };

export function Chip({ v, simulated }: { v: Verdict | string; simulated?: string | null }) {
  const cls = v === "N/A" ? "NA" : v;
  const label = v === "N/A" ? "n/a" : v === "INCONCLUSIVE" ? "inconclusive" : v === "PASS" ? "pass" : v === "FAIL" ? "fail" : v;
  return (
    <>
      <span className={`chip ${cls}`}>{label}</span>
      {simulated && <Sim />}
    </>
  );
}

export const Sim = () => <span className="chip SIM" title="The test harness rewrote PayPal's answer before the shop saw it, to reach a case the sandbox cannot produce on demand. PayPal's real record is shown too.">simulated</span>;

/** What the harness did to PayPal's answers, for a cell. Real PayPal-Mock-Response codes keep their names. */
export function mockLabel(codes: string[]): string[] {
  return codes.map((c) => c === "DROPPED_RESPONSE" ? "simulated: the shop never received PayPal's answer, though PayPal processed the call" : `PayPal-Mock-Response ${c}`);
}

export function Check({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function Arrow() {
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4.5L15.5 10 11 14.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** The two records side by side: what the shop wrote down, what PayPal actually holds. */
export function Receipt({ cell, title, lead, foot, ok, className }: { cell: Cell; title?: ReactNode; lead?: ReactNode; foot?: ReactNode; ok?: boolean; className?: string }) {
  const caps = cell.paypal.flatMap((p) => p.captures.filter((c) => c.status === "COMPLETED"));
  const captured = caps.map((c) => c.amount).join(" + ");
  const ppMain = captured || "nothing";
  const last = cell.paypal[cell.paypal.length - 1];
  return (
    <div className={`receipt ${className ?? ""}`}>
      {title && <div className="receipt-head">{title}</div>}
      {lead && <div className="receipt-lead">{lead}</div>}
      <div className="receipt-cols">
        <div className="receipt-col shop" style={ok ? { color: "inherit" } : undefined}>
          <div className="who">The shop's record</div>
          <div className="amount" style={ok ? { color: "var(--ink)" } : undefined}>{fmt(cell.shopTotal) ?? "—"}</div>
          <div className="state">{cell.shopAfter ? <>Order {cell.shopPaid ? <span style={{ color: ok ? "var(--pass)" : "var(--fail)" }}>marked paid</span> : <span>not paid</span>}</> : "—"}</div>
          {cell.shopAfter && cell.shopAfter.toLowerCase() !== (cell.shopPaid ? "paid" : "") && <div className="detail">the shop's own status: <code>{cell.shopAfter}</code>{cell.shopPaid && cell.shopAfter.toLowerCase() !== "paid" ? ", the status this shop gives an order it counts as paid" : ""}</div>}
          {cell.shopOrderId && <div className="detail">order <code>{cell.shopOrderId}</code></div>}
        </div>
        <div className="receipt-col pp">
          <div className="who">PayPal's record (sandbox)</div>
          <div className="amount">{fmt(ppMain)}</div>
          <div className="state">{caps.length ? `${caps.length} completed capture${caps.length > 1 ? "s" : ""}` : last ? `order ${last.status.toLowerCase()}, no capture` : "no PayPal order"}</div>
          {cell.simulated && <div className="detail">what the shop was told: <code>{cell.simulated === "pending" ? "PENDING" : String(cell.simulated).toUpperCase()}</code> (simulated by the harness)</div>}
          {cell.paypal.map((p) => (
            <div className="detail" key={p.orderId}>
              <code>{p.orderId}</code> {p.status}
              {p.captures.map((c) => <div key={c.id} className="muted"><code>{c.id}</code> {c.status} {c.amount}</div>)}
            </div>
          ))}
        </div>
      </div>
      {foot && <div className={`receipt-foot ${ok ? "ok" : ""}`}>{foot}</div>}
    </div>
  );
}

// ---- screenshot lightbox ----
const Lb = createContext<(src: string, caption: string) => void>(() => {});
export function LightboxProvider({ children }: { children: ReactNode }) {
  const [open, set] = useState<{ src: string; caption: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && set(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <Lb.Provider value={(src, caption) => set({ src, caption })}>
      {children}
      {open && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={open.caption} onClick={() => set(null)}>
          <figure style={{ margin: 0 }}>
            <img src={asset(open.src)} alt={open.caption} />
            <figcaption>{open.caption} · click or press Esc to close</figcaption>
          </figure>
        </div>
      )}
    </Lb.Provider>
  );
}
export const useLightbox = () => useContext(Lb);

/** `full`: the lightbox opens this image instead (a crop's whole page). `natural`: no 16:10 thumbnail crop. */
export function Shot({ src, caption, full, natural }: { src: string; caption: string; full?: string; natural?: boolean }) {
  const open = useLightbox();
  return (
    <button className={`shot${natural ? " natural" : ""}`} onClick={() => open(full ?? src, caption)}>
      <img src={asset(src)} alt={caption} />
      <span>{caption}</span>
    </button>
  );
}

export function SectionHead({ kicker, title, children, id }: { kicker: string; title: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="section-head" id={id}>
      <div>
        <p className="kicker">{kicker}</p>
        <h2>{title}</h2>
      </div>
      {children && <div>{children}</div>}
    </div>
  );
}

/** Renders the evidence packs' light markdown: `code` and **bold** only. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p)}</>;
}
