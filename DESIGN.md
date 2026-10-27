# Checkout Proof — implementation design

> Parent: [`README.md`](README.md) (what and why), [`../hackathons-next/paypal-pick/PICK.md`](../hackathons-next/paypal-pick/PICK.md)
> (the pick), [`round3-challenge.md`](../hackathons-next/paypal-pick/round3-challenge.md) (storyboard, hosted-demo
> shape, risks). Scenario catalogue: [`SCENARIOS.md`](SCENARIOS.md). Targets: [`TARGETS.md`](TARGETS.md).

Checkout Proof is a local CLI that takes a Node/JS shop on an older PayPal integration and does four things:

1. **scan**: finds what has a newer version (JS SDK v5 in its script, `paypal.Buttons`, React and `paypal-js` forms;
   PayPal supports v5 fully and its rules say never to call it deprecated), what PayPal has deprecated
   (`@paypal/checkout-server-sdk`, `paypal-rest-sdk` v1 Payments, Orders v2 `application_context`) and known
   money-losing patterns, with file:line;
2. **upgrade**: has the model move it to JS SDK v6 and `@paypal/paypal-server-sdk`, with PayPal's AI Toolkit skills
   and the APIMatic server-SDK context plugin loaded as context;
3. **prove**: runs the shop locally against the sandbox, drives a sandbox buyer, replays failure scenarios
   (`PayPal-Mock-Response`, attack calls) through the shop's own server, and compares the shop's record with
   PayPal's (`GET /v2/checkout/orders/{id}`). Failures go back to the model with the evidence, it fixes, the proof
   re-runs;
4. **pack**: writes an evidence pack (scenario table with sandbox IDs, screenshots, before/after diff) and a PR body,
   locally only.

The model's job is the edit and the repair. Everything that decides pass or fail is deterministic code.

---

## Scope

**Milestone 1 (this build, 17 Oct): one target end to end.** `scan`, `prove`, `upgrade` and the fix loop on
simple-clothing-store. Prove on the original must show D1 and D2 with sandbox IDs; prove on the upgrade must go
green or say what is left.

**Milestone 2 (done 17 Oct):** expressCart (v1 Payments redirect, MongoDB, the E1 hero) through the same commands;
pending capture (10) as a labelled synthetic rewrite.

**Deferred:**
- webhook scenarios 12 and 14 (need an HTTPS listener), refunds (13) — milestone 3;
- the evidence gallery and Cloud Run server — milestone 3;
- a model-written target adapter (milestone 1 adapters are hand-written, one per target; see "Target adapters").

---

## Architecture

```
                 ┌──────────── checkout-proof CLI (Node 22 + TypeScript, tsx) ────────────┐
                 │                                                                       │
  repo dir ──►  scan ──► findings.json                                                   │
                 │                                                                       │
  out/targets/   │  upgrade ──► claude -p (Max plan) in out/work/<t>-upgraded/ ──► git commits
  <clone> ──►    │                ▲ skills: paypal (AI Toolkit), paypal-server-sdk (APIMatic)
                 │                │ fix prompt = failing scenarios + evidence                │
                 │                │                                                       │
                 │  prove ──► target adapter ──► shop process (node -r preload.cjs) ──► api-m.sandbox.paypal.com
                 │              │                  │  preload: mock header, call log            ▲
                 │              │                  └─ Printful stub (local)                     │
                 │              ├─► sandbox buyer (Playwright, headless)  ─► sandbox approval   │
                 │              └─► truth client (own REST, own token) ─────────────────────────┘
                 │                     │
                 │                     ▼
                 │   money invariants (pure, vitest) ──► verdicts ──► evidence pack (out/evidence/…)
                 └───────────────────────────────────────────────────────────────────────┘

  Later (milestone 3): Vite + React + TS evidence gallery + small Node server on Cloud Run
    - reads committed evidence packs (static JSON + screenshots);
    - "scan a public repo" box: the same scan rules over a shallow fetch, no execution;
    - "re-run proof": the deterministic scenario runner against the upgraded fork, NO model calls,
      rate-limited, sandbox credentials server-side only.
```

