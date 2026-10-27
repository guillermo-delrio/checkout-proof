// Prompts for the model. The proof contract and the money rules are the spec; the proof run checks them.
import type { Finding } from "../scan/scan.ts";
import type { ScenarioResult } from "../prove/runner.ts";

export const CONTRACT = `PROOF CONTRACT (an automated sandbox proof drives these; keep them exactly):
- POST /api/paypal/orders  with JSON body {"shopOrderId": "<id>"}  ->  2xx JSON {"id": "<PayPal order id>"}.
  The server takes amount and currency from its OWN record of that shop order (the Printful order's retail_costs,
  fetched server-side), never from the request body. It remembers which PayPal order belongs to which shop order.
- POST /api/paypal/orders/:id/capture  ->  captures on the server and, only if the money is right, confirms the shop
  order the same way the shop confirms today (DEMO mode: the in-memory confirmed list; otherwise Printful confirm with
  the PRINTFUL order id). Success: 2xx JSON {"status":"COMPLETED","shopOrderId":"...","captureId":"..."}.
  Failure: 4xx (or 5xx only when PayPal itself failed) JSON {"error":"<PayPal issue or reason>","debug_id":"<PayPal
  debug id if any>","action":"restart"|"payer-action"|"fail"}; with "payer-action", also "payer_action_url": the
  PayPal order's payer-action link, where the browser sends the buyer.
- GET /api/orders/:id keeps working as today: status "pending" means confirmed.
- Whatever endpoint the v6 browser SDK needs for its client token (server-side, credentials never sent to the browser).
- The old POST /api/confirm/:orderId must not be able to confirm anything on its own: remove it, or make it apply the
  exact same checks as the capture endpoint.`;

export const MONEY_RULES = `MONEY RULES (checked against PayPal's own records after every scenario):
- Confirm a shop order only when PayPal reports a capture with status COMPLETED for a PayPal order that THIS server
  created for THIS shop order, and the capture's amount AND currency equal the shop order's total. Order status
  COMPLETED alone is not enough (a declined card returns order COMPLETED with captures[0].status DECLINED).
- A PayPal order the server did not create for that shop order (for example one made by a tampering browser, even
  with a matching custom_id) must never confirm anything.
- Repeated or concurrent capture calls for the same order (double click, refresh, retry) must end with at most one
  capture at PayPal and one confirmation, and must never answer 5xx because of the repeat. Send PayPal-Request-Id on
  capture. If PayPal says ORDER_ALREADY_CAPTURED, look the order up and answer from its real state.
- If the buyer was charged, the shop order must end confirmed (no "charged but not confirmed").
- Funding failures (INSTRUMENT_DECLINED) answer with action "restart" so the buyer can pick another funding source;
  PAYER_ACTION_REQUIRED answers "payer-action"; other refusals "fail". None of them confirms the order.
- A PayPal error on create reaches the browser as a 4xx with the debug_id; the server keeps serving.
- PAYER_ACTION_REQUIRED on capture: answer 422 with action "payer-action" and payer_action_url = the payer-action link
  PayPal returned for that order (PayPal lists it in its answer to the create call; a GET of an already approved order
  lists none). Never build that URL yourself. When the buyer comes back, capture the same PayPal order again.
- The server process can restart at any moment (a deploy, a crash, a scale-down). Which PayPal order belongs to which
  shop order, each shop order's payment state (pending, paid, ...), the webhook events already handled and anything
  else the checks above need must survive a restart: persist it in files under process.env.SHOP_DATA_DIR (a writable
  folder; use ./data when it is unset), written before you answer, or rebuild it from PayPal. After a restart, a
  capture of an approved order this server created must still go through exactly once, a shop order whose payment is
  pending or paid must still refuse any other payment, and a later PAYMENT.CAPTURE.COMPLETED (webhook, or the buyer's
  return page asking for the capture again) must still confirm a pending order once.`;

