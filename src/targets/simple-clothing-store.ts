// Adapter for kerkkoh/simple-clothing-store (MIT). DEMO=1 mode (confirm records in memory) with the local Printful stub.
// original: v5 client (react-paypal-button-v2) creates and captures in the browser, then POST /api/confirm/:id.
// upgraded: the proof contract from the upgrade prompt (POST /api/paypal/orders, POST /api/paypal/orders/:id/capture).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { OUT, ROOT, mkdirp, scrub } from "../env.ts";
import { parseMoney } from "../money/money.ts";
import { call as pp, approveLink, getOrder } from "../paypal/truth.ts";
import { approveOn, getBrowser } from "../buyer/buyer.ts";
import type { Adapter, ShopCall, Variant } from "./types.ts";

const NAME = "simple-clothing-store";
const PORTS: Record<Variant, [number, number]> = { original: [3301, 4301], upgraded: [3302, 4302] };

const portFree = (p: number) => new Promise<boolean>((res) => {
  const srv = net.createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true))).listen(p);
});
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function workDirFor(variant: Variant) {
  // CP_ARM names a second upgraded copy (e.g. "plain": the migration-only prompt), kept apart from the main one.
  return path.join(OUT, "work", variant === "original" ? NAME : `${NAME}-upgraded${process.env.CP_ARM ? "-" + process.env.CP_ARM : ""}`);
}

function sh(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  // Child processes for installs and builds get no PayPal credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PAYPAL_")));
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
}