### Commands

| Command | What it does | Model? |
|---|---|---|
| `cp scan <dir>` | Static rules over JS/TS/HTML/package.json; prints a table, writes `out/scan/<name>.json` | no |
| `cp prove <target> --variant original\|upgraded` | Prepares the work copy, starts the shop, runs the scenarios, writes the evidence pack | no |
| `cp upgrade <target>` | Fresh work copy from the clone, git baseline, `claude -p` upgrade, commit | yes |
| `cp loop <target> [--max 3]` | `prove` the upgrade; while scenarios fail and rounds remain: fix prompt, commit, re-prove | yes |
| `cp pack <target>` | Combines the original and upgraded runs into `EVIDENCE.md` + `PR-BODY.md` | no |

(`cp` is `npx tsx src/cli.ts`; `npm run cp -- …`.)

---

## Data model

```ts
// A scan finding
interface Finding {
  rule: string;            // "v5-script" | "v5-buttons" | "checkout-server-sdk" | "rest-sdk-v1" | "client-create-order"
                           // | "client-capture" | "no-capture-status-check" | "client-currency" | ...
  kind: "upgrade" | "deprecated" | "risk";   // upgrade = JS SDK v5 (v6 available); deprecated = PayPal says so
  file: string; line: number; text: string;
  why: string;             // one line, with the SCENARIOS.md number it maps to
}

// Money, always integer minor units + ISO currency (no floats anywhere in verdicts)
interface Money { minor: number; currency: string }

// PayPal's view of one order, from GET /v2/checkout/orders/{id} (the "truth")
interface PayPalTruth {
  orderId: string; status: string;                       // CREATED | APPROVED | COMPLETED | ...
  customId?: string;
  captures: { id: string; status: string; amount: Money }[];
}

// The shop's view of its order, from the target adapter
interface ShopState { shopOrderId: string; total: Money; paid: boolean; rawStatus: string }

// One scenario run
interface ScenarioResult {
  id: string; title: string; scenarioRef: string;        // "SCENARIOS.md #7"
  expect: "paid-once" | "not-paid";
  shopBefore: ShopState; shopAfter: ShopState;
  paypal: PayPalTruth[];                                  // every PayPal order the scenario touched
  calls: { step: string; http: number; body?: unknown }[]; // calls into the shop
  ppLog: { method: string; path: string; status: number; debugId?: string; mocked?: string }[];
  verdict: "PASS" | "FAIL" | "N/A";
  reasons: string[];                                      // why, in plain words
  screenshot?: string;
}
```

---

## Money invariants (the tests that decide pass or fail)

These are pure functions in `src/money/`, written test-first (`tests/money.test.ts`). The scenario runner only
gathers facts; these decide.

| # | Invariant | Fails on |
|---|---|---|
| I1 | Money parses to integer minor units; `"62.00 EUR"` ≠ `"62.00 MXN"`; `"62.0"` = `"62.00"` | float drift, currency ignored |
| I2 | If the shop says paid, exactly one PayPal order bound to this shop order has **one** `COMPLETED` capture | D1 (paid with no capture), declined card, double charge |
| I3 | That capture's amount **and** currency equal the shop's own total | D2 (MXN), lowered amount, E1 (stale order) |
| I4 | If the shop says not paid, no `COMPLETED` capture exists for it ("charged but not fulfilled" is its own failure) | D3, lost confirm |
| I5 | Across repeated calls (double click, retry), PayPal shows at most one completed capture and the shop never answers 5xx | D5, S2, E7 |
| I6 | The scenario's expectation holds: `paid-once` or `not-paid` | everything else |

A scenario verdict is `FAIL` if any invariant fails, with each failing invariant as a reason
("shop marked order 9000002 paid; PayPal captured 62.00 MXN, shop total is 62.00 EUR (I3)").

---

## Scenario runner

### Mechanics (reused from the spikes)

