// simple-clothing-store before-code: D1 (confirm without payment), D2 (currency), D5 (double confirm).
// Usage: node scs-defects.mjs <appPort> <case...>   cases: d1-created d1-approved d2-currency d5-double happy
import path from "node:path";
import { chromium } from "playwright";
import { call, getOrder, approve, summarizeOrder, log, OUT } from "./pp.mjs";
const port = process.argv[2]; const cases = process.argv.slice(3);
const APP = `http://localhost:${port}`;
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
async function draft(variant = 102) {
  const r = await fetch(`${APP}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Buyer", email: "buyer@example.com", phone: "600000000", address: "Calle 1", country: "ES", city: "Madrid", state: "", zip: "28001", cart: { items: [{ id: variant }], discountCode: "" } }) });
  const id = await r.text();
  const o = await j(await fetch(`${APP}/api/orders/${id}`));
  return { id, total: o.retail_costs.total, currency: o.retail_costs.currency, status: o.status };
}
const shopStatus = async (id) => (await j(await fetch(`${APP}/api/orders/${id}`))).status;
async function ppOrder(d, { currency = d.currency, value = d.total, redirect = false } = {}) {
  const body = { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: currency, value }, description: `Payment for your order ${d.id}`, custom_id: `${d.id}` }] };
  if (redirect) body.payment_source = { paypal: { experience_context: { return_url: "http://localhost:9999/return", cancel_url: "http://localhost:9999/cancel", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } };
  const r = await call("POST", "/v2/checkout/orders", body);
  return r.json;
}
const confirm = async (ppid) => (await fetch(`${APP}/api/confirm/${ppid}`, { method: "POST" })).status;
let browser;
const br = async () => (browser ||= await chromium.launch({ headless: true }));
for (const c of cases) {
  const d = await draft();
  const rec = { target: "simple-clothing-store", port, case: c, shopOrder: d.id, shopTotal: `${d.total} ${d.currency}`, shopStatusBefore: d.status };
  if (c === "d1-created") {
    const o = await ppOrder(d);
    rec.paypalOrder = o.id; rec.confirmHttp = await confirm(o.id);
  } else if (c === "d1-approved" || c === "happy" || c === "d5-double") {
    const o = await ppOrder(d, { redirect: true });
    rec.paypalOrder = o.id;
    const a = await approve(await br(), o.links.find((l) => l.rel === "payer-action" || l.rel === "approve").href, { until: /localhost:9999\// });
    rec.approved = a.ok; if (!a.ok) rec.approveError = a.error; else await a.ctx.close();
    if (c !== "d1-approved") { const cap = await call("POST", `/v2/checkout/orders/${o.id}/capture`, {}); rec.captureHttp = cap.status; }
    rec.confirmHttp = await confirm(o.id);
    if (c === "d5-double") rec.confirmHttp2 = await confirm(o.id);
  } else if (c === "d2-currency") {
    const cur = process.env.D2_CURRENCY || "MXN";
    const o = await ppOrder(d, { currency: cur, redirect: true });
    rec.paypalOrder = o.id; rec.paidCurrency = cur;
    const a = await approve(await br(), o.links.find((l) => l.rel === "payer-action" || l.rel === "approve").href, { until: /localhost:9999\//, shotName: `scs-d2-approve-${o.id}.png` });
    rec.approved = a.ok; if (!a.ok) rec.approveError = a.error; else await a.ctx.close();
    const cap = await call("POST", `/v2/checkout/orders/${o.id}/capture`, {}); rec.captureHttp = cap.status;
    rec.confirmHttp = await confirm(o.id);
  }
  rec.shopStatusAfter = await shopStatus(d.id);
  rec.paypal = summarizeOrder((await getOrder(rec.paypalOrder)).json);
  if (process.env.SHOTS) {
    const pg = await (await br()).newPage();
    await pg.goto(`${APP}/order/${d.id}`); await pg.waitForTimeout(2500);
    rec.screenshot = `scs-${port}-${c}-${d.id}.png`;
    await pg.screenshot({ path: path.join(OUT, rec.screenshot), fullPage: true });
    rec.shopPageBadge = (await pg.locator("h2").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    await pg.close();
  }
  log("scs.jsonl", rec);
}
if (browser) await browser.close();
