// Both type checks stay clean. The root program reaches web/src/claims.ts through scripts/export-web-data.ts and the
// tests, under NodeNext resolution, so an extensionless import there turned every web type into `any` (42 errors from
// a67a957 to 158af46, unnoticed because only the web build's own check ran). web/ imports between its files with ".ts".
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "vitest";

const root = join(import.meta.dirname, "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

describe("type checks", () => {
  it("root tsc --noEmit (src, tests, server, scripts and the web files they import) is clean", () => {
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", root], { stdio: "pipe" });
  }, 60_000);
  it("web tsc --noEmit is clean", () => {
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", join(root, "web")], { stdio: "pipe" });
  }, 60_000);
});
