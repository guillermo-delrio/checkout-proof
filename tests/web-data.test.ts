// Guards the gallery's exported evidence (web/public/data): no credentials, no e-mail beyond the harness's fake
// buyer, and the claims the overview leads with still match the data. Skipped until `npm run export-web` has run.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dirname, "..", "web", "public", "data");
const has = fs.existsSync(path.join(DIR, "index.json"));
const env = fs.existsSync(path.resolve(import.meta.dirname, "..", ".env")) ? fs.readFileSync(path.resolve(import.meta.dirname, "..", ".env"), "utf8") : "";
const values = env.split("\n").map((l) => l.split("=").slice(1).join("=").trim()).filter((v) => v.length >= 6 && v !== "sandbox");

describe.skipIf(!has)("exported gallery data", () => {
  const files = has ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
  it("holds no .env value, token or real e-mail", () => {
    for (const f of files) {
      const s = fs.readFileSync(path.join(DIR, f), "utf8");
      for (const v of values) expect(s.includes(v), `${f} contains an .env value`).toBe(false);
      expect(s).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9]|access_token/);
      const emails = (s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter((e) => !/^(buyer@example\.com|owner@test\.com|checkout-proof@localhost)$/.test(e));
      expect(emails, f).toEqual([]);
    }
  });
  it("every referenced screenshot exists", () => {
    for (const f of files) {
      for (const m of fs.readFileSync(path.join(DIR, f), "utf8").matchAll(/"(data\/shots\/[^"]+)"/g)) expect(fs.existsSync(path.join(DIR, "..", m[1])), m[1]).toBe(true);
    }
  });
  it("the hero claim matches the data: €85 paid, €480 order marked paid, fixed after", () => {
    const idx = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
    const t = idx.targets.find((x: any) => x.failures.some((f: any) => f.code === "E1"));
    if (!t || idx.aliasMode) return;
    const d = JSON.parse(fs.readFileSync(path.join(DIR, `${t.slug}.json`), "utf8"));
    const c = d.scenarios.find((s: any) => s.id === d.heroId).modes[0];
    expect(c.before.verdict).toBe("FAIL");
    expect(c.before.shopTotal).toBe("480.00 EUR");
    expect(c.before.shopPaid).toBe(true);
    expect(c.before.paypal.flatMap((p: any) => p.captures).filter((x: any) => x.status === "COMPLETED").map((x: any) => x.amount)).toEqual(["85.00 EUR"]);
    expect(c.after.verdict).toBe("PASS");
  });
});
