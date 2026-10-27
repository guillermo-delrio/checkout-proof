// Spike 2: verify the toolkit-guided upgrade of simple-clothing-store (out/work/simple-clothing-store-doctor),
// running on http://localhost:3201 (DEMO=1, Printful stub, harness preload). Usage: node verify.mjs <step...>
//   ui:        v6 button renders; click it and try the wallet popup end to end
//   server:    happy path through the app's new endpoints (create -> redirect approval -> capture -> confirm)
//   d1:        confirm an unapproved order (scenario 7a)
//   d2:        create through the app's endpoint with a different currency, pay, confirm (scenario 11)
//   declined:  capture with PayPal-Mock-Response INSTRUMENT_DECLINED through the app's endpoint (scenario 5)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { approve, approveOn, getOrder, summarizeOrder, OUT, ROOT, log } from "../s3-defects/harness/pp.mjs";

const APP = "http://localhost:3201";
const S2OUT = path.join(ROOT, "out/s2");
fs.mkdirSync(S2OUT, { recursive: true });
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
async function draft() {
  const r = await fetch(`${APP}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Buyer", email: "buyer@example.com", phone: "600000000", address: "Calle 1", country: "ES", city: "Madrid", state: "", zip: "28001", cart: { items: [{ id: 102 }], discountCode: "" } }) });
  const id = await r.text();
  const o = await j(await fetch(`${APP}/api/orders/${id}`));
  return { id, total: o.retail_costs.total, currency: o.retail_costs.currency };
}
const shopStatus = async (id) => (await j(await fetch(`${APP}/api/orders/${id}`))).status;
const appCreate = async (d, currency = d.currency) => j(await fetch(`${APP}/paypal-api/checkout/orders/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: d.total, currency, custom_id: d.id, description: `Payment for your order ${d.id}` }) }));
const appCapture = async (id) => { const r = await fetch(`${APP}/paypal-api/checkout/orders/${id}/capture`, { method: "POST" }); return { http: r.status, body: await j(r) }; };
const confirm = async (id) => (await fetch(`${APP}/api/confirm/${id}`, { method: "POST" })).status;
const approveLink = async (id) => (await getOrder(id)).json.links.find((l) => l.rel === "payer-action" || l.rel === "approve").href;

const browser = await chromium.launch({ headless: true });
for (const step of process.argv.slice(2)) {
  const d = await draft();
  const rec = { spike: 2, step, shopOrder: d.id, shopTotal: `${d.total} ${d.currency}` };
  if (step === "ui") {
    const ctx = await browser.newContext({ locale: "en-US" });
    const p = await ctx.newPage();
    const errors = [];
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    await p.goto(`${APP}/order/${d.id}`);
    try {
      await p.locator("paypal-button:not([hidden])").waitFor({ timeout: 30000 });
      rec.v6ButtonRendered = true;
    } catch { rec.v6ButtonRendered = false; }
    rec.v6ScriptLoaded = await p.evaluate(() => !!(window.paypal && window.paypal.createInstance));
    rec.v5ScriptPresent = await p.evaluate(() => !!document.querySelector('script[src*="paypal.com/sdk/js"]'));
    await p.screenshot({ path: path.join(S2OUT, `ui-1-button-${d.id}.png`), fullPage: true });
    if (rec.v6ButtonRendered) {
      const popupP = ctx.waitForEvent("page", { timeout: 20000 }).catch(() => null);
      await p.locator("paypal-button").click();
      const popup = await popupP;
      rec.presentation = popup ? "popup" : "in-page (modal/redirect)";
      const target = popup || p;
      const a = await approveOn(target, { until: /localhost:3201/ , shotName: undefined });
      rec.walletApproval = a.ok ? "ok" : a.error;
      await p.waitForTimeout(8000);
      await p.screenshot({ path: path.join(S2OUT, `ui-2-after-${d.id}.png`), fullPage: true });
      rec.pageNotice = (await p.locator(".alert").allInnerTexts().catch(() => [])).join(" | ").slice(0, 200);
    }
    rec.consoleErrors = errors.slice(0, 5);
    await ctx.close();
  } else if (step === "server" || step === "d2") {
    const cur = step === "d2" ? "MXN" : d.currency;
    const c = await appCreate(d, cur);
    rec.paypalOrder = c.id; rec.createdCurrency = cur;
    const a = await approve(browser, await approveLink(c.id), { until: /localhost:3201\/success/ });
    rec.approved = a.ok; if (!a.ok) rec.approveError = a.error; else await a.ctx.close();
    rec.capture = await appCapture(c.id);
    rec.confirmHttp = await confirm(c.id);
  } else if (step === "d1") {
    const c = await appCreate(d);
    rec.paypalOrder = c.id;
    rec.confirmHttp = await confirm(c.id);
  } else if (step === "declined") {
    const c = await appCreate(d);
    rec.paypalOrder = c.id;
    const a = await approve(browser, await approveLink(c.id), { until: /localhost:3201\/success/ });
    rec.approved = a.ok; if (!a.ok) rec.approveError = a.error; else await a.ctx.close();
    fs.writeFileSync(path.join(ROOT, "out/s3/mock-3201.json"), JSON.stringify({ match: "/capture", code: "INSTRUMENT_DECLINED" }));
    rec.capture = await appCapture(c.id);
  }
  rec.shopStatusAfter = await shopStatus(d.id);
  if (rec.paypalOrder) rec.paypal = summarizeOrder((await getOrder(rec.paypalOrder)).json);
  fs.appendFileSync(path.join(S2OUT, "verify.jsonl"), JSON.stringify({ ...rec, at: new Date().toISOString() }) + "\n");
  console.log(JSON.stringify(rec));
}
await browser.close();
