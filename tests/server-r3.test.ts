// Review r3 (25 Oct), server side: made-up run ids must not reload the history (A4), and an IPv6 visitor is a /48 (A3).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rerun } from "../server/rerun.ts";
import { MemoryStore } from "../server/store.ts";
import { visitorKey } from "../server/limits.ts";

describe("unknown run ids (A4)", () => {
  it("100 made-up ids over 10 minutes cost one history load, not one every 10 s", async () => {
    const store = new MemoryStore();
    let lists = 0;
    const list = store.listJobs.bind(store);
    store.listJobs = (n: number) => { lists++; return list(n); };
    let t = Date.parse("2026-10-25T10:00:00Z");
    const r = new Rerun({ root: fs.mkdtempSync(path.join(os.tmpdir(), "cp-r3-")), mode: "cloud", dailyGlobal: 6, dailyPerVisitor: 1, expected: 18, store, now: () => t });
    for (let i = 0; i < 100; i++) { t += 6_000; expect(await r.find(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)).toBeUndefined(); }
    // The 60 s history cache expires about 10 times in 10 minutes; before the fix a miss forced a reload every 10 s.
    expect(lists).toBeLessThanOrEqual(11);
  });
});

describe("visitor key (A3)", () => {
  it("counts an IPv6 /48 as one visitor; IPv4 stays per address", () => {
    expect(visitorKey("2001:db8:1:2::1")).toBe(visitorKey("2001:db8:1:ffff:abcd::9"));
    expect(visitorKey("2001:db8:1::1")).not.toBe(visitorKey("2001:db8:2::1"));
    expect(visitorKey("1.2.3.4")).not.toBe(visitorKey("1.2.3.5"));
    expect(visitorKey("::ffff:1.2.3.4")).toBe(visitorKey("1.2.3.4"));
  });
});
