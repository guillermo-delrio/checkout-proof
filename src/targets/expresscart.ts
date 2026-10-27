// Adapter for mrvautin/expressCart (MIT). Server-rendered shop, MongoDB, session cart.
// original: v1 Payments redirect (paypal-rest-sdk): form POST /paypal/checkout_action → PayPal → GET
//           /paypal/checkout_return executes the payment and sets the order status.
// upgraded: the expressCart proof contract (EC_CONTRACT in upgrade/prompts.ts): POST /paypal/orders prices the
//           session's cart, POST /paypal/orders/:id/capture captures; the payment page shows a v6 <paypal-button>.
// The shop's record is read straight from its MongoDB (orders.orderStatus), not from its pages.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { MongoClient, ObjectId, type Db } from "mongodb";
import type { BrowserContext, Page } from "playwright";
import { OUT, ROOT, mkdirp, scrub } from "../env.ts";
import { parseMoney } from "../money/money.ts";
import { getOrder } from "../paypal/truth.ts";
import { approveOn, getBrowser } from "../buyer/buyer.ts";
import { buyerApproves } from "./simple-clothing-store.ts";
import type { Adapter, ShopCall, Variant } from "./types.ts";
import type { ShopState } from "../money/verdict.ts";
import { HarnessError } from "../prove/errors.ts";

export const NAME = "expressCart";
const PORTS: Record<Variant, number> = { original: 1111, upgraded: 1112 };
export const MONGO_PORT = 27018;
const MONGO_URI = `mongodb://127.0.0.1:${MONGO_PORT}`;
const MONGOD = path.join(OUT, "vendor", "mongodb", "mongodb-linux-x86_64-ubuntu2204-6.0.24", "bin", "mongod");
// expressCart's own status vocabulary (app.js getStatusColor): these mean "the shop considers it paid".
export const PAID_STATUSES = ["Paid", "Approved", "Approved - Processing", "Completed", "Shipped"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portFree = (p: number) => new Promise<boolean>((res) => {
  const srv = net.createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true))).listen(p, "127.0.0.1");
});
const arm = () => (process.env.CP_ARM ? "-" + process.env.CP_ARM : "");

export function workDirFor(variant: Variant) {
  return path.join(OUT, "work", variant === "original" ? NAME : `${NAME}-upgraded${arm()}`);
}
const dbName = (variant: Variant) => (variant === "original" ? "expresscart" : `expresscart-upgraded${arm()}`);

// A standalone mongod (no Docker on this machine): MongoDB 6.0 tarball under out/vendor, data under out/mongo.
export async function ensureMongo() {
  if (!(await portFree(MONGO_PORT))) return;
  if (!fs.existsSync(MONGOD)) throw new Error(`harness: no mongod at ${MONGOD}; see PROGRESS.md (resume steps)`);
  mkdirp(path.join(OUT, "mongo", "data"));
  execFileSync(MONGOD, ["--fork", "--dbpath", path.join(OUT, "mongo", "data"), "--logpath", path.join(OUT, "mongo", "mongod.log"), "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1"], { stdio: "ignore" });
  for (let i = 0; i < 40 && (await portFree(MONGO_PORT)); i++) await sleep(250);
}

let client: MongoClient | null = null;
async function db(variant: Variant): Promise<Db> {
  client ??= await new MongoClient(MONGO_URI).connect();
  return client.db(dbName(variant));
}
export async function closeMongo() { if (client) await client.close(); client = null; }

function sh(cmd: string, args: string[], cwd: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PAYPAL_")));
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, maxBuffer: 64 * 1024 * 1024 });
}

