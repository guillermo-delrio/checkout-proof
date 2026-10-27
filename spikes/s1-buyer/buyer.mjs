// Spike 1 buyer harness. Usage: node buyer.mjs <mode> [runs]
//   mode: popup | popup-state | redirect | redirect-state | cards | login-save
// Writes JSON lines to out/s1/results.jsonl. Never prints credentials; failure screenshots mask login fields.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env"), quiet: true });
const OUT = path.join(here, "../../out/s1");
const STATE = path.join(OUT, "buyer-state.json");
const BASE = "http://localhost:8787";
const EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
const PASS = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
const scrub = (s) =>
  String(s)
    .replaceAll(PASS, "***")
    .replaceAll(EMAIL, "<buyer>")
    .replace(/clientID=[^&\s]+/g, "clientID=…")
    .slice(0, 300);

const [mode = "popup", runsArg = "1"] = process.argv.slice(2);
const runs = Number(runsArg);
const useState = mode.endsWith("-state");

async function classify(p) {
  if (!p || p.isClosed()) return null;
  const txt = (await p.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
  // PayPal preloads hidden captcha iframes; count only visible, sizeable ones.
  const frames = await p
    .evaluate(() =>
      [...document.querySelectorAll("iframe")]
        .filter((f) => { const r = f.getBoundingClientRect(); return r.width > 100 && r.height > 60 && getComputedStyle(f).visibility !== "hidden"; })
        .map((f) => f.src)
        .join(" "),
    )
    .catch(() => "");
  if (/captcha|arkose|funcaptcha/i.test(frames) ||/security challenge|i'm not a robot|captcha/.test(txt)) return "captcha";
  if (/verification code|get a code|confirm it's you|security code/.test(txt)) return "2fa";
  return null;
}

// Log in (if asked) and approve on a PayPal-hosted page. Returns when an approve button was clicked.
async function approveOnPayPal(p, steps) {
  const deadline = Date.now() + 60000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (p.isClosed()) return; // popup closes itself after approval
    const block = await classify(p);
    if (block) throw new Error(block);
    const email = p.locator("#email");
    const pass = p.locator("#password");
    const submit = p.locator(
      '#payment-submit-btn, [data-testid="submit-button-initial"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue to Review Order")',
    );
    try {
      if (await submit.first().isVisible({ timeout: 500 })) {
        steps.push("approve-click");
        await submit.first().click({ timeout: 5000 });
        return;
      }
      if (!loggedIn && (await email.isVisible({ timeout: 500 }))) {
        if ((await email.inputValue()) !== EMAIL) await email.fill(EMAIL);
        // Two login-page variants: split (email, Next, then password) and one where a stray password node
        // reports visible while #btnLogin is hidden. Click Next whenever it is shown.
        if ((await p.locator("#btnNext").isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false))) {
          steps.push("next");
          await p.locator("#btnNext").click();
          await pass.waitFor({ state: "visible", timeout: 15000 });
        }
        await pass.fill(PASS);
        steps.push("login");
        await p.locator("#btnLogin").click();
        loggedIn = true;
        continue;
      }
      if (!loggedIn && (await p.locator("#btnLogin").isVisible({ timeout: 300 }).catch(() => false))) {
        await pass.fill(PASS);
        steps.push("login-pass-only");
        await p.locator("#btnLogin").click();
        loggedIn = true;
        continue;
      }
    } catch (e) {
      if (p.isClosed()) return;
      steps.push("retry:" + scrub(e.message).split("\n")[0].slice(0, 60));
    }
    await p.waitForTimeout(700);
  }
  throw new Error("timeout waiting for approve button");
}

async function shot(p, name) {
  if (!p || p.isClosed()) return;
  await p
    .screenshot({ path: path.join(OUT, name), mask: [p.locator("#password"), p.locator("#email"), p.locator("input")] })
    .catch(() => {});
}

async function runOnce(browser, i) {
  const ctx = await browser.newContext({
    locale: "en-US",
    storageState: useState && fs.existsSync(STATE) ? STATE : undefined,
  });
  const page = await ctx.newPage();
  const steps = [];
  const t0 = Date.now();
  let paypalPage;
  const rec = { mode, run: i, ok: false };
  try {
    if (mode.startsWith("popup") || mode === "login-save") {
      await page.goto(BASE + "/?mode=popup");
      await page.waitForFunction(() => /READY|ERROR/.test(document.body.dataset.state || ""), null, { timeout: 30000 });
      const st = await page.evaluate(() => document.body.dataset.state);
      if (st !== "READY") throw new Error("page " + st);
      [paypalPage] = await Promise.all([ctx.waitForEvent("page", { timeout: 20000 }), page.locator("#pp").click()]);
      await approveOnPayPal(paypalPage, steps);
      await page.waitForFunction(() => /^CAPTURE|ERROR|CANCELLED/.test(document.body.dataset.state || ""), null, {
        timeout: 60000,
      });
      const st2 = await page.evaluate(() => document.body.dataset.state);
      rec.status = st2.split(" ").slice(0, 2).join(" ");
      rec.ok = st2.startsWith("CAPTURE COMPLETED");
    } else if (mode.startsWith("redirect")) {
      const r = await (await fetch(BASE + "/api/orders/redirect", { method: "POST" })).json();
      await page.goto(r.approveUrl);
      paypalPage = page;
      await approveOnPayPal(page, steps);
      await page.waitForURL(/localhost:8787\/(return|cancel)/, { timeout: 60000 });
      const st2 = await page.locator("#status").innerText();
      rec.status = st2.split(" ").slice(0, 2).join(" ");
      rec.ok = st2.startsWith("CAPTURE COMPLETED");
    } else if (mode === "cards") {
      await page.goto(BASE + "/cards");
      await page.waitForFunction(() => /READY|ERROR/.test(document.body.dataset.state || ""), null, { timeout: 30000 });
      const st = await page.evaluate(() => document.body.dataset.state);
      if (!st.startsWith("READY")) throw new Error("page " + st);
      const card = JSON.parse(process.env.S1_CARD || '{"number":"4032039317984658","expiry":"12/30","cvv":"123"}');
      await page.waitForTimeout(1500);
      const fill = async (sel, val) => {
        const fr = page.frameLocator(`${sel} iframe`).first();
        await fr.locator("input").first().pressSequentially(val, { delay: 30 });
      };
      await fill("#card-number", card.number);
      await fill("#card-expiry", card.expiry);
      await fill("#card-cvv", card.cvv);
      await page.locator("#pay-card").click();
      await page.waitForFunction(() => /^CAPTURE|ERROR|CARD_(failed|canceled)/.test(document.body.dataset.state || ""), null, {
        timeout: 60000,
      });
      const st2 = await page.evaluate(() => document.body.dataset.state);
      rec.status = st2.split(" ").slice(0, 2).join(" ");
      rec.ok = st2.startsWith("CAPTURE COMPLETED");
    }
    if (rec.ok && mode === "login-save") await ctx.storageState({ path: STATE });
  } catch (e) {
    rec.error = scrub(e.message).split("\n")[0];
    rec.block = await classify(paypalPage).catch(() => null);
    await shot(paypalPage, `fail-${mode}-${i}.png`);
    await shot(page, `fail-${mode}-${i}-main.png`);
  }
  rec.ms = Date.now() - t0;
  rec.steps = steps.join(",");
  await ctx.close();
  fs.appendFileSync(path.join(OUT, "results.jsonl"), JSON.stringify({ ...rec, at: new Date().toISOString() }) + "\n");
  console.log(JSON.stringify(rec));
  return rec;
}

const browser = await chromium.launch({ headless: true });
let pass = 0;
for (let i = 1; i <= runs; i++) if ((await runOnce(browser, i)).ok) pass++;
console.log(`${mode}: ${pass}/${runs}`);
await browser.close();
