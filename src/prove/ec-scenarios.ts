// expressCart scenarios (SCENARIOS.md numbers in `ref`). Each one drives a real buyer session through the shop and
// names the shop order to judge; verdict() and the extra checks here decide. Same steps for both variants where the
// flows allow it: the original's "complete" is PayPal's redirect back to the shop, the upgrade's is its capture call.
import path from "node:path";
import { createForeignOrder, approveLink, call as pp, getOrder } from "../paypal/truth.ts";
import { RETURN_BASE, approveUrl, approveOn } from "../buyer/buyer.ts";
import { buyerApproves } from "../targets/simple-clothing-store.ts";
import type { EcAdapter, EcSession, Begin } from "../targets/expresscart.ts";
import type { Adapter, ShopCall } from "../targets/types.ts";
import type { Facts, Scenario } from "./scenarios.ts";
import { HarnessError } from "./errors.ts";

const CAP = "5-panel-camp-cap";       // €48.00 in expressCart's seed data
const BOOT = "ranger-boot";
const JACKET = "duckworth-jacket";

function clock() {
  const t0 = Date.now();
  const timeline: NonNullable<Facts["timeline"]> = [];
  return { timeline, mark: (step: string, shot?: string) => timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, step, ...(shot ? { shot } : {}) }) };
}

// Which shop order to judge: the one the shop marked paid; several paid orders for one cart is a failure itself.
async function judge(a: EcAdapter, ids: (string | undefined)[]) {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  const paid: string[] = [];
  for (const id of uniq) if ((await a.shopState(id)).paid) paid.push(id);
  return { id: paid[0] ?? uniq[uniq.length - 1], extra: paid.length > 1 ? [`${paid.length} shop orders marked paid for one cart: ${paid.join(", ")} (I5)`] : [] };
}

async function cartAt(a: EcAdapter, items: [string, number][]) {
  const s = await a.newSession();
  for (const [p, n] of items) await a.addToCart(s, p, n);
  await a.toPayment(s);
  return s;
}

// A crash during the scenario is the shop's failure; the runner gets a live shop back for the next scenario.
async function crashCheck(a: EcAdapter, notes: string[], extra: string[]) {
  const c = a.crashed();
  if (c) {
    extra.push(`${c}: the whole shop went down for every customer (E7)`);
    notes.push(`${c}; harness restarted it`);
    await a.ensureUp!();
  }
}

type Run = (a: EcAdapter, shotDir: string) => Promise<Facts>;
const sc = (id: string, title: string, ref: string, expect: "paid-once" | "not-paid", run: Run): Scenario =>
  ({ id, title, ref, expect, selfOrder: true, run: (a: Adapter, _id: string, shotDir: string) => run(a as EcAdapter, shotDir) });

const ppIds = (...bs: (Begin | undefined)[]) => bs.map((b) => b?.ppId).filter(Boolean) as string[];

