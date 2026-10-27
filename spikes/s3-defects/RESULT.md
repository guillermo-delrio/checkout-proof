# Spike 3: original target code through the scenarios (16–17 Oct 2026)

**Verdict: the video has its hero.**
- In expressCart, an honest sandbox buyer cancels a €480 cart, shrinks it, and pays €85. The shop marks the €480
  order (8 items) **Paid**.
- It is reproduced 2 of 2, with no mock header and no tampering.
- Four more money-losing defects are confirmed on real sandbox orders. The mock-code sweep came back 26 of 26.

Everything ran on local copies in `out/work/<name>/`, against the sandbox only. Logs are in `out/s3/*.jsonl`,
screenshots in `out/s3/*.png`, and the harness in `harness/`. Run commands are at the end.

## Confirmed defects

| # | Target | Defect | Real sandbox evidence | Shop's record | Screenshot (`out/s3/`) |
|---|---|---|---|---|---|
| **E1** | expressCart (v1 Payments) | **Stale order reuse. The hero.** Cancel at PayPal, shrink the cart (remove the boots, jackets 4→1), check out again, pay. The old order is set to Paid | Payment 1 `PAYID-NLJJ3SI6M215114D0845103G`: €480.00, state `created`, never executed. Payment 2 `PAYID-NLJJ3UQ5C620188W8285235C`: €85.00, sale `60250968YB4425223` **completed**. Repeat run: `PAYID-NLJJ5PA9M513581JA485570X` (created, €480) / `PAYID-NLJJ5RA2DJ68654GY776813A`, sale `70585006881453733` €85.00 completed | Order `6ad29dca89aa9cad97f6f442`: **Paid**, total €480, 4× Red Wing boot + 4× Duckworth jacket, shipping €0; its `orderPaymentId` is the unexecuted €480 payment. The transaction says €85. Repeat: order `6ad29ebc18dde098b9151c93`, same result | `ec-e1-run8-1-payment-big-cart.png` (€480), `-2-payment-small-cart.png` (€85), `-3-paypal-approve.png` (PayPal shows 85,00 EUR), `-5-admin-order.png` (**Paid, €480, 8 items**); run9 the same |
| **D1** | simple-clothing-store (`checkout-server-sdk`) | Confirm never checks payment: `POST /api/confirm/<id>` on an unapproved order | `7KL7563527632970V`: `CREATED`, no capture. Earlier runs: `8EY644630J0534339`, `4YK95059TT804220N` (CREATED) and `8RV46951A2224293L` (APPROVED, never captured) | Order 9000001: status `pending`. The order page shows a green **"Paid ✓"** badge with confetti | `scs-3101-d1-created-9000001.png` |
| **D2** | simple-clothing-store | Currency never compared: the client sends `currency_code`, so the buyer pays 62.00 MXN (about €3) for a €62.00 order. Real approval and capture | `3FY963146M705913F`, capture `4V439525992497501` **COMPLETED 62.00 MXN**. Earlier: `4NX18253W2437361G` / `73R230412M259522B` | Order 9000002 (€62.00 EUR): **Paid ✓** | `scs-3101-d2-currency-9000002.png`, `scs-d2-approve-3FY963146M705913F.png` |
| **S1** | sourcefuse payment-service (original `PaypalProvider`, run in isolation) | Marks Paid when the order is `COMPLETED`; a declined card capture returns exactly that | `4WY309204D9078844`: the capture response says order `COMPLETED`; capture `6HV34939TE5128523` is **DECLINED** (PayPal `GET` shows the order `CREATED`) | App order `paid`, transaction `paid` with `captureId` of the declined capture | none (no UI; log in `sf.jsonl`) |
| **C1** | Cromwell plugin-paypal (original `createPayment`, run in isolation) | Never executes the v1 payment. The buyer approves, PayPal redirects to `successUrl?paymentStatus=success` (the only signal the checkout waits for), and no money moves | `PAYID-NLJKBHI2HA31929775118206`, €45.00: state `created`, 0 related resources, 60 s after approval | Not run: `placeOrder()` on that signal is read from `toolkits/commerce/.../Checkout/actions.ts:85-90,352-366` | none |
| **E7** (new) | expressCart | Reloading the PayPal return URL **crashes the whole shop process**. The re-execute succeeds (200), a second transaction is inserted (amount 0, pointing at a non-existent order), then `order.orderEmail` on `null` throws inside a Mongo callback | `PAYID-NLJJ5CY6XG05294BF5366106`: the execute log shows two `200`s | Node exits; the shop is down for every customer until restarted. Duplicate transaction `6ad29e9a89aa9cad97f6f452` | `ec-refresh-r2-1-after-return.png` |
| **D7** (new, stub-based) | simple-clothing-store, production mode (no `DEMO`) | Confirm posts to Printful with the **PayPal** order ID (`pf.post(\`orders/${orderID}/confirm\`)`, `server.js:110`) instead of the Printful ID. Every paid order fails to confirm, and the buyer's spinner never stops (no `.catch`) | `3HE176378R3255108`, capture `8EH365485V424481L` COMPLETED €62.00 | Order stays `draft`; the stub logged `POST orders/3HE176378R3255108/confirm` → 404 → 400. Real Printful's response to a non-numeric ID is assumed from its API docs, not seen | none |