export function upgradePrompt(findings: Finding[]): string {
  const f = findings.map((x) => `- [${x.kind}] ${x.rule} at ${x.file}:${x.line}: ${x.why}`).join("\n");
  return `You are upgrading this shop's PayPal integration (a local copy of an open-source Express + React 17 app).

GOAL
1. Server: replace the deprecated @paypal/checkout-server-sdk with @paypal/paypal-server-sdk (APIMatic-generated).
   Use the paypal-server-sdk skills (start with typescript-getting-started; also calling-endpoints, error-handling,
   client-initialization) for how to build the client, call OrdersController, pass PayPal-Request-Id and read errors.
   The server stays CommonJS JavaScript. Credentials come only from process.env.PAYPAL_CLIENT_ID and
   process.env.PAYPAL_CLIENT_SECRET; use the Sandbox environment unless PAYPAL_ENVIRONMENT is "live". Never log them.
2. Browser: replace react-paypal-button-v2 (JS SDK v5) with JS SDK v6. Use the paypal:paypal-best-practices skill
   (its JS SDK v6 reference) for createInstance, findEligibleMethods, createPayPalOneTimePaymentSession and the
   <paypal-button> element. Orders are created and captured through the server endpoints below, never in the browser.
   Show the buyer a clear message for each failure action, and let them retry after "restart".
3. Fix the money-losing defects the scan found (below) as part of the move.

${CONTRACT}

${MONEY_RULES}

SCAN FINDINGS IN THIS COPY
${f}

CONSTRAINTS
- Install packages only with "npm install --ignore-scripts" (in frontend/ also add --legacy-peer-deps). Do not run the
  server or the front-end build; the proof harness builds and runs it and will send you any failure.
- Do not create or edit .env files and do not hard-code any credential or client ID.
- No database: an in-memory map is fine for the PayPal-order-to-shop-order binding (say so in a code comment).
- Keep the change focused on payments, in the existing code style. Do not add test-only code or check for test headers.
- Finish with a short summary: files changed, what each money rule maps to in the code, anything you could not do.`;
}

export function fixPrompt(round: number, failing: ScenarioResult[], buildError?: string, contract = CONTRACT, rules = MONEY_RULES): string {
  const ev = failing.map((r) => [
    `## ${r.id}: ${r.title} (expected ${r.expect})`,
    `Why it failed: ${r.reasons.join("; ")}`,
    `Shop order ${r.shopOrderId} (${r.shopTotal}): ${r.shopBefore} -> ${r.shopAfter}`,
    `Calls into the shop:`, ...r.calls.map((c) => `  - ${c.step} -> HTTP ${c.http} ${c.body !== undefined ? JSON.stringify(c.body).slice(0, 300) : ""}`),
    `Notes: ${r.notes.join(" | ")}`,
    ...(r.simulated ? [`SIMULATED: ${r.simulated} (PayPal's answer was rewritten by the harness; real record below)`] : []),
    `PayPal truth (GET order): ${JSON.stringify(r.paypal)}`,
    `PayPal calls made by the shop's server: ${JSON.stringify(r.ppLog.map((l: any) => ({ m: l.method, p: l.path, s: l.status, debug: l.debugId, mock: l.mocked, simulated: l.simulated ?? l.rewritten })))}`,
    `Shop log tail:\n${(r as any).shopLogTail || "(empty)"}`,
  ].join("\n")).join("\n\n");
  return `Fix round ${round}. The automated sandbox proof ran against your PayPal upgrade in this directory. ${buildError ? "The app did not build or start." : `${failing.length} scenario(s) failed.`}
Read the evidence, find the cause in the code, fix it, and keep everything that already passes working.
The proof contract and money rules (review round 2 added the payer-action link and the restart rules):

${contract}

${rules}

${buildError ? "BUILD/START ERROR\n" + buildError : "EVIDENCE\n" + ev}

Same constraints as before: npm install --ignore-scripts only, do not run the server or the build, no credentials,
no test-only code. "SIMULATED" scenarios rewrite PayPal's answer in the test harness (e.g. a capture reported as
PENDING); handle the answer, do not detect the harness. "Mock" in the evidence is a PayPal-Mock-Response header the harness injects to simulate PayPal's
answer; the shop must handle the resulting PayPal response, not detect the header. Finish with a short summary of the
cause and the fix.`;
}

