import { describe, expect, it } from "vitest";
import { parseMoney, moneyEqual, formatMoney } from "../src/money/money.ts";

describe("parseMoney (I1)", () => {
  it("parses to integer minor units", () => {
    expect(parseMoney("62.00", "EUR")).toEqual({ minor: 6200, currency: "EUR" });
    expect(parseMoney("62.0", "eur")).toEqual({ minor: 6200, currency: "EUR" });
    expect(parseMoney("62", "EUR")).toEqual({ minor: 6200, currency: "EUR" });
    expect(parseMoney("0.10", "EUR")).toEqual({ minor: 10, currency: "EUR" });
  });
  it("does not drift like floats", () => {
    expect(parseMoney("0.30", "EUR").minor).toBe(parseMoney("0.1", "EUR").minor + parseMoney("0.2", "EUR").minor);
  });
  it("handles zero-decimal currencies", () => {
    expect(parseMoney("100", "JPY")).toEqual({ minor: 100, currency: "JPY" });
    expect(() => parseMoney("100.50", "JPY")).toThrow();
  });
  it("rejects junk", () => {
    expect(() => parseMoney("€62", "EUR")).toThrow();
    expect(() => parseMoney("62.001", "EUR")).toThrow();
    expect(() => parseMoney("", "EUR")).toThrow();
    expect(() => parseMoney("62.00", "")).toThrow();
    expect(() => parseMoney("-1.00", "EUR")).toThrow();
  });
});

describe("moneyEqual (I1)", () => {
  it("compares amount and currency", () => {
    expect(moneyEqual(parseMoney("62.00", "EUR"), parseMoney("62.0", "EUR"))).toBe(true);
    expect(moneyEqual(parseMoney("62.00", "EUR"), parseMoney("62.00", "MXN"))).toBe(false);
    expect(moneyEqual(parseMoney("62.00", "EUR"), parseMoney("61.99", "EUR"))).toBe(false);
  });
  it("formats", () => {
    expect(formatMoney(parseMoney("62", "EUR"))).toBe("62.00 EUR");
    expect(formatMoney(parseMoney("100", "JPY"))).toBe("100 JPY");
  });
});
