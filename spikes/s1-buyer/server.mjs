// Spike 1 server: Orders v2 (REST) + JS SDK v6 pages. Sandbox only. Never logs credentials.
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env"), quiet: true });

const { PAYPAL_CLIENT_ID: CID, PAYPAL_CLIENT_SECRET: SECRET } = process.env;
if (process.env.PAYPAL_ENVIRONMENT && !/sandbox/i.test(process.env.PAYPAL_ENVIRONMENT)) throw new Error("sandbox only");
const API = "https://api-m.sandbox.paypal.com";
const PORT = Number(process.env.S1_PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const basic = "Basic " + Buffer.from(`${CID}:${SECRET}`).toString("base64");

let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`oauth ${r.status} ${j.error}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

async function clientToken() {
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", response_type: "client_token", intent: "sdk_init" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`client token ${r.status} ${j.error}`);
  return j.access_token;
}

async function pp(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j, debugId: r.headers.get("paypal-debug-id") };
}

const captures = new Map(); // orderId -> {status, http, debugId, at}

async function createOrder({ redirect = false, amount = "1.00" } = {}) {
  const body = {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "EUR", value: amount }, description: "S1 spike" }],
  };
  if (redirect) {
    body.payment_source = {
      paypal: {
        experience_context: {
          return_url: `${ORIGIN}/return`,
          cancel_url: `${ORIGIN}/cancel`,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    };
  }
  const r = await pp("POST", "/v2/checkout/orders", body);
  if (r.status >= 300) throw new Error(`create ${r.status} ${r.json.name} ${r.debugId}`);
  const approve = (r.json.links || []).find((l) => l.rel === "approve" || l.rel === "payer-action");
  return { orderId: r.json.id, approveUrl: approve?.href };
}

async function capture(orderId) {
  const r = await pp("POST", `/v2/checkout/orders/${orderId}/capture`);
  const cap = r.json?.purchase_units?.[0]?.payments?.captures?.[0];
  const rec = {
    orderStatus: r.json.status ?? r.json.name,
    captureStatus: cap?.status ?? null,
    http: r.status,
    debugId: r.debugId,
    at: new Date().toISOString(),
  };
  captures.set(orderId, rec);
  return rec;
}

const page = (title, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>#card-number,#card-expiry,#card-cvv{height:56px;width:320px;margin:6px 0}</style></head><body>
<h1>${title}</h1><div id="buttons"><paypal-button id="pp" type="pay" hidden></paypal-button></div>
<div id="cards" hidden><div id="card-number"></div><div id="card-expiry"></div><div id="card-cvv"></div>
<button id="pay-card">Pay by card</button></div>
<pre id="status">loading</pre>
<script>
const $s = (t) => { document.getElementById("status").textContent = t; document.body.dataset.state = t; };
async function createOrder() { const r = await fetch("/api/orders", { method: "POST" }); const j = await r.json(); window.__orderId = j.orderId; return { orderId: j.orderId }; }
async function captureOrder(id) { const r = await fetch("/api/orders/" + id + "/capture", { method: "POST" }); const j = await r.json(); $s("CAPTURE " + j.captureStatus + " " + id); }
window.onerror = (m) => $s("ERROR " + m);
${script}
</script>
<script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" onload="boot().catch(e => $s('ERROR ' + (e.code||'') + ' ' + e.message))"></script>
</body></html>`;

const walletScript = `
async function boot() {
  const { clientToken } = await (await fetch("/api/client-token")).json();
  const sdk = await window.paypal.createInstance({ clientToken, components: ["paypal-payments"], pageType: "checkout" });
  const methods = await sdk.findEligibleMethods({ currencyCode: "EUR" });
  if (!methods.isEligible("paypal")) return $s("ERROR paypal not eligible");
  const mode = new URLSearchParams(location.search).get("mode") || "auto";
  const session = sdk.createPayPalOneTimePaymentSession({
    onApprove: async (d) => { $s("APPROVED " + d.orderId); await captureOrder(d.orderId); },
    onCancel: () => $s("CANCELLED"),
    onError: (e) => $s("ERROR " + (e.code||"") + " " + e.message),
  });
  if (session.hasReturned && session.hasReturned()) { $s("RESUMING"); await session.resume(); return; }
  const btn = document.getElementById("pp"); btn.hidden = false;
  btn.addEventListener("click", async () => { $s("STARTED"); await session.start({ presentationMode: mode }, createOrder()); });
  $s("READY");
}`;

const cardScript = `
async function boot() {
  const { clientToken } = await (await fetch("/api/client-token")).json();
  const sdk = await window.paypal.createInstance({ clientToken, components: ["card-fields"], pageType: "checkout" });
  const methods = await sdk.findEligibleMethods({ currencyCode: "EUR" });
  if (!methods.isEligible("advanced_cards")) $s("WARN advanced_cards not eligible; trying anyway");
  const cs = sdk.createCardFieldsOneTimePaymentSession();
  document.getElementById("cards").hidden = false;
  document.querySelector("#card-number").appendChild(cs.createCardFieldsComponent({ type: "number", placeholder: "Card number" }));
  document.querySelector("#card-expiry").appendChild(cs.createCardFieldsComponent({ type: "expiry", placeholder: "MM/YY" }));
  document.querySelector("#card-cvv").appendChild(cs.createCardFieldsComponent({ type: "cvv", placeholder: "CVV" }));
  document.getElementById("pay-card").addEventListener("click", async () => {
    $s("SUBMITTING");
    const { orderId } = await createOrder();
    const { data, state } = await cs.submit(orderId, { billingAddress: { postalCode: "28001", countryCode: "ES" } });
    if (state === "succeeded") { $s("CARD_OK " + (data.liabilityShift||"")); await captureOrder(data.orderId || orderId); }
    else $s("CARD_" + state + " " + (data && data.message || ""));
  });
  $s("READY");
}`;

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page("S1 wallet", walletScript), "text/html");
      if (req.method === "GET" && url.pathname === "/cards") return send(res, 200, page("S1 cards", cardScript), "text/html");
      if (url.pathname === "/api/client-token") return send(res, 200, { clientToken: await clientToken() });
      if (req.method === "POST" && url.pathname === "/api/orders") return send(res, 200, await createOrder());
      if (req.method === "POST" && url.pathname === "/api/orders/redirect")
        return send(res, 200, await createOrder({ redirect: true }));
      let m = url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/);
      if (req.method === "POST" && m) return send(res, 200, await capture(m[1]));
      m = url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/status$/);
      if (m) return send(res, 200, captures.get(m[1]) ?? {});
      if (url.pathname === "/return") {
        const rec = await capture(url.searchParams.get("token"));
        return send(res, 200, `<pre id="status">CAPTURE ${rec.captureStatus} ${url.searchParams.get("token")}</pre>`, "text/html");
      }
      if (url.pathname === "/cancel") return send(res, 200, `<pre id="status">CANCELLED</pre>`, "text/html");
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: String(e.message).replaceAll(SECRET, "***") });
    }
  })
  .listen(PORT, () => console.log(`s1 server on ${ORIGIN}`));
