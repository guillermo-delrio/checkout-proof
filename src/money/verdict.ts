// Money invariants I1-I6 (DESIGN.md). Pure: the scenario runner gathers facts, this decides.
import { type Money, parseMoney, moneyEqual, formatMoney } from "./money.ts";

export interface Capture { id: string; status: string; amount: Money }
export interface PayPalTruth { orderId: string; status: string; customId?: string; captures: Capture[] }
export interface ShopState { shopOrderId: string; total: Money; paid: boolean; rawStatus: string }

// PayPal's view of one order from GET /v2/checkout/orders/{id}.
export function truthFromOrder(o: any): PayPalTruth {
  const pu = o?.purchase_units?.[0] ?? {};
  const caps = (o?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []);
  return {
    orderId: o?.id,
    status: o?.status,
    ...(pu.custom_id !== undefined ? { customId: String(pu.custom_id) } : {}),
    captures: caps.map((c: any) => ({ id: c.id, status: c.status, amount: parseMoney(c.amount.value, c.amount.currency_code) })),
  };
}

export interface VerdictInput {
  expect: "paid-once" | "not-paid";
  shop: ShopState;
  paypal: PayPalTruth[];          // every PayPal order the scenario touched for this shop order
  responses: number[];            // HTTP status of each call into the shop, in order
  allow5xx?: number[];            // indices where a 5xx is the scenario's injected fault, not the shop's
  attack?: boolean;               // PayPal orders were made by an attacker: their captures are not the shop's to fulfil
}
export interface Verdict { verdict: "PASS" | "FAIL"; reasons: string[] }

const describeOrders = (ts: PayPalTruth[]) =>
  ts.map((t) => `${t.orderId} ${t.status}${t.captures.length ? " [" + t.captures.map((c) => `${c.id} ${c.status} ${formatMoney(c.amount)}`).join(", ") + "]" : " (no capture)"}`).join("; ");

export function verdict(v: VerdictInput): Verdict {
  const reasons: string[] = [];
  const completed = v.paypal.flatMap((t) => t.captures.filter((c) => c.status === "COMPLETED"));
  const id = v.shop.shopOrderId;
  const total = formatMoney(v.shop.total);

  if (v.shop.paid) {
    if (completed.length === 0)
      reasons.push(`shop marked order ${id} paid; PayPal shows no completed capture: ${describeOrders(v.paypal)} (I2)`);
    else if (completed.length === 1 && !moneyEqual(completed[0].amount, v.shop.total))
      reasons.push(`shop marked order ${id} paid; PayPal captured ${formatMoney(completed[0].amount)}, shop total is ${total} (I3)`);
  } else if (completed.length > 0 && !v.attack) {
    reasons.push(`buyer was charged (${completed.map((c) => `${c.id} ${formatMoney(c.amount)}`).join(", ")}) but shop order ${id} is not confirmed (I4)`);
  }
  if (completed.length > 1)
    reasons.push(`${completed.length} completed captures for shop order ${id}: ${completed.map((c) => c.id).join(", ")} (I5)`);
  v.responses.forEach((s, i) => {
    if (s >= 500 && !(v.allow5xx ?? []).includes(i)) reasons.push(`shop answered ${s} (5xx) on call ${i + 1} (I5)`);
  });
  if (v.expect === "paid-once" && !v.shop.paid) reasons.push(`expected order ${id} paid once; it is ${v.shop.rawStatus} (I6)`);
  if (v.expect === "not-paid" && v.shop.paid) reasons.push(`expected order ${id} not paid; shop says ${v.shop.rawStatus} (I6)`);
  return { verdict: reasons.length ? "FAIL" : "PASS", reasons };
}

// A v1 payment as PayPalTruth: its sales play the part of captures (state completed/pending/denied → upper case).
export function truthFromPaymentV1(p: any): PayPalTruth {
  const sales = (p?.transactions ?? []).flatMap((t: any) => (t?.related_resources ?? []).map((r: any) => r?.sale).filter(Boolean));
  return {
    orderId: p?.id,
    status: String(p?.state ?? "").toUpperCase(),
    captures: sales.map((s: any) => ({ id: s.id, status: String(s.state).toUpperCase(), amount: parseMoney(s.amount.total, s.amount.currency) })),
  };
}

export const truthFromAny = (j: any): PayPalTruth => (String(j?.id ?? "").startsWith("PAYID-") ? truthFromPaymentV1(j) : truthFromOrder(j));

// Scenario 10 (pending capture), labelled synthetic: the harness told the shop the capture was PENDING, so the
// verdict judges against that world. Real PayPal records stay in the evidence next to it.
export const asPending = (t: PayPalTruth): PayPalTruth => ({ ...t, captures: t.captures.map((c) => (c.status === "COMPLETED" ? { ...c, status: "PENDING" } : c)) });

// Scenario 11b (amount/currency on the shop's own order), labelled synthetic: the shop was told PayPal took this value
// or currency for the order's completed captures, so the verdict judges against that world.
export const asTold = (t: PayPalTruth, told: { value?: string; currency?: string }): PayPalTruth => ({
  ...t, captures: t.captures.map((c) => (c.status === "COMPLETED" ? { ...c, amount: parseMoney(told.value ?? formatMoney(c.amount).split(" ")[0], told.currency ?? c.amount.currency) } : c)),
});