// Webhook extension (M4): a second, focused model pass on the already-upgraded copy. The proof's webhook scenario
// (live listener only) checks it: a genuine PAYMENT.CAPTURE.* delivery changes the order once, a replay changes nothing.
export const WEBHOOK_CONTRACT = `WEBHOOK CONTRACT (an automated sandbox proof drives this with real PayPal deliveries; keep it exactly):
- POST /api/paypal/webhook receives PayPal webhook deliveries: a JSON event body plus the headers paypal-auth-algo,
  paypal-cert-url, paypal-transmission-id, paypal-transmission-sig and paypal-transmission-time.
- Verify every delivery before acting on it, with POST /v1/notifications/verify-webhook-signature (the server SDK has
  no controller for it: call the REST API with the same client credentials), webhook_id from
  process.env.PAYPAL_WEBHOOK_ID and webhook_event = the event exactly as received (keep the raw body; re-serialising
  it can change the bytes the signature covers). Fail closed, changing nothing: no PAYPAL_WEBHOOK_ID -> 503; a missing
  header, a paypal-cert-url that is not https on a paypal.com host, a body that is not a JSON event, or a
  verification_status other than SUCCESS -> 400; PayPal unreachable or 5xx while verifying or looking up -> 503 (PayPal
  retries the delivery later).
- Never trust the event body for money: after verification, re-fetch the capture from PayPal
  (GET /v2/payments/captures/{id}). For PAYMENT.CAPTURE.COMPLETED, PENDING and DENIED the event's resource is the
  capture; for PAYMENT.CAPTURE.REFUNDED and REVERSED it is a refund whose links entry with rel "up" names the capture.
- The capture's custom_id is the shop order id, and its supplementary_data.related_ids.order_id must be a PayPal
  order THIS server created for THAT shop order; otherwise acknowledge (2xx) and change nothing. Other event types
  are acknowledged (2xx) and ignored.
- The shop order's payment state follows the re-fetched capture's status:
  COMPLETED in the shop order's amount and currency -> paid: confirm the shop order the usual way if it is not
  confirmed yet (for example its capture was PENDING at checkout); PENDING -> pending (never confirmed);
  DECLINED or FAILED -> denied; REFUNDED -> refunded (reversed when the event is PAYMENT.CAPTURE.REVERSED);
  PARTIALLY_REFUNDED -> partially_refunded.
- Pending is money held, not a failure. When PayPal answers the capture with a PENDING capture, the capture endpoint
  remembers that capture for the shop order as pending (not confirmed) and answers 2xx JSON
  {"status":"PENDING","shopOrderId","captureId"}; the browser tells the buyer the payment is being reviewed by PayPal
  and must NOT be paid again (no "could not complete your payment", no PayPal button for that order while pending).
  While a shop order has a pending or paid payment, POST /api/paypal/orders and the capture endpoint refuse any other
  PayPal order for it (409 ALREADY_PAID or PAYMENT_PENDING), so the buyer cannot be charged twice. A later verified
  PAYMENT.CAPTURE.COMPLETED confirms the order once; PAYMENT.CAPTURE.DENIED marks it denied.
- Exactly once: the state changes only when the new state differs from the current one, and each change is recorded
  once, with the event id that caused it. A repeated delivery of an event id (PayPal retries and resends) is
  acknowledged with 2xx and changes nothing.
- GET /api/orders/:id adds "payment" for every shop order this server took or saw a payment for:
  {"paypalOrderId","captureId","state","changes":[{"from","to","eventId","eventType","at"}],"deliveries":{"<event id>": <count>}}
  ("changes" lists every state change, including the capture endpoint's own, which has eventId null). Its "status" is
  "pending" (= confirmed, as today) only while the payment state is paid or partially_refunded; once refunded,
  reversed or denied, "status" is that state.`;

