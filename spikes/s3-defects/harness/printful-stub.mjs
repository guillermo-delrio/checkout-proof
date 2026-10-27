// Minimal local Printful API stub for simple-clothing-store. Port from argv[2]. Logs requests to stdout.
import http from "node:http";
const port = Number(process.argv[2] || 4010);
const variants = [
  { id: 101, name: "Tee / M", retail_price: "25.00", currency: "EUR", files: [], product: { image: "" } },
  { id: 102, name: "Hoodie / L", retail_price: "45.00", currency: "EUR", files: [], product: { image: "" } },
];
const products = [{ id: 1, name: "Tee", thumbnail_url: "", variants: 1 }, { id: 2, name: "Hoodie", thumbnail_url: "", variants: 1 }];
const orders = new Map();
let next = 9000001;
const ok = (res, result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: 200, result })); };
const nf = (res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: 404, result: "Not found", error: { reason: "NotFound", message: "Not found" } })); };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url.replace(/^\//, "");
    console.log(JSON.stringify({ stub: "printful", method: req.method, path: u }));
    const j = body ? JSON.parse(body) : {};
    if (u === "store/products") return ok(res, products);
    let m;
    if ((m = u.match(/^store\/products\/(\d+)$/))) {
      const p = products.find((x) => x.id == m[1]);
      return ok(res, { sync_product: { id: p.id, name: p.name, thumbnail_url: "" }, sync_variants: [variants[p.id - 1]] });
    }
    if (u === "store") return ok(res, { name: "Stub Store", currency: "EUR", packing_slip: { email: "store@example.com" } });
    if (u === "countries") return ok(res, [{ code: "ES", name: "Spain", states: null }]);
    if (u === "orders/estimate-costs") return ok(res, { costs: { shipping: "5.00" } });
    if (u === "orders" && req.method === "POST") {
      const subtotal = j.items.reduce((a, i) => a + Number(i.retail_price), 0);
      const num = (v) => Number(String(v || 0).replace(/[^0-9.-]/g, "")); const discount = num(j.retail_costs?.discount), tax = num(j.retail_costs?.tax), shipping = 5;
      const total = (subtotal + shipping + tax - discount).toFixed(2);
      const id = next++;
      const o = { id, status: "draft", created: Math.floor(Date.now() / 1000), shipments: [], shipping_service_name: "Flat rate", recipient: { country_name: "Spain", state_name: "", ...j.recipient }, items: j.items.map((i, n) => ({ id: n + 1, name: `Item ${i.sync_variant_id}`, quantity: i.quantity, retail_price: i.retail_price, files: [] })),
        costs: { currency: "EUR", subtotal: subtotal.toFixed(2), discount: discount.toFixed(2), shipping: "5.00", digitization: "0.00", additional_fee: "0.00", fulfillment_fee: "0.00", tax: tax.toFixed(2), vat: "0.00", total },
        retail_costs: { currency: "EUR", subtotal: subtotal.toFixed(2), discount: discount.toFixed(2), shipping: "5.00", tax: tax.toFixed(2), vat: "0.00", total } };
      orders.set(String(id), o);
      return ok(res, o);
    }
    if ((m = u.match(/^orders\/([^/]+)\/confirm$/)) && req.method === "POST") {
      const o = orders.get(m[1]);
      if (!o) return nf(res);
      o.status = "pending";
      return ok(res, o);
    }
    if ((m = u.match(/^orders\/([^/]+)$/))) { const o = orders.get(m[1]); return o ? ok(res, o) : nf(res); }
    nf(res);
  });
}).listen(port, () => console.log("printful stub on " + port));
