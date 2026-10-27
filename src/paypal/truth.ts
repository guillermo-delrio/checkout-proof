// The CLI's own sandbox REST client: PayPal's truth (GET order) and the attacker's calls. Never the shop's client.
import { addSecret, requireSandbox } from "../env.ts";
import { HarnessError } from "../prove/errors.ts";

export const API = "https://api-m.sandbox.paypal.com";
let tok: { v: string; exp: number } | null = null;

async function token(): Promise<string> {
  requireSandbox();
  if (tok && tok.exp > Date.now()) return tok.v;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new HarnessError(`token: HTTP ${r.status}`);
  const d: any = await r.json();
  addSecret(d.access_token);
  tok = { v: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tok.v;
}

export interface PPResponse { status: number; debugId: string | null; json: any }

export async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<PPResponse> {
  let r: Response;
  // The harness's own PayPal calls: a network error here is never the shop's fault.
  try {
    r = await fetch(API + p, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) { throw new HarnessError(`PayPal ${method} ${p.split("?")[0]}: ${String(e?.message || e)}`); }
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, debugId: r.headers.get("paypal-debug-id"), json };
}

export const getOrder = (id: string) => call("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);

export const approveLink = (order: any): string | undefined =>
  order?.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;

// A PayPal order made outside the shop (attacker / tampering client), with a redirect so the buyer can approve it.
export async function createForeignOrder(customId: string, value: string, currency: string, returnBase: string) {
  return call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: currency, value }, description: `Payment for your order ${customId}`, custom_id: customId }],
    payment_source: { paypal: { experience_context: { return_url: `${returnBase}/return`, cancel_url: `${returnBase}/cancel`, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
  }, { "PayPal-Request-Id": `cp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
}

// v1 Payments (paypal-rest-sdk targets): GET /v1/payments/payment/{id}.
export const getPaymentV1 = (id: string) => call("GET", `/v1/payments/payment/${encodeURIComponent(id)}`);

// PayPal's view of any id the shop used: v1 payment ids start with PAYID-, everything else is an Orders v2 id.
export async function getTruthJson(id: string) {
  return id.startsWith("PAYID-") ? getPaymentV1(id) : getOrder(id);
}