- **Shop process:** started by the adapter with `node -r harness/preload.cjs` (spike 3), which:
  - adds `PayPal-Mock-Response` to the next PayPal call matching a control file
    (`{"match":"/capture","code":"INSTRUMENT_DECLINED"}`), consumed on use. It patches `https.request`, so it works
    for `@paypal/checkout-server-sdk` (Node `https`) and for `@paypal/paypal-server-sdk` (axios → Node `https`)
    without touching target code;
  - logs every PayPal call (method, path, status, `paypal-debug-id`, mock code) to a JSON-lines file, which becomes
    the scenario's `ppLog`;
  - reroutes `api.printful.com` to the local Printful stub (simple-clothing-store only).
  The new SDK also takes `paypalMockResponse` as a typed parameter, but using the same preload for before and after
  keeps the two runs comparable and leaves the upgraded code free of test seams.
- **Buyer:** Playwright, headless, fresh context, sandbox ES buyer from `.env`; branches on which login control is
  visible (spike 1 lesson); handles the Spanish labels (spike 2). Redirect approval for API-level scenarios; the
  shop's own `<paypal-button>` for the UI scenario.
- **Truth:** the CLI's own REST client and token (not the shop's), `GET /v2/checkout/orders/{id}`. Transaction
  Search is optional evidence (lags up to 3 h) and never decides a verdict.

### Scenarios in milestone 1

| id | SCENARIOS.md | Steps | Expect |
|---|---|---|---|
| `happy` | #1 | cart → checkout → buyer approves → complete | paid-once |
| `happy-ui` | #1 | upgraded only: click the shop's real `<paypal-button>`, approve in the popup | paid-once |
| `unapproved` | #7a | cart → checkout → **no approval** → complete | not-paid |
| `declined-retry` | #5 | approve → mock `INSTRUMENT_DECLINED` on capture → complete (fails) → complete again | paid-once, one capture |
| `duplicate` | #8a | approve → complete twice concurrently, then once more | paid-once, one capture, no 5xx |
| `currency` | #11a | a PayPal order for the same value in MXN with `custom_id` = shop order, approved and captured, then handed to the shop's complete step | not-paid |
| `amount` | #11a | same with 1.00 EUR | not-paid |
| `create-refused` | #4 | upgraded only: mock `PAYER_CANNOT_PAY` on create | not-paid, 4xx, shop still serves |
| `server-error-retry` | #9b | approve → mock `INTERNAL_SERVER_ERROR` on capture → complete again | paid-once |
| `lost-response` | #9a | approve → capture goes through at PayPal, preload drops the response → complete again | paid-once |
| `two-tabs` | #8 | two checkouts for one shop order, both approved, both completed concurrently | paid-once, one capture |

The `currency` and `amount` attacks create their PayPal order with the merchant's sandbox credentials. That is what
any browser can do with the shop's public client ID (v5) or its browser-safe client token (v6), so it is a fair
model of a tampering client, and it is the same call for both variants.

### Target adapters

An adapter knows how to drive one target: set up the work copy, start and stop it, make a shop order, and run the
checkout the way the shop's own client does. Milestone 1 has one, `src/targets/simple-clothing-store.ts`, with two
variants:

| Step | original (v5 + checkout-server-sdk) | upgraded (proof contract) |
|---|---|---|
| shop order | `POST /api/orders` (Printful draft) | same |
| checkout | the harness creates the PayPal order with the exact payload `Payment.js` sends from the browser (client-side create is the shop's design) | `POST /api/paypal/orders {shopOrderId}` |
| complete | harness captures as `actions.order.capture()` would, then `POST /api/confirm/:id` (the shop's own server step) | `POST /api/paypal/orders/:id/capture` |
| state | `GET /api/orders/:id`, `status === "pending"` = confirmed | same |

**The proof contract** is part of the upgrade prompt: the upgraded server exposes the two endpoints above, keeps
`GET /api/orders/:id`, reads credentials only from the environment, and returns
`{error, debug_id, action: "restart" | "payer-action" | "fail"}` on a failed capture. It fixes the shape the proof
drives without dictating the implementation. Milestone 2 (expressCart) tests whether the same contract fits a v1
redirect shop; if it does not, the adapter for the upgraded variant becomes something the model writes and the
proof run reviews (open question).

---

## How the model is invoked

- **Local runs only.** `claude -p` (Claude Code headless) on the owner's Max plan, in the work copy directory, model
  `claude-opus-5-5` (the current default Opus per the claude-api skill), `--effort high` for the upgrade, `medium`
  for fix rounds. The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the same harness as a library; `claude -p`
  needs no API key on a Max plan and its JSON result gives cost and turn counts, so milestone 1 uses it.
- **Context it gets:**
  - the PayPal AI Toolkit plugin (installed at user scope by the owner, 16 Oct): `paypal:paypal-best-practices`
    (JS SDK v6 references, RulesHub);
  - the APIMatic server-SDK context plugin, loaded for the session only with `--plugin-dir` from a vendored copy
    renamed `paypal-server-sdk` (its manifest is also named `paypal`, which clashes with the AI Toolkit; and
    `npx context-plugins install` only installs at user scope, not into a repo). See `APIMATIC-NOTES.md`;
  - the scan findings, the money invariants and the proof contract, in the prompt.
- **What it may do:** `Read/Edit/Write/Glob/Grep/Skill`, and Bash limited to `npm install --ignore-scripts …`,
  `npm ls`, `npm view`, `node --check`. `--strict-mcp-config` with no servers, so the AI Toolkit's PayPal MCP is
  not loaded and the model makes no PayPal calls. The CLI's `.env` is denied to Read. The harness builds, runs and
  judges; the model never sees credentials.
- **Fix loop:** the fix prompt carries, per failing scenario, the verdict reasons, the shop's HTTP responses, the
  `ppLog` (paths, status, debug IDs), PayPal's truth and the tail of the shop's stderr. The model edits; the CLI
  commits (`fix round N`), rebuilds, re-proves everything. Max 3 rounds by default.
- **Hosted demo makes no model calls.** The gallery shows pre-run packs; "re-run proof" replays the deterministic
  runner.

---

## Security

- **Third-party code runs only in local work copies** (`out/work/<target>-<variant>/`, gitignored), never in this
  repo's tree, never with our credentials in its files.
  - `npm install --ignore-scripts` where the target allows it (the CLI and the model's Bash rule both use it);
    `--legacy-peer-deps` for CRA 4.
  - The shop gets `PAYPAL_CLIENT_ID`/`SECRET` as process env from the CLI at start, not through a file in the work
    copy.
- **Credentials only from `checkout-proof/.env`**, loaded by the CLI; `PAYPAL_ENVIRONMENT` must be `sandbox` or the
  CLI exits. They are never printed or logged: every evidence string passes `scrub()`, which replaces the client
  ID, secret, buyer e-mail and password; Playwright screenshots mask every `<input>`.
- **Evidence scrubbing** also drops access tokens and `Authorization` headers from shop logs before they enter a
  fix prompt or a pack.
- **Before each commit**, a grep of the staged diff for every `.env` value (`scripts/check-secrets.sh`).
- **Nothing outward-facing:** packs and PR bodies are written to `out/evidence/`; no forks, PRs, issues or messages.
  The disclosure rule in TARGETS.md applies before any of these defects appear in public.

---

## Module structure

```
checkout-proof/
├── DESIGN.md, APIMATIC-NOTES.md
├── package.json, tsconfig.json, vitest.config.ts
├── scripts/check-secrets.sh        # staged-diff grep for .env values
├── harness/
│   ├── preload.cjs                 # mock header, PayPal call log, Printful reroute (spike 3)
│   └── printful-stub.mjs           # local Printful API (spike 3)
├── src/
│   ├── cli.ts                      # scan | prove | upgrade | loop | pack
│   ├── env.ts                      # .env loading, sandbox guard, scrub()
│   ├── money/money.ts              # parse, equal, format (pure)
│   ├── money/verdict.ts            # invariants I1-I6 (pure)
│   ├── paypal/truth.ts             # sandbox REST client: token, getOrder, createOrder, capture (for attacks)
│   ├── scan/rules.ts, scan/scan.ts # static rules
│   ├── buyer/buyer.ts              # Playwright approval (spikes 1-3)
│   ├── targets/types.ts            # Adapter interface
│   ├── targets/simple-clothing-store.ts
│   ├── prove/scenarios.ts          # scenario definitions
│   ├── prove/runner.ts             # runs scenarios, collects facts, calls verdict()
│   ├── upgrade/claude.ts           # claude -p invocation, transcript capture
│   ├── upgrade/prompts.ts          # upgrade and fix prompts
│   └── evidence/pack.ts            # results.json, EVIDENCE.md, PR-BODY.md
└── tests/                          # vitest: money, verdict, scan rules, scrub
```

---

## Milestones to 11 Nov

| # | By | Deliverable |
|---|---|---|
| M1 | 18 Oct | This doc; scan, prove, upgrade, fix loop on simple-clothing-store; original shows D1/D2 with sandbox IDs |
| M2 | 22 Oct (done 17 Oct) | expressCart hero: v1 redirect adapter, standalone MongoDB 6.0 (no Docker), scenario 3 (cancel, shrink, pay) catches E1; upgrade to Orders v2 + v6 + server SDK; E7 reload crash scenario |
| M3 | 26 Oct | Webhook listener + scenarios 12/14 (needs an HTTPS listener: Cloud Run or a tunnel; owner adds the webhook URL); evidence gallery (Vite + React + TS); scan box |
| M4 | 30 Oct | Cloud Run with the hard caps from `scratch/CLAUDE.md` (Free Trial billing account, kill switch, quotas), "re-run proof" with no model calls; sandbox buyer re-tested from the VM's IP |
| M5 | 4 Nov | A third target (sourcefuse S1 or Cromwell C1) through the same loop; population grid for the video's 0:00 shot |
| M6 | 8 Nov | Video (storyboard in round3-challenge.md, Marquee's pipeline), README, Devpost text, APIMatic answers from `APIMATIC-NOTES.md` |
| — | 9–11 Nov | Fresh-persona review rounds; slack |

---

## Open questions (resolved)

- **Proxy or preload for mock headers?** Preload (spike 3 proved it on unmodified target code; one mechanism for
  both SDKs).
- **API key or Max plan for the model?** Max plan via `claude -p` for local runs; the hosted demo makes no model
  calls.
- **Install the APIMatic plugin with `npx context-plugins install`?** No: it installs at user scope only (README,
  "Everything is installed for the current user") and its plugin name `paypal` collides with the AI Toolkit. It is
  vendored under `out/vendor/` and loaded per session with `--plugin-dir`.

- **Is a sandbox-buyer failure the shop's fault?** No. A failed approval throws `HarnessError`; the scenario is
  retried once and otherwise reported `INCONCLUSIVE`, and never reaches a fix prompt. Before this, fix round 2 of the
  plain arm chased a buyer timeout and added a `return_url` the shop did not need (17 Oct).
- **Why did approvals start timing out?** The sandbox buyer's balance ran below the order total after ~70 paid
  scenarios; PayPal then funds the rest from the linked bank, which needs a SEPA mandate. The buyer now picks the
  sandbox Visa for the remainder. Each full proof (2 variants x 2 modes) spends about EUR 1,000-1,300 of sandbox
  balance.
- **Does one proof contract fit every target?** The shape does: a create endpoint and a capture endpoint returning
  `{id}` / `{status, captureId}` or `{error, debug_id, action}`. Each target still gets its own hand-written
  contract text and adapter. For expressCart that means the session cookie instead of a shop order id, and MongoDB's
  `orders.orderStatus` as the shop's record (`EC_CONTRACT` in `src/upgrade/prompts.ts`). A model-written adapter is
  still not needed (M2, 17 Oct).
- **Pending capture (scenario 10)?** A labelled synthetic rewrite: `harness/preload.cjs` (`REWRITE_FILE`) turns
  PayPal's COMPLETED capture or completed v1 sale into PENDING before the shop sees it. The verdict judges against
  that answer, and the run, the pack and the fix prompt all say SIMULATED. PayPal's real record stays in the evidence.
- **Does the proof only pass what the prompt already spelled out?** The plain arm answers it: with a migrate-only
  prompt (no money rules), the model's upgrade passed 8 of 11 scenarios per mode and failed `currency`, `amount` and
  `two-tabs` (a real double charge); fix round 1 repaired all three from the evidence alone. On expressCart (17 Oct)
  the plain arm passed 13 of 13 at the first proof, E1 included, with no fix round: the money rules are not what
  fixed E1 there; the proof is what shows it.

## Open questions (remaining)

- Resolved in M4 (18–19 Oct, PROGRESS "Milestone 4"): the sandbox webhook is registered on the hosted URL, and the
  sandbox buyer works from Cloud Run (live re-runs pass).

## Status

Milestone history: each figure below is as of its date. Today's numbers are the README's generated results and the
site, both from `web/public/data` (`npm run export-web`).

- **M1: done (17 Oct).** 11 scenarios x 2 modes (`DEMO=1`, production with the Printful stub).
  - Original: 8 pass, 10 fail, 4 n/a. Fails: D1 unapproved confirm, D2 MXN, lost capture response (charged, not
    confirmed), two tabs (double charge), and in production mode D7 (every paid order stays unconfirmed).
  - Upgraded (full prompt, `claude-opus-5-5`, 88 turns, ~10 min): 22 of 22 pass at the first proof; no fix round
    needed.
  - Upgraded (plain migrate-only prompt, `CP_ARM=plain`): 16 of 22 at first proof (currency, amount, two-tabs fail
    in both modes); fix round 1 (14 turns, 85 s) took it to 21/22, the remaining failure was the harness's (above);
    final 22/22.
  - Packs: `out/evidence/simple-clothing-store{,-plain}/` (PR-BODY.md, EVIDENCE.md, upgrade.diff), local only.
- **M2: done (17 Oct).** expressCart, 13 scenarios (`src/prove/ec-scenarios.ts`), each driving a real buyer
  session through the shop's pages. The shop's record is read from MongoDB, and PayPal's truth comes from v1
  `GET payment` (before) or v2 `GET order` (after).
  - Original: 6 pass, 4 fail, 3 n/a, the same on two runs.
    - **E1 hero:** an €85.00 sale marks the €480.00 order of 8 items Paid.
    - **E7:** a reload of the return page crashes the process.
    - **Lost execute response:** the buyer is charged, the process crashes and the order stays `created`. The
      buyer's reload then fails with "Client Authentication failed": `paypal.configure` runs only in
      `checkout_action` (new defect, **E8**).
    - **Simulated pending sale:** marked Paid (E2).
  - Upgraded (`claude-opus-5-5`, 82 turns, 698 s, plan-equivalent $3.65): 13 of 13 at the first proof, the same on
    a second run.
  - Pack: `out/evidence/expressCart/` with `VIDEO-cancel-shrink.md`, the E1 recording summary (steps, timings,
    selectors, screenshots, sandbox IDs).
- **M3: done (17 Oct), except webhook scenarios 12/14.** `web/` (Vite + React + TS gallery: overview, one evidence
  page per target, scan box) and `server/` (static + `/api/scan`, `/api/rerun`, `/api/webhooks/paypal`). The data is
  exported from the packs by `scripts/export-web-data.ts` into `web/public/data/`. Re-run proof works locally behind
  `CP_RERUN=local` and shows "coming in M4" otherwise; the webhook listener fails closed until `PAYPAL_WEBHOOK_ID` is
  set. Local only (disclosure gate).
- Added in M1 beyond the first table: `lost-response` (#9a, the preload drops PayPal's capture response after PayPal
  processed it) and `two-tabs` (#8, two PayPal orders for one shop order).
