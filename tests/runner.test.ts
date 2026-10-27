// Review r1 K1: only a result the shop is responsible for is a FAIL; harness errors are INCONCLUSIVE.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runProof } from "../src/prove/runner.ts";
import { HarnessError, type Scenario } from "../src/prove/scenarios.ts";
import { asTold, verdict } from "../src/money/verdict.ts";
import { parseMoney } from "../src/money/money.ts";
import type { Adapter } from "../src/targets/types.ts";

function fakeAdapter(over: Partial<Adapter>, scenarios: Scenario[], baseUrl = "http://127.0.0.1:1"): Adapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-runner-"));
  return {
    target: "fake", variant: "upgraded", mode: "demo", workDir: dir, baseUrl, ppLogFile: path.join(dir, "pp.jsonl"), appLogFile: path.join(dir, "app.log"),
    unsupported: {}, scenarios,
    prepare: async () => {}, start: async () => {}, stop: async () => {},
    newShopOrder: async () => ({ id: "1", total: parseMoney("10.00", "EUR") }),
    shopState: async (id) => ({ shopOrderId: id, total: parseMoney("10.00", "EUR"), paid: false, rawStatus: "draft" }),
    checkout: async () => ({ call: { step: "x", http: 200 } }), complete: async () => [], submitForeign: async () => [],
    mock: () => {}, dropNext: () => {}, orderPageUrl: () => "about:blank",
    screenshotOrder: async () => {},
    ...over,
  };
}
const noop: Scenario = { id: "s", title: "s", ref: "#0", expect: "not-paid", run: async () => ({ ppOrders: [], calls: [], notes: [] }) };
const runDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cp-run-"));

describe("runner: harness and PayPal errors are INCONCLUSIVE; the shop's are FAIL", () => {
  it("newShopOrder throwing is the harness's problem", async () => {
    const a = fakeAdapter({ newShopOrder: async () => { throw new TypeError("Cannot read properties of undefined (reading 'total')"); }, ensureUp: async () => undefined }, [noop]);
    const r = await runProof(a, runDir());
    expect(r.results[0]).toMatchObject({ verdict: "INCONCLUSIVE", attempts: 2 });
    expect(r.results[0].reasons[0]).toMatch(/^harness: could not set up a shop order/);
  });
  // Review r2, sceptic N8: r1 made every exception grey, so a shop answering an HTML 500 that broke the scenario's
  // JSON read was never a FAIL. Now an exception is the shop's unless the harness's own step raised it.
  it("an exception from the shop's answer (shop still up) is the shop's FAIL", async () => {
    const srv = http.createServer((_q, s) => s.end("ok")).listen(0);
    await new Promise((r) => srv.once("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const s: Scenario = { ...noop, run: async () => { JSON.parse("<html>500</html>"); return { ppOrders: [], calls: [], notes: [] }; } };
    const r = await runProof(fakeAdapter({}, [s], base), runDir());
    srv.close();
    expect(r.results[0]).toMatchObject({ verdict: "FAIL", cause: "shop", attempts: 1 });
  });
  it("PayPal's sandbox being slow (no webhook delivery reached the listener) is INCONCLUSIVE, cause paypal, retried", async () => {
    const { PayPalSlowError } = await import("../src/prove/errors.ts");
    let n = 0;
    const s: Scenario = { ...noop, run: async () => { n++; throw new PayPalSlowError("PayPal: no PAYMENT.CAPTURE.COMPLETED delivery for C1 reached our listener within 75 s"); } };
    const r = await runProof(fakeAdapter({ ensureUp: async () => undefined }, [s]), runDir());
    expect(n).toBe(2);
    expect(r.results[0]).toMatchObject({ verdict: "INCONCLUSIVE", cause: "paypal" });
    expect(r.results[0].reasons[0]).toMatch(/^PayPal: no PAYMENT/);
  });
  it("a Playwright timeout (driving the sandbox pages) is the harness's", async () => {
    const s: Scenario = { ...noop, run: async () => { throw Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), { name: "TimeoutError" }); } };
    const r = await runProof(fakeAdapter({ ensureUp: async () => undefined }, [s]), runDir());
    expect(r.results[0]).toMatchObject({ verdict: "INCONCLUSIVE", cause: "harness" });
  });
  it("an exception with the shop process gone is the shop's FAIL", async () => {
    const s: Scenario = { ...noop, run: async () => { throw new TypeError("fetch failed"); } };
    const r = await runProof(fakeAdapter({ ensureUp: async () => "shop process exited (code 1)" }, [s]), runDir());
    expect(r.results[0].verdict).toBe("FAIL");
    expect(r.results[0].reasons[0]).toMatch(/shop process exited/);
  });
  it("a HarnessError stays INCONCLUSIVE", async () => {
    const s: Scenario = { ...noop, run: async () => { throw new HarnessError("sandbox buyer could not approve X: timeout"); } };
    const r = await runProof(fakeAdapter({ ensureUp: async () => undefined }, [s]), runDir());
    expect(r.results[0]).toMatchObject({ verdict: "INCONCLUSIVE", cause: "harness" });
  });
  it("a shop FAIL from the money verdict carries cause shop", async () => {
    const s: Scenario = { ...noop, expect: "paid-once" };
    const r = await runProof(fakeAdapter({ ensureUp: async () => undefined }, [s]), runDir());
    expect(r.results[0]).toMatchObject({ verdict: "FAIL", cause: "shop" });
  });
});

