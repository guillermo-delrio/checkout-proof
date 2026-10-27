// Shared sandbox helpers for spikes 2 and 3. Loads credentials from checkout-proof/.env and never prints them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") throw new Error("sandbox only");
export const API = "https://api-m.sandbox.paypal.com";
export const OUT = path.join(ROOT, "out/s3");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
const PASS = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
export const scrub = (s) => {
  let t = String(s);
  for (const v of [PASS, EMAIL, process.env.PAYPAL_CLIENT_SECRET, process.env.PAYPAL_CLIENT_ID]) if (v) t = t.replaceAll(v, "***");
  return t;
};

let tok = null;
export async function token() {
  if (tok && tok.exp > Date.now()) return tok.v;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json();
  tok = { v: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tok.v;
}

export async function call(method, p, body, headers = {}) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, debugId: r.headers.get("paypal-debug-id"), json };
}

export const getOrder = (id) => call("GET", `/v2/checkout/orders/${id}`);
export const getPaymentV1 = (id) => call("GET", `/v1/payments/payment/${id}`);

export function summarizeOrder(o) {
  const pu = o.purchase_units?.[0] || {};
  const cap = pu.payments?.captures?.[0];
  return {
    id: o.id, status: o.status, amount: pu.amount ? `${pu.amount.value} ${pu.amount.currency_code}` : undefined,
    custom_id: pu.custom_id, capture: cap ? { id: cap.id, status: cap.status, amount: `${cap.amount.value} ${cap.amount.currency_code}` } : null,
  };
}

// Buyer approval on a PayPal-hosted page (redirect flow). Login selectors adapted from spikes/s1-buyer/buyer.mjs.
export async function approve(browser, url, opts = {}) {
  const ctx = await browser.newContext({ locale: "en-US" });
  const p = await ctx.newPage();
  await p.goto(url);
  const r = await approveOn(p, opts);
  if (r.ok) return { ...r, ctx };
  await ctx.close();
  return r;
}

// Same, on a page that is already on (or redirecting to) PayPal's hosted approval page.
export async function approveOn(p, { until = /localhost|example\.com/, shotName, cancel = false } = {}) {
  const steps = [];
  try {
    const deadline = Date.now() + 90000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      if (until.test(p.url())) break;
      const txt = (await p.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
      if (/security challenge|i'm not a robot|captcha/.test(txt)) throw new Error("captcha");
      try {
        if (cancel) {
          const c = p.locator('[data-testid="cancel-link"], a:text-matches("cancel(ar)? (and return|y volver)", "i"), button:text-matches("cancel(ar)? (and return|y volver)", "i")');
          if (await c.first().isVisible({ timeout: 500 })) { steps.push("cancel"); await c.first().click(); await p.waitForURL(until, { timeout: 30000 }); break; }
        }
        const submit = p.locator('#payment-submit-btn, [data-testid="submit-button-initial"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue to Review Order"), #confirmButtonTop, button:text-matches("^(continue|continuar|pay now|pagar ahora|complete purchase|completar compra|agree and pay|aceptar y pagar|continuar y revisar pedido|continue to review order)", "i")');
        if (!cancel && (await submit.first().isVisible({ timeout: 500 }))) {
          steps.push("approve");
          if (shotName) await p.screenshot({ path: path.join(OUT, shotName), mask: [p.locator("input")] }).catch(() => {});
          await submit.first().click({ timeout: 5000 });
          await p.waitForURL(until, { timeout: 8000 }).catch(() => {});
          continue;
        }
        const email = p.locator("#email");
        const pass = p.locator("#password");
        if (!loggedIn && (await email.isVisible({ timeout: 500 }))) {
          await email.fill(EMAIL);
          await p.locator("#btnNext").click({ timeout: 5000 }).catch(() => {});
          await p.waitForTimeout(2500);
          await pass.fill(PASS, { timeout: 15000 });
          steps.push("login");
          await p.locator("#btnLogin").click({ timeout: 10000 });
          loggedIn = true;
          await p.waitForTimeout(3000);
          continue;
        }
      } catch (e) {
        steps.push("retry:" + scrub(e.message).split("\n")[0].slice(0, 50));
      }
      await p.waitForTimeout(700);
    }
    if (!until.test(p.url())) throw new Error("timeout; at " + p.url().split("?")[0]);
    return { ok: true, finalUrl: p.url(), steps, page: p };
  } catch (e) {
    await p.screenshot({ path: path.join(OUT, `fail-${Date.now()}.png`), mask: [p.locator("input")] }).catch(() => {});
    return { ok: false, error: scrub(e.message), steps };
  }
}

export function log(file, rec) {
  fs.appendFileSync(path.join(OUT, file), JSON.stringify({ ...rec, at: new Date().toISOString() }) + "\n");
  console.log(JSON.stringify(rec));
}

// Local landing page for return_url/cancel_url (http://localhost:9999/return|cancel).
import http from "node:http";
export const returnServer = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<h1>${req.url.split("?")[0]}</h1>`); });
returnServer.listen(9999).on("error", () => {});
returnServer.unref();
