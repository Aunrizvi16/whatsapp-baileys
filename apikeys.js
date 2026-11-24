// API keys for other systems. A key belongs to one business and carries scopes:
//   read    : read messages, contacts, orders, the business status
//   send    : send messages
//   manage  : change orders, the auto-reply switch, and webhooks
// Only a hash of the key is stored; the key itself is shown once, when it is created.
const crypto = require('crypto');
const db = require('./db');

const SCOPES = ['read', 'send', 'manage'];
const KEY_PREFIX = 'wak_';
const MAX_KEYS = 20;
const RATE_PER_MIN = Number(process.env.API_RATE_PER_MIN || 120);

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function create(business, { name, scopes, by } = {}) {
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw httpError(400, 'Give the key a name, for example the system that will use it.');
  const list = scopes === undefined ? ['read', 'send'] : scopes;
  if (!Array.isArray(list) || !list.length || list.some((s) => !SCOPES.includes(s))) throw httpError(400, `"scopes" must be a list of: ${SCOPES.join(', ')}.`);
  if ((await db.listApiKeys(business)).length >= MAX_KEYS) throw httpError(409, `A business can have at most ${MAX_KEYS} keys. Remove one you no longer use.`);
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const doc = { _id: sha(key), business, name: cleanName, prefix: key.slice(0, 12), scopes: [...new Set(list)], created_by: by || null, created_at: Date.now(), last_used_at: null };
  await db.createApiKey(doc);
  return { id: doc._id, name: doc.name, prefix: doc.prefix, scopes: doc.scopes, created_at: doc.created_at, key }; // `key` is shown only now
}

// ---- rate limit: requests per key per minute ----
const windows = new Map(); // key id -> { n, reset }
function hit(id, limit = RATE_PER_MIN, now = Date.now()) {
  let w = windows.get(id);
  if (!w || w.reset <= now) { w = { n: 0, reset: now + 60000 }; windows.set(id, w); }
  w.n++;
  if (windows.size > 5000) for (const [k, v] of windows) if (v.reset <= now) windows.delete(k);
  return { ok: w.n <= limit, limit, remaining: Math.max(0, limit - w.n), reset: Math.ceil(w.reset / 1000), retry: Math.max(1, Math.ceil((w.reset - now) / 1000)) };
}

// Wrong keys from one address: slow guessing down.
const failures = new Map(); // ip -> { n, reset }
function failedAuth(ip, now = Date.now()) {
  let f = failures.get(ip);
  if (!f || f.reset <= now) { f = { n: 0, reset: now + 10 * 60000 }; failures.set(ip, f); }
  f.n++;
  if (failures.size > 5000) for (const [k, v] of failures) if (v.reset <= now) failures.delete(k);
}
const tooManyFailures = (ip, now = Date.now()) => { const f = failures.get(ip); return Boolean(f && f.reset > now && f.n > 30); };

const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });

// Express middleware: Authorization: Bearer wak_...  -> req.api = { business, keyId, scopes }
function authenticate(req, res, next) {
  (async () => {
    if (tooManyFailures(req.ip)) return err(res, 429, 'rate_limited', 'Too many wrong keys from this address. Try again in a few minutes.');
    const m = /^Bearer\s+(wak_[A-Za-z0-9_-]{20,})\s*$/.exec(req.get('authorization') || '');
    const doc = m && db.isReady() ? await db.getApiKey(sha(m[1])) : null;
    if (!doc) {
      failedAuth(req.ip);
      return err(res, 401, 'invalid_key', 'Missing or invalid API key. Send it as "Authorization: Bearer wak_...".');
    }
    const rate = hit(doc._id);
    res.set({ 'RateLimit-Limit': String(rate.limit), 'RateLimit-Remaining': String(rate.remaining), 'RateLimit-Reset': String(rate.reset) });
    if (!rate.ok) {
      res.set('Retry-After', String(rate.retry));
      return err(res, 429, 'rate_limited', `Too many requests. Limit is ${rate.limit} per minute for this key.`, { retry_after: rate.retry });
    }
    if (!doc.last_used_at || Date.now() - doc.last_used_at > 60000) db.touchApiKey(doc._id).catch(() => {});
    req.api = { business: doc.business, keyId: doc._id, scopes: doc.scopes };
    next();
  })().catch(next);
}

const need = (scope) => (req, res, next) => (req.api.scopes.includes(scope)
  ? next()
  : err(res, 403, 'missing_scope', `This key does not have the "${scope}" scope.`));

// ---- short-lived download links for received media (inside webhook events) ----
const URL_SECRET = process.env.API_URL_SECRET || crypto.randomBytes(32).toString('hex');
const MEDIA_LINK_TTL_S = 3600;
const mediaSig = (business, msgId, exp) => crypto.createHmac('sha256', URL_SECRET).update(`${business}|${msgId}|${exp}`).digest('hex');
function mediaLink(business, msgId) {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_S;
  const rel = `/v1/messages/${encodeURIComponent(msgId)}/media?business=${encodeURIComponent(business)}&exp=${exp}&sig=${mediaSig(business, msgId, exp)}`;
  return (process.env.PUBLIC_URL || '').replace(/\/+$/, '') + rel;
}
function checkMediaLink(business, msgId, exp, sig) {
  const e = Number(exp);
  if (!business || !sig || !Number.isFinite(e) || e < Date.now() / 1000) return false;
  const want = Buffer.from(mediaSig(business, msgId, e));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { SCOPES, create, authenticate, need, hit, mediaLink, checkMediaLink, err, sha };