export function scsAdapter(variant: Variant, runDir: string, mode: "demo" | "production" = "demo"): Adapter {
  const [port, stubPort] = PORTS[variant];
  const workDir = workDirFor(variant);
  const baseUrl = `http://localhost:${port}`;
  const mockFile = path.join(runDir, `mock-${port}.json`);
  const rewriteFile = path.join(runDir, `rewrite-${port}.json`);
  const ppLogFile = path.join(runDir, "pp-calls.jsonl");
  const appLogFile = path.join(runDir, "shop.log");
  let stub: ChildProcess | undefined, app: ChildProcess | undefined;
  // The shop's own data folder for this run: kept across a restart within the run, fresh for the next run.
  const dataDir = path.join(runDir, "shop-data");

  const startApp = async (log: number) => {
    const env = {
      PATH: process.env.PATH!, HOME: process.env.HOME!,
      PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID!, PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET!, PAYPAL_ENVIRONMENT: "sandbox",
      PORT: String(port), ...(mode === "demo" ? { DEMO: "1" } : {}), PRINTFUL_STUB_PORT: String(stubPort), PP_LOG: ppLogFile, MOCK_FILE: mockFile, REWRITE_FILE: rewriteFile,
      SHOP_DATA_DIR: mkdirp(dataDir),
      // Tags the payer-action link in PayPal's create answers, so the proof can tell PayPal's link from a built one.
      CP_TAG_LINKS: "1",
      // The shop verifies webhook deliveries itself (the site's listener forwards them while a re-run is going).
      ...(process.env.PAYPAL_WEBHOOK_ID ? { PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID } : {}),
    };
    app = spawn("node", ["-r", path.join(ROOT, "harness/preload.cjs"), "server.js"], { cwd: workDir, env, stdio: ["ignore", log, log] });
    const me = app;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (me.exitCode !== null) throw new Error(`shop exited (${me.exitCode}); see ${appLogFile}`);
      try {
        const prods = await j(await fetch(`${baseUrl}/api/products`));
        if (Array.isArray(prods) && prods.length && prods.every((p: any) => p.sync_variants)) return;
      } catch {}
    }
    throw new Error("shop did not become ready");
  };

  const draftBody = { firstName: "Test", lastName: "Buyer", email: "buyer@example.com", phone: "600000000", address: "Calle 1", country: "ES", city: "Madrid", state: "", zip: "28001", cart: { items: [{ id: 102 }], discountCode: "" } };

  const a: Adapter = {
    target: NAME, variant, mode, workDir, baseUrl, ppLogFile, appLogFile,
    unsupported: variant === "original"
      ? { "happy-ui": "v5 button needs a client ID compiled into the front end; the original's flow is proved through its server step instead", "create-refused": "the original creates orders in the browser, so the shop's server never sees a create call to fail", webhook: "no webhook handling in the original (a finding: pending, refunded and reversed payments never reach the order)", "payer-action": "the original captures in the browser through the v5 SDK, so its server never sees PayPal's PAYER_ACTION_REQUIRED answer", "restart-pending": "the original's server never sees the capture, so it has no pending payment to keep across a restart (its missing pending handling is the webhook row's finding)" }
      : process.env.CP_WEBHOOK_LIVE === "1" ? {}
      : { webhook: "needs real PayPal deliveries, which reach only the hosted listener: runs in the live re-run (CP_WEBHOOK_LIVE=1)" },

    async prepare({ rebuild = false } = {}) {
      if (!fs.existsSync(workDir)) {
        if (variant === "upgraded") throw new Error(`no upgraded work copy at ${workDir}; run upgrade first`);
        fs.cpSync(path.join(OUT, "targets", NAME), workDir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) });
      }
      if (!fs.existsSync(path.join(workDir, "node_modules")) || rebuild) sh("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], workDir);
      const fe = path.join(workDir, "frontend");
      // The Cloud Run image carries build/ but no frontend/: only install the front end when it must be built.
      const built = fs.existsSync(path.join(workDir, "build", "index.html"));
      if ((!built || rebuild) && (!fs.existsSync(path.join(fe, "node_modules")) || rebuild)) sh("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], fe);
      if (!built || rebuild) {
        // CRA 4 on Node 22: legacy OpenSSL; the root's eslint config deps are not installed (spike 2).
        sh("npx", ["react-scripts", "build"], fe, { NODE_OPTIONS: "--openssl-legacy-provider", DISABLE_ESLINT_PLUGIN: "true", CI: "false", GENERATE_SOURCEMAP: "false" });
        fs.rmSync(path.join(workDir, "build"), { recursive: true, force: true });
        fs.cpSync(path.join(fe, "build"), path.join(workDir, "build"), { recursive: true });
      }
    },

    async start() {
      mkdirp(runDir);
      // A port held by a leftover run is the harness's problem, never the shop's: fail before the model sees it.
      for (const p of [port, stubPort]) if (!(await portFree(p))) throw new Error(`harness: port ${p} is in use (a leftover proof run?); stop it and retry`);
      const log = fs.openSync(appLogFile, "a");
      stub = spawn("node", [path.join(ROOT, "harness/printful-stub.mjs"), String(stubPort)], { stdio: ["ignore", log, log] });
      await sleep(400);
      // Never leave a shop or stub behind when the CLI is killed (a leftover held ports 3302/4302 on 17 Oct).
      const cleanup = () => { stub?.kill(); app?.kill(); };
      process.once("exit", cleanup);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { cleanup(); process.exit(130); });
      await startApp(log);
    },

    // Restarts only the shop's process (a deploy, a crash, a scale-down); the Printful stub keeps its orders, and
    // SHOP_DATA_DIR (inside this run's folder) keeps whatever the shop wrote there.
    async restart() {
      const old = app;
      if (old && old.exitCode === null) { const gone = new Promise((r) => old.once("exit", r)); old.kill("SIGTERM"); await Promise.race([gone, sleep(5000)]); if (old.exitCode === null) old.kill("SIGKILL"); }
      for (let i = 0; i < 20 && !(await portFree(port)); i++) await sleep(250);
      await startApp(fs.openSync(appLogFile, "a"));
    },

    async stop() {
      stub?.kill(); app?.kill();
      stub = app = undefined;
      await sleep(300);
    },

    async newShopOrder() {
      const r = await fetch(`${baseUrl}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftBody) });
      const id = String(await r.text());
      const o = await j(await fetch(`${baseUrl}/api/orders/${id}`));
      return { id, total: parseMoney(o.retail_costs.total, o.retail_costs.currency) };
    },

    async shopState(id) {
      const o = await j(await fetch(`${baseUrl}/api/orders/${id}`));
      return { shopOrderId: id, total: parseMoney(o.retail_costs.total, o.retail_costs.currency), paid: o.status === "pending", rawStatus: String(o.status) };
    },

    async checkout(shopOrderId) {
      if (variant === "original") {
        // Payment.js:32-68 builds this in the browser with the order's retail_costs (breakdown omitted).
        const o = await j(await fetch(`${baseUrl}/api/orders/${shopOrderId}`));
        const r = await pp("POST", "/v2/checkout/orders", {
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: o.retail_costs.currency, value: o.retail_costs.total }, description: `Payment for your order ${shopOrderId}`, custom_id: `${shopOrderId}` }],
          application_context: { shipping_preference: "NO_SHIPPING", brand_name: "CLOTHING STORE" },
        });
        return { ppOrderId: r.json?.id, call: { step: "browser: actions.order.create (played by harness)", http: r.status, body: { id: r.json?.id, debug_id: r.debugId } } };
      }
      const r = await fetch(`${baseUrl}/api/paypal/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopOrderId }) });
      const body = await j(r);
      return { ppOrderId: body?.id, call: { step: "POST /api/paypal/orders", http: r.status, body: scrub(body) } };
    },

    async complete(ppOrderId, { clientMock, lose } = {}) {
      const calls: ShopCall[] = [];
      if (variant === "original") {
        // Payment.js:11-17: actions.order.capture() in the browser, then POST /api/confirm/:id; no .catch.
        const cap = await pp("POST", `/v2/checkout/orders/${ppOrderId}/capture`, {}, clientMock ? { "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: clientMock }) } : {});
        calls.push({ step: "browser: actions.order.capture (played by harness)", http: cap.status, body: { status: cap.json?.status, issue: cap.json?.details?.[0]?.issue, debug_id: cap.debugId, ...(clientMock ? { mock: clientMock } : {}) } });
        if (cap.status >= 300) { calls.push({ step: "browser: capture rejected; Payment.js has no handler, confirm is never called", http: 0 }); return calls; }
        if (lose) { calls.push({ step: "browser: capture response lost (tab closed / network); Payment.js never calls confirm and nothing reconciles", http: 0 }); return calls; }
        const r = await fetch(`${baseUrl}/api/confirm/${ppOrderId}`, { method: "POST" });
        calls.push({ step: "POST /api/confirm/:id", http: r.status, body: scrub(await j(r)) });
        return calls;
      }
      const r = await fetch(`${baseUrl}/api/paypal/orders/${ppOrderId}/capture`, { method: "POST" });
      calls.push({ step: "POST /api/paypal/orders/:id/capture", http: r.status, body: scrub(await j(r)) });
      return calls;
    },

    async submitForeign(ppOrderId) {
      const step = variant === "original" ? `/api/confirm/${ppOrderId}` : `/api/paypal/orders/${ppOrderId}/capture`;
      const r = await fetch(baseUrl + step, { method: "POST" });
      return [{ step: `POST ${step.replace(ppOrderId, ":id")}`, http: r.status, body: scrub(await j(r)) }];
    },

    dropNext(match) {
      fs.writeFileSync(mockFile, JSON.stringify({ match, drop: true }));
    },

    mock(match, code, method) {
      fs.writeFileSync(mockFile, JSON.stringify({ match, code, ...(method ? { method } : {}) }));
    },

    orderPageUrl: (id) => `${baseUrl}/order/${id}`,

    rewritePending(on) {
      if (on) fs.writeFileSync(rewriteFile, JSON.stringify({ pending: true }));
      else fs.rmSync(rewriteFile, { force: true });
    },

    rewriteMoney(spec) {
      if (spec) fs.writeFileSync(rewriteFile, JSON.stringify(spec));
      else fs.rmSync(rewriteFile, { force: true });
    },
  };

  if (variant === "upgraded") {
    a.uiCheckout = async (shopOrderId, shotDir) => {
      const notes: string[] = [];
      const calls: ShopCall[] = [];
      let ppOrderId: string | undefined;
      const ctx = await (await getBrowser()).newContext({ locale: "en-US" });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      page.on("response", async (res) => {
        const u = new URL(res.url());
        if (u.origin !== baseUrl || !u.pathname.startsWith("/api/paypal/")) return;
        const body = await res.json().catch(() => undefined);
        if (u.pathname === "/api/paypal/orders" && body?.id) ppOrderId = body.id;
        calls.push({ step: `browser → ${res.request().method()} ${u.pathname.replace(/orders\/[A-Z0-9]+/, "orders/:id")}`, http: res.status(), body: scrub(body) });
      });
      try {
        await page.goto(a.orderPageUrl(shopOrderId));
        const btn = page.locator("paypal-button");
        await btn.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
        if (!(await btn.isVisible().catch(() => false))) {
          notes.push("the shop's <paypal-button> never became visible");
          await page.screenshot({ path: path.join(shotDir, "happy-ui-no-button.png"), fullPage: true });
          return { ppOrderId, calls, notes: [...notes, ...errors.map((e) => "console: " + e)] };
        }
        await page.screenshot({ path: path.join(shotDir, "happy-ui-1-button.png"), fullPage: true });
        const popupP = ctx.waitForEvent("page", { timeout: 20000 }).catch(() => null);
        await btn.click();
        const popup = await popupP;
        notes.push(popup ? "PayPal opened in a popup" : "PayPal opened in the same page");
        const target = popup || page;
        const r = await approveOn(target, {
          until: new RegExp(baseUrl.replace(/[/.:]/g, "\\$&")),
          shotPath: path.join(shotDir, "happy-ui-2-paypal.png"),
          done: async () => !!ppOrderId && ["APPROVED", "COMPLETED"].includes((await getOrder(ppOrderId)).json?.status),
        });
        notes.push(`buyer: ${r.ok ? "approved" : "failed: " + r.error} (${r.steps.join(",")})`);
        for (let i = 0; i < 30; i++) { if ((await a.shopState(shopOrderId)).paid) break; await sleep(1000); }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(shotDir, "happy-ui-3-after.png"), fullPage: true });
        const notice = (await page.locator(".alert").allInnerTexts().catch(() => [])).join(" | ");
        if (notice) notes.push("shop notice: " + notice.slice(0, 200));
      } finally {
        await ctx.close();
      }
      return { ppOrderId, calls, notes: [...notes, ...errors.slice(0, 5).map((e) => "console: " + scrub(e))] };
    };
  }
  return a;
}

