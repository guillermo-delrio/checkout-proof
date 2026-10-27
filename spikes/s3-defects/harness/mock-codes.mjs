// Which PayPal-Mock-Response codes from SCENARIOS.md does the sandbox actually honour?
// Each code is sent on the operation SCENARIOS.md lists it under. "honoured" = the error that comes back names it.
// Usage: node mock-codes.mjs <captureIdForRefundMocks>
import { chromium } from "playwright";
import { call, approve, log } from "./pp.mjs";

const refundCapture = process.argv[2];
const mockHdr = (code) => ({ "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: code }) });
const issueOf = (j) => (typeof j === "object" ? j.details?.[0]?.issue || j.name || j.error : String(j).slice(0, 80));
const ret = { return_url: "http://localhost:9999/return", cancel_url: "http://localhost:9999/cancel" };
const order = (intent = "CAPTURE", extra = {}) => ({ intent, purchase_units: [{ amount: { currency_code: "EUR", value: "2.00" }, ...extra }], payment_source: { paypal: { experience_context: ret } } });

async function run(api, op, code, method, path, body) {
  const r = await call(method, path, body, mockHdr(code));
  const got = issueOf(r.json);
  log("mock-codes.jsonl", { api, op, code, http: r.status, returned: got, honoured: got === code, debugId: r.debugId });
}

const browser = await chromium.launch({ headless: true });
// Orders v2: create
for (const c of ["PAYEE_ACCOUNT_RESTRICTED", "PAYER_CANNOT_PAY", "DUPLICATE_INVOICE_ID"]) await run("orders-v2", "create", c, "POST", "/v2/checkout/orders", order());
// Orders v2: capture (on a fresh, unapproved order)
for (const c of ["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED", "TRANSACTION_REFUSED", "COMPLIANCE_VIOLATION", "ORDER_NOT_APPROVED", "ORDER_ALREADY_CAPTURED", "INTERNAL_SERVER_ERROR"]) {
  const o = (await call("POST", "/v2/checkout/orders", order())).json;
  await run("orders-v2", "capture", c, "POST", `/v2/checkout/orders/${o.id}/capture`, {});
}
// Orders v2: authorize (on a fresh AUTHORIZE order)
for (const c of ["ORDER_EXPIRED", "ORDER_ALREADY_AUTHORIZED"]) {
  const o = (await call("POST", "/v2/checkout/orders", order("AUTHORIZE"))).json;
  await run("orders-v2", "authorize", c, "POST", `/v2/checkout/orders/${o.id}/authorize`, {});
}
// Payments v2: refund (on a real completed capture)
if (refundCapture) for (const c of ["REFUND_AMOUNT_EXCEEDED", "CAPTURE_FULLY_REFUNDED", "PENDING_CAPTURE", "REFUND_FAILED_INSUFFICIENT_FUNDS", "REFUND_NOT_ALLOWED", "REFUND_TIME_LIMIT_EXCEEDED", "TRANSACTION_DISPUTED"])
  await run("payments-v2", "refund", c, "POST", `/v2/payments/captures/${refundCapture}/refund`, { amount: { value: "0.01", currency_code: "EUR" } });
// Payments v2: authorization capture (needs a real authorization: approve an AUTHORIZE order, then authorize)
{
  const o = (await call("POST", "/v2/checkout/orders", order("AUTHORIZE"))).json;
  const a = await approve(browser, o.links.find((l) => l.rel === "payer-action").href, { until: /localhost:9999\// });
  if (a.ok) await a.ctx.close();
  const au = await call("POST", `/v2/checkout/orders/${o.id}/authorize`, {});
  const authId = au.json.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  log("mock-codes.jsonl", { note: "authorization for auth-capture mock", order: o.id, approved: a.ok, authorizeHttp: au.status, authId });
  if (authId) await run("payments-v2", "authorization-capture", "AUTHORIZATION_EXPIRED", "POST", `/v2/payments/authorizations/${authId}/capture`, {});
}
// Payments v1: create and execute
const v1 = (extra = {}) => ({ intent: "sale", payer: { payment_method: "paypal" }, redirect_urls: ret, transactions: [{ amount: { total: "2.00", currency: "EUR" } }], ...extra });
await run("payments-v1", "create", "TRANSACTION_REFUSED", "POST", "/v1/payments/payment", v1());
for (const c of ["INSTRUMENT_DECLINED", "CREDIT_CARD_REFUSED", "PAYMENT_NOT_APPROVED_FOR_EXECUTION", "PAYMENT_ALREADY_DONE"]) {
  const p = (await call("POST", "/v1/payments/payment", v1())).json;
  await run("payments-v1", "execute", c, "POST", `/v1/payments/payment/${p.id}/execute`, { payer_id: "TESTPAYERID1" });
}
await browser.close();
