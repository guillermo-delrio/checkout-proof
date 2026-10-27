// Milestone-1 scenarios (DESIGN.md table). Each one gathers facts through the adapter; verdict() decides.
import fs from "node:fs";
import path from "node:path";
import { createForeignOrder, call as pp } from "../paypal/truth.ts";
import crypto from "node:crypto";
import { RETURN_BASE, approveUrl } from "../buyer/buyer.ts";
import { approveLink } from "../paypal/truth.ts";
import { buyerApproves } from "../targets/simple-clothing-store.ts";
import { formatMoney } from "../money/money.ts";
import type { Adapter, ShopCall } from "../targets/types.ts";

export interface Facts {
  ppOrders: string[]; calls: ShopCall[]; notes: string[]; allow5xx?: number[]; attack?: boolean;
  shopOrderId?: string;              // selfOrder scenarios: the shop order to judge (the one the shop marked paid, if any)
  extraReasons?: string[];           // failures the scenario itself establishes (e.g. E1: paid order holds another cart)
  // Labelled synthetic: the shop was told the capture is PENDING (SCENARIOS #10b), or that PayPal took another amount
  // or currency for the shop's own order (#11b). The verdict judges the world the shop was told; PayPal's real record
  // stays in the evidence.
  simulated?: "pending" | { value?: string; currency?: string };
  after?: () => Promise<string[]>;   // clean-up once PayPal's record is read (e.g. refund a capture the scenario made)
  timeline?: { t: number; step: string; shot?: string }[]; // seconds from scenario start, for the video summary
}
export interface Scenario {
  id: string; title: string; ref: string; expect: "paid-once" | "not-paid";
  selfOrder?: boolean;               // the scenario makes its own shop order(s) (session shops such as expressCart)
  run(a: Adapter, shopOrderId: string, shotDir: string): Promise<Facts>;
}

import { HarnessError, PayPalSlowError } from "./errors.ts";
export { HarnessError, PayPalSlowError };

async function approved(ppOrderId: string | undefined, notes: string[], shot?: string) {
  if (!ppOrderId) { notes.push("no PayPal order was created"); return false; }
  const r = await buyerApproves(ppOrderId, shot).catch((e) => ({ ok: false, error: String(e?.message || e), steps: [] as string[] }));
  if (!r.ok) throw new HarnessError(`sandbox buyer could not approve ${ppOrderId}: ${r.error} (${r.steps.join(",")})`);
  notes.push(`buyer approved ${ppOrderId}`);
  return true;
}

// Foreign order: same value, other currency or lower amount, custom_id bound to the shop order, really paid.
async function foreign(a: Adapter, shopOrderId: string, shotDir: string, value: (v: string) => string, currency: (c: string) => string): Promise<Facts> {
  const notes: string[] = [];
  const s = await a.shopState(shopOrderId);
  const [v, c] = formatMoney(s.total).split(" ");
  const o = await createForeignOrder(shopOrderId, value(v), currency(c), RETURN_BASE);
  notes.push(`attacker created ${o.json?.id} for ${value(v)} ${currency(c)} with custom_id ${shopOrderId} (debug ${o.debugId})`);
  const r = await approveUrl(approveLink(o.json)!, { until: /localhost:9999/, shotPath: path.join(shotDir, `approve-${o.json?.id}.png`) });
  if (!r.ok) throw new HarnessError(`sandbox buyer could not approve attacker order ${o.json?.id}: ${r.error}`);
  notes.push("buyer approved");
  const { call } = await import("../paypal/truth.ts");
  const cap = await call("POST", `/v2/checkout/orders/${o.json?.id}/capture`, {});
  const cp = cap.json?.purchase_units?.[0]?.payments?.captures?.[0];
  notes.push(`attacker captured: HTTP ${cap.status}, capture ${cp?.id} ${cp?.status} ${cp?.amount?.value} ${cp?.amount?.currency_code}`);
  const calls = await a.submitForeign(o.json?.id);
  return { ppOrders: [o.json?.id], calls, notes, attack: true };
}