export const EC_SCENARIOS: Scenario[] = [
  sc("happy", "Happy path, PayPal wallet", "#1", "paid-once", async (a, shotDir) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    calls.push(...(await a.pay(s, b, { shot: path.join(shotDir, "happy-approve.png") })));
    const extra: string[] = []; const notes = ["buyer approved and paid"];
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra] };
  }),

  sc("happy-ui", "Happy path through the shop's own v6 PayPal button", "#1", "paid-once", async (a, shotDir) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const notes: string[] = []; const calls: ShopCall[] = [];
    let ppId: string | undefined; let shopOrderId: string | undefined;
    s.page.on("response", async (res) => {
      const u = new URL(res.url());
      if (u.origin !== a.baseUrl || !u.pathname.startsWith("/paypal/")) return;
      const body = await res.json().catch(() => undefined);
      if (u.pathname === "/paypal/orders" && body?.id) { ppId = body.id; shopOrderId = body.orderId && String(body.orderId); }
      calls.push({ step: `browser → ${res.request().method()} ${u.pathname.replace(/orders\/[A-Z0-9]+/, "orders/:id")}`, http: res.status(), body });
    });
    const errors: string[] = [];
    s.page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    await s.page.reload();
    const btn = s.page.locator("paypal-button");
    await btn.first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    if (!(await btn.first().isVisible().catch(() => false))) {
      await a.shot(s, path.join(shotDir, "happy-ui-no-button.png"));
      await a.closeSession(s);
      return { ppOrders: [], calls, notes: ["the payment page shows no <paypal-button>", ...errors.slice(0, 5).map((e) => "console: " + e)], extraReasons: ["no v6 <paypal-button> on /checkout/payment"] };
    }
    await a.shot(s, path.join(shotDir, "happy-ui-1-button.png"));
    const popupP = s.ctx.waitForEvent("page", { timeout: 20000 }).catch(() => null);
    await btn.first().click();
    const popup = await popupP;
    notes.push(popup ? "PayPal opened in a popup" : "PayPal opened in the same page");
    const r = await approveOn(popup || s.page, {
      until: new RegExp(a.baseUrl.replace(/[/.:]/g, "\\$&")), shotPath: path.join(shotDir, "happy-ui-2-paypal.png"),
      done: async () => !!ppId && ["APPROVED", "COMPLETED"].includes((await getOrder(ppId)).json?.status),
    });
    notes.push(`buyer: ${r.ok ? "approved" : "failed: " + r.error} (${r.steps.join(",")})`);
    if (!r.ok && !calls.some((c) => c.step.includes("/capture"))) { await a.closeSession(s); throw new HarnessError(`sandbox buyer: ${r.error}`); }
    for (let i = 0; i < 30 && !(shopOrderId && (await a.shopState(shopOrderId)).paid); i++) await new Promise((x) => setTimeout(x, 1000));
    await s.page.waitForTimeout(1500);
    await a.shot(s, path.join(shotDir, "happy-ui-3-after.png"));
    const extra: string[] = [];
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    return { ppOrders: ppId ? [ppId] : [], calls, notes: [...notes, ...errors.slice(0, 5).map((e) => "console: " + e)], shopOrderId, extraReasons: extra };
  }),

  // E1, the hero: an honest buyer cancels a big cart at PayPal, shrinks it, pays the small total.
  sc("cancel-shrink", "Cancel at PayPal, shrink the cart, pay the smaller total (E1)", "#3 + #11b", "paid-once", async (a, shotDir) => {
    const { timeline, mark } = clock();
    const shot = async (s: EcSession, n: string, step: string) => { const f = `e1-${n}.png`; await a.shot(s, path.join(shotDir, f)); mark(step, `shots/${f}`); };
    const s = await a.newSession();
    mark("open the shop in a fresh browser");
    await a.addToCart(s, BOOT, 4);
    await a.addToCart(s, JACKET, 4);
    mark("add 4x Ranger boot and 4x Duckworth jacket to the cart");
    await a.toPayment(s);
    const cart1 = await a.sessionInfo(s);
    await shot(s, "1-payment-big-cart", `checkout: shipping details, payment page shows ${cart1.total}`);
    const b1 = await a.begin(s);
    const pay = a.variant === "original" ? "click Pay with PayPal" : "checkout calls POST /paypal/orders (what the v6 button calls)";
    mark(`${pay}: ${b1.ppId ?? "no PayPal id"} created for ${cart1.total}; shop order ${b1.shopOrderId ?? "(none yet)"}`);
    const calls: ShopCall[] = [b1.call];
    calls.push(...(await a.cancel(s, b1, path.join(shotDir, "e1-2-paypal-cancel.png"))));
    if (a.variant === "original") mark("buyer cancels at PayPal and is sent back to the shop", "shots/e1-2-paypal-cancel.png");
    else mark("buyer closes the PayPal window without paying");
    await a.shrinkCart(s);
    await shot(s, "3-cart-shrunk", "buyer removes the boots and lowers the jackets to 1");
    await a.toPayment(s);
    const cart2 = await a.sessionInfo(s);
    await shot(s, "4-payment-small-cart", `payment page now shows ${cart2.total}`);
    const b2 = await a.begin(s);
    mark(`${pay} again: ${b2.ppId ?? "no PayPal id"} for ${cart2.total}; shop order ${b2.shopOrderId ?? "(none)"}`);
    calls.push(b2.call);
    calls.push(...(await a.pay(s, b2, { shot: path.join(shotDir, "e1-5-paypal-approve.png") })));
    mark(`buyer logs in and pays ${cart2.total} at PayPal`, "shots/e1-5-paypal-approve.png");
    await shot(s, "6-return", "back at the shop: payment result page");
    const notes = [`first cart ${cart1.total} (${cart1.items} items), cancelled at PayPal; paid cart ${cart2.total} (${cart2.items} items)`];
    const extra: string[] = [];
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b1.shopOrderId, b2.shopOrderId]);
    const oi = j.id ? await a.orderItems(j.id) : null;
    const st = j.id ? await a.shopState(j.id) : null;
    if (oi && st?.paid && (oi.total !== cart2.total || oi.items !== cart2.items))
      extra.push(`order ${j.id} is marked ${st.rawStatus} but holds ${oi.lines.join(" + ")} (${oi.total}); the cart the buyer paid for was ${cart2.items} item(s), ${cart2.total} (E1)`);
    if (oi) notes.push(`shop order ${j.id}: ${st?.rawStatus}, ${oi.lines.join(" + ")}, total ${oi.total}`);
    if (j.id && a.screenshotOrder) { await a.screenshotOrder(j.id, path.join(shotDir, "e1-7-admin-order.png")); mark(`shop admin: order ${j.id} is ${st?.rawStatus}, total ${oi?.total}, ${oi?.lines.join(" + ")}`, "shots/e1-7-admin-order.png"); }
    await a.closeSession(s);
    return { ppOrders: ppIds(b1, b2), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra], timeline };
  }),

  sc("unapproved", "Complete a payment the buyer never approved", "#7a", "not-paid", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    if (a.variant === "original") {
      // Straight to the return URL with a made-up payer, as a bug or a tampering client could.
      const r = await s.page.goto(`${a.baseUrl}/paypal/checkout_return?paymentId=${b.ppId}&token=EC-0000000000000000&PayerID=ABCDEFGHIJKLM`).catch(() => null);
      await s.page.waitForTimeout(1500);
      calls.push({ step: "GET /paypal/checkout_return with no approval (made-up PayerID)", http: s.returnResults.at(-1)?.http ?? r?.status() ?? 0, body: { landed: s.page.url().replace(a.baseUrl, "") } });
    } else if (b.ppId) calls.push(...(await a.capture(s, b.ppId)));
    const notes = ["buyer never approved"]; const extra: string[] = [];
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: b.shopOrderId, extraReasons: extra };
  }),

  sc("declined-retry", "Declined instrument, then a retry that works", "#5", "paid-once", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b1 = await a.begin(s);
    const calls: ShopCall[] = [b1.call];
    calls.push(...(await a.pay(s, b1, { mockCode: "INSTRUMENT_DECLINED" })));
    const notes = ["first completion mocked INSTRUMENT_DECLINED"]; const extra: string[] = [];
    await crashCheck(a, notes, extra);
    let b2: Begin | undefined;
    if (a.variant === "original") {
      // The redirect flow has no restart: the buyer goes back to checkout and pays again.
      await a.toPayment(s);
      b2 = await a.begin(s);
      calls.push(b2.call, ...(await a.pay(s, b2)));
      notes.push("buyer went back to checkout and paid again");
    } else { calls.push(...(await a.retry(s, b1))); notes.push("capture retried unmocked"); }
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b1.shopOrderId, b2?.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b1, b2), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra] };
  }),

  // E7: the buyer reloads the return page (original); the upgrade gets a double click and a third call.
  sc("duplicate", "Duplicate completion (reload of the return page / double click)", "#8a", "paid-once", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    const notes: string[] = []; const extra: string[] = [];
    if (a.variant === "original") {
      calls.push(...(await a.pay(s, b)));
      calls.push(...(await a.retry(s, b)));
      notes.push("buyer paid, then reloaded the PayPal return page");
    } else if (b.ppId) {
      const r = await buyerApproves(b.ppId);
      if (!r.ok) throw new HarnessError(`sandbox buyer could not approve ${b.ppId}: ${r.error}`);
      const [c1, c2] = await Promise.all([a.capture(s, b.ppId), a.capture(s, b.ppId)]);
      calls.push(...c1, ...c2, ...(await a.capture(s, b.ppId)));
      notes.push("two concurrent captures, then a third");
    }
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra] };
  }),

  sc("server-error-retry", "PayPal 500 on completion, then a retry", "#9b", "paid-once", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b1 = await a.begin(s);
    const calls: ShopCall[] = [b1.call];
    calls.push(...(await a.pay(s, b1, { mockCode: "INTERNAL_SERVER_ERROR" })));
    const allow5xx = calls.map((c, i) => (c.http >= 500 ? i : -1)).filter((i) => i >= 0);
    const notes = ["first completion mocked INTERNAL_SERVER_ERROR (a 5xx passed through is allowed)"]; const extra: string[] = [];
    await crashCheck(a, notes, extra);
    let b2: Begin | undefined;
    if (a.variant === "original") {
      await a.toPayment(s);
      b2 = await a.begin(s);
      calls.push(b2.call, ...(await a.pay(s, b2)));
      notes.push("buyer went back to checkout and paid again");
    } else { calls.push(...(await a.retry(s, b1))); notes.push("capture retried unmocked"); }
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b1.shopOrderId, b2?.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b1, b2), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra], allow5xx };
  }),

  sc("lost-response", "Completion succeeds at PayPal, its response is lost, then a retry", "#9a", "paid-once", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    calls.push(...(await a.pay(s, b, { drop: true })));
    const allow5xx = calls.map((c, i) => (c.http >= 500 ? i : -1)).filter((i) => i >= 0);
    const notes = ["PayPal processed the first completion; its response was dropped before the shop's code saw it"]; const extra: string[] = [];
    await crashCheck(a, notes, extra);
    calls.push(...(await a.retry(s, b)));
    notes.push(a.variant === "original" ? "buyer reloaded the return page" : "capture retried");
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra], allow5xx };
  }),

  ...(["currency", "amount"] as const).map((kind) => sc(kind, kind === "currency" ? "Foreign PayPal order (same amount, cheaper currency MXN) handed to the shop" : "Foreign PayPal order (lower amount 1.00) handed to the shop", "#11a", "not-paid", async (a, shotDir) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    const notes: string[] = [];
    const st = await a.shopState(b.shopOrderId ?? "");
    const [v, c] = st.rawStatus === "no order" ? ["48.00", "EUR"] : [String(st.total.minor / 100), st.total.currency];
    const value = kind === "amount" ? "1.00" : Number(v).toFixed(2); const cur = kind === "currency" ? "MXN" : c;
    const o = await createForeignOrder(b.shopOrderId ?? "x", value, cur, RETURN_BASE);
    notes.push(`attacker created ${o.json?.id} for ${value} ${cur} with custom_id ${b.shopOrderId} (debug ${o.debugId})`);
    const r = await approveUrl(approveLink(o.json)!, { until: /localhost:9999/, shotPath: path.join(shotDir, `approve-${o.json?.id}.png`) });
    if (!r.ok) throw new HarnessError(`sandbox buyer could not approve attacker order ${o.json?.id}: ${r.error}`);
    const cap = await pp("POST", `/v2/checkout/orders/${o.json?.id}/capture`, {});
    const cp = cap.json?.purchase_units?.[0]?.payments?.captures?.[0];
    notes.push(`attacker captured: HTTP ${cap.status}, capture ${cp?.id} ${cp?.status} ${cp?.amount?.value} ${cp?.amount?.currency_code}`);
    calls.push(...(await a.capture(s, o.json?.id)));
    const extra: string[] = [];
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    return { ppOrders: [o.json?.id], calls, notes, attack: true, shopOrderId: b.shopOrderId, extraReasons: extra };
  })),

  sc("two-tabs", "Two checkouts for one cart (two tabs), both approved", "#8", "paid-once", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const notes: string[] = []; const extra: string[] = [];
    const calls: ShopCall[] = [];
    let b1: Begin, b2: Begin;
    if (a.variant === "original") {
      const tabB: EcSession = Object.assign(Object.create(s), { page: await s.ctx.newPage() }) as EcSession;
      b1 = await a.begin(s);
      await tabB.page.goto(`${a.baseUrl}/checkout/payment`);
      b2 = await a.begin(tabB);
      calls.push(b1.call, b2.call);
      calls.push(...(await a.pay(s, b1)));
      calls.push(...(await a.pay(tabB, b2)));
      notes.push("tab A and tab B each went to PayPal; the buyer approved A, then B");
    } else {
      b1 = await a.begin(s);
      b2 = await a.begin(s);
      calls.push(b1.call, b2.call);
      for (const b of [b1, b2]) if (b.ppId) { const r = await buyerApproves(b.ppId); if (!r.ok) throw new HarnessError(`sandbox buyer could not approve ${b.ppId}: ${r.error}`); }
      const [r1, r2] = await Promise.all([b1, b2].map((b) => (b.ppId ? a.capture(s, b.ppId) : Promise.resolve([]))));
      calls.push(...r1, ...r2);
      notes.push("both tabs approved, then both captured at the same time");
    }
    await crashCheck(a, notes, extra);
    const j = await judge(a, [b1.shopOrderId, b2.shopOrderId]);
    await a.closeSession(s);
    return { ppOrders: ppIds(b1, b2), calls, notes, shopOrderId: j.id, extraReasons: [...j.extra, ...extra] };
  }),

  sc("create-refused", "PayPal refuses to create the payment", "#4", "not-paid", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    if (a.variant === "original") a.mock("/v1/payments/payment", "TRANSACTION_REFUSED", "POST");
    else a.mock("/v2/checkout/orders", "PAYER_CANNOT_PAY", "POST");
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    const alive = await fetch(`${a.baseUrl}/`).then((r) => r.status).catch(() => 0);
    calls.push({ step: "GET / (shop still serving)", http: alive });
    const notes = [`create answered ${b.call.http}${b.ppId ? ", but the buyer was sent to pay " + b.ppId : ""}`];
    const extra: string[] = [];
    if (a.variant === "upgraded" && b.call.http < 400) notes.push("expected a 4xx with the debug_id to reach the browser");
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: b.shopOrderId, extraReasons: extra };
  }),

  // Labelled synthetic (SCENARIOS #11b, review r2 N5): the shop's own PayPal order, really paid in full, while the
  // harness tells the shop's server that PayPal took another currency or a lower amount. Tests the shop's own money
  // check (a foreign order is refused before it). The real capture is refunded afterwards.
  ...(["currency-own", "amount-own"] as const).map((kind) => sc(kind, kind === "currency-own" ? "PayPal reports a cheaper currency (MXN) for the shop's own order (SIMULATED)" : "PayPal reports a lower amount (1.00) for the shop's own order (SIMULATED)", "#11b", "not-paid", async (a) => {
    const spec = kind === "currency-own" ? { currency: "MXN" } : { value: "1.00" };
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    a.rewriteMoney(spec);
    try { calls.push(...(await a.pay(s, b))); } finally { a.rewriteMoney(null); }
    const told = spec.currency ? `currency ${spec.currency}` : `amount ${spec.value}`;
    const notes = [`SIMULATED: while the shop completed ${b.ppId}, PayPal's answers to the shop's server reported ${told} for the order and its capture; PayPal's real record is unchanged`];
    const extra: string[] = [];
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    const after = async () => {
      const out: string[] = [];
      if (!b.ppId) return out;
      const g = await pp("GET", `/v2/checkout/orders/${b.ppId}`);
      for (const c of (g.json?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []).filter((c: any) => c.status === "COMPLETED")) {
        const rf = await pp("POST", `/v2/payments/captures/${c.id}/refund`, {}, { "PayPal-Request-Id": `cp-refund-${c.id}` });
        out.push(`harness refunded the real capture ${c.id} (${c.amount?.value} ${c.amount?.currency_code}) afterwards to keep the sandbox buyer's balance: HTTP ${rf.status}, refund ${rf.json?.id} ${rf.json?.status}`);
      }
      return out;
    };
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: b.shopOrderId, extraReasons: extra, attack: true, simulated: spec, after };
  })),

  // Labelled synthetic (SCENARIOS #10 option b): PayPal's real answer is rewritten to a PENDING capture/sale before
  // the shop sees it. A correct shop keeps the order unpaid ("awaiting payment") until the capture completes.
  sc("pending-simulated", "Pending capture (SIMULATED: the harness rewrites PayPal's answer to PENDING)", "#10 (simulated)", "not-paid", async (a) => {
    const s = await cartAt(a, [[CAP, 1]]);
    const b = await a.begin(s);
    const calls: ShopCall[] = [b.call];
    a.rewritePending(true);
    try { calls.push(...(await a.pay(s, b))); } finally { a.rewritePending(false); }
    const notes = ["SIMULATED: every PayPal response the shop received after approval had its COMPLETED capture / completed sale rewritten to PENDING (reason RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION) by the test harness; PayPal's real record shows the money captured"];
    const extra: string[] = [];
    await crashCheck(a, notes, extra);
    await a.closeSession(s);
    return { ppOrders: ppIds(b), calls, notes, shopOrderId: b.shopOrderId, extraReasons: extra, simulated: "pending" };
  }),
];