export function webhookPrompt(): string {
  return `This shop's PayPal integration was already upgraded to JS SDK v6 and @paypal/paypal-server-sdk (server.js,
lib/paypal.js, frontend/src). Add PayPal webhook handling to the server so payment changes that happen after checkout
(a pending capture completing or being denied, a refund, a reversal) reach the shop's orders, and fix the pending
path: today a PENDING capture answers 409 CAPTURE_PENDING, records nothing, and the browser says "We could not complete
your payment" while PayPal holds the buyer's money, so nothing stops a second payment (a double charge). In the
browser, the order page also shows the payment state honestly (under review / refunded / reversed / denied).

${CONTRACT}

${WEBHOOK_CONTRACT}

${MONEY_RULES}

CONSTRAINTS
- Install packages only with "npm install --ignore-scripts" (you should not need any). Do not run the server or the
  front-end build; the proof harness builds and runs it.
- Do not create or edit .env files and do not hard-code any credential, client ID or webhook ID. Never log them.
- In-memory state is fine (no database; say so in a code comment). Keep the change focused, in the existing style.
- Do not add test-only code or check for test headers.
- Finish with a short summary: what each webhook rule maps to in the code, anything you could not do.`;
}

// The interface only, with no money guidance: what a merchant asking for "just migrate it" would specify.
export const CONTRACT_SHAPE = `ENDPOINTS (an automated sandbox test drives these; keep them exactly):
- POST /api/paypal/orders  with JSON body {"shopOrderId": "<id>"}  ->  2xx JSON {"id": "<PayPal order id>"}.
- POST /api/paypal/orders/:id/capture  ->  captures the PayPal order and confirms the shop order (as /api/confirm does
  today). Success: 2xx JSON {"status":"COMPLETED","shopOrderId":"...","captureId":"..."}. Failure: 4xx/5xx JSON
  {"error":"...","debug_id":"...","action":"restart"|"payer-action"|"fail"}; with "payer-action", also
  "payer_action_url": the PayPal order's payer-action link, where the browser sends the buyer.
- GET /api/orders/:id keeps working as today: status "pending" means confirmed.
- Whatever endpoint the v6 browser SDK needs for its client token.`;

// Plain arm: "migrate this to the current SDKs", no money rules and no risk findings. The proof finds what is left.
export function plainUpgradePrompt(findings: Finding[]): string {
  // Deprecated pieces and "upgrade available" ones (JS SDK v5 → v6); risk findings stay out of the plain arm.
  const f = findings.filter((x) => x.kind === "deprecated" || x.kind === "upgrade").map((x) => `- [${x.kind}] ${x.rule} at ${x.file}:${x.line}: ${x.why}`).join("\n");
  return `You are upgrading this shop's PayPal integration (a local copy of an open-source Express + React 17 app) to
PayPal's current SDKs.

GOAL
1. Server: replace the deprecated @paypal/checkout-server-sdk with @paypal/paypal-server-sdk (APIMatic-generated).
   Use the paypal-server-sdk skills (start with typescript-getting-started). The server stays CommonJS JavaScript.
   Credentials come only from process.env.PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (Sandbox unless
   PAYPAL_ENVIRONMENT is "live").
2. Browser: replace react-paypal-button-v2 (JS SDK v5) with JS SDK v6, using the paypal:paypal-best-practices skill.
   The browser calls the server endpoints below to create and capture.

${CONTRACT_SHAPE}

DEPRECATED PIECES FOUND
${f}

CONSTRAINTS
- Install packages only with "npm install --ignore-scripts" (in frontend/ also add --legacy-peer-deps). Do not run the
  server or the front-end build; the test harness builds and runs it and will send you any failure.
- Do not create or edit .env files and do not hard-code any credential or client ID.
- Keep the change focused on the migration. Finish with a short summary of files changed.`;
}

// ---------------------------------------------------------------------------------------------------------------
// expressCart (milestone 2): a server-rendered Express + Handlebars + MongoDB shop on the v1 Payments redirect.

