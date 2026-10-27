// Scanner fixes from review r1 (reviews/r1-PLAN.md B1, B7): v5 is "upgrade available", never "deprecated"; the
// React and paypal-js v5 loaders are found; correct capture checks are not flagged; repo-wide facts withdraw leads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINE_RULES, FILE_RULES } from "../src/scan/rules.ts";
import { repoScan, scanDir, scanSource } from "../src/scan/scan.ts";

const ids = (file: string, src: string) => scanSource(file, src).map((f) => f.rule).sort();
const repo = (files: Record<string, string>) => { const s = repoScan(); for (const [f, src] of Object.entries(files)) s.add(f, src); return s.done().map((f) => `${f.rule}@${f.file}:${f.line}`).sort(); };

describe("JS SDK v5 is not called deprecated", () => {
  it("every v5 rule is kind 'upgrade'", () => {
    const v5 = [...LINE_RULES, ...FILE_RULES].filter((r) => r.id.startsWith("v5-"));
    expect(v5.length).toBeGreaterThanOrEqual(5);
    for (const r of v5) { expect(r.kind, r.id).toBe("upgrade"); expect(r.why, r.id).not.toMatch(/deprecat/i); }
  });
  it("'deprecated' is used only for PayPal's deprecated pieces", () => {
    const dep = [...LINE_RULES, ...FILE_RULES].filter((r) => r.kind === "deprecated").map((r) => r.id).sort();
    expect(dep).toEqual(["application-context", "checkout-server-sdk", "rest-sdk-v1", "v1-payments-api"]);
  });
  it("finds the v5 script with kind upgrade", () => {
    expect(scanSource("a.html", `<script src="https://www.paypal.com/sdk/js?client-id=x"></script>`)[0].kind).toBe("upgrade");
  });
});

describe("modern v5 loaders", () => {
  it("finds @paypal/react-paypal-js in code and package.json", () => {
    expect(ids("App.jsx", `import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";\n<PayPalScriptProvider options={o}>`)).toEqual(["v5-react-paypal-js", "v5-react-paypal-js"]);
    expect(ids("package.json", `{"dependencies": {"@paypal/react-paypal-js": "^8.6.0"}}`)).toEqual(["v5-react-paypal-js"]);
  });
  it("does not flag the react-paypal-js v6 entry", () => {
    expect(ids("App.tsx", `import { PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";`)).toEqual([]);
  });
  it("finds @paypal/paypal-js loadScript, at the loadScript line", () => {
    const f = scanSource("pp.js", `import { loadScript } from "@paypal/paypal-js";\n\nconst paypal = await loadScript({ clientId: "x" });`);
    expect(f.map((x) => [x.rule, x.line, x.kind])).toEqual([["v5-paypal-js", 3, "upgrade"]]);
  });
  it("does not flag paypal-js's v6 loader", () => {
    expect(ids("pp.js", `import { loadCoreSdkScript } from "@paypal/paypal-js/sdk-v6";\nawait loadCoreSdkScript({})`)).toEqual([]);
  });
});

describe("no false RISK on correct capture checks (K2)", () => {
  it("a COMPLETED check on a capture is not order-status-only", () => {
    expect(ids("server.js", `const completed = captures.find((capture) => capture.status === 'COMPLETED')`)).not.toContain("order-status-only");
    expect(ids("server.js", `if (order.purchase_units[0].payments.captures[0].status === "COMPLETED") ok()`)).not.toContain("order-status-only");
    expect(ids("server.js", `if (r.captures?.[0]?.status === "COMPLETED") ok()`)).not.toContain("order-status-only");
  });
  it("a COMPLETED check on the order still is", () => {
    expect(ids("svc.ts", `if (order.status === 'COMPLETED') {`)).toContain("order-status-only");
    expect(ids("svc.ts", `if (captureData.status === 'COMPLETED') {`)).toContain("order-status-only");
  });
  it("capture in one file, capture-status check in another: no no-capture-status-check", () => {
    const files = {
      "lib/paypal.js": `const response = await ordersController.captureOrder({ id, paypalRequestId: k })`,
      "server.js": `const completed = captures.find((capture) => capture.status === 'COMPLETED')`,
    };
    expect(repo(files)).toEqual([]);
    // Alone, the capture file is still a lead.
    expect(repo({ "lib/paypal.js": files["lib/paypal.js"] })).toEqual(["no-capture-status-check@lib/paypal.js:1"]);
  });
  it("recording PayPal's amount is not a missing currency check", () => {
    expect(ids("p.js", `amount: capture.amount ? Number(capture.amount.value) : order.orderTotal,`)).not.toContain("no-currency-check");
    expect(ids("p.js", `if (total === order.purchase_units[0].amount.value) ok()`)).toContain("no-currency-check");
  });
});

describe("PayPal's docs-examples shape (DevRel finding 9)", () => {
  const server = [
    `import { Client, OrdersController } from "@paypal/paypal-server-sdk";`,
    `const captureOrder = async (orderID) => {`,
    `  const { body } = await ordersController.captureOrder({ id: orderID, prefer: "return=minimal" });`,
    `  return JSON.parse(body);`,
    `};`,
    `app.post("/api/orders/:orderID/capture", async (req, res) => {`,
    `  res.json(await captureOrder(req.params.orderID));`,
    `});`,
  ].join("\n");
  const browser = `const transaction = orderData?.purchase_units?.[0]?.payments?.captures?.[0];\nresultMessage(\`Transaction \${transaction.status}: \${transaction.id}\`);`;
  it("capture-no-request-id points at the SDK call, not the Express route", () => {
    const f = scanSource("server/node/server.js", server).find((x) => x.rule === "capture-no-request-id")!;
    expect(f.line).toBe(3);
    expect(f.why).toMatch(/PayPal-Request-Id/);
  });
  it("a browser-side capture-status read withdraws no-capture-status-check", () => {
    expect(repo({ "server/node/server.js": server, "client/app.js": browser })).toEqual(["capture-no-request-id@server/node/server.js:3"]);
  });
});

describe("deprecated application_context", () => {
  it("flags both spellings, not experience_context", () => {
    expect(ids("p.js", `application_context: { brand_name: "x" }`)).toEqual(["application-context"]);
    expect(ids("p.ts", `applicationContext: { shippingPreference: X }`)).toEqual(["application-context"]);
    expect(ids("p.ts", `paymentSource: { paypal: { experienceContext: { shippingPreference: X } } }`)).toEqual([]);
  });
});

describe("scanDir uses the repo pass", () => {
  it("withdraws across files on disk", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
    fs.writeFileSync(path.join(d, "a.js"), `await ordersController.captureOrder({ id, paypalRequestId: k })`);
    fs.writeFileSync(path.join(d, "b.js"), `if (capture.status !== 'COMPLETED') fail()`);
    expect(scanDir(d)).toEqual([]);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