// Local run settings: EUR, PayPal only, our Mongo, no real SMTP. Credentials never go into the work copy: the v1
// config file gets a placeholder that harness/preload.cjs fills from the process env (CP_V1_CONFIG).
export function configureWorkCopy(dir: string, variant: Variant) {
  const sf = path.join(dir, "config", "settings.json");
  const s = JSON.parse(fs.readFileSync(sf, "utf8"));
  Object.assign(s, {
    baseUrl: `http://localhost:${PORTS[variant]}`, emailHost: "127.0.0.1", emailPort: 2525, currencySymbol: "€", currencyISO: "EUR",
    paymentGateway: ["paypal"], databaseConnectionString: `${MONGO_URI}/${dbName(variant)}`,
  });
  fs.writeFileSync(sf, JSON.stringify(s, null, 4));
  const pf = path.join(dir, "config", "payment", "config", "paypal.json");
  if (fs.existsSync(pf)) {
    const c = JSON.parse(fs.readFileSync(pf, "utf8"));
    for (const k of ["client_id", "client_secret"]) if (k in c) c[k] = "__FROM_ENV__";
    if ("mode" in c) c.mode = "sandbox";
    if ("paypalCurrency" in c) c.paypalCurrency = "EUR";
    fs.writeFileSync(pf, JSON.stringify(c, null, 4));
  }
}

export interface EcSession {
  ctx: BrowserContext; page: Page;
  returnUrl?: string;                         // the PayPal return URL the browser last hit (original)
  returnResults: { url: string; http: number; error?: string }[];
}
export interface Begin { ppId?: string; shopOrderId?: string; call: ShopCall }

export interface EcAdapter extends Adapter {
  port: number;
  newSession(): Promise<EcSession>;
  closeSession(s: EcSession): Promise<void>;
  addToCart(s: EcSession, permalink: string, times?: number): Promise<void>;
  shrinkCart(s: EcSession): Promise<void>;      // remove the first line, then take the next line down to quantity 1
  toPayment(s: EcSession): Promise<void>;
  sessionInfo(s: EcSession): Promise<{ orderId?: string; paymentId?: string; total?: string; items?: number }>;
  begin(s: EcSession): Promise<Begin>;          // "Pay with PayPal": creates the PayPal payment/order
  pay(s: EcSession, b: Begin, opts?: { mockCode?: string; drop?: boolean; shot?: string }): Promise<ShopCall[]>; // buyer approves, shop completes
  cancel(s: EcSession, b: Begin, shot?: string): Promise<ShopCall[]>;
  retry(s: EcSession, b: Begin): Promise<ShopCall[]>; // the buyer's retry of the completion step (reload / capture again)
  capture(s: EcSession, ppId: string): Promise<ShopCall[]>; // upgraded only: POST /paypal/orders/:id/capture
  orderItems(id: string): Promise<{ items: number; lines: string[]; total: string } | null>;
  rewritePending(on: boolean): void;
  rewriteMoney(spec: { value?: string; currency?: string } | null): void;
  crashed(): string | undefined;
  shot(s: EcSession, file: string): Promise<void>;
}

