// The public API for other systems: /v1/...  (keys: see apikeys.js, events: see webhooks.js).
// Errors are always { error: { code, message } }.
const express = require('express');
const apikeys = require('./apikeys');
const webhooks = require('./webhooks');
const wa = require('./sessions');
const db = require('./db');

const { authenticate, need, err } = apikeys;
const router = express.Router();

const CODES = { 400: 'invalid_request', 401: 'invalid_key', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'gone', 413: 'too_large', 415: 'unsupported_media', 422: 'unprocessable', 429: 'rate_limited', 502: 'whatsapp_error', 504: 'timeout' };
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e.status) return err(res, e.status, CODES[e.status] || 'error', e.message);
    next(e);
  }
};

// ---- received or sent files: a signed link (in webhook events) or the key ----
const serveMedia = wrap(async (req, res) => {
  const business = req.api?.business || String(req.query.business || '');
  const file = await wa.messageMedia(business, req.params.id);
  res.set({ 'Content-Type': file.mimetype.split(';')[0], 'Content-Length': file.data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' });
  res.end(file.data);
});
router.get('/messages/:id/media', (req, res, next) => {
  if (!req.query.sig) return next();
  if (!apikeys.checkMediaLink(String(req.query.business || ''), req.params.id, req.query.exp, req.query.sig)) return err(res, 403, 'invalid_link', 'This download link is invalid or has expired.');
  serveMedia(req, res);
}, authenticate, need('read'), serveMedia);

router.use(authenticate);
const json = express.json({ limit: '70mb' }); // base64 of the biggest file (50 MB document) fits
const asNumber = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def; };

// ---- business ----
router.get('/business', need('read'), wrap(async (req, res) => res.json(wa.businessInfo(req.api.business))));
router.patch('/business/auto-reply', need('manage'), json, wrap(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return err(res, 400, 'invalid_request', '"enabled" must be true or false.');
  await require('./rules').setEnabled(req.api.business, req.body.enabled);
  res.json(wa.businessInfo(req.api.business));
}));

// ---- messages ----
async function readMultipart(req) {
  const length = Number(req.get('content-length') || 0);
  if (length > 60 * 1024 * 1024) throw Object.assign(new Error('The upload is larger than 60 MB.'), { status: 413 });
  const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.get('content-type') }, body: req, duplex: 'half' }).formData().catch(() => { throw Object.assign(new Error('Could not read the multipart upload.'), { status: 400 }); });
  const input = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') input[k] = v;
    else input.upload = { data: Buffer.from(await v.arrayBuffer()), mimetype: v.type, filename: v.name };
  }
  if (input.contacts) { try { input.contacts = JSON.parse(input.contacts); } catch { throw Object.assign(new Error('"contacts" must be JSON.'), { status: 400 }); } }
  if (input.gif !== undefined) input.gif = input.gif === 'true';
  return input;
}

router.post('/messages', need('send'), wrap(async (req, res, next) => {
  const multipart = /^multipart\/form-data/i.test(req.get('content-type') || '');
  let input;
  if (multipart) input = await readMultipart(req);
  else await new Promise((ok, no) => json(req, res, (e) => (e ? no(e) : ok())));
  input = input || req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return err(res, 400, 'invalid_request', 'Send a JSON body.');

  const idemKey = String(req.get('idempotency-key') || input.idempotency_key || '').trim().slice(0, 100);
  const business = req.api.business;
  if (idemKey) {
    const old = await db.reserveIdem(business, idemKey);
    if (old) {
      if (old.state !== 'done') return err(res, 409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.');
      res.set('Idempotent-Replay', 'true');
      return res.status(old.status).json(old.response);
    }
  }
  try {
    const result = await wa.sendApi(business, input);
    if (idemKey) await db.finishIdem(business, idemKey, 201, result);
    res.status(201).json(result);
  } catch (e) {
    if (idemKey) await db.releaseIdem(business, idemKey).catch(() => {}); // a failed send may be tried again
    throw e;
  }
}));

router.get('/messages', need('read'), wrap(async (req, res) => {
  res.json({ items: await wa.listMessages(req.api.business, { contact: req.query.contact, limit: asNumber(req.query.limit, 50, 1, 200) }) });
}));
router.get('/messages/:id', need('read'), wrap(async (req, res) => res.json(await wa.messageInfo(req.api.business, req.params.id))));

// ---- contacts ----
router.get('/contacts', need('read'), wrap(async (req, res) => {
  const limit = asNumber(req.query.limit, 50, 1, 200), offset = asNumber(req.query.offset, 0, 0, 1e6);
  const r = await wa.listApiContacts(req.api.business, { q: req.query.q, limit, offset });
  res.json({ ...r, limit, offset });
}));

// ---- orders ----
router.get('/orders', need('read'), wrap(async (req, res) => {
  const { status, contact, since } = req.query;
  if (status && !db.ORDER_STATUSES.includes(status)) return err(res, 400, 'invalid_request', `"status" must be one of: ${db.ORDER_STATUSES.join(', ')}.`);
  let sinceMs;
  if (since) {
    sinceMs = /^\d+$/.test(since) ? Number(since) : Date.parse(since);
    if (!Number.isFinite(sinceMs)) return err(res, 400, 'invalid_request', '"since" must be a date such as 2025-01-31 or a time in milliseconds.');
  }
  const digits = String(contact || '').replace(/\D/g, '');
  const limit = asNumber(req.query.limit, 50, 1, 100), offset = asNumber(req.query.offset, 0, 0, 1e6);
  const r = await db.queryOrders(req.api.business, { status, chatId: digits ? `${digits}@c.us` : undefined, since: sinceMs, limit, offset });
  res.json({ items: r.items.map(({ business, ...o }) => o), total: r.total, limit, offset });
}));
const orderId = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Order not found.'), { status: 404 }); return n; };
router.get('/orders/:id', need('read'), wrap(async (req, res) => {
  const o = await db.getOrder(req.api.business, orderId(req));
  if (!o) return err(res, 404, 'not_found', 'Order not found.');
  const { business, ...rest } = o;
  res.json(rest);
}));
router.patch('/orders/:id', need('manage'), json, wrap(async (req, res) => {
  const { business, ...o } = await wa.setOrderStatus(req.api.business, orderId(req), req.body?.status);
  res.json(o);
}));

// ---- webhooks ----
router.get('/webhooks', need('manage'), wrap(async (req, res) => {
  res.json({ items: (await db.listWebhooks(req.api.business)).map(webhooks.publicHook), events: webhooks.EVENTS });
}));
router.post('/webhooks', need('manage'), json, wrap(async (req, res) => res.status(201).json(await webhooks.create(req.api.business, req.body || {}))));
router.delete('/webhooks/:id', need('manage'), wrap(async (req, res) => {
  if (!(await db.deleteWebhook(req.api.business, req.params.id))) return err(res, 404, 'not_found', 'Webhook not found.');
  res.status(204).end();
}));
router.post('/webhooks/:id/test', need('manage'), wrap(async (req, res) => res.json(await webhooks.test(req.api.business, req.params.id))));

router.use((req, res) => err(res, 404, 'not_found', `No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}`));
router.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  if (e.type === 'entity.too.large') return err(res, 413, 'too_large', 'The request body is too large.');
  if (e.type === 'entity.parse.failed' || e instanceof SyntaxError) return err(res, 400, 'invalid_request', 'The body is not valid JSON.');
  console.error('API error:', e.message);
  err(res, 500, 'server_error', 'Server error.');
});

module.exports = router;
