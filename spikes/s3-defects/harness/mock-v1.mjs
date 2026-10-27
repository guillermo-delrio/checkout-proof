import { call, log } from "./pp.mjs";
const ret = { return_url: "http://localhost:9999/return", cancel_url: "http://localhost:9999/cancel" };
const v1 = { intent: "sale", payer: { payment_method: "paypal" }, redirect_urls: ret, transactions: [{ amount: { total: "2.00", currency: "EUR" } }] };
for (const c of ["INSTRUMENT_DECLINED", "CREDIT_CARD_REFUSED", "PAYMENT_NOT_APPROVED_FOR_EXECUTION", "PAYMENT_ALREADY_DONE"]) {
  const p = (await call("POST", "/v1/payments/payment", v1)).json;
  const r = await call("POST", `/v1/payments/payment/${p.id}/execute`, { payer_id: "TESTPAYERID1" }, { "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: c }) });
  log("mock-codes.jsonl", { api: "payments-v1", op: "execute", code: c, http: r.status, returned: r.json.name, honoured: r.json.name === c, debugId: r.debugId, rerun: "name field" });
}
// Control: execute with no mock on an unapproved payment, to show what the real error is.
const p = (await call("POST", "/v1/payments/payment", v1)).json;
const r = await call("POST", `/v1/payments/payment/${p.id}/execute`, { payer_id: "TESTPAYERID1" });
log("mock-codes.jsonl", { api: "payments-v1", op: "execute", code: "(none: control)", http: r.status, returned: r.json.name, debugId: r.debugId });
