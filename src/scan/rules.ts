// Static rules: PayPal integrations with a newer version available, deprecated PayPal pieces, and money-losing
// patterns. Line rules match one line; file rules look at a whole file; a repo rule (see scan.ts) can withdraw a
// finding when another file in the same repo answers it. Each risk maps to the SCENARIOS.md scenario that proves or
// kills it at run time.
//
// Kinds:
// - "upgrade": JS SDK v5 in any form. PayPal supports v5 fully and its own rules say never to call it deprecated
//   (out/docs/ruleshub/upgrade-to-v6_v5-to-v6-upgrade_rules.md:589, :732); v6 is the newer SDK.
// - "deprecated": only what PayPal marks deprecated: @paypal/checkout-server-sdk, paypal-rest-sdk / v1 Payments, and
//   Orders v2 `application_context` (the server SDK's own model docs: "DEPRECATED … use experience_context").
// - "risk": a money pattern. A lead, not a verdict: only a sandbox proof shows whether money is lost.
export type Kind = "upgrade" | "deprecated" | "risk";
export interface FileRule { id: string; kind: Kind; files?: RegExp; test: (src: string) => number | null; why: string }

const CODE = /\.(m?[jt]sx?|cjs|html?|hbs|ejs|vue|svelte|php)$/;
const PKG = /(^|\/)package\.json$/;
const V6 = "JS SDK v6 is available (web-sdk/v6/core)";

