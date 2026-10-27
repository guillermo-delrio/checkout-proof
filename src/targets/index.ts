// The targets the CLI knows, and what differs per target for prove, upgrade, loop and pack.
import type { Adapter, Variant } from "./types.ts";
import type { Finding } from "../scan/scan.ts";
import { scsAdapter, workDirFor as scsWorkDir } from "./simple-clothing-store.ts";
import { ecAdapter, workDirFor as ecWorkDir, configureWorkCopy } from "./expresscart.ts";
import { EC_SCENARIOS } from "../prove/ec-scenarios.ts";
import { upgradePrompt, plainUpgradePrompt, ecUpgradePrompt, ecPlainUpgradePrompt, CONTRACT, WEBHOOK_CONTRACT, MONEY_RULES, EC_CONTRACT, EC_MONEY_RULES } from "../upgrade/prompts.ts";

export interface TargetDef {
  name: string;
  modes: string[];                                   // proof modes run by loop and combined by pack
  workDirFor(v: Variant): string;
  adapter(v: Variant, runDir: string, mode: string): Adapter;
  upgradePrompt(f: Finding[]): string;
  plainPrompt(f: Finding[]): string;
  contract: string; rules: string;
  dropOnCopy: string[];                              // build output not copied into the upgraded work copy
  diffExcludes: string[];
  beforeLabel: string; afterLabel: string;
  intro: string;                                     // PR body: what the change does
  runsNote: string;                                  // PR body: how the rows were produced
  harnessNote: string;                               // PR body: test harness disclosure
  configureUpgraded?(dir: string): void;
  videoHowTo?: Record<string, string[]>;            // per scenario id: notes for re-enacting it on camera
}

export const TARGETS: Record<string, TargetDef> = {
  "simple-clothing-store": {
    name: "simple-clothing-store", modes: ["demo", "production"],
    workDirFor: scsWorkDir, adapter: (v, d, m) => scsAdapter(v, d, m as "demo" | "production"),
    upgradePrompt, plainPrompt: plainUpgradePrompt, contract: `${CONTRACT}\n\n${WEBHOOK_CONTRACT}`, rules: MONEY_RULES,
    dropOnCopy: ["build", "frontend/build"], diffExcludes: ["package-lock.json", "frontend/package-lock.json"],
    beforeLabel: "Original (v5 + checkout-server-sdk)", afterLabel: "Upgraded (v6 + paypal-server-sdk)",
    intro: "This moves simple-clothing-store off JS SDK v5 (`react-paypal-button-v2`) and the deprecated `@paypal/checkout-server-sdk` onto JS SDK v6 and `@paypal/paypal-server-sdk`. Orders are created and captured on the server from the shop's own prices, and an order is confirmed only when PayPal reports a completed capture for an order this server created for it, in the shop's amount and currency.",
    runsNote: "Every row is a real PayPal sandbox run through this app's own server, in both the published demo mode (`DEMO=1`) and production mode (Printful confirm, against a local Printful stub). IDs are sandbox order IDs with their captures as PayPal's `GET /v2/checkout/orders/{id}` reports them.",
    harnessNote: "Test harness (not part of this change): a Node preload that adds `PayPal-Mock-Response` or drops a response on the shop server's next PayPal call and logs every PayPal call, a local Printful stub, and a Playwright sandbox buyer.",
  },
  expressCart: {
    name: "expressCart", modes: ["default"],
    workDirFor: ecWorkDir,
    adapter: (v, d) => Object.assign(ecAdapter(v, d), { scenarios: EC_SCENARIOS }),
    upgradePrompt: ecUpgradePrompt, plainPrompt: ecPlainUpgradePrompt, contract: EC_CONTRACT, rules: EC_MONEY_RULES,
    dropOnCopy: [], diffExcludes: ["package-lock.json", "bin/googleproducts.xml", "config/settings.json", "config/settings-local.json", "config/payment/config/paypal.json"],
    beforeLabel: "Original (v1 Payments redirect, paypal-rest-sdk)", afterLabel: "Upgraded (Orders v2 + JS SDK v6 + paypal-server-sdk)",
    intro: "This moves expressCart's PayPal checkout off the deprecated v1 Payments redirect (`paypal-rest-sdk`) onto Orders v2 with `@paypal/paypal-server-sdk` on the server and a JS SDK v6 `<paypal-button>` in the browser. Each PayPal order is priced from the session's current cart on the server and bound to an order document holding exactly that cart; an order becomes Paid only when PayPal reports a completed capture for it, in the order's amount and currency.",
    runsNote: "Every row is a real PayPal sandbox run through the shop's own server and pages, with a real sandbox buyer approving on PayPal. The shop's record is its MongoDB `orders.orderStatus`; PayPal's is `GET /v1/payments/payment/{id}` (before) or `GET /v2/checkout/orders/{id}` (after). The pending-capture row is SIMULATED: the harness rewrites PayPal's answer to PENDING before the shop sees it (no sandbox route produces a pending capture with the account's default settings).",
    harnessNote: "Test harness (not part of this change): a Node preload that adds `PayPal-Mock-Response`, drops a response, or (labelled SIMULATED) rewrites a capture to PENDING on the shop server's PayPal calls and logs every PayPal call; it also feeds the sandbox credentials to the original's config file from the process environment. A standalone MongoDB 6.0 and a Playwright sandbox buyer.",
    configureUpgraded: (dir) => configureWorkCopy(dir, "upgraded"),
    videoHowTo: {
      "cancel-shrink": [
        "Start the shop with the proof's settings: `npm run cp -- prove expressCart --variant original --only happy` leaves the work copy configured; for a take, start it the same way (`node -r harness/preload.cjs app.js` in `out/work/expressCart` with the env the adapter sets, port 1111) or reuse `ecAdapter().start()` from a flow script.",
        "Products: `/product/ranger-boot` and `/product/duckworth-jacket`, button `.product-add-to-cart`; 4 clicks each give the 480.00 EUR cart (with free shipping over the threshold).",
        "Checkout: `/checkout/information` (fields `#shipEmail`, `#shipFirstname`, `#shipLastname`, `#shipAddr1`, `#shipCountry` = Spain, `#shipState`, `#shipPostcode`, `#shipPhoneNumber`, then `#checkoutInformation`), then `/checkout/payment`, button `#checkout_paypal`.",
        "At PayPal, cancel before logging in: the link 'Cancelar y volver a Test Store' (ES buyer) at the bottom.",
        "Shrink on `/checkout/cart`: delete the boots line (`.btn-delete-from-cart`), press `.btn-qty-minus` three times on the jackets. Do not empty the cart: emptying clears the stale order id and hides the bug.",
        "Pay again (85.00 EUR = 1 jacket at 60.00 + 25.00 shipping): the sandbox buyer logs in; the login fields are masked in every screenshot, keep them out of frame or blur them in the edit.",
        "Money shot: the admin view `/admin/order/view/<order id>` (login owner@test.com / test, expressCart's seed admin) reads Paid, 480.00 EUR, 4 boots + 4 jackets, next to PayPal's 85.00 EUR sale.",
        "Pacing: the proof's run took about 35 s end to end (timeline below); on camera, hold each screen 2-3 s, so a take is about 60-75 s before editing.",
      ],
    },
  },
};

export function targetDef(name: string): TargetDef {
  const t = TARGETS[name];
  if (!t) throw new Error(`unknown target ${name}; known: ${Object.keys(TARGETS).join(", ")}`);
  return t;
}