// The shop's own PayPal order, really paid in full, while the harness tells the shop's server PayPal took another
// amount or currency (labelled SIMULATED; SCENARIOS #11b). Tests the shop's own money check, which a foreign order
// never reaches when the shop refuses unknown orders first. The real capture is refunded afterwards.
async function ownMoney(a: Adapter, shopOrderId: string, spec: { value?: string; currency?: string }): Promise<Facts> {
  const notes: string[] = [];
  if (!a.rewriteMoney) throw new HarnessError("this adapter cannot rewrite PayPal's answers");
  const { ppOrderId, call } = await a.checkout(shopOrderId);
  const calls = [call];
  if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
  a.rewriteMoney(spec);
  try { calls.push(...(await a.complete(ppOrderId!))); } finally { a.rewriteMoney(null); }
  const told = [spec.value && `amount ${spec.value}`, spec.currency && `currency ${spec.currency}`].filter(Boolean).join(" and ");
  notes.push(`SIMULATED: while the shop completed ${ppOrderId}, PayPal's answers to the shop's server reported ${told} for the order and its capture; PayPal's real record is unchanged`);
  const after = async () => {
    const g = await pp("GET", `/v2/checkout/orders/${ppOrderId}`);
    const caps = (g.json?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []).filter((c: any) => c.status === "COMPLETED");
    const out: string[] = [];
    for (const c of caps) {
      const rf = await pp("POST", `/v2/payments/captures/${c.id}/refund`, {}, { "PayPal-Request-Id": `cp-refund-${c.id}` });
      out.push(`harness refunded the real capture ${c.id} (${c.amount?.value} ${c.amount?.currency_code}) afterwards to keep the sandbox buyer's balance: HTTP ${rf.status}, refund ${rf.json?.id} ${rf.json?.status}`);
    }
    return out;
  };
  return { ppOrders: [ppOrderId!], calls, notes, attack: true, simulated: spec, after };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "happy", title: "Happy path, PayPal wallet", ref: "#1", expect: "paid-once",
    async run(a, id, shotDir) {
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (await approved(ppOrderId, notes, path.join(shotDir, "happy-approve.png"))) calls.push(...(await a.complete(ppOrderId!)));
      return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
    },
  },
  {
    id: "happy-ui", title: "Happy path through the shop's own PayPal button", ref: "#1", expect: "paid-once",
    async run(a, id, shotDir) {
      const r = await a.uiCheckout!(id, shotDir);
      const b = r.notes.find((n) => n.startsWith("buyer: failed"));
      if (b && !r.calls.some((c) => c.step.includes("/capture"))) throw new HarnessError(b);
      return { ppOrders: r.ppOrderId ? [r.ppOrderId] : [], calls: r.calls, notes: r.notes };
    },
  },
  {
    id: "unapproved", title: "Paid before approval (confirm an unapproved order)", ref: "#7a", expect: "not-paid",
    async run(a, id) {
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (a.variant === "original") calls.push(...(await a.submitForeign(ppOrderId!))); // straight to the server step
      else calls.push(...(await a.complete(ppOrderId!)));
      return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes: ["buyer never approved"] };
    },
  },
  {
    id: "declined-retry", title: "Declined instrument, then a retry that works", ref: "#5", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      if (a.variant === "original") calls.push(...(await a.complete(ppOrderId!, { clientMock: "INSTRUMENT_DECLINED" })));
      else { a.mock("/capture", "INSTRUMENT_DECLINED"); calls.push(...(await a.complete(ppOrderId!))); }
      notes.push("first capture mocked INSTRUMENT_DECLINED; second attempt unmocked");
      calls.push(...(await a.complete(ppOrderId!)));
      return { ppOrders: [ppOrderId!], calls, notes };
    },
  },
  {
    id: "duplicate", title: "Duplicate capture (double click, then a refresh)", ref: "#8a", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      const [c1, c2] = await Promise.all([a.complete(ppOrderId!), a.complete(ppOrderId!)]);
      calls.push(...c1, ...c2, ...(await a.complete(ppOrderId!)));
      notes.push("two concurrent completes, then a third");
      return { ppOrders: [ppOrderId!], calls, notes };
    },
  },
  {
    id: "currency", title: "Foreign PayPal order (same amount, cheaper currency MXN) handed to the shop", ref: "#11a", expect: "not-paid",
    run: (a, id, d) => foreign(a, id, d, (v) => v, () => "MXN"),
  },
  {
    id: "amount", title: "Foreign PayPal order (lower amount 1.00) handed to the shop", ref: "#11a", expect: "not-paid",
    run: (a, id, d) => foreign(a, id, d, () => "1.00", (c) => c),
  },
  {
    id: "currency-own", title: "PayPal reports a cheaper currency (MXN) for the shop's own order (SIMULATED)", ref: "#11b", expect: "not-paid",
    run: (a, id) => ownMoney(a, id, { currency: "MXN" }),
  },
  {
    id: "amount-own", title: "PayPal reports a lower amount (1.00) for the shop's own order (SIMULATED)", ref: "#11b", expect: "not-paid",
    run: (a, id) => ownMoney(a, id, { value: "1.00" }),
  },
  {
    id: "create-refused", title: "PayPal refuses to create the order", ref: "#4", expect: "not-paid",
    async run(a, id) {
      a.mock("/v2/checkout/orders", "PAYER_CANNOT_PAY", "POST");
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      const alive = await fetch(`${a.baseUrl}/api/orders/${id}`);
      calls.push({ step: "GET /api/orders/:id (shop still serving)", http: alive.status });
      const notes = [`create answered ${call.http}${ppOrderId ? ", but returned an order id " + ppOrderId : ""}`];
      if (call.http < 400) notes.push("expected a 4xx to reach the client");
      return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
    },
  },
  {
    id: "server-error-retry", title: "PayPal 500 on capture, then a retry", ref: "#9b", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      if (a.variant === "original") calls.push(...(await a.complete(ppOrderId!, { clientMock: "INTERNAL_SERVER_ERROR" })));
      else { a.mock("/capture", "INTERNAL_SERVER_ERROR"); calls.push(...(await a.complete(ppOrderId!))); }
      const allow5xx = calls.map((c, i) => (c.http >= 500 ? i : -1)).filter((i) => i >= 0); // the injected fault
      calls.push(...(await a.complete(ppOrderId!)));
      notes.push("first capture mocked INTERNAL_SERVER_ERROR (a 5xx passed through is allowed); retry unmocked");
      return { ppOrders: [ppOrderId!], calls, notes, allow5xx };
    },
  },
  {
    id: "lost-response", title: "Capture succeeds, its response is lost, then a retry", ref: "#9a", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      if (a.variant === "original") calls.push(...(await a.complete(ppOrderId!, { lose: true })));
      else { a.dropNext("/capture"); calls.push(...(await a.complete(ppOrderId!))); }
      const allow5xx = calls.map((c, i) => (c.http >= 500 ? i : -1)).filter((i) => i >= 0);
      if (a.variant === "upgraded") calls.push(...(await a.complete(ppOrderId!)));
      else notes.push("the v5 client has no retry or lookup path after a lost capture response");
      notes.push("PayPal processed the first capture; its response was dropped before the shop's code saw it");
      return { ppOrders: [ppOrderId!], calls, notes, allow5xx };
    },
  },
  {
    // SCENARIOS #6: PayPal answers the capture with PAYER_ACTION_REQUIRED (mocked). The documented handling is to send
    // the buyer to the order's payer-action link and capture the same order when they return. PayPal gives that link
    // only in its answer to the create call (a GET of an approved order lists none: probed 19 Oct), so the shop must
    // keep it. The harness tags the link in PayPal's create answer (cp_link=paypal, CP_TAG_LINKS) so a link the shop
    // builds itself, even byte-identical to PayPal's, is told apart. No real 3-D Secure step is run.
    id: "payer-action", title: "PayPal demands a buyer step on capture (PAYER_ACTION_REQUIRED, mocked): the shop sends the buyer to the order's own payer-action link, and a later capture of the same order succeeds", ref: "#6", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [], extra: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      const given = payPalLinkFor(a, ppOrderId!);
      a.mock("/capture", "PAYER_ACTION_REQUIRED");
      const first = await a.complete(ppOrderId!);
      calls.push(...first);
      const refusal = first[first.length - 1];
      const body = refusal?.body as any;
      const link = String(body?.payer_action_url ?? "");
      if (!refusal || refusal.http < 400 || refusal.http >= 500) extra.push(`the shop answered HTTP ${refusal?.http} to a capture PayPal refused with PAYER_ACTION_REQUIRED (expected a 4xx with action "payer-action")`);
      else if (body?.action !== "payer-action") extra.push(`the refusal says action "${body?.action}", not "payer-action"`);
      if (!given) throw new HarnessError(`the harness saw no payer-action link in PayPal's create answer for ${ppOrderId}`);
      if (link !== given) extra.push(link ? `the shop sent the buyer to ${link}, not to the payer-action link PayPal gave for ${ppOrderId} (${given})${link.split("&cp_link=")[0] === given.split("&cp_link=")[0] ? ": same address without the harness's tag, so the shop built it itself" : ""}` : `the refusal carries no payer_action_url (PayPal's link for ${ppOrderId} was ${given})`);
      else notes.push(`shop answered ${refusal.http} ${body?.error} with PayPal's own payer-action link for the order (${link}; cp_link=paypal is the harness's tag)`);
      // In the sandbox the order is already approved and the mock only stands in for PayPal's demand, so there is no
      // extra page to complete: the buyer's return is played by capturing the same order again, as the return page does.
      calls.push(...(await a.complete(ppOrderId!)));
      notes.push("first capture mocked PAYER_ACTION_REQUIRED; after the buyer's return, the same PayPal order captured unmocked");
      return { ppOrders: [ppOrderId!], calls, notes, extraReasons: extra };
    },
  },
  {
    // Judge r2 #3: the capture refusals seen in the sandbox on 17 Oct, each mocked on a capture of the same approved
    // order. Each must reach the buyer as a 4xx, never confirm the order and never leave a capture behind.
    id: "capture-refused", title: "PayPal refuses the capture three ways (TRANSACTION_REFUSED, COMPLIANCE_VIOLATION, MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED, mocked)", ref: "#5", expect: "not-paid",
    async run(a, id) {
      const notes: string[] = [], extra: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      for (const code of REFUSALS) {
        const r = a.variant === "original" ? await a.complete(ppOrderId!, { clientMock: code }) : (a.mock("/capture", code), await a.complete(ppOrderId!));
        calls.push(...r);
        const last = [...r].reverse().find((c) => c.http > 0);
        if (!last || last.http < 400 || last.http >= 500) extra.push(`${code}: the shop answered HTTP ${last?.http ?? "nothing"}, expected a 4xx refusal`);
        const st = await a.shopState(id);
        if (st.paid) { extra.push(`${code}: the shop confirmed the order`); break; }
        notes.push(`capture mocked ${code}: shop answered ${last?.http}${(last?.body as any)?.error ? " " + (last?.body as any).error : ""}`);
      }
      return { ppOrders: [ppOrderId!], calls, notes, extraReasons: extra };
    },
  },
  {
    // Judge r2 #10: the buyer approved at PayPal, then the shop's process restarted (deploy, crash, scale-down)
    // before the return page captured. The payment must still go through, once.
    id: "restart-approved", title: "Shop restarts between the buyer's approval and the capture", ref: "#7b", expect: "paid-once",
    async run(a, id) {
      if (!a.restart) throw new HarnessError("this adapter cannot restart the shop");
      const notes: string[] = [];
      const { ppOrderId, call } = await a.checkout(id);
      const calls = [call];
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      await a.restart();
      notes.push("shop process restarted after the buyer approved");
      calls.push(...(await a.complete(ppOrderId!)));
      calls.push(...(await a.complete(ppOrderId!)));
      notes.push("the return page captured, then a refresh captured again");
      return { ppOrders: [ppOrderId!], calls, notes };
    },
  },
  {
    // Sceptic r2 N1: PayPal holds the capture (PENDING, SIMULATED), the shop restarts before PayPal completes it.
    // After the restart the shop must still refuse a second payment, and PayPal's completion must confirm the order
    // once: a genuine PAYMENT.CAPTURE.COMPLETED delivery on the live run (replayed after the restart if it came
    // before), the buyer's return page locally (PayPal delivers webhooks only to the hosted listener).
    id: "restart-pending", title: "Shop restarts while PayPal holds the payment (pending, SIMULATED): no second payment, and PayPal's completion still confirms the order once", ref: "#10c", expect: "paid-once",
    async run(a, id) {
      if (!a.restart || !a.rewritePending) throw new HarnessError("this adapter cannot restart the shop or simulate a pending capture");
      const notes: string[] = [], extra: string[] = [], calls: ShopCall[] = [];
      const t0 = Date.now();
      const timeline: { t: number; step: string }[] = [];
      const mark = (step: string) => timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, step });
      const order = async () => (await fetch(`${a.baseUrl}/api/orders/${id}`)).json() as Promise<any>;
      const { ppOrderId, call } = await a.checkout(id);
      calls.push(call);
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      a.rewritePending(true);
      try { calls.push(...(await a.complete(ppOrderId!))); } finally { a.rewritePending(false); }
      mark("capture answered PENDING (SIMULATED; the real capture completed)");
      const held = await a.shopState(id);
      if (held.paid) extra.push("shop confirmed the order on a PENDING capture");
      await a.restart();
      mark("shop process restarted");
      notes.push("shop process restarted while the capture was pending");
      const again = await a.checkout(id);
      calls.push({ ...again.call, step: again.call.step + " (again, after the restart)" });
      if (again.call.http < 400 || again.ppOrderId) extra.push(`after the restart a second payment was allowed (HTTP ${again.call.http}${again.ppOrderId ? ", PayPal order " + again.ppOrderId : ""})`);
      else notes.push(`second checkout after the restart refused: HTTP ${again.call.http} ${(again.call.body as any)?.error ?? ""}`);
      let o = await order();
      const live = !!process.env.CP_WEBHOOK_LOG && process.env.CP_WEBHOOK_LIVE === "1";
      if (live) {
        // PayPal sends COMPLETED within seconds of the real capture: before or after the restart. Either way the kept
        // genuine delivery is replayed to the restarted shop: it must confirm the order, or (if it already did)
        // be acknowledged without a second change.
        const captureId = o?.payment?.captureId ?? (await capturesOf(ppOrderId!))[0];
        const d = await keptDelivery("PAYMENT.CAPTURE.COMPLETED", captureId, 60_000);
        if (!d) throw new PayPalSlowError(`PayPal: no PAYMENT.CAPTURE.COMPLETED delivery for ${captureId} reached our listener within 60 s`);
        const r = await fetch(`${a.baseUrl}/api/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...d.headers }, body: d.raw });
        calls.push({ step: `POST /api/paypal/webhook (genuine ${d.eventId} replayed after the restart)`, http: r.status, body: await r.json().catch(() => undefined) });
        mark(`genuine PAYMENT.CAPTURE.COMPLETED ${d.eventId} replayed to the restarted shop: HTTP ${r.status}`);
        if (r.status < 200 || r.status >= 300) extra.push(`the restarted shop answered HTTP ${r.status} to a genuine COMPLETED delivery`);
      }
      // The buyer's return page (or a refresh) after the restart: must answer from PayPal's real state, never capture twice.
      calls.push(...(await a.complete(ppOrderId!)));
      mark("buyer's return page asked the shop to complete the order");
      o = await order();
      const st = await a.shopState(id);
      if (!st.paid) extra.push(`after the restart, PayPal's completed capture did not confirm the order (status ${st.rawStatus})`);
      const paidChanges = (o?.payment?.changes ?? []).filter((c: any) => c.to === "paid");
      if (paidChanges.length > 1) extra.push(`order changed to paid ${paidChanges.length} times`);
      return { ppOrders: [ppOrderId!], calls, notes, extraReasons: extra, timeline };
    },
  },
  {
    id: "two-tabs", title: "Two checkouts for one shop order (two tabs), both approved and paid", ref: "#8", expect: "paid-once",
    async run(a, id) {
      const notes: string[] = [];
      const c1 = await a.checkout(id);
      const c2 = await a.checkout(id);
      const calls = [c1.call, c2.call];
      const pp = [c1.ppOrderId, c2.ppOrderId].filter(Boolean) as string[];
      for (const o of pp) await approved(o, notes);
      const [r1, r2] = await Promise.all(pp.map((o) => a.complete(o)));
      calls.push(...(r1 ?? []), ...(r2 ?? []));
      notes.push("both tabs completed at the same time");
      return { ppOrders: pp, calls, notes };
    },
  },
  {
    // SCENARIOS #10b + #12 + #13 + #14 on the shop's own webhook route, with real deliveries (live re-run only: PayPal
    // delivers to the hosted listener, which forwards verified deliveries to this shop while the run is going).
    id: "webhook", title: "Pending capture (SIMULATED) confirmed by a genuine webhook, then refunded; replayed and forged deliveries change nothing", ref: "#12 #14", expect: "not-paid",
    async run(a, id) {
      const notes: string[] = [], extra: string[] = [], calls: ShopCall[] = [];
      const t0 = Date.now();
      const timeline: { t: number; step: string }[] = [];
      const mark = (step: string) => timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, step });
      const order = async () => (await fetch(`${a.baseUrl}/api/orders/${id}`)).json() as Promise<any>;
      const until = async (what: string, ok: (o: any) => boolean, ms: number, record = true) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1500))) { const o = await order(); if (ok(o)) return o; }
        if (record) extra.push(`no ${what} within ${ms / 1000} s`); return order();
      };
      // A delivery can land on another Cloud Run instance (no re-run there, so no shop to pass it to). After 45 s
      // the harness finds PayPal's event for this capture and asks PayPal to deliver it again; the note says so.
      const awaitEvent = async (what: string, type: string, captureId: string | undefined, ok: (o: any) => boolean) => {
        const x = await until(what, ok, 45_000, false);
        if (ok(x)) return x;
        if (!captureId) { extra.push(`no ${what} within 45 s`); return x; }
        // Delivered to our listener (and so forwarded to the shop), yet the order did not change: the shop's fault.
        if (findKept(type, captureId)) { const y = await until(what, ok, 15_000, false); if (!ok(y)) extra.push(`PayPal's ${type} delivery reached the shop, but the order did not change within 60 s`); return y; }
        const since = new Date(t0 - 60_000).toISOString();
        const list = await pp("GET", `/v1/notifications/webhooks-events?event_type=${type}&start_time=${since}&page_size=20`);
        const ev = (list.json?.events ?? []).find((e: any) => e.resource?.id === captureId || (e.resource?.links ?? []).some((l: any) => l.rel === "up" && String(l.href).endsWith(`/captures/${captureId}`)));
        if (!ev) { const y = await until(what, ok, 30_000, false); if (ok(y)) return y; throw new PayPalSlowError(`PayPal: no ${type} delivery for ${captureId} reached our listener within 75 s, and PayPal lists no such event yet`); }
        const rs = await pp("POST", `/v1/notifications/webhooks-events/${ev.id}/resend`, { webhook_ids: [process.env.PAYPAL_WEBHOOK_ID] });
        notes.push(`${type} ${ev.id} had not reached the shop after 45 s; harness asked PayPal to deliver it again (HTTP ${rs.status})`);
        const y = await until(what, ok, 45_000, false);
        if (ok(y)) return y;
        if (findKept(type, captureId)) { extra.push(`PayPal's ${type} delivery reached the shop, but the order did not change`); return y; }
        throw new PayPalSlowError(`PayPal: ${type} ${ev.id} never reached our listener (resend asked, HTTP ${rs.status}; waited 90 s)`);
      };
      const changesTo = (o: any, to: string) => (o?.payment?.changes ?? []).filter((c: any) => c.to === to);

      const { ppOrderId, call } = await a.checkout(id);
      calls.push(call);
      if (!(await approved(ppOrderId, notes))) return { ppOrders: ppOrderId ? [ppOrderId] : [], calls, notes };
      a.rewritePending!(true);
      try { calls.push(...(await a.complete(ppOrderId!))); } finally { a.rewritePending!(false); }
      mark("capture answered PENDING (SIMULATED; the real capture completed)");
      let o = await order();
      if (o.status === "pending") extra.push("shop confirmed the order on a PENDING capture");
      if (o?.payment?.state !== "pending") extra.push(`shop did not record the pending capture (payment.state ${o?.payment?.state ?? "missing"})`);
      // While the capture is pending, a second checkout for the same order must be refused (no double charge).
      const again = await a.checkout(id);
      calls.push({ ...again.call, step: again.call.step + " (again, while pending)" });
      if (again.call.http < 400 || again.ppOrderId) extra.push(`a second payment was allowed while the first was pending (HTTP ${again.call.http})`);
      notes.push(`shop answered the pending capture; second checkout while pending: HTTP ${again.call.http}`);

      o = await awaitEvent("PAYMENT.CAPTURE.COMPLETED delivery confirming the order", "PAYMENT.CAPTURE.COMPLETED", o?.payment?.captureId, (x) => changesTo(x, "paid").some((c: any) => c.eventId));
      const paid = changesTo(o, "paid").find((c: any) => c.eventId);
      if (paid) { mark(`genuine ${paid.eventType} ${paid.eventId} confirmed the order`); notes.push(`webhook ${paid.eventType} ${paid.eventId}: pending → paid`); }
      if (o.status !== "pending") extra.push(`after the COMPLETED delivery the order is ${o.status}, not confirmed`);
      const captureId = o?.payment?.captureId;
      if (!captureId) { extra.push("shop does not report the capture id"); return { ppOrders: [ppOrderId!], calls, notes, extraReasons: extra, timeline }; }

      // Forged deliveries straight at the shop's own route: no headers; then a real-looking REVERSED with a bad signature.
      const forged = { id: `WH-FORGED-${Date.now()}`, event_type: "PAYMENT.CAPTURE.REVERSED", resource_type: "refund", resource: { id: "FORGED", status: "COMPLETED", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } };
      const hook = (headers: Record<string, string>) => fetch(`${a.baseUrl}/api/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(forged) });
      const beforeForged = JSON.stringify([o.status, o?.payment?.changes]);
      const f1 = await hook({});
      const f2 = await hook({ "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77", "paypal-transmission-id": crypto.randomUUID(), "paypal-transmission-sig": "Zm9yZ2Vk", "paypal-transmission-time": new Date().toISOString() });
      calls.push({ step: "POST /api/paypal/webhook (forged: no PayPal headers)", http: f1.status, body: await f1.json().catch(() => undefined) }, { step: "POST /api/paypal/webhook (forged REVERSED: bad signature)", http: f2.status, body: await f2.json().catch(() => undefined) });
      if (f1.status < 400 || f1.status >= 500) extra.push(`forged delivery without headers got HTTP ${f1.status}`);
      if (f2.status < 400 || f2.status >= 500) extra.push(`forged REVERSED with a bad signature got HTTP ${f2.status}`);
      o = await order();
      if (JSON.stringify([o.status, o?.payment?.changes]) !== beforeForged) extra.push(`a forged delivery changed the order (now ${o.status})`);

      // A real refund at PayPal: PayPal itself sends PAYMENT.CAPTURE.REFUNDED.
      const rf = await pp("POST", `/v2/payments/captures/${captureId}/refund`, {}, { "PayPal-Request-Id": `cp-refund-${captureId}` });
      notes.push(`harness refunded ${captureId} at PayPal: HTTP ${rf.status}, refund ${rf.json?.id} ${rf.json?.status} (debug ${rf.debugId})`);
      mark(`refund ${rf.json?.id} at PayPal`);
      o = await awaitEvent("PAYMENT.CAPTURE.REFUNDED delivery", "PAYMENT.CAPTURE.REFUNDED", captureId, (x) => changesTo(x, "refunded").length > 0);
      const refunded = changesTo(o, "refunded")[0];
      if (refunded) { mark(`genuine ${refunded.eventType} ${refunded.eventId} marked the order refunded`); notes.push(`webhook ${refunded.eventType} ${refunded.eventId}: paid → refunded`); }

      // Replay: the genuine deliveries of both events, byte for byte (PayPal's signature still verifies), straight
      // to the shop's route. A replayed COMPLETED must not undo the refund; a replayed REFUNDED must change nothing.
      if (refunded?.eventId && paid?.eventId) {
        const before = JSON.stringify(o.payment.changes);
        for (const ev of [paid, refunded]) {
          const file = path.join(process.env.CP_WEBHOOK_LOG ?? "", `${String(ev.eventId).replace(/[^\w-]/g, "_")}.json`);
          if (!process.env.CP_WEBHOOK_LOG || !fs.existsSync(file)) { extra.push(`no kept delivery of ${ev.eventId} to replay`); continue; }
          const d = JSON.parse(fs.readFileSync(file, "utf8"));
          const n0 = o.payment.deliveries?.[ev.eventId] ?? 0;
          const r = await fetch(`${a.baseUrl}/api/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...d.headers }, body: d.raw });
          calls.push({ step: `POST /api/paypal/webhook (replay of the genuine ${ev.eventType} delivery)`, http: r.status, body: await r.json().catch(() => undefined) });
          o = await order();
          const n1 = o.payment?.deliveries?.[ev.eventId] ?? 0;
          notes.push(`replayed ${ev.eventType} ${ev.eventId}: HTTP ${r.status}, deliveries ${n0} → ${n1}`);
          if (r.status < 200 || r.status >= 300) extra.push(`the replayed ${ev.eventType} got HTTP ${r.status}, expected a 2xx acknowledgement`);
          if (n1 <= n0) extra.push(`the shop did not count the replayed ${ev.eventType} delivery`);
        }
        mark("both genuine deliveries replayed; state unchanged");
        notes.push(`changes ${JSON.stringify(o.payment.changes.map((c: any) => `${c.from}→${c.to}${c.eventId ? " " + c.eventId : ""}`))}`);
        if (JSON.stringify(o.payment.changes) !== before) extra.push("a replayed delivery changed the order again");
      }
      for (const to of ["paid", "refunded"]) if (changesTo(o, to).length !== 1) extra.push(`order changed to ${to} ${changesTo(o, to).length} times, expected once`);
      if (o.status !== "refunded") extra.push(`order ends ${o.status}, expected refunded`);
      return { ppOrders: [ppOrderId!], calls, notes, extraReasons: extra, timeline };
    },
  },
];

