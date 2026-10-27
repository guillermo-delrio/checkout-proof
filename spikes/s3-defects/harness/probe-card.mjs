import { call, summarizeOrder, log } from "./pp.mjs";
for (const name of ["CCREJECT-REFUSED", "Test Buyer"]) {
  const o = await call("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "3.00" } }] });
  const c = await call("POST", `/v2/checkout/orders/${o.json.id}/capture`, { payment_source: { card: { number: "4012888888881881", expiry: "2030-12", security_code: "123", name } } });
  const g = await call("GET", `/v2/checkout/orders/${o.json.id}`);
  log("probe.jsonl", { probe: "card-capture", name, captureHttp: c.status, captureIssue: c.json.details?.[0]?.issue, captureResp: c.status < 300 ? summarizeOrder(c.json) : c.json.name, order: summarizeOrder(g.json), debugId: c.debugId });
}
