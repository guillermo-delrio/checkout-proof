// Probe: approve a 62.00 EUR order with the harness buyer and capture it (balance runs low after many runs).
import { call, approveLink, getOrder } from "../src/paypal/truth.ts";
import { approveUrl, closeBrowser } from "../src/buyer/buyer.ts";
const o = await call("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "62.00" } }] });
const a = await approveUrl(approveLink(o.json)!, { until: /localhost/, shotPath: "out/probe-buyer.png", done: async () => (await getOrder(o.json.id)).json.status === "APPROVED" });
console.log(o.json.id, JSON.stringify(a));
const c = await call("POST", `/v2/checkout/orders/${o.json.id}/capture`, {});
console.log("capture", c.status, c.json?.purchase_units?.[0]?.payments?.captures?.[0]?.status);
await closeBrowser();