Notes on scope:
- **D1 and D2 bite only in `DEMO` mode** (the published demo), because D7 breaks production confirms first. Fixing
  D7 (a one-word change) turns D1 and D2 into shipped-but-unpaid orders.
- The project is active, so the disclosure rule in TARGETS.md applies: report privately with the owner's approval
  before any public use.

## Hypotheses killed or weakened

| # | Result |
|---|---|
| S2 (concurrent capture) | **Killed as money-losing.** Two simultaneous `charge()` calls each got HTTP 201 from PayPal, with **one** capture (`48E2271326790625H` / `3C064446L4880672A`); PayPal deduplicated them. A mocked `INSTRUMENT_DECLINED` is thrown raw (422, no restart path), but the order stays unpaid and a retry succeeds |
| S3 (double refund) | **Killed as money-losing.** The second full refund was rejected with `DUPLICATE_INVOICE_ID`, because the provider sets `invoice_id` to the order ID (refund `7PA36981LD4892415`; capture `5GW018558T736202L` REFUNDED once) |
| D5 (double confirm) | Confirmed but cheap: two confirms both return 200 (`0BH82619Y69862417`). In DEMO mode it pushes twice; in production D7 stops it first |
| E-declined (mock `INSTRUMENT_DECLINED` on execute) | The shop handles it acceptably: the order stays `created` and the buyer sees "Your payment has failed". But the session keeps `orderId`, so the next checkout reuses that order: it is the entry point to E1 |
| E2 / S1-pending / scenario 10 | Not testable yet. An ES merchant paid in MXN still returned `COMPLETED`; producing `PENDING` needs the receiving-preference change (owner dashboard step) or a labelled synthetic rewrite |

## Mock codes (SCENARIOS.md updated)

**26 of 26 code-and-API pairs came back from the sandbox** with the requested code:
- Orders v2: 3 create, 8 capture (including `INTERNAL_SERVER_ERROR`, now seen as a working mock with HTTP 500) and
  2 authorize;
- Payments v2: 7 refund and 1 authorization-capture;
- Payments v1: 1 create and 4 execute.

Caveats:
- `ORDER_NOT_APPROVED` and `PAYMENT_NOT_APPROVED_FOR_EXECUTION` were sent on unapproved resources, where the real
  error is identical (the control run shows it).
- Refund mocks did not refund: the target capture stayed `COMPLETED`.

Log: `out/s3/mock-codes.jsonl`, with each call's debug ID.

Card-decline shape (scenario 5, which asked to "check on day 1"): capture → HTTP **201**, order `COMPLETED`, capture
`DECLINED`.

## Not run

- **Habitica: skipped.** It needs MongoDB plus a large app build and its payment libs pull in the user/gems
  models; that is heavy setup, and the spike allowed skipping it. H1 stays an unverified hypothesis. Nothing was
  probed, so there is nothing to flag in `out/`.
- **Cromwell full app: skipped** (yarn monorepo + Next build). Only the plugin's `createPayment` ran, with
  `@cromwell/*` stubbed.
- **sourcefuse full service: skipped** (LoopBack + Postgres). The original `paypal-provider.service.ts` was bundled
  with esbuild, with DI decorators and repositories replaced by in-memory stubs
  (`out/work/sourcefuse-payment-service/build.mjs`).

## What is synthetic, and disclosed

- **Printful:** a local stub (`harness/printful-stub.mjs`). The target code is unmodified; `harness/preload.cjs`
  reroutes `api.printful.com`.
- **Mock headers:** added by `preload.cjs` to the next matching PayPal call (`out/s3/mock-<port>.json`). The target
  code is unmodified.
- **S1's card leg:** `preload.cjs` replaces the provider's empty capture body with a card `payment_source` (name
  `CCREJECT-REFUSED`). It stands in for a buyer who pays by card on PayPal's page. PayPal's response, and the
  provider code that reads it, are real.
- **Buyer approvals:**
  - real sandbox buyer logins through Playwright on the redirect approval page (login selectors adapted from
    `spikes/s1-buyer/buyer.mjs`);
  - expressCart was driven entirely through its own UI;
  - simple-clothing-store orders were created by the harness with the same payload its client sends (create
    happens in the browser in that app).

## Reproduce

```
docker start cp-mongo                                  # mongo:4.4 on 127.0.0.1:27018 (expressCart)
harness/run-scs.sh <abs>/out/work/simple-clothing-store 3101 4101 1     # background; 0 = production mode
harness/run-ec.sh                                      # background; writes sandbox creds into the work copy's
                                                       # gitignored config/payment/config/paypal.json
cd harness && node ec-e1.mjs runN                      # hero
SHOTS=1 D2_CURRENCY=MXN node scs-defects.mjs 3101 d1-created d2-currency happy
node ec-flow.mjs refresh rN                            # E7 (restart the shop after)
MOCK_FILE=… INJECT_FILE=… PP_LOG=… node -r ./preload.cjs sf-provider.mjs s1-declined-card
node cromwell-c1.mjs ; node mock-codes.mjs <completed capture id>
```

Hero runs 1–7 were harness iterations: selectors, Spanish PayPal labels, and the finding that emptying the cart
clears the stale order. Runs 8 and 9 are the clean reproductions.
