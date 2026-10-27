# Targets for the proof runs (16 Oct 2026)

This file covers PICK.md's day-1 spike 3: run the before-code of five target forks through the scenarios in
`SCENARIOS.md` and look for one real money-losing defect for the video.

**How the targets were checked:**
- metadata from the GitHub REST API, unauthenticated, 16 Oct 2026;
- candidates from Sourcegraph public search (`@paypal/checkout-server-sdk`, `paypal-rest-sdk`, `OrdersCaptureRequest`);
- a shallow clone of each in `out/targets/<name>/`, read only, with no installs and no code run.

Every defect below comes from reading the code. **None has run yet.** Each one is a hypothesis for the scenario
runs to confirm or kill.

## Ranking

| # | Repo | Licence | Stars, last push | Deprecated pieces | Node | Local run | Best defect |
|---|---|---|---|---|---|---|---|
| 1 | [kerkkoh/simple-clothing-store](https://github.com/kerkkoh/simple-clothing-store) | MIT | 73★, 8 May 2026 | `@paypal/checkout-server-sdk`; v5 script through `react-paypal-button-v2` (`paypal.Buttons`, client-side `actions.order.create/capture`) | engines `13.14.x`, Dockerfile `node:latest`; CRA 4 front end (needs Node ≤16, or `--openssl-legacy-provider`) | **Easy.** One Express file, no database. Needs a Printful stub (see below) | Confirms and ships an order that PayPal never captured |
| 2 | [mrvautin/expressCart](https://github.com/mrvautin/expressCart) | MIT | 2,251★, 23 Nov 2023 | `paypal-rest-sdk` (v1 Payments, redirect flow; `intent: sale`) | engines `>=10.16`; docker-compose `node:8` + `mongo:3.4` (try Node 16/18 + current Mongo) | **Medium.** MongoDB required (docker or local) | **Hero candidate:** marks an old, larger order "Paid" for a smaller payment |
| 3 | [sourcefuse/loopback4-microservice-catalog](https://github.com/sourcefuse/loopback4-microservice-catalog) `services/payment-service` | MIT | 297★, 14 Oct 2026 (active) | `@paypal/checkout-server-sdk` (Orders v2, server-side create/capture/refund) | `22 \|\| 24` | **Medium.** LoopBack 4 + Postgres + db-migrate; `sandbox/payment-example` exists | Marks Paid on order `COMPLETED` while the capture is `PENDING` |
| 4 | [CromwellCMS/Cromwell](https://github.com/CromwellCMS/Cromwell) `plugins/paypal` | MIT | 753★, 12 Jul 2024 | `paypal-rest-sdk` (v1 `payment.create` only) | not pinned in the root `package.json` | **Hard.** Yarn monorepo plus Next.js build; SQLite by default, so no database server | **Hero candidate:** the payment is never executed, so the store takes the order and PayPal moves no money |
| 5 | [HabitRPG/habitica](https://github.com/HabitRPG/habitica) | GPL-3.0 (GitHub shows NOASSERTION; `LICENSE` says "Code is GPL v3") | 14,219★, 15 Oct 2026 | `paypal-rest-sdk` (v1 payments, billing agreements) + `pp-ipn` | `20` | **Hard.** Large app, MongoDB | Possible money-losing bug (code reading only, not tested); reported privately, details withheld |

**First target for spike 2 (`/paypal:doctor fix-all`): simple-clothing-store.**
- It is the smallest app, and it carries both deprecated pieces: v5 client and `checkout-server-sdk`.
- It runs with no database.
- Its maintainer is active (pushed May 2026, and the repo has `AGENTS.md`/`CLAUDE.MD`), so an upstream PR could
  actually land if the owner approves one.

**Hero defect for the video:** expressCart's stale-order "Paid" (E1).
- It is fully real: a real sandbox payment and an honest buyer path, with no mock header.
- The order page literally reads "Paid", for more goods than were paid for.

Backups:
- Cromwell's never-executed payment (C1): every PayPal order is unpaid, but the app is the costliest to run.
- simple-clothing-store's unpaid confirm (D1): cheap to run, but it needs a direct API call rather than a buyer flow.

**Disclosure rule:**
- If Habitica H1 or any defect in an active project (sourcefuse, simple-clothing-store) is real and exploitable, it
  is reported privately to that project (security policy or e-mail) before it appears in a video or a public fork.
- That report is an outward-facing step, so it needs the owner first.
- The video uses inactive or tutorial-grade repos (expressCart, Cromwell), where a public fork is a normal bug report.

## Dropped, and why

| Repo | Why |
|---|---|
| WebDevSimplified/paypal-checkout (54★, 33 forks) | **No licence.** GitHub shows none and there is no LICENSE file; `package.json` says `ISC`, but that is npm's default. It is also a demo with no order state: client-side `actions.order.capture()` (`public/script.js:105-107`) and nothing records payment, so there is nothing to lose money on. It stays out of the 0:15 shot unless the owner accepts an unlicensed fork |
| jrussbautista/dress-shop (321★) | **No licence.** It would otherwise be a good target: `server/src/controllers/checkoutController.ts:107-127` creates a paid order from any capture response without checking `captures[0].status`, and with no amount check. Also MongoDB, PHP currency |
| cpinitiative/usaco-guide (1.9k★) | Licence CC BY-NC-SA 4.0 (not OSI), and `@paypal/checkout-server-sdk` is declared in `src/functions/package.json:19` but never imported |
| levelopers/Ecommerce-Nodejs (MIT, 209★) | It keeps no order or paid state (`routes/index.js:224-241` only echoes the payment), so there is nothing to corrupt; the `else` branch never responds |
| mayeaux/nodetube (MIT) | `paypal-rest-sdk` is only a commented-out `require` (`controllers/backend/internalApi.js:37`) |
| shopnex-ai/shopnex (MIT) | The SDK is only a dependency of `packages/builder-io-plugin`; no checkout code uses it |
| sangammukherjee/mern-ecommerce-2024, quintuslabs/fashion-cube, bradtraversy/node_paypal_sdk_sample, nuuxcode/BikeHub | No licence (GitHub API) |

## Per-target detail

### 1. simple-clothing-store (MIT)

**PayPal code**
- `server.js:85-116`, `POST /api/confirm/:orderId`: `OrdersGetRequest`, then it confirms the Printful order.
- `lib/paypal.js:9-34` holds the SDK client; it is hard-wired to `SandboxEnvironment`.
- `frontend/src/components/order/Payment.js:11` captures on the client; `:27-71` creates the order on the client.

**To run:**
- `PAYPAL_CLIENT_ID`/`SECRET` in `.env`, plus `frontend/src/config.js:11`.
- `DEMO=1` makes confirm push to an in-memory array instead of calling Printful (`server.js:104-107`).
- Start-up calls `api.printful.com` for products and store (`server.js:26-68`). The host is hard-coded at
  `lib/printfulclient.js:102`, so the fork needs a one-line, disclosed test seam (`PRINTFUL_HOST`) and a ~50-line
  local Printful stub serving `store/products`, `store` and `orders/:id`.

**Candidate defects**
- **D1 (money-losing): confirm never checks payment status.** `server.js:98-102` checks only that the Printful draft
  total equals `purchase_units[0].amount.value`. It never checks `order.status === 'COMPLETED'` or the capture status.
  - Scenario: create the draft (`POST /api/orders`), create a PayPal order with the same amount and `custom_id`, and
    never approve it. Then `POST /api/confirm/<id>`, and the store confirms an unpaid order.
  - A `PENDING` capture is confirmed the same way.
- **D2 (money-losing): currency never compared.** The amount check compares `value` only. The client sets
  `currency_code` (`Payment.js:36`), so "45.00" in a cheaper currency passes.
- **D3 (state):** capture happens on the client, then a separate confirm POST follows (`Payment.js:11-17`, no
  `.catch`). If the confirm fails after a successful capture, the buyer has paid, nothing ships, the spinner never
  stops, and no webhook reconciles it.
- **D4:** a declined capture (`INSTRUMENT_DECLINED`) rejects `actions.order.capture()` unhandled, and there is no
  `actions.restart()`.
- **D5:** confirm is not idempotent. A second POST pushes or confirms again.
- **D6:** `server.js:115`: on a Printful error the request never gets a response.

### 2. expressCart (MIT)

**PayPal code**
- `lib/payments/paypal.js:128-232` is `/paypal/checkout_action`, which creates the v1 payment and the order doc.
- `:14-125` is `/paypal/checkout_return`, which executes the payment and sets the status.
- `views/partials/payments/paypal.hbs:1-4` holds the form button.
- Config is in `config/payment/config/paypal.json`.

**Candidate defects**
- **E1 (money-losing, hero): stale order reuse.** `:208-212`: if `req.session.orderId` exists ("probably from a
  failed/cancelled payment previously"), it redirects to the new PayPal payment **without updating the order doc**.
  `orderId` is cleared only by `emptyCart` (`lib/cart.js:81`), which runs on success.
  - Scenario: put a €480 cart through checkout, then cancel at PayPal. Reduce the cart to €12 and check out again.
    Pay €12. The €480 order (old products, old `orderTotal`) is set to **Paid** (`:89`).
  - No mock header needed.
- **E2 (money-losing):** `:51` sets Paid on `payment.state === 'approved'` without reading
  `transactions[0].related_resources[0].sale.state`, so a `pending` sale counts as paid.
- **E3:** `:48` defaults `paymentStatus` to `'Approved'`. An executed payment that is neither approved nor
  `failureReason` is stored as "Approved".
- **E4:** `:76` records the transaction amount from the session, not from PayPal's response, so there is no
  amount or currency reconciliation.
- **E5:** `:29-39`: `error.response` is undefined on network errors, which crashes the handler.
  `PAYMENT_ALREADY_DONE`, from a refreshed return URL, is shown to a buyer who did pay as a failure.
- **E6:** there is no webhook or IPN, so reversals and refunds never reach the order.
- **E7 (sandbox-confirmed, spike 3 and M2):** reloading the return URL re-executes the payment, inserts a second
  transaction and crashes the whole process on `order.orderEmail` of `null`.
- **E8 (sandbox-confirmed, M2, 17 Oct):** `paypal.configure()` is called only in `checkout_action`. After any
  restart (a deploy, or the E5/E7 crash), the return handler executes with no credentials ("Client Authentication
  failed"), so every payment in flight at that moment fails, including ones the buyer already approved.

### 3. sourcefuse payment-service (MIT)

**PayPal code:** all of it is in `services/payment-service/src/providers/paypal/paypal-provider.service.ts`.
- `create` at `:68-143`, `charge` (capture) at `:144-187`, `refund` at `:188-226`.
- The webhook is a stub at `:239-241`.
- Unit tests: `src/__tests__/unit/paypal-provider.unit.ts`.

**Candidate defects**
- **S1 (money-losing):** `:155` sets Paid when `order.status === 'COMPLETED'`. Orders v2 returns `COMPLETED` with
  `captures[0].status = PENDING` (or `DECLINED` for cards), and `:173` stores the capture ID either way.
- **S2:** `:149-153` checks "not Paid" and then captures with no `PayPal-Request-Id`, so concurrent calls both
  capture. The loser gets `ORDER_ALREADY_CAPTURED`. Capture errors (`INSTRUMENT_DECLINED`, `ORDER_NOT_APPROVED`) are
  thrown raw, giving a 500 with no restart path.
- **S3:** `:195-212` always refunds the full `totalAmount` with no `PayPal-Request-Id`. It treats a `PENDING` refund
  as failure ("please check transactionId"), so a retry can start a second refund.
- **S4:** `:129-141` returns the stored PayPal order and pay link even if the merchant order total changed since
  (unverified: it depends on whether orders can be updated).
- **S5:** there is no webhook handling or verification.

### 4. Cromwell (MIT)

**PayPal code**
- `plugins/paypal/src/backend/actions/create-payment.action.ts:55-107` is the whole plugin. It only
  `paypal.payment.create`s and returns the approval link.
- `toolkits/commerce/src/base/Checkout/actions.ts:85-90,352,366`: the popup returns with `?paymentStatus=success`,
  `window.opener.paySuccess()` runs, and then `placeOrder()`.
- `system/server/src/services/store.service.ts:268` takes `paymentMethod` from the client.

**Candidate defects**
- **C1 (money-losing, hero backup):** nothing ever calls `paypal.payment.execute`; the plugin contains no
  `execute`, `get` or webhook. A v1 payment that is approved but never executed moves no money, yet the store places
  the order after the popup.
  - The split screen: the store's order list shows the order, while the sandbox merchant account shows no
    transaction.
- **C2:** "success" is a client-side query parameter, so the server never verifies anything.
- **C3:** `successUrl`/`cancelUrl` come from the request body (`:29-36`, `:84-87`).
- **C4:** `:90-97` swallows create errors and returns nothing.

### 5. Habitica (GPL-3.0)

Possible money-losing bug in the PayPal gem purchase, found by reading the code and not tested. Reported privately to Habitica on 18 Oct 2026 (no reply yet); details withheld until it is fixed.

## What the day-1 spikes need from the owner

These are about 15 minutes in the browser, and none of them costs money.

1. **Sandbox accounts in Spain:**
   - on <https://developer.paypal.com/dashboard/accounts>, one **business** (merchant) account and one **personal**
     (buyer) account, both country ES and currency EUR;
   - give the personal account a balance and, for card-fields fallback runs, a generated card;
   - note the buyer's e-mail and password for `.env`.
2. **A REST app** (Apps & Credentials, Sandbox) linked to that business account.
   - Copy its client ID and secret into `checkout-proof/.env` yourself; they never go in chat or git.
   - In the app's features, tick **Transaction Search** (for the evidence and the "PayPal shows no capture" check;
     results can lag up to 3 hours) and leave Accept payments on.
3. **A sandbox webhook** on that app, pointing to the HTTPS:443 listener we will give you (Cloud Run or a tunnel).
   - Subscribe to `CHECKOUT.ORDER.APPROVED` and to `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DENIED`, `.REFUNDED`
     and `.REVERSED`.
   - Paste its **webhook ID** into `.env` as `PAYPAL_WEBHOOK_ID`.
4. **The PayPal AI Toolkit plugin in Claude Code**: run `/plugin install paypal@claude-plugins-official` once in an interactive session in this repo,
   so spike 2 can run `/paypal:doctor` and `fix-all` on the simple-clothing-store fork.
   - It may ask for the same sandbox client ID and secret, and it connects PayPal's MCP to sandbox only.
5. **No GitHub forks yet.** The spikes run on the local clones. Creating forks under the owner's account is a
   separate, outward-facing yes (PICK.md, "Owner gates").
