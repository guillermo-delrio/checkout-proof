// expressCart before-code: single-cart flows. Usage: node ec-flow.mjs <declined|refused|refresh> [tag]
//  declined/refused: PayPal-Mock-Response INSTRUMENT_DECLINED / CREDIT_CARD_REFUSED on the shop's own execute call
//                    (added by preload.cjs via out/s3/mock-1111.json), after a real buyer approval.
//  refresh: real payment, then the buyer reloads the return URL (scenario 8a, E5).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { approveOn, getPaymentV1, log, OUT, ROOT } from "./pp.mjs";
const SHOP = "http://localhost:1111";
const [mode, tag = String(Date.now())] = process.argv.slice(2);
const mongo = (js) => execFileSync("docker", ["exec", "cp-mongo", "mongo", "--quiet", "expresscart", "--eval", js], { encoding: "utf8" }).trim();
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `ec-${mode}-${tag}-${n}.png`), fullPage: true });
const browser = await chromium.launch({ headless: true });
const p = await (await browser.newContext({ locale: "en-US" })).newPage();
const rec = { target: "expressCart", mode, tag };
let returnHit = null;
p.on("request", (r) => { if (r.url().includes("/paypal/checkout_return")) returnHit = r.url(); });
await p.goto(`${SHOP}/product/5-panel-camp-cap`); await p.locator(".product-add-to-cart").first().click(); await p.waitForTimeout(1200);
await p.goto(`${SHOP}/checkout/information`);
for (const [id, v] of [["#shipEmail", "buyer@example.com"], ["#shipFirstname", "Test"], ["#shipLastname", "Buyer"], ["#shipAddr1", "Calle Mayor 1"], ["#shipState", "Madrid"], ["#shipPostcode", "28001"], ["#shipPhoneNumber", "600000000"]]) await p.fill(id, v);
await p.locator("#shipCountry").selectOption({ label: "Spain" }).catch(() => {});
await p.locator("#checkoutInformation").click(); await p.waitForURL(/checkout\/shipping/);
await p.goto(`${SHOP}/checkout/payment`);
await Promise.all([p.waitForURL(/paypal\.com/, { timeout: 30000 }), p.locator("#checkout_paypal").click()]);
const code = { declined: "INSTRUMENT_DECLINED", refused: "CREDIT_CARD_REFUSED" }[mode];
if (code) fs.writeFileSync(path.join(ROOT, "out/s3/mock-1111.json"), JSON.stringify({ match: "/execute", code }));
let pay = await approveOn(p, { until: /localhost:1111\/payment\// });
for (let i = 0; !pay.ok && i < 2 && /paypal\.com/.test(p.url()); i++) { await p.reload().catch(() => {}); pay = await approveOn(p, { until: /localhost:1111\/payment\// }); }
rec.approveOk = pay.ok; if (!pay.ok) rec.approveError = pay.error;
await p.waitForTimeout(1500);
rec.returnPage = p.url().replace(SHOP, "");
rec.shopMessage = (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
await shot(p, "1-after-return");
if (mode === "refresh") {
  // The buyer reloads the PayPal return URL (/paypal/checkout_return?paymentId=…&PayerID=…), e.g. a refresh or back.
  rec.reloaded = returnHit && returnHit.replace(SHOP, "").replace(/PayerID=[^&]+/, "PayerID=…");
  await p.goto(returnHit).catch(() => {});
  await p.waitForTimeout(2000);
  rec.refreshPage = p.url().replace(SHOP, "");
  rec.refreshMessage = (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
  await shot(p, "2-after-refresh");
}
const o = JSON.parse(mongo('var o=db.orders.find().sort({orderDate:-1}).limit(1).toArray()[0]; print(JSON.stringify({id:o._id.str,status:o.orderStatus,total:o.orderTotal,payId:o.orderPaymentId}))'));
rec.shopOrder = o;
rec.transactions = JSON.parse(mongo(`print(JSON.stringify(db.transactions.find({order:ObjectId("${o.id}")}).toArray().map(t=>({ref:t.gatewayReference,approved:t.approved,amount:t.amount,msg:t.gatewayMessage}))))`));
const pp = (await getPaymentV1(o.payId)).json;
rec.paypal = { id: pp.id, state: pp.state, sale: pp.transactions?.[0]?.related_resources?.[0]?.sale?.state || null };
rec.ppCalls = fs.readFileSync(path.join(ROOT, "out/s3/logs/pp-expressCart.jsonl"), "utf8").trim().split("\n").slice(-3).map((l) => JSON.parse(l)).map((c) => `${c.method} ${c.path} ${c.status}${c.mocked ? " mock=" + c.mocked : ""}`);
log("ec.jsonl", rec);
await browser.close();
