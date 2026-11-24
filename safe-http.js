// Outgoing HTTP(S) requests to addresses a customer gave us (media URLs, webhook URLs).
// They must not reach the server's own network: every address the name resolves to is
// checked, and the connection is made to the address that was checked (no rebinding).
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

let allowPrivate = process.env.ALLOW_PRIVATE_URLS === '1'; // for local testing only

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe[89ab])/.test(v) || v.startsWith('ff');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function checkedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses.filter((a) => allowPrivate || !isPrivateAddress(a.address));
    if (!list.length) return cb(httpError(400, 'That address points to a private network, which is not allowed.'));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw httpError(400, 'Not a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'Only http and https URLs are allowed.');
  if (u.username || u.password) throw httpError(400, 'URLs with a username or password are not allowed.');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !allowPrivate && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw httpError(400, 'That address points to a private network, which is not allowed.');
  }
  return u;
}

// One request. Resolves { status, headers, body (Buffer) }. Never follows redirects.
function request(raw, { method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 50 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = parseUrl(raw); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, lookup: checkedLookup, timeout: timeoutMs }, (res) => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) { res.destroy(); return reject(httpError(413, `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); return reject(httpError(413, `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`)); }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(httpError(504, 'The other server took too long to answer.')));
    req.on('error', (e) => reject(e.status ? e : httpError(502, `Could not reach the address: ${e.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

// GET with up to 3 redirects, each one checked again.
async function get(raw, opts = {}) {
  let url = raw;
  for (let i = 0; i < 4; i++) {
    const r = await request(url, { ...opts, method: 'GET' });
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = new URL(r.headers.location, url).toString(); continue; }
    return r;
  }
  throw httpError(502, 'Too many redirects.');
}

module.exports = { request, get, parseUrl, isPrivateAddress, _test: { setAllowPrivate: (v) => { allowPrivate = v; } } };
