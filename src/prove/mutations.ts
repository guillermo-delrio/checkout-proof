// Mutation checks (review r2, sceptic N9): take a shop fix out on purpose and show that the scenario guarding it turns
// red. Each one runs on a copy of the upgraded work copy (`<work copy>-mutation-<name>`, its own run folder ending in
// `-mutation-<name>`), and the run's results.json carries `mutation` and a commit marked `+mutation:<name>`, so it is
// never read as the commit's own result. `tests/mutations.test.ts` checks that every mutation still applies.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { targetDef } from "../targets/index.ts";

export interface MutationDef {
  name: string; target: string; description: string; scenarios: string[]; modes?: string[];
  edits: { file: string; find: string; replace: string }[];   // each `find` must occur exactly once
}

export const MUTATIONS: MutationDef[] = [
  {
    name: "no-same-money", target: "simple-clothing-store", scenarios: ["currency-own", "amount-own"],
    description: "the capture's money check (sameMoney in checkCapture) removed: any captured amount and currency confirm the order",
    edits: [{ file: "server.js", find: "  if (!sameMoney(capture.amount, binding)) {\n    console.error(`PayPal capture ${capture.id} for shop order", replace: "  if (false) {\n    console.error(`PayPal capture ${capture.id} for shop order" }],
  },
  {
    name: "confirm-on-refusal", target: "simple-clothing-store", scenarios: ["capture-refused"],
    description: "a refused capture no longer stops the confirmation: the shop confirms the order whatever PayPal answered (the original's bug)",
    edits: [{ file: "server.js", find: "    if (captured.refusal) {\n      return captured.refusal\n    }\n    order = captured.order\n  }\n\n  const checked", replace: "    if (captured.refusal) {\n      await confirmShopOrder(shopOrderId)\n      return captured.refusal\n    }\n    order = captured.order\n  }\n\n  const checked" }],
  },
  {
    name: "no-saved-state", target: "simple-clothing-store", scenarios: ["restart-approved", "restart-pending"],
    description: "the saved payment records are not read back at start (fix round 1, af4e134, taken out): a restart forgets every PayPal order, pending payment and handled event",
    edits: [{ file: "server.js", find: "const saved = loadState()\n", replace: "const saved = {}\n" }],
  },
  {
    name: "built-payer-link", target: "simple-clothing-store", scenarios: ["payer-action"],
    description: "the payer-action refusal sends the buyer to a checkout URL the shop builds from the order id, not to the link PayPal gave for the order (the reverted hand commit's fallback)",
    edits: [{ file: "server.js", find: "      failed.body.payer_action_url = binding.payerActionUrl\n", replace: "      failed.body.payer_action_url = `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(paypalOrderId)}`\n" }],
  },
  {
    name: "no-own-money-check", target: "expressCart", scenarios: ["currency-own", "amount-own"],
    description: "the capture's money check removed (sameMoney on PayPal's order and capture in applyPaypalOrder): any captured amount and currency mark the order paid",
    edits: [
      { file: "lib/payments/paypal.js", find: "        (unit.amount && !sameMoney(unit.amount, order))){", replace: "        false){" },
      { file: "lib/payments/paypal.js", find: "        if(!sameMoney(completed.amount, order)){", replace: "        if(false){" },
    ],
  },
];

export const mutationByName = (name: string) => {
  const m = MUTATIONS.find((x) => x.name === name);
  if (!m) throw new Error(`unknown mutation ${name}; known: ${MUTATIONS.map((x) => x.name).join(", ")}`);
  return m;
};

/** Applies a mutation's edits to file contents; throws when a `find` is missing or not unique. */
export function applyEdits(read: (file: string) => string, m: MutationDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of m.edits) {
    const s = out[e.file] ?? read(e.file);
    const n = s.split(e.find).length - 1;
    if (n !== 1) throw new Error(`mutation ${m.name}: expected the text once in ${e.file}, found it ${n} times (the shop's code changed: update the mutation)`);
    out[e.file] = s.replace(e.find, e.replace);
  }
  return out;
}

/** Copies the upgraded work copy (node_modules linked, not copied) and applies the mutation. Returns the CP_ARM. */
export function prepareMutant(m: MutationDef): string {
  const t = targetDef(m.target);
  const src = t.workDirFor("upgraded");
  const arm = `mutation-${m.name}`;
  const prev = process.env.CP_ARM;
  process.env.CP_ARM = arm;
  const dst = t.workDirFor("upgraded");
  if (prev === undefined) delete process.env.CP_ARM; else process.env.CP_ARM = prev;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/]node_modules$/.test(p) });
  for (const nm of ["node_modules", "frontend/node_modules"]) if (fs.existsSync(path.join(src, nm))) fs.symlinkSync(path.join(src, nm), path.join(dst, nm), "dir");
  const files = applyEdits((f) => fs.readFileSync(path.join(dst, f), "utf8"), m);
  for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(dst, f), s);
  // The copy's git sees the edit as uncommitted: its commit reads "<head>-dirty".
  try { execFileSync("git", ["update-index", "-q", "--refresh"], { cwd: dst }); } catch {}
  return arm;
}
