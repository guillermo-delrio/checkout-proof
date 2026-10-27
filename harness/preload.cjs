// Test harness preload (node -r). Not part of any target's code.
// 1. Routes api.printful.com to a local Printful stub (PRINTFUL_STUB_PORT), so target code stays unmodified.
// 2. Adds a PayPal-Mock-Response header to the next matching sandbox PayPal call when MOCK_FILE holds
//    {"match":"<substring of path>","code":"<CODE>"}; the file is consumed on use.
// 3. Logs every PayPal call (method, path, status, debug id) to PP_LOG as JSON lines.
const https = require('https');
const http = require('http');
const fs = require('fs');
const origReq = https.request;
const PP_HOSTS = ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'];
// 5. CP_V1_CONFIG=1 (expressCart): the work copy's config/payment/config/paypal.json holds the placeholder
//    "__FROM_ENV__" instead of credentials; reads of that file get PAYPAL_CLIENT_ID/SECRET from this process's env,
//    so no credential is ever written into the work copy.
if (process.env.CP_V1_CONFIG) {
  const origRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    const out = origRead.call(this, file, ...rest);
    if (typeof file === 'string' && /config[\\/]payment[\\/]config[\\/]paypal\.json$/.test(file)) {
      const txt = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
      if (txt.includes('__FROM_ENV__')) {
        const c = JSON.parse(txt);
        if (c.client_id === '__FROM_ENV__') c.client_id = process.env.PAYPAL_CLIENT_ID;
        if (c.client_secret === '__FROM_ENV__') c.client_secret = process.env.PAYPAL_CLIENT_SECRET;
        const j = JSON.stringify(c);
        return Buffer.isBuffer(out) ? Buffer.from(j) : j;
      }
    }
    return out;
  };
}
// 6. REWRITE_FILE (SYNTHETIC and labelled so in the evidence): while the file exists, PayPal's responses to the shop
//    are rewritten before the shop's code sees them. PayPal's real records are unchanged. The file is not consumed;
//    the scenario removes it.
//    {"pending":true} (scenario 10): every COMPLETED capture (Orders v2) or completed sale (v1) becomes PENDING with
//      reason RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION.
//    {"value":"1.00"} / {"currency":"MXN"} (scenarios amount/currency on the shop's own order): every purchase unit's
//      amount and every capture's amount (Orders v2, also GET /v2/payments/captures/{id}) report that value or
//      currency instead, as if PayPal had taken a different sum for this very order. Tests the shop's own money check.
const { Readable } = require('stream');
const zlib = require('zlib');
function rewrite(j, spec) {
  let n = 0;
  const R = 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION';
  const money = (a) => {
    if (!a || typeof a !== 'object' || a.value === undefined) return;
    if (spec.value !== undefined) a.value = spec.value;
    if (spec.currency !== undefined) a.currency_code = spec.currency;
    n++;
  };
  const isCapture = j && j.amount && j.id && !j.purchase_units && j.links; // GET /v2/payments/captures/{id}
  if (spec.pending) {
    for (const pu of (j && j.purchase_units) || []) for (const c of (pu.payments && pu.payments.captures) || []) {
      if (c.status === 'COMPLETED') { c.status = 'PENDING'; c.status_details = { reason: R }; n++; }
    }
    if (isCapture && j.status === 'COMPLETED') { j.status = 'PENDING'; j.status_details = { reason: R }; n++; }
    for (const t of (j && j.transactions) || []) for (const r of t.related_resources || []) {
      if (r.sale && r.sale.state === 'completed') { r.sale.state = 'pending'; r.sale.reason_code = R; n++; }
    }
  } else if (spec.value !== undefined || spec.currency !== undefined) {
    for (const pu of (j && j.purchase_units) || []) {
      money(pu.amount);
      for (const c of (pu.payments && pu.payments.captures) || []) money(c.amount);
    }
    if (isCapture) money(j.amount);
  }
  // CP_TAG_LINKS (labelled, not a money change): PayPal's payer-action/approve link in a create answer gets an extra
  // query parameter cp_link=paypal, so the proof can tell the link PayPal gave from one the shop builds itself.
  if (spec.tagLinks) for (const l of (j && j.links) || []) {
    if ((l.rel === 'payer-action' || l.rel === 'approve') && typeof l.href === 'string' && !l.href.includes('cp_link=')) {
      l.href += (l.href.includes('?') ? '&' : '?') + 'cp_link=paypal';
      spec.tagged = { orderId: j.id, rel: l.rel, href: l.href };
    }
  }
  return n;
}
const rewriteLabel = (spec) => spec.pending ? 'PENDING' : [spec.value !== undefined && `amount ${spec.value}`, spec.currency !== undefined && `currency ${spec.currency}`].filter(Boolean).join(', ');
function rewriting(res, cb, meta, spec) {
  const chunks = [];
  res.on('data', (d) => chunks.push(d));
  res.on('end', () => {
    let buf = Buffer.concat(chunks);
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    try {
      if (enc === 'gzip') buf = zlib.gunzipSync(buf); else if (enc === 'deflate') buf = zlib.inflateSync(buf); else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
      const j = JSON.parse(buf.toString('utf8'));
      const n = rewrite(j, spec);
      if (n) meta.rewritten = `${rewriteLabel(spec)} x${n} (simulated)`;
      if (spec.tagged) meta.tagged = spec.tagged;
      if (n || spec.tagged) buf = Buffer.from(JSON.stringify(j));
    } catch (e) { meta.rewriteError = String(e.message).slice(0, 80); }
    const fake = new Readable({ read() {} });
    fake.push(buf); fake.push(null);
    const headers = { ...res.headers, 'content-length': String(buf.length) };
    delete headers['content-encoding'];
    Object.assign(fake, { statusCode: res.statusCode, statusMessage: res.statusMessage, headers, rawHeaders: [], httpVersion: res.httpVersion, httpVersionMajor: res.httpVersionMajor, httpVersionMinor: res.httpVersionMinor, req: res.req, socket: res.socket, connection: res.socket, complete: true, trailers: {}, rawTrailers: [], setTimeout: () => fake });
    logLine({ method: meta.method, path: meta.path, status: res.statusCode, debugId: res.headers['paypal-debug-id'], mocked: meta.mocked, rewritten: meta.rewritten, rewriteError: meta.rewriteError, tagged: meta.tagged });
    cb(fake);
  });
}
const logLine = (o) => process.env.PP_LOG && fs.appendFileSync(process.env.PP_LOG, JSON.stringify({...o, at: new Date().toISOString()}) + '\n');
https.request = function (opts, ...rest) {
  if (typeof opts === 'string' || opts instanceof URL) return origReq.call(this, opts, ...rest);
  const host = opts.hostname || opts.host;
  if (host === 'api.printful.com' && process.env.PRINTFUL_STUB_PORT) {
    const o = {...opts, host: '127.0.0.1', hostname: '127.0.0.1', port: Number(process.env.PRINTFUL_STUB_PORT), protocol: 'http:'};
    delete o.agent;
    return http.request(o, ...rest);
  }
  if (PP_HOSTS.includes(host)) {
    if (PP_HOSTS[0] === host && host !== 'api-m.sandbox.paypal.com') { /* keep host */ }
    const mf = process.env.MOCK_FILE;
    let mocked = null;
    let drop = false;
    if (mf && fs.existsSync(mf)) {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      if ((opts.path || '').includes(m.match) && (!m.method || m.method === opts.method)) {
        // {"drop":true}: let PayPal process the call, then lose its response (SCENARIOS #9a, a real lost response)
        if (m.drop) drop = true;
        else opts.headers = {...(opts.headers || {}), 'PayPal-Mock-Response': JSON.stringify({mock_application_codes: m.code})};
        mocked = m.drop ? null : m.code; // a dropped response is our own simulation, not a PayPal mock code
        fs.unlinkSync(mf);
      }
    }
    // 4. INJECT_FILE {"match":"/capture","body":{...}} replaces the JSON body of the next matching call
    //    (stand-in for a buyer's card entered on PayPal's page; disclosed as synthetic in RESULT.md).
    const inf = process.env.INJECT_FILE;
    let inject = null;
    if (inf && fs.existsSync(inf)) {
      const m = JSON.parse(fs.readFileSync(inf, 'utf8'));
      if ((opts.path || '').includes(m.match)) {
        inject = JSON.stringify(m.body);
        fs.unlinkSync(inf);
        opts.headers = {...(opts.headers || {})};
        for (const k of Object.keys(opts.headers)) if (k.toLowerCase() === 'content-length') delete opts.headers[k];
        opts.headers['Content-Length'] = Buffer.byteLength(inject);
        opts.headers['Content-Type'] = 'application/json';
      }
    }
    let req;
    const rf = process.env.REWRITE_FILE;
    const tag = !!process.env.CP_TAG_LINKS && opts.method === 'POST' && (opts.path || '').split('?')[0] === '/v2/checkout/orders';
    if (!drop && ((rf && fs.existsSync(rf)) || tag)) {
      const i = rest.findIndex((x) => typeof x === 'function');
      if (i >= 0) {
        opts.headers = { ...(opts.headers || {}) };
        for (const k of Object.keys(opts.headers)) if (k.toLowerCase() === 'accept-encoding') delete opts.headers[k];
        opts.headers['Accept-Encoding'] = 'identity';
        const cb = rest[i];
        const meta = { method: opts.method, path: (opts.path || '').split('?')[0], mocked };
        const spec = { ...(rf && fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : {}), ...(tag ? { tagLinks: true } : {}) };
        rest[i] = (res) => rewriting(res, cb, meta, spec);
        return origReq.call(this, opts, ...rest);
      }
    }
    if (drop) {
      const i = rest.findIndex((x) => typeof x === 'function');
      const lose = (res) => {
        res.resume();
        logLine({method: opts.method, path: (opts.path || '').split('?')[0], status: res.statusCode, debugId: res.headers['paypal-debug-id'], dropped: true, simulated: 'harness: response dropped after PayPal processed the call'});
        req.destroy(Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}));
      };
      if (i >= 0) rest[i] = lose;
      req = origReq.call(this, opts, ...rest);
      if (i < 0) req.prependOnceListener('response', lose);
      return req;
    }
    req = origReq.call(this, opts, ...rest);
    if (inject) {
      const end = req.end.bind(req);
      req.write = () => true;
      req.end = (...a) => { const cb = a.find((x) => typeof x === 'function'); return end(inject, cb); };
    }
    req.on('response', (res) => logLine({method: opts.method, path: (opts.path || '').split('?')[0], status: res.statusCode, debugId: res.headers['paypal-debug-id'], mocked, injected: !!inject}));
    return req;
  }
  return origReq.call(this, opts, ...rest);
};
