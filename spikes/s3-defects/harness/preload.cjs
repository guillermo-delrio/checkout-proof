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
    if (mf && fs.existsSync(mf)) {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      if ((opts.path || '').includes(m.match) && (!m.method || m.method === opts.method)) {
        opts.headers = {...(opts.headers || {}), 'PayPal-Mock-Response': JSON.stringify({mock_application_codes: m.code})};
        mocked = m.code;
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
    const req = origReq.call(this, opts, ...rest);
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
