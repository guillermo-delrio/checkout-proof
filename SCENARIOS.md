# Proof-wall scenarios (16 Oct 2026)

This catalogue designs 15 scenarios for a target's checkout, each run once on the original code and once after the
upgrade. Scenario 15 applies only to targets that authorize before capturing.

**What runs today.** Generated from the site's data by `npm run export-web` (scenario id, then its number in this
catalogue; the evidence pages show each run with PayPal's IDs):

<!-- generated:runs-today -->
- **expressCart** (one mode), 15 scenarios: `happy` (#1), `happy-ui` (#1), `cancel-shrink` (#3 + #11b), `unapproved` (#7a), `declined-retry` (#5), `duplicate` (#8a), `server-error-retry` (#9b), `lost-response` (#9a), `currency` (#11a), `amount` (#11a), `two-tabs` (#8), `create-refused` (#4), `pending-simulated` (#10 (simulated)), `currency-own` (#11b), `amount-own` (#11b).
- **simple-clothing-store** (demo and production mode), 18 scenarios: `happy` (#1), `happy-ui` (#1), `unapproved` (#7a), `declined-retry` (#5), `duplicate` (#8a), `currency` (#11a), `amount` (#11a), `currency-own` (#11b), `amount-own` (#11b), `create-refused` (#4), `server-error-retry` (#9b), `lost-response` (#9a), `payer-action` (#6), `capture-refused` (#5), `restart-approved` (#7b), `restart-pending` (#10c), `two-tabs` (#8), `webhook` (#12 #14, live re-run only).
<!-- /generated:runs-today -->

**Designed, not run:** 2 (card fields: neither upgraded shop has v6 card fields yet), 13 (refunds: neither original
shop's code issues a refund, so there is nothing of theirs to prove; the harness refunds its own test captures),
15 (authorizations: neither shop authorizes before capturing). Of 6, `PAYER_ACTION_REQUIRED` runs as a mocked refusal
on capture, not a real 3-D Secure challenge.

Each scenario lists:
- what it simulates;
- how to simulate it in sandbox;
- what a correct merchant does;
- the assertion the suite checks.

**Mock codes and how they were checked.** PayPal's negative-testing page ("Simulate negative responses with request
headers", updated 14 Oct 2026, <https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/>):
- sets `PayPal-Mock-Response: {"mock_application_codes": "<CODE>"}`;
- covers Orders v2 create, update, show, authorize and capture;
- covers Payments v2 authorization show, capture and void, and capture show and refund;
- covers Payments v1 create and execute.

It says valid codes are the ones in PayPal's error-message references. Each code below was checked against those
references, under the operation it is used on:
- the Orders v2 "Error Messages" page, sections Create / Authorize / Capture
  (<https://developer.paypal.com/api/rest/reference/orders/v2/errors/>);
- the Payments v2 schema `x-errors` and its per-operation examples
  (<https://developer.paypal.com/api/payments/v2/schema.json>);
- the Payments v1 schema (<https://developer.paypal.com/api/payments/v1/schema.json>).

Snapshots are in `out/docs/`.
- **Confirmed** means the code is listed for that operation in those references.
- The docs never promise that every listed code is honoured as a mock.
- **Unconfirmed** means it is not found in the docs for that use.
- **Seen (17 Oct 2026)** means the sandbox returned that code when the header was sent on that operation
  (`spikes/s3-defects/harness/mock-codes.mjs`, log in `out/s3/mock-codes.jsonl`). All 26 pairs below were seen.

**How the mock header reaches the merchant's server:**
- **New SDK:** `@paypal/paypal-server-sdk` 2.5.0 takes `paypalMockResponse` as a typed parameter on
  `OrdersController`/`PaymentsController` (round 3).
- **Before-code** (`checkout-server-sdk`, `paypal-rest-sdk`): the suite does not edit the target's PayPal calls.
  Instead it routes the SDK's API host through a local forwarding proxy that adds the header to the next matching
  call. The proxy is our test harness and is disclosed in the PR.
  - Unverified: each SDK's base-URL override. Fallback: a one-line, disclosed env hook in the fork's client wrapper.

**Sandbox inputs:**
- buyer: the ES personal account from `.env`;
- cards: `4012888888881881` (Visa) from <https://developer.paypal.com/tools/sandbox/card-testing/>, with rejection
  triggers typed in the cardholder name (`CCREJECT-REFUSED` 0500 DO_NOT_HONOR, `CCREJECT-IF` 5120 INSUFFICIENT_FUNDS,
  `CCREJECT-SF` 9500 SUSPECTED_FRAUD, `CCREJECT-EC` 5400 EXPIRED_CARD);
- webhooks: the simulator (dashboard, or `POST /v1/notifications/simulate-event`), HTTPS:443 only.
  - Simulated events "cannot be verified by posting back to the PayPal verify-webhook-signature endpoint".
  - They self-verify only with the literal webhook ID string `WEBHOOK_ID`
    (<https://developer.paypal.com/api/rest/webhooks/simulator/>).
  - Observed on our live listener (18 Oct 2026, PROGRESS "Webhook"): simulator REVERSED and DENIED events sent to our
    registered webhook did verify (200) by post-back, unlike that doc line. We rely on neither: scenarios 12 and 14
    run on PayPal's genuine deliveries for a real sandbox order.

**What every scenario records as evidence:**
- PayPal order ID, capture/refund IDs and `debug_id`;
- the merchant's order state before and after;
- PayPal's state from `GET /v2/checkout/orders/{id}` (and Transaction Search where it has caught up);
- pass or fail.

## Summary

| # | Scenario | Sandbox method | Mock codes (status) | Catches (TARGETS.md) |
|---|---|---|---|---|
| 1 | Happy path, PayPal wallet | Real buyer approval | none | baseline |
| 2 | Happy path, card fields (v6) | Test card 4012888888881881 | none | baseline |
| 3 | Buyer cancels | Real approval page, "Cancel and return" | none | E1 |
| 4 | Create order refused | Mock on create | `PAYEE_ACCOUNT_RESTRICTED`, `PAYER_CANNOT_PAY`, `DUPLICATE_INVOICE_ID` (confirmed) | C4 |
| 5 | Declined instrument | Mock on capture; card `CCREJECT-*` | `INSTRUMENT_DECLINED` (confirmed); v1 `INSTRUMENT_DECLINED`, `CREDIT_CARD_REFUSED` (confirmed) | D4, S2 |
| 6 | Buyer must act again / refused | Mock on capture | `PAYER_ACTION_REQUIRED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`, `TRANSACTION_REFUSED`, `COMPLIANCE_VIOLATION` (confirmed) | S2 |
| 7 | Paid before approval | Real unapproved order; mock on capture | `ORDER_NOT_APPROVED` (confirmed); v1 `PAYMENT_NOT_APPROVED_FOR_EXECUTION` (confirmed) | **D1**, C1, C2 |
| 8 | Duplicate capture | Real double capture; mock on capture | `ORDER_ALREADY_CAPTURED` (confirmed); v1 `PAYMENT_ALREADY_DONE` (confirmed) | S2, D5, E5 |
| 9 | Lost response, retry | Fault proxy drops the response after a real capture; mock 500 | `INTERNAL_SERVER_ERROR` (not in the docs as an issue code, but **seen**: HTTP 500 with that name) | S2, D3 |
| 10 | Pending capture | No mock exists; see below | none (**sandbox route unconfirmed**; paying an ES merchant in MXN came back `COMPLETED`, not `PENDING`) | **S1**, **E2**, D1, H2 |
| 11 | Amount and currency tampering | Client payload rewrite; cart change between create and capture | none | **E1**, **D2**, E4, H1 |
| 12 | Forged webhook | Unsigned / wrongly signed POST to the listener | none | E6, S5 |
| 13 | Refunds | Real full and partial refunds; mocks on refund | `REFUND_AMOUNT_EXCEEDED`, `CAPTURE_FULLY_REFUNDED`, `PENDING_CAPTURE`, `REFUND_FAILED_INSUFFICIENT_FUNDS`, `REFUND_NOT_ALLOWED`, `REFUND_TIME_LIMIT_EXCEEDED`, `TRANSACTION_DISPUTED` (confirmed) | S3 |
| 14 | Reversal or denial after payment | Webhook simulator, self-verified | none | E6, S5 |
| 15 | *(authorize-intent targets only)* Expired or repeated authorization | Mock on authorize / auth capture | `ORDER_EXPIRED`, `ORDER_ALREADY_AUTHORIZED` (confirmed, Orders authorize); `AUTHORIZATION_EXPIRED` (confirmed, Payments v2 auth capture) | none of the 5 |

**Mock-code tally:** 23 distinct codes confirmed in the docs for the operation they are used on.
- That is 25 code-and-API pairs: 12 Orders v2, 8 Payments v2 and 5 Payments v1. `INSTRUMENT_DECLINED` and
  `TRANSACTION_REFUSED` appear in both Orders v2 and v1.
- `INTERNAL_SERVER_ERROR` is not in the docs as a mock code, but it works as one.
- **Seen in sandbox, 17 Oct 2026: 26 of 26 pairs** (the 25 plus `INTERNAL_SERVER_ERROR`). Two caveats:
  - `ORDER_NOT_APPROVED` and v1 `PAYMENT_NOT_APPROVED_FOR_EXECUTION` were sent on unapproved resources, where the
    real error is the same code, so those two runs do not prove the mock overrides anything;
  - v1 errors carry the code in `name`; `details[0].issue` holds prose.
- Refund mocks returned 422 without refunding: the capture they targeted (`7RJ74432TY8540327`) stayed `COMPLETED`.
- No mock exists for a `PENDING` capture (scenario 10).

---

## 1. Happy path, PayPal wallet
- **Simulates:** a buyer pays with their PayPal balance.
- **Sandbox:** Playwright drives the ES personal account through the merchant's real button and the approval
  popup.
  - Fallbacks from PICK.md risk 1, in order: saved storage state; scenario 2's card fields; one human-recorded run.
- **Correct merchant:** creates the order server-side from its own prices and captures server-side.
  - It marks the order paid only on `captures[0].status == COMPLETED`, with amount and currency equal to its own
    total.
  - It stores the capture ID.
- **Assert:**
  - the merchant order is paid exactly once;
  - PayPal `GET order` shows `COMPLETED` with one `COMPLETED` capture;
  - merchant total = capture amount, with the same currency;
  - the capture ID is stored.

## 2. Happy path, card fields
- **Simulates:** a guest card payment, which is the fallback buyer leg if wallet automation is flaky.
- **Sandbox:** v6 `createCardFieldsOneTimePaymentSession` with `4012888888881881`, a future expiry and any CVV.
  It applies only after the upgrade, or to targets that already have card fields.
- **Correct merchant and assertion:** as scenario 1.

## 3. Buyer cancels
- **Simulates:** the buyer closes the popup, or clicks "Cancel and return" (v1 `cancel_url`).
- **Sandbox:** Playwright cancels on the real approval page. Then it changes the cart and checks out again.
- **Correct merchant:**
  - no order is paid and no stock is taken;
  - the cart is intact;
  - the next checkout creates a **fresh** PayPal order for the **current** cart and never reuses a stale one.
- **Assert:**
  - after the cancel, nothing is paid;
  - after the second checkout and payment, the paid order's items and total equal the second cart and the second
    capture (this catches expressCart E1).

## 4. Create order refused
- **Simulates:** PayPal refuses to create the order: merchant account restricted, buyer/seller combination
  blocked, or a reused `invoice_id`.
- **Sandbox:** mock on `POST /v2/checkout/orders` with `PAYEE_ACCOUNT_RESTRICTED`, `PAYER_CANNOT_PAY` or
  `DUPLICATE_INVOICE_ID` (all confirmed under Orders "Create order"). v1 targets use v1 create with
  `TRANSACTION_REFUSED` (confirmed in the v1 schema).
- **Correct merchant:** shows the buyer a clear error, creates no paid or "pending payment" order, and logs the
  `debug_id`.
- **Assert:**
  - an HTTP error reaches the client;
  - no merchant order is in a paid state;
  - the server did not crash and the next request works.

## 5. Declined instrument
- **Simulates:** the buyer's funding source fails at capture.
- **Sandbox:**
  - Orders capture with `INSTRUMENT_DECLINED` (confirmed under "Capture order");
  - for v1 targets, execute with `INSTRUMENT_DECLINED` or `CREDIT_CARD_REFUSED` (both in the v1 schema);
  - for card fields, the cardholder name `CCREJECT-REFUSED` or `CCREJECT-IF`. Card declines may come back as a
    created capture with `status: DECLINED` rather than an error. **Seen 17 Oct 2026:** the capture call returns
    HTTP 201 with order `status: COMPLETED` and `captures[0].status: DECLINED`; a later `GET` shows the order as
    `CREATED`. Any merchant that checks only the order status marks a declined card as paid (sourcefuse S1).
- **Correct merchant:** follows PayPal's "Handle funding failures": restart the payment so the buyer can choose
  another source (v5 `actions.restart()`, v6 restart the session). It never marks the order paid.
- **Assert:**
  - the merchant order is not paid;
  - the client is told to restart, rather than getting a generic 500 or an endless spinner;
  - a second attempt with a good source succeeds and leaves exactly one capture.

## 6. Buyer must act again, or PayPal refuses
- **Simulates:** PayPal needs the buyer back (for example 3DS or a new funding choice), too many attempts, or a
  risk or compliance refusal.
- **Sandbox:** capture mocks `PAYER_ACTION_REQUIRED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`,
  `TRANSACTION_REFUSED` and `COMPLIANCE_VIOLATION` (all confirmed under "Capture order").
- **Correct merchant:**
  - `PAYER_ACTION_REQUIRED` sends the buyer back to PayPal (the `payer-action` link);
  - the others end the attempt with a clear message;
  - none marks the order paid or retries silently.
- **Assert:** not paid; the right client action for each code; no unhandled exception.

## 7. Paid before approval
- **Simulates:** the merchant's confirm or capture endpoint is called for an order the buyer never approved, by a
  bug or by an attacker with an order ID.
- **Sandbox:**
  - **(a) real:** create an order through the merchant, skip approval, and call the merchant's capture or confirm
    endpoint directly (for simple-clothing-store, `POST /api/confirm/<id>` after a matching draft);
  - **(b) mock:** capture with `ORDER_NOT_APPROVED` (confirmed under "Capture order"). For v1, execute with
    `PAYMENT_NOT_APPROVED_FOR_EXECUTION` (v1 schema);
  - for Cromwell: let the buyer approve, then check that money actually moved.
- **Correct merchant:** fulfils only when **its own server** has a `COMPLETED` capture for this order.
  - Order status alone is not enough, and neither is a client-side "success" flag.
- **Assert:**
  - the merchant order is not paid or confirmed;
  - for Cromwell, every placed PayPal order has a matching completed transaction on PayPal. Before-code expectation:
    it has none (C1).

## 8. Duplicate capture (idempotency)
- **Simulates:** a double click, a page refresh on the return URL, two tabs or a client retry.
- **Sandbox:**
  - **(a) real:** fire the merchant's capture endpoint twice concurrently for one approved order, then again
    sequentially;
  - **(b) mock:** capture with `ORDER_ALREADY_CAPTURED` (confirmed under "Capture order"). For v1, refresh the
    return URL or mock `PAYMENT_ALREADY_DONE` (v1 schema).
- **Correct merchant:**
  - sends `PayPal-Request-Id` on capture, so a retry with the same ID "returns the latest status of the previous
    request" (<https://developer.paypal.com/api/rest/reference/idempotency/>);
  - takes a per-order lock, or makes its own paid transition idempotent;
  - treats `ORDER_ALREADY_CAPTURED` as "look up the order", not as a failure shown to a buyer who paid.
- **Assert:**
  - PayPal shows exactly one capture;
  - the merchant has one paid record, with no duplicate e-mail or fulfilment;
  - the second response tells the buyer they have paid (not a 500).

## 9. Lost response, then retry
- **Simulates:** the capture succeeds at PayPal, but the merchant never sees the response (timeout or 5xx), so it
  retries.
- **Sandbox:**
  - **(a)** a local fault proxy forwards a real capture and drops the response, and the merchant's retry follows;
  - **(b)** capture with `INTERNAL_SERVER_ERROR`. It is listed only as the generic 500 name on the errors page, not
    as an issue code, but the sandbox honours it (seen 17 Oct 2026: HTTP 500). A mock cannot model "captured but
    unseen", so (a) is the real test.
- **Correct merchant:**
  - retries with the **same** `PayPal-Request-Id`, or looks up `GET /v2/checkout/orders/{id}` before
    re-capturing;
  - ends paid exactly once;
  - for client-side-capture apps (simple-clothing-store), reconciles a capture whose confirm call was lost, by
    webhook or a lookup.
- **Assert:** one capture at PayPal, and the merchant ends paid, not "failed but charged".

## 10. Pending capture
- **Simulates:** the capture is accepted but funds are held: order `COMPLETED`, `captures[0].status = PENDING`
  with a `status_details.reason`. It later becomes COMPLETED or DENIED.
- **Sandbox, in order of preference (none confirmed in docs):**
  - **(a)** set the ES business account's payment receiving preferences to block or ask about currencies it does
    not hold, then pay in USD. Expected `PENDING` with `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`. Unverified.
    With the account's default preferences, an MXN payment came back `COMPLETED` (17 Oct 2026), so the preference
    must be changed first; that is a dashboard step for the owner.
  - **(b)** the fault proxy rewrites a real capture response's `captures[0].status` to `PENDING`. This is
    synthetic and must be labelled so on the proof wall.
  - **(c)** the webhook simulator's `PAYMENT.CAPTURE.PENDING`, then `PAYMENT.CAPTURE.COMPLETED` or `.DENIED`
    (event names confirmed on the event-names page).
- **Correct merchant:**
  - marks the order "awaiting payment" and does not ship;
  - flips to paid on `PAYMENT.CAPTURE.COMPLETED`, and to cancelled on `.DENIED`.
- **Assert:**
  - while pending, the merchant order is not paid or fulfilled;
  - after the COMPLETED event it is paid once; after DENIED it is cancelled.
  - Before-code expectations: S1 (sourcefuse) and E2 (expressCart) mark it Paid; D1 (simple-clothing-store)
    confirms it.

## 11. Amount and currency tampering
- **Simulates:** the paid amount or currency differs from what the merchant is selling.
- **Sandbox, three variants:**
  - **(a) client-created orders** (simple-clothing-store `Payment.js:32-68`): Playwright rewrites the client
    `createOrder` payload to the same `value` in a cheaper currency, or a lower value;
  - **(b) server-created orders:** change the cart between create and capture, or after a cancel (scenario 3's
    path);
  - **(c) session state:** start two checkouts in one session and complete the cheaper one.
- **Correct merchant:**
  - creates orders server-side from its own prices;
  - at capture, compares the capture's amount **and** currency with its own stored total for **this** order;
  - binds the PayPal order ID to the merchant order;
  - on a mismatch, refuses to fulfil (and refunds or flags).
- **Assert:**
  - no fulfilment where the captured amount or currency is not equal to the merchant total;
  - the paid order's items equal the cart that was priced.

## 12. Forged webhook
- **Simulates:** an attacker POSTs a fake `PAYMENT.CAPTURE.COMPLETED` (or `CHECKOUT.ORDER.APPROVED`) for a real
  unpaid order ID.
- **Sandbox:**
  - the suite POSTs to the merchant's listener with missing headers, then with a garbage `paypal-transmission-sig`,
    then with a body altered after signing;
  - the control: a genuine sandbox event from scenario 1, delivered to the registered webhook.
- **Correct merchant:**
  - verifies every event, either by `POST /v1/notifications/verify-webhook-signature` with its `PAYPAL_WEBHOOK_ID`,
    or by self-verifying: CRC32 of the raw body, then `transmissionId|timeStamp|webhookId|crc32` checked with the
    cert from `paypal-cert-url`, which must be on a PayPal domain
    (<https://developer.paypal.com/api/rest/webhooks/rest/>);
  - rejects the forged events with 4xx and changes no state;
  - also re-fetches the resource from the API before acting.
- **Assert:**
  - forged events: 4xx and no state change;
  - genuine event: 2xx and processed once.
  - Before-code targets with no listener record "no webhook handling" (a finding, not a pass).

- **As run (M4, upgraded simple-clothing-store, scenario id `webhook`, live re-run only):** forged deliveries go
  straight to the shop's own `POST /api/paypal/webhook` (no PayPal headers; a REVERSED event for the real capture
  with a real-looking cert URL and a garbage signature) and must get 4xx with the order unchanged. The genuine control
  is PayPal's own PAYMENT.CAPTURE.COMPLETED and REFUNDED deliveries for that order (see 14).

## 13. Refunds
- **Simulates:** the merchant refunds, fully or partially, and the refund can fail or be retried.
- **Sandbox:**
  - real `POST /v2/payments/captures/{id}/refund`: partial, then the remainder, then a retry of the same request;
  - mocks on refund, all confirmed in the Payments v2 `x-errors`, with `REFUND_AMOUNT_EXCEEDED` and
    `TRANSACTION_DISPUTED` also in the refund operation's examples:
    - `REFUND_AMOUNT_EXCEEDED`, `CAPTURE_FULLY_REFUNDED`;
    - `PENDING_CAPTURE` (refunding a capture that is still pending);
    - `REFUND_FAILED_INSUFFICIENT_FUNDS`, `REFUND_NOT_ALLOWED`, `REFUND_TIME_LIMIT_EXCEEDED`, `TRANSACTION_DISPUTED`.
- **Correct merchant:**
  - sends `PayPal-Request-Id` per refund;
  - refunds the amount asked for, not always the full total;
  - records a `PENDING` refund as pending, not failed;
  - shows each failure without changing the order to refunded;
  - keeps its ledger equal to PayPal's.
- **Assert:**
  - the merchant's refunded total equals the sum of PayPal's `COMPLETED` refunds, and is ≤ the capture;
  - a retry creates no second refund;
  - failed refunds leave the order paid.

## 14. Reversal or denial after payment
- **Simulates:** a paid order is later reversed (chargeback) or denied.
- **Sandbox:** the webhook simulator sends `PAYMENT.CAPTURE.REVERSED` and `PAYMENT.CAPTURE.DENIED` to the
  listener.
  - Simulated payloads "do not correspond to any real event", so the suite maps the simulated resource ID onto a
    test order, and the proof wall labels the tile "simulated event".
  - They self-verify only with the literal `WEBHOOK_ID` string.
- **Correct merchant:** verifies, looks the capture up, marks the order reversed or denied, and stops fulfilment
  if it has not shipped.
- **Assert:** the order state changes once. A duplicate delivery of the same event ID is a no-op.
- **As run (M4, scenario `webhook`):** real events for a real order instead of simulator payloads. The shop is told
  its capture is PENDING (SIMULATED rewrite, #10b), so it holds the order unconfirmed and refuses a second checkout;
  PayPal's genuine PAYMENT.CAPTURE.COMPLETED then confirms it; the harness refunds the capture through
  `POST /v2/payments/captures/{id}/refund`, and PayPal's genuine PAYMENT.CAPTURE.REFUNDED marks it refunded; the
  harness then replays both genuine deliveries byte for byte (PayPal's signature still verifies, as for a PayPal
  retry), and the shop must acknowledge and count each and change nothing (a replayed COMPLETED must not undo the
  refund). PayPal's own resend (`POST /v1/notifications/webhooks-events/{id}/resend`) answered 404 seconds after the
  event and 202 a few minutes later, but delivered nothing within 5 minutes (19 Oct), so it is only a fallback for a
  first delivery that landed elsewhere. PayPal delivers to the site's
  listener, which verifies and passes every verified delivery (repeats included) to the shop under test while a
  re-run is going; the shop verifies again itself and re-reads the capture before acting. DENIED and REVERSED use the
  same code path but have no sandbox trigger for a real order, so they are not claimed as proven. Local runs mark the
  scenario N/A (deliveries reach only the hosted URL).

## 15. Expired or repeated authorization (authorize-intent targets only)
- **Simulates:** the merchant authorizes at checkout and captures later, after the 3-day honour period or the
  29-day validity.
- **Sandbox:**
  - Orders authorize with `ORDER_EXPIRED` or `ORDER_ALREADY_AUTHORIZED` (confirmed under "Authorize order");
  - `POST /v2/payments/authorizations/{id}/capture` with `AUTHORIZATION_EXPIRED` (confirmed in the Payments v2
    `x-errors` and the auth-capture example).
- **Correct merchant:** reauthorizes (PayPal-wallet payments only), or asks the buyer to pay again. It never ships
  on an expired authorization.
- **Assert:** not paid after an expired-authorization capture; a reauthorization or new payment path is offered.
- None of the 5 targets uses `intent: AUTHORIZE`, so this tile shows only if a later target does.
