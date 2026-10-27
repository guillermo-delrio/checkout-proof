// expressCart before-code, scenario 3 + 11 (E1): an honest buyer cancels a big cart at PayPal, shrinks the cart,
// pays the small total, and the shop marks the OLD big order "Paid". No mock header, no tampering.
// Usage: node ec-e1.mjs [tag]   (shop on http://localhost:1111, admin owner@test.com / test from expressCart test data)
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { approveOn, getPaymentV1, log, OUT } from "./pp.mjs";

const SHOP = "http://localhost:1111";
const tag = process.argv[2] || String(Date.now());
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `ec-e1-${tag}-${n}.png`), fullPage: true, mask: [p.locator('input[type="password"]')] });
const mongo = (js) => execFileSync("docker", ["exec", "cp-mongo", "mongo", "--quiet", "expresscart", "--eval", js], { encoding: "utf8" }).trim();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: "en-US" });
const p = await ctx.newPage();
const rec = { target: "expressCart", scenario: "E1 stale order reuse", tag };

async function addToCart(permalink) {
  await p.goto(`${SHOP}/product/${permalink}`);
  await p.locator(".product-add-to-cart").first().click();
  await p.waitForTimeout(1200);
}
async function toPayment() {
  await p.goto(`${SHOP}/checkout/information`);
  const fill = async (id, v) => { const l = p.locator(id); if ((await l.inputValue()) !== v) await l.fill(v); };
  await fill("#shipEmail", "buyer@example.com");
  await fill("#shipFirstname", "Test");
  await fill("#shipLastname", "Buyer");
  await fill("#shipAddr1", "Calle Mayor 1");
  await p.locator("#shipCountry").selectOption({ label: "Spain" }).catch(() => {});
  await fill("#shipState", "Madrid");
  await fill("#shipPostcode", "28001");
  await fill("#shipPhoneNumber", "600000000");
  await p.locator("#checkoutInformation").click();
  await p.waitForURL(/checkout\/shipping/);
  await p.goto(`${SHOP}/checkout/payment`);
}
const cartTotal = async () => (await p.locator("body").innerText()).match(/Total[^\d€£$]*[€£$]?\s*([\d.,]+)/i)?.[1];

// 1. Big cart, go to PayPal, cancel.
for (let i = 0; i < 4; i++) { await addToCart("ranger-boot"); await addToCart("duckworth-jacket"); }
await toPayment();
rec.cart1Total = await cartTotal();
await shot(p, "1-payment-big-cart");
await Promise.all([p.waitForURL(/paypal\.com/, { timeout: 30000 }), p.locator("#checkout_paypal").click()]);
const cancel = await approveOn(p, { until: /localhost:1111/, cancel: true });
rec.cancelSteps = cancel.steps;
if (!cancel.ok) {
  // Buyer abandons PayPal and returns to the shop by hand; same session state either way.
  rec.cancelFallback = cancel.error;
  await p.goto(`${SHOP}/paypal/checkout_cancel`);
}
rec.payment1 = mongo('var o=db.orders.find().sort({orderDate:-1}).limit(1).toArray()[0]; print(o.orderPaymentId)');
rec.order1 = mongo('var o=db.orders.find().sort({orderDate:-1}).limit(1).toArray()[0]; print(o._id.str)');

// 2. Shrink the cart to one cap, check out again, approve and pay.
// Shrink the cart as a buyer would: remove the boots, drop the jackets to one. (Removing every line would call
// emptyCart, which clears the stale order ID; a partial shrink keeps it.)
await p.goto(`${SHOP}/checkout/cart`);
await p.evaluate(() => window.$(".btn-delete-from-cart").first().trigger("click"));
await p.waitForTimeout(1500);
await p.reload();
for (let i = 0; i < 3; i++) { await p.evaluate(() => window.$(".btn-qty-minus").first().trigger("click")); await p.waitForTimeout(1200); }
await p.reload();
rec.cartLinesAfterDelete = await p.locator(".btn-delete-from-cart:visible").count();
await toPayment();
rec.cart2Total = await cartTotal();
await shot(p, "2-payment-small-cart");
await Promise.all([p.waitForURL(/paypal\.com/, { timeout: 30000 }), p.locator("#checkout_paypal").click()]);
let pay = await approveOn(p, { until: /localhost:1111\/payment\//, shotName: `ec-e1-${tag}-3-paypal-approve.png` });
for (let i = 0; !pay.ok && i < 2 && /paypal\.com/.test(p.url()); i++) {
  rec.approveRetries = (rec.approveRetries || 0) + 1; // sandbox sometimes hangs on "Obteniendo tu cartera"
  await p.reload().catch(() => {});
  pay = await approveOn(p, { until: /localhost:1111\/payment\//, shotName: `ec-e1-${tag}-3-paypal-approve.png` });
}
rec.approveOk = pay.ok;
if (!pay.ok) rec.approveError = pay.error;
await p.waitForTimeout(1500);
await shot(p, "4-payment-complete");
rec.returnUrl = p.url().replace(SHOP, "");
rec.ordersInDb = Number(mongo("print(db.orders.count())"));
rec.paidOrder = JSON.parse(mongo(`var o=db.orders.findOne({_id:ObjectId("${rec.order1}")}); print(JSON.stringify({id:o._id.str,status:o.orderStatus,total:o.orderTotal,paymentId:o.orderPaymentId,products:Object.values(o.orderProducts).map(x=>x.title+" x"+x.quantity+" "+x.totalItemPrice)}))`));
rec.transaction = JSON.parse(mongo(`var t=db.transactions.find({order:ObjectId("${rec.order1}")}).toArray()[0]; print(JSON.stringify(t?{ref:t.gatewayReference,approved:t.approved,amount:t.amount,currency:t.currency}:null))`));

// 3. PayPal's side for both payments.
const pp1 = (await getPaymentV1(rec.payment1)).json;
rec.paypalPayment1 = { id: pp1.id, state: pp1.state, total: `${pp1.transactions?.[0]?.amount?.total} ${pp1.transactions?.[0]?.amount?.currency}` };
if (rec.transaction?.ref) {
  const pp2 = (await getPaymentV1(rec.transaction.ref)).json;
  const sale = pp2.transactions?.[0]?.related_resources?.[0]?.sale;
  rec.paypalPayment2 = { id: pp2.id, state: pp2.state, total: `${pp2.transactions?.[0]?.amount?.total} ${pp2.transactions?.[0]?.amount?.currency}`, sale: sale && { id: sale.id, state: sale.state, amount: `${sale.amount.total} ${sale.amount.currency}` } };
}

// 4. Admin view of the order.
await p.goto(`${SHOP}/admin/login`);
await p.fill("#email", "owner@test.com");
await p.fill("#password", "test");
await p.locator("#loginForm").click();
await p.waitForTimeout(1500);
await p.goto(`${SHOP}/admin/order/view/${rec.order1}`);
await shot(p, "5-admin-order");
log("ec.jsonl", rec);
await browser.close();