export const EC_CONTRACT = `PROOF CONTRACT (an automated sandbox proof drives these with the buyer's own session cookie; keep them exactly):
- POST /paypal/orders  (JSON, body {} or empty; no CSRF token)  ->  2xx JSON {"id":"<PayPal order id>","orderId":"<expressCart order _id>"}.
  The server prices the session's CURRENT cart itself (req.session.totalCartAmount and friends, exactly as checkout
  shows it), creates a PayPal Orders v2 order (intent CAPTURE) for that total in the configured currency, and binds it
  to an expressCart order document (db.orders) that holds exactly that cart: orderProducts, orderTotal, item counts,
  the customer fields, orderPaymentId = the PayPal order id, orderPaymentGateway "Paypal", orderStatus "Pending".
  Never leave a different, older cart or total on the order document that a later capture marks paid.
- POST /paypal/orders/:id/capture  ->  captures on the server. Success: 2xx JSON
  {"status":"COMPLETED","orderId":"...","captureId":"..."}; the order becomes "Paid", a db.transactions record holds
  PayPal's captured amount, currency and capture id, and the cart is emptied (emptyCart) - only if the money rules
  hold. A capture PayPal reports as PENDING: 2xx JSON {"status":"PENDING","orderId":"..."} and the order stays
  "Pending" (not paid). Failure: 4xx (or 5xx only when PayPal itself failed) JSON
  {"error":"<PayPal issue or reason>","debug_id":"<PayPal debug id if any>","action":"restart"|"payer-action"|"fail"}.
- GET /checkout/payment renders a JS SDK v6 PayPal button: a <paypal-button> element that, when clicked, creates
  the order through POST /paypal/orders, opens PayPal for approval and then calls the capture endpoint; after a
  successful capture the browser goes to /payment/<orderId> (the existing result page, which keeps working).
- Whatever endpoint the v6 browser SDK needs for its client token (server-side; credentials never reach the browser).
- MongoDB orders.orderStatus is the shop's record that the proof reads: "Paid" only for a COMPLETED capture that
  matches the order; "Pending" while unpaid or awaiting funds; "Declined" after a failure that ends the attempt.
  Never set "Paid", "Approved" or "Completed" otherwise.
- The old v1 routes (POST /paypal/checkout_action, GET /paypal/checkout_return) must not be able to mark anything
  paid: remove them or make them redirect to /checkout/payment.`;

export const EC_MONEY_RULES = `${MONEY_RULES}
- Bind every PayPal order to the session and the shop order it was created for. The newest PayPal order of a session
  supersedes its earlier unpaid ones: a capture call for a superseded or foreign PayPal order is refused with action
  "fail" WITHOUT calling PayPal's capture, so the buyer is never charged twice for one cart (two tabs).
- Only a COMPLETED capture marks the order "Paid". PENDING (or any other capture status) never does.
- The amount recorded on the transaction is PayPal's captured amount, never the session's.
- A PayPal call that fails without a response (network error, timeout) must never crash the process: no throw inside
  callbacks, every await in try/catch, and the buyer gets a JSON error. On a retry, find out from PayPal (GET order,
  or the same PayPal-Request-Id) whether the earlier capture went through, and mark the order paid exactly once.
- Repeating the capture for an already paid order answers 2xx with the same result and adds no second transaction,
  e-mail or status change.`;