export interface LineRule { id: string; kind: Kind; re: RegExp; unless?: RegExp; files?: RegExp; unlessFile?: (src: string) => boolean; why: string }
export const LINE_RULES: LineRule[] = [
  { id: "v5-script", kind: "upgrade", re: /paypal\.com\/sdk\/js/, files: CODE, why: `JS SDK v5 script; ${V6}` },
  { id: "v5-buttons", kind: "upgrade", re: /paypal\.Buttons\s*\(/, files: CODE, why: `JS SDK v5 paypal.Buttons(); v6 uses createPayPalOneTimePaymentSession` },
  { id: "v5-react-wrapper", kind: "upgrade", re: /["']react-paypal-button-v2["']/, why: `react-paypal-button-v2 (a community wrapper) loads JS SDK v5; ${V6}` },
  // PayPal's own React library: v5 today. PayPal's upgrade rules say React shops keep it until it ships v6 support.
  { id: "v5-react-paypal-js", kind: "upgrade", re: /["']@paypal\/react-paypal-js["']|<PayPalScriptProvider\b/, unless: /react-paypal-js\/sdk-v6/, why: "@paypal/react-paypal-js loads JS SDK v5 through PayPalScriptProvider; PayPal's guidance is to keep it until the library supports v6" },
  { id: "checkout-server-sdk", kind: "deprecated", re: /["']@paypal\/checkout-server-sdk["']/, why: "@paypal/checkout-server-sdk is deprecated; use @paypal/paypal-server-sdk" },
  { id: "rest-sdk-v1", kind: "deprecated", re: /["']paypal-rest-sdk["']/, why: "paypal-rest-sdk (v1 Payments) is deprecated; use Orders v2 via @paypal/paypal-server-sdk" },
  { id: "v1-payments-api", kind: "deprecated", re: /\/v1\/payments\/payment/, files: CODE, why: "v1 Payments API is deprecated; use Orders v2" },
  { id: "application-context", kind: "deprecated", re: /\bapplication_context\s*["']?\s*:|\bapplicationContext\s*:/, files: CODE, why: "Orders v2 application_context is deprecated; set these fields in payment_source.paypal.experience_context" },
  { id: "client-create-order", kind: "risk", re: /actions\.order\.create\s*\(/, files: CODE, why: "order amount and currency are set in the browser (SCENARIOS #11: tampering)" },
  { id: "client-capture", kind: "risk", re: /actions\.order\.capture\s*\(/, files: CODE, why: "capture happens in the browser; a lost confirm leaves a paid, unfulfilled order (SCENARIOS #9)" },
  { id: "v1-approved-state", kind: "risk", re: /\.state\s*===?\s*["']approved["']/, files: CODE, why: "v1 payment state 'approved' is not a completed sale (SCENARIOS #10)" },
  // A COMPLETED check on something that is not a capture (most often the order). A check on a capture is the right
  // one and is not flagged: capture.status, captures[0].status, captures?.[0]?.status, captures.find(c => c.status…).
  {
    id: "order-status-only", kind: "risk", re: /\.status\s*===?\s*["']COMPLETED["']/, files: CODE,
    unless: /\bcapture\.status|captures\s*(\?\.)?\s*\[[^\]\n]{0,80}\]\s*\??\.status|captures\??\.(find|some|every|filter)\s*\(/,
    // Review r2 (evershop finalizePaypalOrder.ts:170): `paypalOrder.status === 'COMPLETED'` only picks where to read
    // the capture from; the same file then takes `captures?.[0]` and maps its status, PENDING included. A file that
    // reads a capture object and handles PENDING (a capture status; orders have none) checks the capture.
    unlessFile: (src) => readsCaptureStatus(src),
    why: "a status of COMPLETED is checked on something that is not a capture; an order can be COMPLETED while its capture is PENDING or DECLINED (SCENARIOS #5)",
  },
];

/** The file takes a capture object out of an order (`captures[0]`, `captures?.[0]`) and compares a status with
 * PENDING, which is a capture (or authorization) status: Orders v2 orders are never PENDING. */
export function readsCaptureStatus(src: string): boolean {
  return /captures\s*(\?\.)?\s*\[[^\]\n]{0,80}\]/.test(src) && /status\s*(===?|!==?)\s*["']PENDING["']|["']PENDING["']\s*(===?|!==?)\s*\S{0,80}status|case\s+["']PENDING["']/.test(src);
}

const has = (src: string, ...res: RegExp[]) => res.some((r) => r.test(src));
const lineOf = (src: string, ...res: RegExp[]) => {
  const lines = src.split("\n");
  for (const re of res) { const i = lines.findIndex((l) => re.test(l)); if (i >= 0) return i + 1; }
  return null;
};

// Every repeat in these rules is bounded ({0,n}, no newline-crossing [^x]*): a crafted file of 14 KB took 48 s on the
// old unbounded patterns and froze the live server (review r3, A1). tests/scan-speed.test.ts holds them linear.
// A file that looks at a capture's status, server or browser side. Repo-wide, this withdraws no-capture-status-check:
// PayPal's own samples capture on a pass-through server and read the capture's status in the browser.
export const CAPTURE_STATUS = /captures\s*(\?\.)?\s*\[\s*0\s*\]\s*(\?\.|\.)\s*status|\bcapture\.status|captures\??\.(find|some|every|filter)\s*\([^\n]{0,400}?\.status|sale\.state|related_resources|captures\s*(\?\.)?\s*\[[^\]\n]{0,80}\][\s\S]{0,400}?\.status\b/;

// The PayPal capture call itself (not the shop's own /capture route).
const CAPTURE_CALL = [/OrdersCaptureRequest/, /\.captureOrder\s*\(/, /payment\.execute\s*\(/, /\/v2\/checkout\/orders\/[^\n'"]{0,200}\/capture/];
const READ_CALL = [...CAPTURE_CALL, /OrdersGetRequest/, /\.getOrder\s*\(/, /\/v2\/checkout\/orders/];

export const FILE_RULES: FileRule[] = [
  {
    id: "no-capture-status-check", kind: "risk", files: CODE,
    test: (s) => (!has(s, ...READ_CALL) || CAPTURE_STATUS.test(s) ? null : lineOf(s, ...READ_CALL)),
    why: "reads or captures a PayPal order, and no file in the repo looks at the capture's status (SCENARIOS #7, #10: paid without a completed capture)",
  },
  {
    id: "no-currency-check", kind: "risk", files: CODE,
    test: (s) => {
      // Only an amount that is compared counts: recording PayPal's amount is not a check.
      const cmp = /===|!==|==|!=|[<>]=?/;
      const amt = /(amount\.value|amount\?\.value)[^\n]{0,300}?(===|!==|==|!=)|(===|!==|==|!=)[^\n]{0,300}?(amount\.value|amount\?\.value)/;
      if (!amt.test(s) || /currency_code|currencyCode/.test(s.split("\n").filter((l) => cmp.test(l)).join("\n"))) return null;
      return lineOf(s, amt);
    },
    why: "compares an amount value but never the currency (SCENARIOS #11: 62.00 MXN passes for 62.00 EUR)",
  },
  {
    id: "capture-no-request-id", kind: "risk", files: CODE,
    test: (s) => {
      // Server-side only: a browser script posting to the shop's own /capture endpoint is not a PayPal call.
      const server = /require\(\s*["'](paypal-rest-sdk|@paypal\/checkout-server-sdk|@paypal\/paypal-server-sdk)["']|from\s+["'](@paypal\/checkout-server-sdk|@paypal\/paypal-server-sdk)["']|api(-m)?\.(sandbox\.)?paypal\.com|OrdersCaptureRequest|payment\.execute\s*\(/;
      if (!has(s, ...CAPTURE_CALL) || !server.test(s) || has(s, /PayPal-Request-Id|payPalRequestId|requestId/i)) return null;
      return lineOf(s, ...CAPTURE_CALL);
    },
    why: "capture sent without a PayPal-Request-Id: if the response is lost, a retry cannot be safely replayed (SCENARIOS #8, #9)",
  },
  {
    id: "v5-paypal-js", kind: "upgrade", files: CODE,
    test: (s) => (/from\s+["']@paypal\/paypal-js["']|require\(\s*["']@paypal\/paypal-js["']\s*\)/.test(s) ? lineOf(s, /\bloadScript\s*\(/) : null),
    why: "@paypal/paypal-js loadScript() loads JS SDK v5; the same package's sdk-v6 entry loads v6",
  },
];

/** Rules whose findings a repo-wide fact can withdraw. */
export const REPO_RULES: { id: string; withdrawIf: RegExp }[] = [{ id: "no-capture-status-check", withdrawIf: CAPTURE_STATUS }];

export const PKG_RULE_IDS = ["checkout-server-sdk", "rest-sdk-v1", "v5-react-wrapper", "v5-react-paypal-js"];
export const PKG_FILES = PKG;
export const CODE_FILES = CODE;
