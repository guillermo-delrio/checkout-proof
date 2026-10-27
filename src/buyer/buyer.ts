// Sandbox buyer on PayPal's hosted approval page (spikes 1-3). Credentials from .env; never printed.
// Branches on which login control is visible (two layouts seen) and accepts the Spanish labels.
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { scrub } from "../env.ts";

let browser: Browser | null = null;
export const getBrowser = async () => (browser ??= await chromium.launch({ headless: true }));
export const closeBrowser = async () => { if (browser) await browser.close(); browser = null; };

// Landing page for return_url / cancel_url of orders the harness creates itself.
export const RETURN_PORT = 9999;
export const RETURN_BASE = `http://localhost:${RETURN_PORT}`;
let rs: http.Server | null = null;
// The buyer's return page for orders the harness makes. If the port was taken when the run began (another proof
// process held it, 19 Oct), the next call tries again, so a later approval never lands on a closed port.
export function startReturnServer() {
  if (rs) return;
  const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<h1>${(req.url || "").split("?")[0]}</h1>`); });
  rs = srv;
  srv.listen(RETURN_PORT).on("error", () => { if (rs === srv) rs = null; });
  srv.unref();
}

export interface ApproveResult { ok: boolean; steps: string[]; error?: string; finalUrl?: string }

export async function approveUrl(url: string, opts: ApproveOpts): Promise<ApproveResult> {
  startReturnServer();
  const ctx = await (await getBrowser()).newContext({ locale: "en-US" });
  const p = await ctx.newPage();
  try {
    await p.goto(url);
    return await approveOn(p, opts);
  } finally {
    await ctx.close();
  }
}

// `done` lets a caller finish early, e.g. once GET order says APPROVED: orders created without a return_url
// stay on PayPal's page after approval (probe 17 Oct).
export interface ApproveOpts { until: RegExp; shotPath?: string; cancel?: boolean; done?: () => Promise<boolean> }

export async function approveOn(p: Page, { until, shotPath, cancel = false, done }: ApproveOpts): Promise<ApproveResult> {
  const EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL || "";
  const PASS = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD || "";
  const steps: string[] = [];
  try {
    const deadline = Date.now() + 90000;
    let loggedIn = false;
    let reloads = 0;
    let lastProgress = Date.now();
    while (Date.now() < deadline) {
      if (p.isClosed()) { steps.push("page-closed"); return { ok: true, steps }; }
      if (until.test(p.url())) break;
      if (done && steps.includes("approve") && (await done().catch(() => false))) { steps.push("done"); return { ok: true, steps }; }
      const txt = (await p.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
      const visibleCaptcha = await p.locator('iframe[title*="captcha" i]:visible').count().catch(() => 0);
      if (visibleCaptcha || /security challenge|i'm not a robot/.test(txt)) throw new Error("captcha");
      try {
        if (cancel) {
          const c = p.locator('[data-testid="cancel-link"], a:text-matches("cancel(ar)? (and return|y volver)", "i"), button:text-matches("cancel(ar)? (and return|y volver)", "i")');
          if (await c.first().isVisible({ timeout: 500 })) { steps.push("cancel"); await c.first().click(); await p.waitForURL(until, { timeout: 30000 }); break; }
        }
        const submit = p.locator('#payment-submit-btn, [data-testid="submit-button-initial"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue to Review Order"), #confirmButtonTop, button:text-matches("^(continue|continuar|pay now|pagar ahora|complete purchase|completar compra|agree and pay|aceptar y pagar|continuar y revisar pedido|continue to review order)", "i")');
        // A SEPA mandate interstitial means the bank account was picked; close it and pay by card instead.
        const sepa = p.locator('[data-testid="cancel-SEPA_CONFIRMATION-interstitial"]');
        if (await sepa.isVisible({ timeout: 300 }).catch(() => false)) { steps.push("close-sepa"); await sepa.click().catch(() => {}); await p.waitForTimeout(1000); }
        if (!cancel && (await submit.first().isVisible({ timeout: 500 }))) {
          // Once the buyer's sandbox balance runs low, PayPal funds the rest from the linked bank account, which
          // needs a SEPA mandate (seen 17 Oct). Fund the rest from the sandbox Visa instead.
          const bank = p.locator('input[name="FIRadioGroup"][id^="BA-"]');
          const card = p.locator('input[name="FIRadioGroup"][id^="CC-"]');
          if ((await bank.count()) && (await bank.first().isChecked().catch(() => false)) && (await card.count())) {
            const id = await card.first().getAttribute("id");
            await p.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch(() => {});
            steps.push("card");
            await p.waitForTimeout(1500);
          }
          steps.push("approve");
          if (shotPath) await p.screenshot({ path: shotPath, mask: [p.locator("input")] }).catch(() => {});
          await submit.first().click({ timeout: 5000 });
          lastProgress = Date.now();
          await p.waitForURL(until, { timeout: done ? 3000 : 8000 }).catch(() => {});
          continue;
        }
        const email = p.locator("#email");
        const pass = p.locator("#password");
        if (!loggedIn && (await email.isVisible({ timeout: 500 }))) {
          await email.fill(EMAIL);
          const next = p.locator("#btnNext");
          if (await next.isVisible({ timeout: 500 }).catch(() => false)) await next.click({ timeout: 5000 });
          await pass.waitFor({ state: "visible", timeout: 15000 });
          await pass.fill(PASS);
          steps.push("login");
          await p.locator("#btnLogin").click({ timeout: 10000 });
          loggedIn = true;
          lastProgress = Date.now();
          await p.waitForTimeout(3000);
          continue;
        }
      } catch (e: any) {
        steps.push("retry:" + scrub(String(e.message)).split("\n")[0].slice(0, 50));
      }
      // Sandbox sometimes hangs on "Obteniendo tu cartera"; a reload recovers it (spike 2).
      if (Date.now() - lastProgress > 25000 && reloads < 2) { reloads++; steps.push("reload"); await p.reload().catch(() => {}); lastProgress = Date.now(); }
      await p.waitForTimeout(700);
    }
    if (!p.isClosed() && !until.test(p.url())) throw new Error("timeout at " + p.url().split("?")[0]);
    return { ok: true, finalUrl: p.isClosed() ? undefined : p.url().split("?")[0], steps };
  } catch (e: any) {
    if (shotPath && !p.isClosed()) await p.screenshot({ path: shotPath.replace(/\.png$/, "-fail.png"), mask: [p.locator("input")] }).catch(() => {});
    return { ok: false, error: scrub(String(e.message)).slice(0, 200), steps };
  }
}

export const shotFile = (dir: string, name: string) => path.join(dir, name.replace(/[^a-z0-9._-]/gi, "-"));