export function ecAdapter(variant: Variant, runDir: string): EcAdapter {
  const port = PORTS[variant];
  const workDir = workDirFor(variant);
  const baseUrl = `http://localhost:${port}`;
  const mockFile = path.join(runDir, `mock-${port}.json`);
  const rewriteFile = path.join(runDir, `rewrite-${port}.json`);
  const ppLogFile = path.join(runDir, "pp-calls.jsonl");
  const appLogFile = path.join(runDir, "shop.log");
  let app: ChildProcess | null = null;
  let crash: string | undefined;
  let admin: BrowserContext | null = null;
  const sessions = new Set<EcSession>();
  const returnRe = /\/paypal\/checkout_return/;

  const fromShop = (u: string) => u.replace(baseUrl, "");
  const bodyText = async (p: Page) => (await p.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ").trim();
  const alertText = async (p: Page) => (await p.locator(".alert, #notify_message, .notify-message").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").trim();

  async function startApp() {
    if (!(await portFree(port))) throw new Error(`harness: port ${port} is in use (a leftover proof run?); stop it and retry`);
    const log = fs.openSync(appLogFile, "a");
    const env = {
      PATH: process.env.PATH!, HOME: process.env.HOME!,
      PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID!, PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET!, PAYPAL_ENVIRONMENT: "sandbox",
      PORT: String(port), PP_LOG: ppLogFile, MOCK_FILE: mockFile, REWRITE_FILE: rewriteFile, CP_V1_CONFIG: "1",
    };
    crash = undefined;
    const child = spawn("node", ["-r", path.join(ROOT, "harness/preload.cjs"), "app.js"], { cwd: workDir, env, stdio: ["ignore", log, log] });
    app = child;
    child.on("exit", (code, sig) => { if (app === child) crash = `shop process exited (code ${code}${sig ? ", " + sig : ""})`; });
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      if (child.exitCode !== null) throw new Error(`shop exited (${child.exitCode}); see ${appLogFile}`);
      try { const r = await fetch(`${baseUrl}/`); if (r.status === 200) return; } catch {}
    }
    throw new Error("shop did not become ready");
  }

  const a: EcAdapter = {
    target: NAME, variant, mode: "default", workDir, baseUrl, ppLogFile, appLogFile, port,
    unsupported: variant === "original"
      ? {
        "happy-ui": "the original's only button is the redirect form, which every original scenario already drives",
        currency: "the v1 redirect executes only the payment id stored in the buyer's session, so a foreign payment cannot be handed to the shop",
        amount: "the v1 redirect executes only the payment id stored in the buyer's session, so a foreign payment cannot be handed to the shop",
        "currency-own": "the harness rewrites amounts in Orders v2 answers only; the original's v1 sale answers are not rewritten",
        "amount-own": "the harness rewrites amounts in Orders v2 answers only; the original's v1 sale answers are not rewritten",
      }
      : {},

    async prepare({ rebuild = false } = {}) {
      await ensureMongo();
      if (!fs.existsSync(workDir)) {
        if (variant === "upgraded") throw new Error(`no upgraded work copy at ${workDir}; run upgrade first`);
        fs.cpSync(path.join(OUT, "targets", NAME), workDir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) });
      }
      configureWorkCopy(workDir, variant);
      if (!fs.existsSync(path.join(workDir, "node_modules")) || rebuild) sh("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], workDir);
      const d = await db(variant);
      if ((await d.collection("products").countDocuments()) === 0) sh("node", ["lib/testdata.js"], workDir); // expressCart's own seed: 8 products, owner@test.com
    },

    async start() {
      mkdirp(runDir);
      await startApp();
      const cleanup = () => { app?.kill(); };
      process.once("exit", cleanup);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { cleanup(); process.exit(130); });
    },

    async stop() {
      for (const s of sessions) await s.ctx.close().catch(() => {});
      sessions.clear();
      if (admin) await admin.close().catch(() => {});
      admin = null;
      const p = app; app = null;
      p?.kill();
      await sleep(400);
      await closeMongo();
    },

    crashed: () => crash,

    async ensureUp() {
      const c = crash;
      if (!c && app && app.exitCode === null) return undefined;
      app = null;
      await startApp();
      return c ?? "shop process was not running";
    },

    async newSession() {
      const ctx = await (await getBrowser()).newContext({ locale: "en-US" });
      const page = await ctx.newPage();
      const s: EcSession = { ctx, page, returnResults: [] };
      ctx.on("response", (r) => { if (returnRe.test(r.url())) { s.returnUrl = r.url(); s.returnResults.push({ url: r.url(), http: r.status() }); } });
      ctx.on("requestfailed", (r) => { if (returnRe.test(r.url())) { s.returnUrl = r.url(); s.returnResults.push({ url: r.url(), http: 0, error: r.failure()?.errorText }); } });
      sessions.add(s);
      return s;
    },
    async closeSession(s) { sessions.delete(s); await s.ctx.close().catch(() => {}); },

    async addToCart(s, permalink, times = 1) {
      for (let i = 0; i < times; i++) {
        await s.page.goto(`${baseUrl}/product/${permalink}`);
        await s.page.locator(".product-add-to-cart").first().click();
        await s.page.waitForTimeout(1000);
      }
    },

    async shrinkCart(s) {
      // As a buyer would on /checkout/cart: delete the first line, then press "-" on the next until it is 1.
      // (Removing every line would empty the cart, which also clears the stale order id.)
      const p = s.page;
      await p.goto(`${baseUrl}/checkout/cart`);
      await p.evaluate(() => (window as any).$(".btn-delete-from-cart").first().trigger("click"));
      await p.waitForTimeout(1500);
      for (let i = 0; i < 10; i++) {
        await p.reload();
        const info = await a.sessionInfo(s);
        const cart = await sessionCart(s);
        const q = Object.values(cart ?? {})[0] as any;
        if (!q || Number(q.quantity) <= 1 || !info) break;
        await p.evaluate(() => (window as any).$(".btn-qty-minus").first().trigger("click"));
        await p.waitForTimeout(1200);
      }
      await p.reload();
    },

    async toPayment(s) {
      const p = s.page;
      await p.goto(`${baseUrl}/checkout/information`);
      const fill = async (id: string, v: string) => { const l = p.locator(id); if ((await l.inputValue().catch(() => v)) !== v) await l.fill(v); };
      await fill("#shipEmail", "buyer@example.com");
      await fill("#shipFirstname", "Test");
      await fill("#shipLastname", "Buyer");
      await fill("#shipAddr1", "Calle Mayor 1");
      await p.locator("#shipCountry").selectOption({ label: "Spain" }).catch(() => {});
      await fill("#shipState", "Madrid");
      await fill("#shipPostcode", "28001");
      await fill("#shipPhoneNumber", "600000000");
      await p.locator("#checkoutInformation").click();
      await p.waitForURL(/checkout\/shipping/, { timeout: 20000 });
      await p.goto(`${baseUrl}/checkout/payment`);
    },

    async sessionInfo(s) {
      const sess = await sessionDoc(s);
      if (!sess) return {};
      return {
        orderId: sess.orderId ? String(sess.orderId) : undefined, paymentId: sess.paymentId,
        total: sess.totalCartAmount !== undefined ? Number(sess.totalCartAmount).toFixed(2) + " EUR" : undefined, items: sess.totalCartItems,
      };
    },

    async begin(s) {
      const p = s.page;
      if (variant === "original") {
        const respP = p.waitForResponse((r) => r.url().endsWith("/paypal/checkout_action"), { timeout: 30000 });
        await p.locator("#checkout_paypal").click();
        const resp = await respP;
        const loc = resp.headers()["location"] || "";
        await p.waitForLoadState("domcontentloaded").catch(() => {});
        if (/paypal\.com/.test(loc)) await p.waitForURL(/paypal\.com/, { timeout: 30000 }).catch(() => {});
        else await p.waitForTimeout(1500);
        const info = await a.sessionInfo(s);
        const atPayPal = /paypal\.com/.test(loc);
        return {
          ppId: atPayPal ? info.paymentId : undefined, shopOrderId: info.orderId,
          call: { step: "POST /paypal/checkout_action (the shop's Pay with PayPal form)", http: resp.status(), body: { redirect: atPayPal ? "PayPal approval page" : fromShop(loc), notice: atPayPal ? undefined : (await alertText(p)).slice(0, 200) || undefined, paymentId: info.paymentId, orderId: info.orderId } },
        };
      }
      const r = await p.request.post(`${baseUrl}/paypal/orders`, { data: {}, failOnStatusCode: false });
      const body = await r.json().catch(async () => (await r.text().catch(() => "")).slice(0, 300));
      return { ppId: body?.id, shopOrderId: body?.orderId ? String(body.orderId) : (await a.sessionInfo(s)).orderId, call: { step: "POST /paypal/orders", http: r.status(), body: scrub(body) } };
    },

    async pay(s, b, { mockCode, drop, shot } = {}) {
      if (variant === "original") {
        const calls: ShopCall[] = [];
        if (mockCode) a.mock("/execute", mockCode, "POST");
        if (drop) a.dropNext("/execute");
        const n0 = s.returnResults.length;
        const r = await approveOn(s.page, { until: new RegExp(`localhost:${port}/(payment|checkout)`), shotPath: shot, done: async () => s.returnResults.length > n0 || !!crash });
        if (!r.ok && s.returnResults.length === n0) throw new HarnessError(`sandbox buyer could not approve ${b.ppId}: ${r.error} (${r.steps.join(",")})`);
        for (let i = 0; i < 40 && s.returnResults.length === n0 && !crash; i++) await sleep(500);
        await s.page.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(1000);
        const ret = s.returnResults[n0];
        calls.push({ step: "GET /paypal/checkout_return (PayPal sends the buyer back; the shop executes the payment)", http: ret?.http ?? 0, body: { landed: fromShop(s.page.url()).split("?")[0], notice: (await alertText(s.page)).slice(0, 160) || undefined, ...(ret?.error ? { error: ret.error } : {}), ...(crash ? { shop: crash } : {}) } });
        return calls;
      }
      if (!b.ppId) return [];
      const r = await buyerApproves(b.ppId, shot);
      if (!r.ok) throw new HarnessError(`sandbox buyer could not approve ${b.ppId}: ${r.error} (${r.steps.join(",")})`);
      if (mockCode) a.mock("/capture", mockCode);
      if (drop) a.dropNext("/capture");
      return a.capture(s, b.ppId);
    },

    async cancel(s, b, shot) {
      if (variant === "original") {
        if (shot) { await s.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}); await a.shot(s, shot); }
        const r = await approveOn(s.page, { until: new RegExp(`localhost:${port}`), cancel: true });
        if (!r.ok) await s.page.goto(`${baseUrl}/paypal/checkout_cancel`); // buyer abandons PayPal and comes back by hand
        return [{ step: `buyer cancels at PayPal (${r.ok ? "Cancel and return" : "came back by hand"}) → GET /paypal/checkout_cancel`, http: 302, body: { landed: fromShop(s.page.url()) } }];
      }
      return [{ step: `buyer closes the PayPal window without paying (${b.ppId} stays unapproved)`, http: 0 }];
    },

    async retry(s, b) {
      if (variant === "original") {
        if (!s.returnUrl) return [{ step: "reload of the return page: none to reload", http: 0 }];
        const n0 = s.returnResults.length;
        const resp = await s.page.goto(s.returnUrl).catch(() => null);
        for (let i = 0; i < 20 && s.returnResults.length === n0; i++) await sleep(250);
        await sleep(1500);
        const ret = s.returnResults[n0];
        return [{ step: "GET /paypal/checkout_return again (buyer reloads the return page)", http: ret?.http ?? resp?.status() ?? 0, body: { landed: fromShop(s.page.url()).split("?")[0], notice: (await alertText(s.page)).slice(0, 160) || undefined, ...(ret?.error ? { error: ret.error } : {}), ...(crash ? { shop: crash } : {}) } }];
      }
      return b.ppId ? a.capture(s, b.ppId) : [];
    },

    async capture(s, ppId) {
      const r = await s.page.request.post(`${baseUrl}/paypal/orders/${ppId}/capture`, { data: {}, failOnStatusCode: false }).catch((e) => e as Error);
      if (r instanceof Error) return [{ step: "POST /paypal/orders/:id/capture", http: 0, body: { error: scrub(r.message).slice(0, 200), ...(crash ? { shop: crash } : {}) } }];
      const body = await r.json().catch(async () => (await r.text().catch(() => "")).slice(0, 300));
      return [{ step: "POST /paypal/orders/:id/capture", http: r.status(), body: scrub(body) }];
    },

    async orderItems(id) {
      const o = await orderDoc(id);
      if (!o) return null;
      const lines = Object.values(o.orderProducts ?? {}).map((x: any) => `${x.quantity}x ${x.title}`);
      return { items: Number(o.orderItemCount ?? lines.length), lines, total: Number(o.orderTotal).toFixed(2) + " EUR" };
    },

    async shopState(id): Promise<ShopState> {
      const o = id ? await orderDoc(id) : null;
      if (!o) return { shopOrderId: id || "(none)", total: parseMoney("0", "EUR"), paid: false, rawStatus: "no order" };
      return { shopOrderId: id, total: parseMoney(Number(o.orderTotal).toFixed(2), "EUR"), paid: PAID_STATUSES.includes(String(o.orderStatus)), rawStatus: String(o.orderStatus) };
    },

    rewritePending(on) {
      if (on) fs.writeFileSync(rewriteFile, JSON.stringify({ pending: true }));
      else fs.rmSync(rewriteFile, { force: true });
    },

    rewriteMoney(spec) {
      if (spec) fs.writeFileSync(rewriteFile, JSON.stringify(spec));
      else fs.rmSync(rewriteFile, { force: true });
    },
    dropNext(match) { fs.writeFileSync(mockFile, JSON.stringify({ match, drop: true })); },
    mock(match, code, method) { fs.writeFileSync(mockFile, JSON.stringify({ match, code, ...(method ? { method } : {}) })); },

    async shot(s, file) { await s.page.screenshot({ path: file, fullPage: true, mask: [s.page.locator('input[type="password"]')] }).catch(() => {}); },

    // The admin's view of the order (expressCart's test admin from its own seed data).
    async screenshotOrder(id: string, file: string) {
      if (!admin) {
        admin = await (await getBrowser()).newContext({ locale: "en-US" });
        const p = await admin.newPage();
        await p.goto(`${baseUrl}/admin/login`);
        await p.fill("#email", "owner@test.com");
        await p.fill("#password", "test");
        await p.locator("#loginForm").click();
        await p.waitForTimeout(1500);
        await p.close();
      }
      const p = await admin.newPage();
      try {
        await p.goto(`${baseUrl}/admin/order/view/${id}`);
        await p.waitForTimeout(800);
        await p.screenshot({ path: file, fullPage: true });
      } finally { await p.close(); }
    },

    orderPageUrl: (id) => `${baseUrl}/admin/order/view/${id}`,

    // The generic (simple-clothing-store-shaped) steps are not used for this target: its scenarios drive sessions.
    newShopOrder: async () => { throw new Error("expressCart scenarios create their own orders"); },
    checkout: async () => { throw new Error("use begin()"); },
    complete: async () => { throw new Error("use pay()/retry()"); },
    submitForeign: async () => { throw new Error("use capture()"); },
  };

  async function sessionDoc(s: EcSession): Promise<any> {
    const c = (await s.ctx.cookies(baseUrl)).find((x) => x.name === "connect.sid");
    if (!c) return null;
    const sid = decodeURIComponent(c.value).replace(/^s:/, "").split(".")[0];
    const doc = await (await db(variant)).collection("sessions").findOne({ _id: sid as any });
    return doc?.session ?? null;
  }
  async function sessionCart(s: EcSession) { return (await sessionDoc(s))?.cart; }
  async function orderDoc(id: string): Promise<any> {
    let oid: ObjectId | string = id;
    try { oid = new ObjectId(id); } catch {}
    const d = await db(variant);
    return (await d.collection("orders").findOne({ _id: oid as any })) ?? (typeof oid !== "string" ? await d.collection("orders").findOne({ _id: id as any }) : null);
  }
  return a;
}

export const pageText = async (p: Page) => (await p.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
export { getOrder };
