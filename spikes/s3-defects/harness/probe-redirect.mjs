import { chromium } from "playwright";
import { call, approve, summarizeOrder, log } from "./pp.mjs";
const o = await call("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "1.00" } }],
  payment_source: { paypal: { experience_context: { return_url: "http://localhost:9/return", cancel_url: "http://localhost:9/cancel", user_action: "PAY_NOW" } } } });
console.log(o.status, o.json.id);
const link = o.json.links.find((l) => l.rel === "payer-action" || l.rel === "approve").href;
const b = await chromium.launch({ headless: true });
const a = await approve(b, link, { until: /localhost:9\// , shotName: "probe-approve.png"});
console.log(a.ok, a.error, a.steps);
const c = await call("POST", `/v2/checkout/orders/${o.json.id}/capture`, {});
log("probe.jsonl", { probe: "redirect", approve: a.ok, capture: c.status, order: summarizeOrder(c.json) });
await b.close();
