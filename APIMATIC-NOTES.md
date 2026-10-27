# APIMatic context plugin: what it got right and wrong

The APIMatic sponsor prize form asks how the APIMatic tooling was used. This is the running record. Plugin:
[`paypaldev/server-sdk-context-plugin-preview`](https://github.com/paypaldev/server-sdk-context-plugin-preview)
at `6aa0571` (25 Sep 2026), TypeScript skills only, for `@paypal/paypal-server-sdk` 2.5.0.

## How it is loaded

- `npx context-plugins install <url>` (v0.12.0) installs **at user scope only** ("Everything is installed for the
  current user"), into every detected assistant. It cannot install into one repo.
- The plugin's manifest is named `paypal`, the same name as PayPal's AI Toolkit plugin (`paypal@claude-plugins-official`),
  which is already installed. Installing both would need `--force` and replace one with the other.
- So Checkout Proof vendors the repo under `out/vendor/` and, per model run, writes a copy renamed
  `paypal-server-sdk` with only the TypeScript skills, loaded with `claude -p --plugin-dir`. Both plugins then load
  side by side: `paypal-server-sdk:typescript-*` and `paypal:paypal-best-practices` (checked 17 Oct with a
  listing run).

## Run 1: simple-clothing-store upgrade (17 Oct 2026, `claude-opus-5-5`, effort high, 88 turns, ~10 min)

Skills the model loaded, in order: `typescript-getting-started`, `typescript-client-initialization`,
`typescript-calling-endpoints`, `typescript-error-handling`, then the AI Toolkit's `paypal-best-practices` for the
v6 browser side. Transcript: `out/runs/simple-clothing-store/model/upgrade-transcript.jsonl`.

**What it got right** (the code ran first time through 9 sandbox scenarios):
- Client construction: `new Client({clientCredentialsAuthCredentials: {oAuthClientId, oAuthClientSecret},
  environment: Environment.Sandbox, timeout})`, one client per process so the OAuth token is cached.
- Calling `OrdersController.createOrder / captureOrder / getOrder` with the request object shape and reading
  `response.result`.
- Error handling: the "two shapes" section (typed subclass with `result` vs base `ApiError` with the payload only in
  `body`) is exactly what the model implemented in `errorInfo()`: it reads `err.result`, falls back to parsing
  `err.body`, then pulls `details[].issue` and the `paypal-debug-id` header. The declined, refused and 500 scenarios
  all surfaced PayPal's issue code and debug ID to the browser because of it.
- Not logging the request object (it carries the auth header): the error-handling skill's warning was followed.

**What it did not cover** (the model had to read the SDK source instead: 6 Bash/Read calls into
`node_modules/@paypal/paypal-server-sdk/src/controllers/ordersController.ts`, `oAuthAuthorizationController.ts`,
`models/order.ts`):
- `paypalRequestId` (the `PayPal-Request-Id` idempotency header) is not mentioned in any TypeScript skill. It is the
  single most important parameter for a correct capture (SCENARIOS #8, #9).
- `paypalMockResponse` (the `PayPal-Mock-Response` negative-testing header the SDK exposes as a typed parameter) is
  not mentioned either.
- The browser-safe client token for JS SDK v6 (`OAuthAuthorizationController.requestToken` with
  `response_type=client_token`, `intent=sdk_init`) is not covered; the model assembled it from the controller source
  and the AI Toolkit's v6 reference.
- The skills are generator-generic (any APIMatic SDK); `typescript-getting-started` carries the PayPal-specific
  facts, but no Orders v2 semantics: nothing on `captures[0].status` versus order status, `ORDER_ALREADY_CAPTURED`,
  or `prefer: return=representation` (the model found `prefer` in the source and used it correctly).

**What it got wrong, or let through:**
- The model used `applicationContext` (`shipping_preference`, `brand_name`) on create. Orders v2 marks
  `application_context` deprecated in favour of `payment_source.paypal.experience_context`; the skills do not say so.
  It works in sandbox today. Candidate for the next fix prompt or a scan rule.

## Open

- Run 2 (expressCart, milestone 2): v1 Payments to Orders v2 is a bigger jump; record whether the skills help with
  the redirect flow (`experience_context.return_url`).
