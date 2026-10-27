import fs from "node:fs";
import path from "node:path";
// PayPal webhook listener for M4 (scenarios 12 and 14: a forged event is rejected, PAYMENT.CAPTURE.COMPLETED flips a
// pending order). Verification is PayPal's own: POST /v1/notifications/verify-webhook-signature with the five
// transmission headers, our webhook ID and the raw event. It fails closed: no webhook ID, no credentials, a missing
// header, a non-sandbox environment, an error or anything but "SUCCESS" means the event is not accepted.
export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

export type WebhookOutcome =
  | { status: "not-configured"; http: 503; why: string }
  | { status: "rejected"; http: 400; why: string }
  | { status: "error"; http: 502; why: string }
  | { status: "busy"; http: 429; why: string }
  | { status: "verified"; http: 200; eventId: string; eventType: string };

export interface WebhookEnv { PAYPAL_ENVIRONMENT?: string; PAYPAL_CLIENT_ID?: string; PAYPAL_CLIENT_SECRET?: string; PAYPAL_WEBHOOK_ID?: string }

export function webhookConfig(env: WebhookEnv) {
  const missing = [
    env.PAYPAL_ENVIRONMENT !== "sandbox" && "PAYPAL_ENVIRONMENT=sandbox",
    !env.PAYPAL_CLIENT_ID && "PAYPAL_CLIENT_ID",
    !env.PAYPAL_CLIENT_SECRET && "PAYPAL_CLIENT_SECRET",
    !env.PAYPAL_WEBHOOK_ID && "PAYPAL_WEBHOOK_ID",
  ].filter(Boolean) as string[];
  return { configured: missing.length === 0, missing };
}

// One OAuth token per process until a minute before it expires, so a burst of forged POSTs costs one PayPal call each
// (the verify), not two. Keyed by client ID so a test with other credentials never reuses it.
let cached: { key: string; token: string; exp: number } | null = null;
export const _resetTokenCache = () => { cached = null; };
async function accessToken(env: WebhookEnv, fetchImpl: typeof fetch): Promise<string | WebhookOutcome> {
  if (cached && cached.key === env.PAYPAL_CLIENT_ID && cached.exp > Date.now()) return cached.token;
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const t = await fetchImpl(`${SANDBOX_API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(10_000) });
  if (!t.ok) return { status: "error", http: 502, why: `token: HTTP ${t.status}` };
  const j = (await t.json()) as any;
  cached = { key: String(env.PAYPAL_CLIENT_ID), token: String(j.access_token), exp: Date.now() + (Number(j.expires_in) || 600) * 1000 - 60_000 };
  return cached.token;
}

// PayPal signs with SHA256withRSA and serves its certs from its API hosts; anything else is refused before any call.
const CERT_HOSTS = new Set(["api.paypal.com", "api.sandbox.paypal.com", "api-m.paypal.com", "api-m.sandbox.paypal.com"]);

/** `allowCall` is asked once per POST that passed every local check, right before the PayPal calls: false answers 429
 *  (PayPal retries), so forged traffic can never make more PayPal calls than that budget allows. */
export async function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, env: WebhookEnv, fetchImpl: typeof fetch = fetch, allowCall: () => boolean = () => true): Promise<WebhookOutcome> {
  const cfg = webhookConfig(env);
  if (!cfg.configured) return { status: "not-configured", http: 503, why: `webhook listener not configured (missing ${cfg.missing.join(", ")})` };
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const absent = HEADERS.filter((k) => !h(k));
  if (absent.length) return { status: "rejected", http: 400, why: `missing ${absent.join(", ")}` };
  // PayPal serves its signing certs from its own domains only; anything else is a forgery attempt.
  try { const u = new URL(h("paypal-cert-url")!); if (u.protocol !== "https:" || !CERT_HOSTS.has(u.hostname)) return { status: "rejected", http: 400, why: "cert URL is not on PayPal's API host" }; }
  catch { return { status: "rejected", http: 400, why: "cert URL is not a URL" }; }
  if (h("paypal-auth-algo") !== "SHA256withRSA") return { status: "rejected", http: 400, why: "unknown signing algorithm" };
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return { status: "rejected", http: 400, why: "body is not JSON" }; }
  if (!event?.id || !event?.event_type) return { status: "rejected", http: 400, why: "body is not a webhook event" };
  if (!allowCall()) return { status: "busy", http: 429, why: "too many deliveries to verify right now; PayPal retries later" };
  try {
    const token = await accessToken(env, fetchImpl);
    if (typeof token !== "string") return token;
    // The raw event is embedded as-is: re-serialising it could change bytes the signature covers.
    const body = `{"auth_algo":${JSON.stringify(h("paypal-auth-algo"))},"cert_url":${JSON.stringify(h("paypal-cert-url"))},"transmission_id":${JSON.stringify(h("paypal-transmission-id"))},"transmission_sig":${JSON.stringify(h("paypal-transmission-sig"))},"transmission_time":${JSON.stringify(h("paypal-transmission-time"))},"webhook_id":${JSON.stringify(env.PAYPAL_WEBHOOK_ID)},"webhook_event":${rawBody}}`;
    const v = await fetchImpl(`${SANDBOX_API}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
    if (!v.ok) return { status: "error", http: 502, why: `verify: HTTP ${v.status}` };
    const res = (await v.json()) as any;
    if (res?.verification_status !== "SUCCESS") return { status: "rejected", http: 400, why: `PayPal says ${String(res?.verification_status ?? "nothing")}` };
    return { status: "verified", http: 200, eventId: String(event.id), eventType: String(event.event_type) };
  } catch {
    return { status: "error", http: 502, why: "could not reach PayPal to verify" };
  }
}

// While a re-run is going, the shop under test owns the orders: every verified delivery (repeats included, since the
// shop's own idempotency is what the proof checks) is passed on with PayPal's headers and the raw body, and the shop
// verifies it again itself. Returns the shop's HTTP status, or 0 when it could not be reached.
export async function forwardToShop(url: string, headers: Record<string, string | string[] | undefined>, rawBody: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...paypalHeaders(headers) };
  try { return (await fetchImpl(url, { method: "POST", headers: h, body: rawBody, signal: AbortSignal.timeout(20_000) })).status; }
  catch { return 0; }
}

// Keeps the first delivery of each event for the running proof (headers PayPal signed with, raw body).
export function keepDelivery(dir: string, eventId: string, headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const file = path.join(dir, `${eventId.replace(/[^\w-]/g, "_")}.json`);
  if (fs.existsSync(file)) return;
  const h = paypalHeaders(headers);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ headers: h, raw: rawBody }));
}

/** PayPal's five transmission headers only (what the shop needs to verify a delivery again; nothing secret). */
export function paypalHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of HEADERS) { const v = headers[k]; if (v) h[k] = Array.isArray(v) ? v[0] : v; }
  return h;
}