// Approve a PayPal order on PayPal's hosted page as the sandbox buyer (redirect, no return_url needed).
export async function buyerApproves(ppOrderId: string, shotPath?: string) {
  const o = await getOrder(ppOrderId);
  const link = approveLink(o.json);
  if (!link) return { ok: false, steps: [], error: "no approve link" };
  const ctx = await (await getBrowser()).newContext({ locale: "en-US" });
  // Orders the upgraded shop creates return the buyer to its order page (?paypal=return), which captures. The
  // harness plays the buyer only up to approval and drives the capture itself, so that page is never loaded here.
  const SHOP_RETURN = /[?&]paypal=(return|cancel)\b/;
  await ctx.route((u) => SHOP_RETURN.test(u.search), (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>returned to the shop (held by the harness)</h1>" }));
  const p = await ctx.newPage();
  try {
    await p.goto(link);
    return await approveOn(p, { until: /localhost:9999|[?&]paypal=(return|cancel)\b/, shotPath, done: async () => ["APPROVED", "COMPLETED"].includes((await getOrder(ppOrderId)).json?.status) });
  } finally { await ctx.close(); }
}

// The Cloud Run image carries no .git: ops/stage.sh writes the work copy's commit to .cp-commit instead.
export const gitHead = (dir: string) => { if (fs.existsSync(path.join(dir, ".cp-commit"))) return fs.readFileSync(path.join(dir, ".cp-commit"), "utf8").trim(); if (!fs.existsSync(path.join(dir, ".git"))) return undefined; try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim(); } catch { return undefined; } };
