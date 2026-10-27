import { describe, expect, it } from "vitest";
import { scanSource } from "../src/scan/scan.ts";

const ids = (file: string, src: string) => scanSource(file, src).map((f) => f.rule).sort();

describe("scan rules", () => {
  it("finds the v5 script and Buttons", () => {
    expect(ids("a.html", `<script src="https://www.paypal.com/sdk/js?client-id=x"></script>\npaypal.Buttons({})`)).toEqual(["v5-buttons", "v5-script"]);
  });
  it("finds deprecated server SDKs in code and package.json", () => {
    expect(ids("lib/p.js", `const sdk = require('@paypal/checkout-server-sdk')`)).toContain("checkout-server-sdk");
    expect(ids("package.json", `{"dependencies": {"paypal-rest-sdk": "^1.8.1", "react-paypal-button-v2": "^2"}}`)).toEqual(["rest-sdk-v1", "v5-react-wrapper"]);
  });
  it("does not flag the new SDK or v6", () => {
    expect(ids("s.js", `import { Client } from '@paypal/paypal-server-sdk'\nconst u = 'https://www.sandbox.paypal.com/web-sdk/v6/core'`)).toEqual([]);
  });
  it("flags client-side create and capture", () => {
    expect(ids("P.js", `actions.order.create({})\nactions.order.capture().then()`)).toEqual(["client-capture", "client-create-order"]);
  });
  it("flags a server that reads the order but never checks the capture status (D1)", () => {
    const d1 = `const request = new sdk.orders.OrdersGetRequest(id)\nif (data.retail_costs.total === order.result.purchase_units[0].amount.value) ok()`;
    expect(ids("server.js", d1)).toEqual(expect.arrayContaining(["no-capture-status-check", "no-currency-check"]));
  });
  it("does not flag a server that checks capture status and currency", () => {
    const good = `const r = await orders.getOrder({id})\nconst c = r.result.purchaseUnits[0].payments.captures[0]\nif (capture.status === 'COMPLETED' && c.amount.currencyCode === cur && c.amount.value === total) ok()`;
    expect(ids("server.ts", good)).not.toContain("no-capture-status-check");
  });
  it("flags capture with no PayPal-Request-Id", () => {
    expect(ids("s.js", `const req = new sdk.orders.OrdersCaptureRequest(id)`)).toContain("capture-no-request-id");
    expect(ids("s.js", `const req = new sdk.orders.OrdersCaptureRequest(id); req.headers['PayPal-Request-Id'] = k`)).not.toContain("capture-no-request-id");
  });
  it("flags v1 approved-state checks (E2)", () => {
    expect(ids("paypal.js", `if (payment.state === 'approved') paid()`)).toContain("v1-approved-state");
  });
  it("ignores non-code files", () => {
    expect(ids("README.md", `paypal.Buttons(`)).toEqual([]);
  });
});

import { scrub } from "../src/env.ts";
describe("scrub", () => {
  it("removes bearer tokens, access tokens and JWT-shaped client tokens", () => {
    const s = scrub(JSON.stringify({ a: "Bearer A21AAabcdefghijklmnop", access_token: "zzz", clientToken: "eyJraWQiOiJjMDg0.eyJpc3MiOiJodHRw.sig_abcd" }));
    expect(s).not.toMatch(/A21AA|zzz|eyJ/);
  });
});
