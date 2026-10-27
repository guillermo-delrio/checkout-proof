// sourcefuse payment-service before-code: the ORIGINAL PaypalProvider (src/providers/paypal/paypal-provider.service.ts,
// bundled by out/work/sourcefuse-payment-service/build.mjs with LoopBack DI stubbed out) run against the sandbox with
// in-memory repositories. Run with: node -r ./preload.cjs sf-provider.mjs <case...>
//   s1-declined-card: buyer pays by card and the card is declined (card leg injected, see preload.cjs INJECT_FILE)
//   s2-concurrent:    buyer approves; the app's charge endpoint is hit twice at once (double click / two tabs)
//   s2-declined-mock: buyer approves; capture gets PayPal-Mock-Response INSTRUMENT_DECLINED
//   s3-double-refund: paid order refunded, then refund called again (retry)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { ROOT, OUT, approve, getOrder, summarizeOrder, log, call } from "./pp.mjs";

const require = createRequire(import.meta.url);
process.chdir(path.join(ROOT, "out/work/sourcefuse-payment-service")); // resolve the provider's own node_modules
const { PaypalProvider } = require(path.join(ROOT, "out/work/sourcefuse-payment-service/dist/paypal-provider.cjs"));
const MOCK = process.env.MOCK_FILE, INJ = process.env.INJECT_FILE;

function memRepo() {
  const rows = new Map();
  return {
    rows,
    async findById(id) { const r = rows.get(id); if (!r) throw new Error("not found " + id); return structuredClone(r); },
    async findOne({ where }) { for (const r of rows.values()) if (Object.entries(where).every(([k, v]) => r[k] === v)) return structuredClone(r); return null; },
    async updateById(id, data) { rows.set(id, structuredClone({ ...rows.get(id), ...data })); },
    async create(data) { rows.set(data.id, structuredClone(data)); return data; },
  };
}
const browser = await chromium.launch({ headless: true });
for (const c of process.argv.slice(2)) {
  const orders = memRepo(), transactions = memRepo();
  const logger = { info() {}, error() {}, debug() {}, warn() {} };
  const gw = new PaypalProvider(transactions, orders, memRepo(), logger, { clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET }).value();
  const id = `ord-${c}-${Date.now()}`;
  await orders.create({ id, totalAmount: 4, currency: "EUR", status: "draft", paymentGatewayId: "paypal" });
  const created = await gw.create(await orders.findById(id), "");
  const rec = { target: "sourcefuse payment-service", case: c, appOrder: id, paypalOrder: created.payOrderId, payLinkType: typeof created.orderPayLink };
  const approveBuyer = async () => {
    const href = (await getOrder(created.payOrderId)).json.links.find((l) => l.rel === "approve").href;
    const a = await approve(browser, href, { until: /localhost|example\.com/ });
    if (a.ok) await a.ctx.close();
    rec.approved = a.ok; if (!a.ok) rec.approveError = a.error;
  };
  const charge = async () => { try { return await gw.charge({ orderId: id }); } catch (e) { return { threw: e.name || "Error", statusCode: e.statusCode, issue: (() => { try { return JSON.parse(e.message).details?.[0]?.issue; } catch { return String(e.message).slice(0, 80); } })() }; } };
  if (c === "s1-declined-card") {
    fs.writeFileSync(INJ, JSON.stringify({ match: "/capture", body: { payment_source: { card: { number: "4012888888881881", expiry: "2030-12", security_code: "123", name: "CCREJECT-REFUSED" } } } }));
    rec.charge = await charge();
  } else if (c === "s2-concurrent") {
    await approveBuyer();
    rec.charges = await Promise.all([charge(), charge()]);
  } else if (c === "s2-declined-mock") {
    await approveBuyer();
    fs.writeFileSync(MOCK, JSON.stringify({ match: "/capture", code: "INSTRUMENT_DECLINED" }));
    rec.charge = await charge();
    rec.chargeAgainNoMock = await charge();
  } else if (c === "s3-double-refund") {
    await approveBuyer();
    rec.charge = await charge();
    const t = [...transactions.rows.values()][0];
    const refund = async () => { try { const r = await gw.refund(t.id); return { status: r.status, err: r.err, id: r.id }; } catch (e) { return { threw: e.name, statusCode: e.statusCode, issue: (() => { try { return JSON.parse(e.message).details?.[0]?.issue; } catch { return String(e.message).slice(0, 80); } })() }; } };
    rec.refund1 = await refund();
    rec.refund2 = await refund();
  }
  rec.appOrderStatus = orders.rows.get(id).status;
  rec.appTransaction = (({ status, res }) => ({ status, captureId: res?.captureId }))([...transactions.rows.values()][0]);
  rec.paypal = summarizeOrder((await getOrder(created.payOrderId)).json);
  if (rec.appTransaction.captureId) rec.paypalCapture = (await call("GET", `/v2/payments/captures/${rec.appTransaction.captureId}`)).json.status;
  log("sf.jsonl", rec);
}
await browser.close();
