// Review r3, A1: crafted text made the scan rules backtrack (14 KB took 48 s) and froze the live server. Every rule
// must stay linear: 200 KB of each crafted pattern scans in well under a second.
import { describe, it, expect } from "vitest";
import { repoScan } from "../src/scan/scan.ts";

const CRAFTED: Record<string, string> = {
  "captures.find(": "fetch('/v2/checkout/orders');\n" + "captures.find(".repeat(15_000),
  "captures[": "fetch('/v2/checkout/orders');\n" + "captures[".repeat(22_000),
  "captures?.[": "captures?.[".repeat(18_000) + "\nstatus === 'PENDING'\n",
  "'PENDING'===": "captures[0]\n" + "'PENDING'===".repeat(17_000),
  "/v2/checkout/orders/": "/v2/checkout/orders/".repeat(10_000),
  "amount.value": "amount.value".repeat(17_000) + "\n" + "===amount".repeat(20_000),
  ".status === 'COMPLETED'": ".status === 'COMPLETED' captures[".repeat(6_000),
};

describe("scan rules stay linear on crafted input (review r3 A1)", () => {
  for (const [name, src] of Object.entries(CRAFTED)) {
    it(`${name} × ${(src.length / 1024).toFixed(0)} KB`, () => {
      const t = performance.now();
      const s = repoScan();
      s.add("a.js", src);
      s.done();
      expect(performance.now() - t, name).toBeLessThan(1000);
    });
  }
});
