import { describe, expect, it } from "vitest";
import { parseMoney } from "../src/money/money.ts";
import { truthFromOrder, verdict, type ShopState, type PayPalTruth } from "../src/money/verdict.ts";

const EUR62 = parseMoney("62.00", "EUR");
const shop = (paid: boolean, total = EUR62): ShopState => ({ shopOrderId: "9000001", total, paid, rawStatus: paid ? "pending" : "draft" });
const order = (status: string, captures: [string, string, string][] = [], customId = "9000001") => ({
  id: "PP1", status,
  purchase_units: [{ custom_id: customId, amount: { value: "62.00", currency_code: "EUR" },
    payments: captures.length ? { captures: captures.map(([id, st, amt]) => ({ id, status: st, amount: { value: amt.split(" ")[0], currency_code: amt.split(" ")[1] } })) } : undefined }],
});
const truth = (...a: Parameters<typeof order>): PayPalTruth => truthFromOrder(order(...a));

describe("truthFromOrder", () => {
  it("reads status, custom_id and captures", () => {
    const t = truth("COMPLETED", [["CAP1", "COMPLETED", "62.00 EUR"]]);
    expect(t).toEqual({ orderId: "PP1", status: "COMPLETED", customId: "9000001", captures: [{ id: "CAP1", status: "COMPLETED", amount: EUR62 }] });
  });
  it("handles an order with no captures", () => {
    expect(truth("CREATED").captures).toEqual([]);
  });
});

describe("verdict", () => {
  it("passes a clean paid order (I2, I3, I6)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 EUR"]])], responses: [200] });
    expect(v.verdict).toBe("PASS");
    expect(v.reasons).toEqual([]);
  });
  it("fails D1: shop paid, PayPal has no capture (I2)", () => {
    const v = verdict({ expect: "not-paid", shop: shop(true), paypal: [truth("CREATED")], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I2/);
    expect(v.reasons.join(" ")).toMatch(/I6/);
  });
  it("fails D2: paid in another currency (I3)", () => {
    const v = verdict({ expect: "not-paid", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 MXN"]])], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/62\.00 MXN.*62\.00 EUR.*I3/);
  });
  it("fails a lowered amount (I3)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "1.00 EUR"]])], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I3/);
  });
  it("a declined capture does not count as paid (I2)", () => {
    const v = verdict({ expect: "not-paid", shop: shop(true), paypal: [truth("COMPLETED", [["C", "DECLINED", "62.00 EUR"]])], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I2/);
  });
  it("passes a correctly refused attack", () => {
    const v = verdict({ expect: "not-paid", shop: shop(false), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 MXN"]], "9000001")], responses: [400], attack: true });
    expect(v.verdict).toBe("PASS");
  });
  it("fails charged-but-not-fulfilled (I4)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(false), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 EUR"]])], responses: [500] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I4/);
  });
  it("fails a double charge (I5)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C1", "COMPLETED", "62.00 EUR"], ["C2", "COMPLETED", "62.00 EUR"]])], responses: [200, 200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I5/);
  });
  it("fails two PayPal orders both captured for one shop order (I5)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C1", "COMPLETED", "62.00 EUR"]]), truth("COMPLETED", [["C2", "COMPLETED", "62.00 EUR"]])], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I5/);
  });
  it("fails a 5xx on a repeated call even when money is right (I5)", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 EUR"]])], responses: [200, 500] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/5xx.*I5/);
  });
  it("tolerates an expected PayPal-side error status mid-scenario when told to", () => {
    const v = verdict({ expect: "paid-once", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 EUR"]])], responses: [502, 200], allow5xx: [0] });
    expect(v.verdict).toBe("PASS");
  });
  it("ignores PayPal orders bound to another shop order when the shop is not paid", () => {
    const v = verdict({ expect: "not-paid", shop: shop(false), paypal: [truth("CREATED")], responses: [422] });
    expect(v.verdict).toBe("PASS");
  });
  it("fails not-paid expectation when shop is paid even with a matching capture (I6)", () => {
    const v = verdict({ expect: "not-paid", shop: shop(true), paypal: [truth("COMPLETED", [["C", "COMPLETED", "62.00 EUR"]])], responses: [200] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/I6/);
  });
});
