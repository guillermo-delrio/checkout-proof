// Exploration: open the wallet page, click PayPal, describe the popup's DOM (no credentials typed).
import { chromium } from "playwright";
const OUT = new URL("../../out/s1/", import.meta.url).pathname;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: "en-US" });
const page = await ctx.newPage();
page.on("console", (m) => console.log("[page]", m.text().slice(0, 200)));
await page.goto("http://localhost:8787/" + (process.argv[2] || ""));
await page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "loading", null, { timeout: 30000 });
console.log("state", await page.evaluate(() => document.body.dataset.state));
const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 20000 }), page.locator("#pp").click()]);
await popup.waitForLoadState("domcontentloaded");
for (let i = 0; i < 4; i++) {
  await popup.waitForTimeout(4000);
  console.log("popup url", popup.url().replace(/token=[^&]+/, "token=…"));
  const els = await popup.evaluate(() =>
    [...document.querySelectorAll("input,button,a[role=button]")]
      .filter((e) => e.offsetParent)
      .map((e) => `${e.tagName} id=${e.id} name=${e.getAttribute("name")} type=${e.type} text=${(e.innerText || "").slice(0, 30)}`),
  );
  console.log(els.join("\n"));
  await popup.screenshot({ path: OUT + `probe-${i}.png` });
}
await browser.close();
