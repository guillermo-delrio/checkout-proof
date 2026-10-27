// Review r3 (25 Oct): the catch cards' text and numbers. A card printed "found that the shop the refusal carries no
// payer_action_url (… https://www.sandbox.paypal.com/…)", and "28 pass, 6 fail" sat next to "32 of 32 pass".
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { asClause, failPhrases, plainReason } from "../web/src/claims.ts";

const DIR = path.resolve(import.meta.dirname, "..", "web", "public", "data");
const has = fs.existsSync(path.join(DIR, "index.json"));
const targets = has ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))) : [];

describe.skipIf(!has)("catch cards (review r3)", () => {
  it("say what was found as clauses, with no raw URLs", () => {
    for (const t of targets) for (const c of t.catches ?? []) {
      const s = failPhrases(t, c.red.fail).map(asClause).join("; ");
      expect(s, t.slug).not.toMatch(/https?:\/\//);
      expect(s, t.slug).not.toMatch(/the shop (the|a|an) /);
      expect(s, t.slug).toMatch(/^(the shop|the buyer|a |an )/);
    }
  });
  it("count the same scenario runs red and green (inconclusive included)", () => {
    for (const t of targets) for (const c of t.catches ?? []) {
      expect(c.green.pass + c.green.fail + (c.green.inconclusive ?? 0), `${t.slug} ${c.red.commit}`).toBe(c.red.pass + c.red.fail.length);
    }
  });
  it("show a record where money went wrong, when the red run has one", () => {
    for (const t of targets) for (const c of t.catches ?? []) {
      if (!c.red.fail.some((f: any) => /charged|captured|completed captures/.test(f.reason))) continue;
      expect(/charged|captured|completed captures/.test(c.red.fail.find((f: any) => f.id.startsWith(c.failId))?.reason ?? ""), `${t.slug} ${c.red.commit}`).toBe(true);
    }
  });
});

describe("plain reasons", () => {
  it("drop sandbox URLs from unknown shapes", () => {
    expect(plainReason("something odd (PayPal's link for X was https://www.sandbox.paypal.com/checkoutnow?token=X)")).toBe("something odd");
    expect(plainReason("the refusal carries no payer_action_url (PayPal's link for X was https://a.b/c)")).not.toMatch(/https?:/);
  });
});

// 25 Oct: shots were named variant-mode-scenario-order, so a later run with the same shop order id (the plain arm, a
// catch's green run) overwrote the earlier run's picture, and the scenario table showed the plain arm's page.
describe.skipIf(!has)("screenshots (review r3, gallery 2)", () => {
  it("a catch's red and green runs never share a picture, nor with the scenario table's final runs", () => {
    for (const t of targets) {
      const table = new Set<string>(t.scenarios.flatMap((s: any) => s.modes.flatMap((m: any) => [m.after?.screenshot]).filter(Boolean)));
      for (const c of t.catches ?? []) {
        const red = [c.red.cell?.screenshot, ...Object.values(c.red.cells ?? {}).map((x: any) => x.screenshot)].filter(Boolean);
        for (const s of red) { expect(s, t.slug).not.toBe(c.green.cell?.screenshot); expect(table.has(s), `${t.slug} ${s}`).toBe(false); }
      }
    }
  });
  it("the plain arm's catch on simple-clothing-store carries its EUR 1.00 capture (gallery 2)", () => {
    const t = targets.find((x) => x.slug === "simple-clothing-store");
    const c = t?.catches?.find((x: any) => x.arm === "plain");
    expect(c?.fix.turns).toBe(14);
    const amount = c?.red.cells?.amount;
    expect(amount?.paypal.flatMap((p: any) => p.captures).map((x: any) => x.amount)).toContain("1.00 EUR");
    expect(amount?.shopTotal).toBe("62.00 EUR");
  });
});

// Watch round 114 (26 Oct): the plain catch card names only the EUR 1.00 bug as "new, not in the original", folds the
// run's other bugs, and shows the green run's harness red as inconclusive. These are the data facts those words rest on.
describe.skipIf(!has)("plain catch card wording (watch round 114)", () => {
  const t = targets.find((x) => x.slug === "simple-clothing-store");
  const c = t?.catches?.find((x: any) => x.arm === "plain");
  const before = (id: string) => t?.scenarios.find((s: any) => s.id === id)?.modes.map((m: any) => m.before?.verdict);
  it("the EUR 1.00 bug is new: the original passed the amount scenario in every mode", () => {
    expect(before("amount")?.length).toBeGreaterThan(0);
    expect(before("amount")?.every((v: string) => v === "PASS")).toBe(true);
  });
  it("the folded bugs (currency, two tabs) were in the original too", () => {
    for (const id of ["currency", "two-tabs"]) expect(before(id)?.some((v: string) => v === "FAIL"), id).toBe(true);
    expect(new Set(c?.red.fail.map((f: any) => f.id.replace(/ \(.*\)$/, "")))).toEqual(new Set(["currency", "amount", "two-tabs"]));
  });
  it("the green run's one red is the sandbox buyer timing out (shown as '21 pass, 1 inconclusive (sandbox timeout), 0 fail')", () => {
    expect([c?.green.pass, c?.green.fail, c?.green.inconclusive]).toEqual([21, 1, 0]);
    expect(c?.green.harnessNote).toMatch(/buyer tim/i);
  });
});