export function ecUpgradePrompt(findings: Finding[]): string {
  const f = findings.map((x) => `- [${x.kind}] ${x.rule} at ${x.file}:${x.line}: ${x.why}`).join("\n");
  return `You are upgrading this shop's PayPal integration (a local copy of expressCart, an open-source Express 4 +
Handlebars + MongoDB shop; payments live in lib/payments/, the PayPal button in views/partials/payments/paypal.hbs).

GOAL
1. Server: replace paypal-rest-sdk (v1 Payments redirect) with @paypal/paypal-server-sdk (Orders v2). Use the
   paypal-server-sdk skills (start with typescript-getting-started; also calling-endpoints, error-handling,
   client-initialization) for building the client, OrdersController, PayPal-Request-Id and reading errors. The code
   stays CommonJS JavaScript in the shop's style. Credentials come only from process.env.PAYPAL_CLIENT_ID and
   process.env.PAYPAL_CLIENT_SECRET; Sandbox unless PAYPAL_ENVIRONMENT is "live". Never log them. Keep the
   non-secret settings (currency, description) in config/payment/config/paypal.json; client_id/client_secret there
   are no longer read (adjust config/payment/schema/paypal.json so the app still starts without them).
2. Browser: replace the redirect form with JS SDK v6. Use the paypal:paypal-best-practices skill (its JS SDK v6
   reference) for loading the v6 core script, createInstance, findEligibleMethods,
   createPayPalOneTimePaymentSession and the <paypal-button> element. The page is server-rendered Handlebars with
   jQuery; put the client code in a small script under public/ or inline in the partial. Show the buyer a clear
   message for each failure action and let them try again after "restart".
3. Fix the money-losing defects the proof found on the original as part of the move:
   - E1: after a cancelled PayPal payment, the session keeps orderId and the next checkout reuses that order
     document unchanged, so paying a smaller cart marks the old, larger order "Paid" (sandbox: an 85.00 EUR payment
     marked a 480.00 EUR order of 8 items Paid);
   - E2/E3: "approved" payment state treated as paid without checking the sale/capture; "Approved" default status;
   - E4: transaction amount taken from the session instead of PayPal's response;
   - E5/E7: error.response undefined on a network error crashes the process; reloading the return page re-executes,
     inserts a second transaction for a non-existent order and crashes the whole shop on order.orderEmail.

${EC_CONTRACT}

${EC_MONEY_RULES}

SCAN FINDINGS IN THIS COPY
${f}

CONSTRAINTS
- Install packages only with "npm install --ignore-scripts". Do not run the app or MongoDB; the proof harness runs
  them and will send you any failure.
- Do not create or edit .env, env.yaml or config/settings*.json, and do not hard-code any credential or client ID.
- Keep the change focused on payments, in the existing code style. Do not add test-only code or check for test headers.
- Finish with a short summary: files changed, what each money rule maps to in the code, anything you could not do.`;
}

// Plain arm for expressCart: "migrate it", the endpoint shape only, no money rules or defect list.
export const EC_CONTRACT_SHAPE = `ENDPOINTS (an automated sandbox test drives these with the buyer's session cookie; keep them exactly):
- POST /paypal/orders  ->  2xx JSON {"id":"<PayPal order id>","orderId":"<expressCart order _id>"} for the session's cart.
- POST /paypal/orders/:id/capture  ->  captures and marks the order paid (orders.orderStatus "Paid").
  Success: 2xx JSON {"status":"COMPLETED","orderId":"...","captureId":"..."}. Failure: 4xx/5xx JSON
  {"error":"...","debug_id":"...","action":"restart"|"payer-action"|"fail"}.
- GET /checkout/payment renders a v6 <paypal-button>; after a capture the browser goes to /payment/<orderId>.
- Whatever endpoint the v6 browser SDK needs for its client token.`;

export function ecPlainUpgradePrompt(findings: Finding[]): string {
  // Deprecated pieces and "upgrade available" ones (JS SDK v5 → v6); risk findings stay out of the plain arm.
  const f = findings.filter((x) => x.kind === "deprecated" || x.kind === "upgrade").map((x) => `- [${x.kind}] ${x.rule} at ${x.file}:${x.line}: ${x.why}`).join("\n");
  return `You are upgrading this shop's PayPal integration (a local copy of expressCart, Express 4 + Handlebars +
MongoDB) to PayPal's current SDKs.

GOAL
1. Server: replace paypal-rest-sdk (v1 Payments) with @paypal/paypal-server-sdk (Orders v2), using the
   paypal-server-sdk skills. CommonJS JavaScript. Credentials only from process.env.PAYPAL_CLIENT_ID and
   PAYPAL_CLIENT_SECRET (Sandbox unless PAYPAL_ENVIRONMENT is "live").
2. Browser: replace the redirect form with JS SDK v6, using the paypal:paypal-best-practices skill.

${EC_CONTRACT_SHAPE}

DEPRECATED PIECES FOUND
${f}

CONSTRAINTS
- Install packages only with "npm install --ignore-scripts". Do not run the app or MongoDB.
- Do not create or edit .env, env.yaml or config/settings*.json; no hard-coded credentials.
- Keep the change focused on the migration. Finish with a short summary of files changed.`;
}
