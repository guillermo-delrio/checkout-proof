# Spike 2: does PayPal's own tooling already finish the upgrade? (16–17 Oct 2026)

**Verdict: no, so the kill line is not hit. The client half is close to commodity; the server half is not.**
- **Doctor `fix-all` alone** leaves the app on JS SDK v5 and `@paypal/checkout-server-sdk`. It never flags either one
  as deprecated, and it fixes nothing that loses money.
- **Doctor plus the v5→v6 guidance** (plugin `paypal-best-practices` + RulesHub upgrade-to-v6), applied by Claude
  Code:
  - produces a v6 client that captured in sandbox, after one fix that only running the app found;
  - produces server code in raw `axios`, never `@paypal/paypal-server-sdk`. The deprecated SDK stays in.
- **Both money-losing defects survive the guided upgrade:** confirm-without-payment (D1) and wrong-currency
  payment (D2).

**Reframing (not a kill):**
- The v5→v6 *client* diff is close to commodity for any agent holding RulesHub, so it leaves the video, as planned.
- The entry's own ground is:
  - the server-SDK move, which PayPal's guidance never makes;
  - the run that catches what static guidance misses (the invisible button);
  - the defects that survive a "best practices" upgrade.

## What was run

The work copy is `out/work/simple-clothing-store-doctor/`, with a git log of one commit per stage (patches in
`out/s2/patches/`). The log and the full doctor report are in `out/work/simple-clothing-store-doctor/DOCTOR-LOG.md`.

| Stage | How | Output |
|---|---|---|
| 1. `/paypal:doctor fix-all` | Skill tool (`paypal:doctor`, plugin 1.2.0), followed literally | 4 CRITICAL, 8 WARNING. CRITICAL fixes applied: cached SDK client, `intent: 'CAPTURE'`, `INSTRUMENT_DECLINED` → `actions.restart()`, a verified webhook route. Live probes stopped at the MCP auth probe (401 "Token signature verification failed"; the plugin's MCP token is not this app's) |
| 2. v5→v6 guidance | Skill tool (`paypal:paypal-best-practices`) → `references/js-sdk-v6.md` → RulesHub `upgrade-to-v6` rules and JS snippets | `Payment.js` rewritten to `createInstance` / `findEligibleMethods` / `createPayPalOneTimePaymentSession` / `<paypal-button>`; 4 server endpoints from the snippets (client token, create, capture, get) in `axios`; `react-paypal-button-v2` removed |
| 3. Run it | CRA build. `--legacy-peer-deps` is needed for the original too. `DISABLE_ESLINT_PLUGIN` is needed only because the root dev deps (`eslint-config-google`) were not installed, Printful stub, Playwright | Button never shown → one run-found fix → full wallet flow captured |

## Results against the four questions

| Question | Doctor only | + guidance | + 1 run-found fix |
|---|---|---|---|
| Runs? | Server passes `node --check`; front end still v5 (not rebuilt at this stage) | Builds and serves. v6 script loads, `createInstance` and eligibility succeed, **but the PayPal button never appears**: React 17 writes `hidden="false"` on the custom element. No console error | Yes |
| Uses v6? | No (v5, `react-paypal-button-v2`) | Yes; no v5 script on the page | Yes |
| `@paypal/paypal-server-sdk` on the server? | No | **No.** RulesHub snippets are raw `axios`, and `/api/confirm` keeps `@paypal/checkout-server-sdk` | No |
| Captures correctly in sandbox? | n/a | Server path, yes: order `5X500147W7088633B`, capture `0NW1855332236523C` COMPLETED 62.00 EUR | Yes, through the real v6 popup: order `01H07147HT341814A`, capture `4MM54645ES299851T` COMPLETED 62.00 EUR, shop confirmed |

**Defects after the guided upgrade** (`out/s2/verify.jsonl`):

| Scenario | Result | Evidence |
|---|---|---|
| 7a, confirm unapproved order (D1) | **Still broken.** The shop confirms (200, status `pending` = confirmed) | `96A36273XC666072M` is `PAYER_ACTION_REQUIRED`, no capture |
| 11, currency tampering (D2) | **Still broken.** The new create endpoint takes `currency` from the client, so €62.00 is confirmed for 62.00 MXN | `2JM08583592068347`, capture `0GF70549X0920035J` COMPLETED 62.00 MXN |
| 5, declined (mock) | Better: the capture endpoint returns 422 `INSTRUMENT_DECLINED` and the shop stays `draft` | `50348592RF492791R`, debug `ca4ba6c4e29c7` |

## What the toolkit says vs. does (useful for the pitch)

- The doctor's check tables have no "deprecated SDK" check for v5 or `checkout-server-sdk`. The server SDK appears
  only in the file-discovery step.
- The React guidance contradicts itself:
  - the plugin says React v6 "is available — do not warn";
  - RulesHub says "CANNOT … Upgrade React integrations … continue using current library";
  - neither ships React v6 code.
- RulesHub's capture snippet calls itself validation but only `console.log`s the amount. It never checks
  `captures[0].status`, and it sends a fresh random `PayPal-Request-Id` per call, so a retry is not idempotent.
- The create snippet takes `amount` and `currency` from the request body. Its "CRITICAL: validate amount
  server-side" checks only that the amount is a positive number. Following the guidance faithfully is what carried
  D2 into the upgraded code.

## Side notes for other spikes

- The v6 wallet **popup** completed headless in Playwright with no captcha (one run, 17 Oct, around 00:16 CEST).
  Spike 1's first popup run hit a captcha.
- The redirect approve link worked on every run in spike 3, but the sandbox sometimes hangs on "Obteniendo tu
  cartera". A page reload recovers it.
- The sandbox buyer pages render in Spanish whatever the locale. Approve-button selectors need the Spanish labels.