describe("webhook deliveries kept for the run (sceptic N2: delivered-but-ignored is FAIL, never delivered is PayPal's)", () => {
  it("finds a kept genuine delivery by event type and capture id", async () => {
    const { findKept } = await import("../src/prove/scenarios.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wh-"));
    const prev = process.env.CP_WEBHOOK_LOG; process.env.CP_WEBHOOK_LOG = dir;
    try {
      fs.writeFileSync(path.join(dir, "WH-1.json"), JSON.stringify({ headers: { "paypal-transmission-id": "t" }, raw: JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1" } }) }));
      fs.writeFileSync(path.join(dir, "WH-2.json"), JSON.stringify({ headers: {}, raw: JSON.stringify({ id: "WH-2", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R1", links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP1" }] } }) }));
      expect(findKept("PAYMENT.CAPTURE.COMPLETED", "CAP1")?.eventId).toBe("WH-1");
      expect(findKept("PAYMENT.CAPTURE.REFUNDED", "CAP1")?.eventId).toBe("WH-2");
      expect(findKept("PAYMENT.CAPTURE.COMPLETED", "CAP2")).toBeUndefined();
    } finally { if (prev === undefined) delete process.env.CP_WEBHOOK_LOG; else process.env.CP_WEBHOOK_LOG = prev; }
  });
});

describe("own-order money check (review r1 C1): judged in the world the shop was told", () => {
  const truth = { orderId: "O1", status: "COMPLETED", captures: [{ id: "C1", status: "COMPLETED", amount: parseMoney("62.00", "EUR") }] };
  const shop = (paid: boolean) => ({ shopOrderId: "9", total: parseMoney("62.00", "EUR"), paid, rawStatus: paid ? "pending" : "draft" });
  it("a shop that confirms on a reported 1.00 EUR capture fails; one that refuses passes", () => {
    const told = [asTold(truth, { value: "1.00" })];
    expect(verdict({ expect: "not-paid", shop: shop(true), paypal: told, responses: [200], attack: true }).verdict).toBe("FAIL");
    expect(verdict({ expect: "not-paid", shop: shop(false), paypal: told, responses: [409], attack: true }).verdict).toBe("PASS");
  });
  it("a currency rewrite keeps the value and changes the currency", () => {
    expect(asTold(truth, { currency: "MXN" }).captures[0].amount).toEqual(parseMoney("62.00", "MXN"));
  });
});

describe("one proof per target and variant (review r1 K1: overlapping runs shared ports)", () => {
  it("refuses a second lock while the holder lives, and takes over a dead holder's lock", async () => {
    const { takeLock } = await import("../src/prove/prove.ts");
    const { OUT } = await import("../src/env.ts");
    const target = `test-lock-${process.pid}`;
    const dir = path.join(OUT, "runs", target);
    try {
      const release = takeLock(target, "upgraded");
      fs.writeFileSync(path.join(dir, ".prove-upgraded.lock"), String(process.ppid)); // a live process that is not us
      expect(() => takeLock(target, "upgraded")).toThrow(/another proof/);
      fs.writeFileSync(path.join(dir, ".prove-upgraded.lock"), "999999999"); // no such process
      const again = takeLock(target, "upgraded");
      expect(fs.readFileSync(path.join(dir, ".prove-upgraded.lock"), "utf8")).toBe(String(process.pid));
      again(); release();
      expect(fs.existsSync(path.join(dir, ".prove-upgraded.lock"))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
