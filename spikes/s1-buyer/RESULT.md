# Spike 1: automated sandbox buyer approval (16 Oct 2026)

**Verdict: PASS.** A headless sandbox buyer approved 10 of 10 consecutive v6 wallet checkouts, and every capture
came back `COMPLETED`. The kill line was fewer than 8 of 10 with card fields also failing. Card fields passed too,
at 6 of 6. No captcha or 2FA appeared in 42 sandbox logins and approvals.

## Method

- `server.mjs` is plain Node with no framework. It calls the Orders v2 REST API directly:
  - `intent: CAPTURE`, €1.00, EUR;
  - a client token from `/v1/oauth2/token` (`response_type=client_token`, `intent=sdk_init`, no `domains[]` on
    localhost);
  - `PayPal-Request-Id` on every POST.
- It serves two v6 pages:
  - `/` loads `web-sdk/v6/core` and calls `createInstance({clientToken, components:["paypal-payments"]})`, then
    `findEligibleMethods`, `createPayPalOneTimePaymentSession` and `start({presentationMode})`. `onApprove` captures
    on the server.
  - `/cards` uses `card-fields` and `createCardFieldsOneTimePaymentSession` with `submit()`, then captures.
- It also has `/api/orders/redirect`, which creates the order with `payment_source.paypal.experience_context.return_url`
  and returns the `payer-action` link. `/return` captures on the server.
- `buyer.mjs <mode> [runs]` uses Playwright 1.x with headless Chromium (headless shell 156) and a fresh browser
  context per run.
  - It logs in as the sandbox buyer and clicks the approve button (`#payment-submit-btn` and fallbacks).
  - A run passes only when the shop page shows `CAPTURE COMPLETED`, which is the capture status from PayPal's capture
    response.
- Credentials come from `../../.env` and never reach stdout or the logs: the email is scrubbed and the password is
  masked. Failure screenshots mask every input. A grep of the output and the harness for the password found nothing.
- Raw rows are in `out/s1/` (`results.jsonl`, `popup-batch1-results.jsonl`, `dev-results.jsonl`). The saved session is
  `out/s1/buyer-state.json`. It holds sandbox cookies, sits in a gitignored folder and should not be shared.

Run it: `npm install && npx playwright install chromium && node server.mjs &`, then
`node buyer.mjs popup 10` (modes: `popup`, `redirect`, `login-save`, `popup-state`, `cards`). For card runs, set
`S1_CARD='{"number":"4111111111111111","expiry":"12/30","cvv":"123"}'`.

## Results

| Path | Pass | Median s | Max s | Failures |
|---|---|---|---|---|
| Wallet popup, batch 1 (harness v1) | 6/10 | 11.8 | 14.4 | 4 harness selector bugs on a second login-page variant; no captcha or 2FA |
| **Wallet popup, batch 2 (pre-registered test, fixed harness)** | **10/10** | 11.8 | 12.8 | none |
| Redirect (`return_url`, navigate to approve link, no popup) | 10/10 | 8.9 | 9.5 | none |
| Fallback A: saved buyer session (`storageState`), popup | 5/5 | 9.0 | 9.3 | none; login skipped, one click to approve |
| Fallback B: v6 card fields, Visa 4111 1111 1111 1111 | 6/6 | 9.4 | 10.6 | none; no 3DS challenge |

Notes on batch 1:
- PayPal served two login layouts during that batch. One is split: email, then Next, then password. In the other,
  the password node reports as visible while `#btnLogin` is hidden. Harness v1 typed the password without clicking
  Next and then timed out on Log In.
- The fix is to click Next whenever it is shown. That is a harness bug, not PayPal friction. I count the clean
  10/10 rerun as the test, and the 6/10 stays on the record.
- The lesson: the agent's buyer must branch on which control is visible, not on one fixed sequence.
- One earlier dev row also flagged a false "captcha": PayPal preloads hidden captcha iframes, so detection now counts
  only visible iframes.

Time per run includes page load, SDK init, login, approval and the server-side capture.

## What the product should use

1. **Default: redirect for the proof run, with fresh login.** It is 10/10, the fastest at ~9 s, and has no popup
   handling. It works against any merchant server that creates orders with a `return_url`, and the evidence is a
   linear page sequence that records cleanly on video.
2. **The v6 popup flow, when the merchant's button is the subject of the proof.** It also went 10/10 at ~12 s. A
   migration proof has to click the merchant's own `<paypal-button>`, so this is the path the PR evidence should
   show. Use `presentationMode: "popup"` in the test, or `auto`, which tries popup first. Expect login-layout
   variants.
3. **Saved session as a speed-up, not a dependency.** It skips login (~9 s) but ties runs to a cookie file that
   expires. Use it for the hosted "re-run proof" button, and fall back to fresh login when the approve button doesn't
   appear.
4. **Card fields as the second scenario.** It went 6/6 with no login at all, which makes it the most robust path for
   a no-LLM replay. It needs `advanced_cards` eligibility, which this sandbox app has.

## Limits

- This is one sandbox app, one buyer (ES) and one evening (~21:35–21:45 UTC), with 42 automated runs in ~10 minutes.
  PayPal may add risk checks at higher volume or from data-centre IPs such as the hosted demo's VM. Re-test there
  before relying on it.
- Only EUR €1.00 was tested. Shipping callbacks, 3DS cards (sandbox 3DS test cards) and `auto` presentation mode on
  a merchant's real page were not tested.
- Headless Chromium only. The window-size and popup behaviour of the snap Chromium was not used.
