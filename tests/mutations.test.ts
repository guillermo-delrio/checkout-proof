// Review r2, sceptic N9: every mutation check still applies to the shop code it guards (each edit's text found once),
// so `npm run cp -- mutate <name>` keeps proving that its scenarios turn red without the fix. Work copies live in out/
// (not in git): a missing one skips its mutations.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MUTATIONS, applyEdits } from "../src/prove/mutations.ts";
import { targetDef } from "../src/targets/index.ts";
import { SCENARIOS } from "../src/prove/scenarios.ts";
import { EC_SCENARIOS } from "../src/prove/ec-scenarios.ts";

describe("mutation checks", () => {
  for (const m of MUTATIONS) {
    const dir = targetDef(m.target).workDirFor("upgraded");
    it.skipIf(!fs.existsSync(dir))(`${m.name} still applies to ${m.target}'s upgraded code and names real scenarios`, () => {
      const out = applyEdits((f) => fs.readFileSync(path.join(dir, f), "utf8"), m);
      for (const [f, s] of Object.entries(out)) expect(s).not.toBe(fs.readFileSync(path.join(dir, f), "utf8"));
      const ids = (m.target === "expressCart" ? EC_SCENARIOS : SCENARIOS).map((s) => s.id);
      for (const s of m.scenarios) expect(ids).toContain(s);
    });
  }
  it("refuses an edit whose text is gone", () => {
    expect(() => applyEdits(() => "nothing here", { ...MUTATIONS[0] })).toThrow(/found it 0 times/);
  });
});
