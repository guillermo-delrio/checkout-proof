import { describe, expect, it } from "vitest";
import { parseMoney } from "../src/money/money.ts";
import { truthFromPaymentV1, truthFromAny, asPending, verdict, type ShopState } from "../src/money/verdict.ts";

const payment = (id: string, state: string, sale?: [string, string, string]) => ({
  id, state,
  transactions: [{ amount: { total: "480.00", currency: "EUR" }, related_resources: sale ? [{ sale: { id: sale[0], state: sale[1], amount: { total: sale[2].split(" ")[0], currency: sale[2].split(" ")[1] } } }] : [] }],
});

describe("v1 payments as PayPal truth", () => {
  it("maps sales to captures and upper-cases states", () => {
    expect(truthFromPaymentV1(payment("PAYID-B", "approved", ["60250968YB4425223", "completed", "85.00 EUR"]))).toEqual({
      orderId: "PAYID-B", status: "APPROVED", captures: [{ id: "60250968YB4425223", status: "COMPLETED", amount: parseMoney("85.00", "EUR") }],
    });
  });
  it("an unexecuted payment has no captures", () => {
    expect(truthFromPaymentV1(payment("PAYID-A", "created")).captures).toEqual([]);
  });
  it("truthFromAny picks v1 for PAYID- ids", () => {
    expect(truthFromAny(payment("PAYID-A", "created")).status).toBe("CREATED");
    expect(truthFromAny({ id: "5O190127TN364715T", status: "COMPLETED", purchase_units: [] }).status).toBe("COMPLETED");
  });
});

describe("E1 shape (spike 3 numbers)", () => {
  const shop: ShopState = { shopOrderId: "6ad29dca89aa9cad97f6f442", total: parseMoney("480.00", "EUR"), paid: true, rawStatus: "Paid" };
  it("fails I3: €480 order marked Paid for an €85 sale", () => {
    const v = verdict({ expect: "paid-once", shop, paypal: [truthFromPaymentV1(payment("PAYID-A", "created")), truthFromPaymentV1(payment("PAYID-B", "approved", ["S", "completed", "85.00 EUR"]))], responses: [302, 302, 302] });
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.join(" ")).toMatch(/85\.00 EUR, shop total is 480\.00 EUR \(I3\)/);
  });
});

describe("simulated pending (SCENARIOS #10b)", () => {
  const t = truthFromPaymentV1(payment("PAYID-C", "approved", ["S", "completed", "73.00 EUR"]));
  it("asPending turns completed captures into PENDING and leaves the rest", () => {
    expect(asPending(t).captures[0].status).toBe("PENDING");
    expect(t.captures[0].status).toBe("COMPLETED");
  });
  it("a shop that marks a pending capture paid fails; one that waits passes", () => {
    const total = parseMoney("73.00", "EUR");
    expect(verdict({ expect: "not-paid", shop: { shopOrderId: "o", total, paid: true, rawStatus: "Paid" }, paypal: [asPending(t)], responses: [302] }).verdict).toBe("FAIL");
    expect(verdict({ expect: "not-paid", shop: { shopOrderId: "o", total, paid: false, rawStatus: "Pending" }, paypal: [asPending(t)], responses: [200] }).verdict).toBe("PASS");
  });
});
