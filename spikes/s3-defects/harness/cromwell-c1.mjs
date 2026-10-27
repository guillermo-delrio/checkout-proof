// Cromwell before-code, C1: the ORIGINAL plugin createPayment (bundled with @cromwell/* stubbed) creates the v1
// payment; a real buyer approves; PayPal redirects to successUrl (?paymentStatus=success), which is all the store's
// checkout waits for before placeOrder() (toolkits/commerce/src/base/Checkout/actions.ts:85-90,352-366, read, not run).
// We then ask PayPal whether any money moved.
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { ROOT, approve, getPaymentV1, log } from "./pp.mjs";
const require = createRequire(import.meta.url);
const { createPayment } = require(path.join(ROOT, "out/work/cromwell-paypal-plugin/dist/create-payment.cjs"));
const out = await createPayment({ cart: [{ product: { name: "Tee", price: 20 }, amount: 2 }], shippingPrice: 5, orderTotalPrice: 45, currency: "EUR",
  successUrl: "http://localhost:9999/return?paymentStatus=success", cancelUrl: "http://localhost:9999/cancel?paymentStatus=cancelled" });
const rec = { target: "Cromwell plugin-paypal", case: "C1 approved, never executed", pluginOutput: out && { name: out.name, hasLink: !!out.link } };
const token = new URL(out.link).searchParams.get("token");
const browser = await chromium.launch({ headless: true });
const a = await approve(browser, out.link, { until: /localhost:9999\/return/ });
rec.approved = a.ok; if (!a.ok) rec.approveError = a.error;
if (a.ok) { const u = new URL(a.page.url()); rec.successUrlHit = u.pathname + "?paymentStatus=" + u.searchParams.get("paymentStatus"); rec.paymentId = u.searchParams.get("paymentId"); await a.ctx.close(); }
rec.ecToken = token;
await new Promise((r) => setTimeout(r, 60000)); // give PayPal a minute; an un-executed v1 payment never completes
if (rec.paymentId) {
  const p = (await getPaymentV1(rec.paymentId)).json;
  rec.paypal = { id: p.id, state: p.state, total: `${p.transactions?.[0]?.amount?.total} ${p.transactions?.[0]?.amount?.currency}`, relatedResources: p.transactions?.[0]?.related_resources?.length ?? 0, payerStatus: p.payer?.status };
}
log("cromwell.jsonl", rec);
await browser.close();