const REFUSALS = ["TRANSACTION_REFUSED", "COMPLIANCE_VIOLATION", "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED"];

// The payer-action link in PayPal's answer to the shop's create call for this order, as the preload tagged it.
function payPalLinkFor(a: Adapter, ppOrderId: string): string | undefined {
  if (!fs.existsSync(a.ppLogFile)) return undefined;
  for (const l of fs.readFileSync(a.ppLogFile, "utf8").split("\n").filter(Boolean).reverse()) {
    try { const x = JSON.parse(l); if (x.tagged?.orderId === ppOrderId) return x.tagged.href; } catch {}
  }
  return undefined;
}

async function capturesOf(ppOrderId: string): Promise<string[]> {
  const g = await pp("GET", `/v2/checkout/orders/${ppOrderId}`);
  return (g.json?.purchase_units ?? []).flatMap((u: any) => (u?.payments?.captures ?? []).map((c: any) => c.id));
}

// A genuine delivery the site's listener kept for this run (live re-run only): PayPal's signed headers and raw body.
export function findKept(type: string, captureId: string | undefined): { eventId: string; headers: Record<string, string>; raw: string } | undefined {
  const dir = process.env.CP_WEBHOOK_LOG;
  if (!dir || !captureId || !fs.existsSync(dir)) return undefined;
  for (const f of fs.readdirSync(dir)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const ev = JSON.parse(d.raw);
      const about = ev.resource?.id === captureId || (ev.resource?.links ?? []).some((l: any) => l.rel === "up" && String(l.href).endsWith(`/captures/${captureId}`));
      if (ev.event_type === type && about) return { eventId: ev.id, headers: d.headers, raw: d.raw };
    } catch {}
  }
  return undefined;
}
async function keptDelivery(type: string, captureId: string | undefined, ms: number) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 1500))) {
    const d = findKept(type, captureId);
    if (d || Date.now() > end) return d;
  }
}

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);
export const _fs = fs;
