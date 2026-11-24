// Webhooks: tell another system when something happens in a business.
// Each event is saved as one delivery per matching webhook and sent by a small worker, so
// a slow or failing endpoint never holds up WhatsApp, and retries survive a restart.
//
// Every request is a POST with a JSON body: { id, type, created, business, data } and the headers
//   X-Webhook-Id, X-Webhook-Event, X-Webhook-Timestamp,
//   X-Webhook-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook's secret>
const crypto = require('crypto');
const db = require('./db');
const safeHttp = require('./safe-http');

const EVENTS = [
  'message.received', 'message.sent', 'message.status',
  'order.created', 'order.updated', 'question.created',
  'session.connected', 'session.disconnected',
];
const RETRY_DELAYS_MS = process.env.WEBHOOK_RETRY_DELAYS_MS // for tests
  ? process.env.WEBHOOK_RETRY_DELAYS_MS.split(',').map(Number)
  : [0, 10000, 60000, 5 * 60000, 30 * 60000, 2 * 3600000]; // 6 tries
const SEND_TIMEOUT_MS = 10000;
const DISABLE_AFTER_FAILED = Number(process.env.WEBHOOK_DISABLE_AFTER || 10); // failed deliveries in a row before a webhook is switched off

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sign = (secret, timestamp, body) => `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

function cleanEvents(events) {
  if (events === undefined || events === null || (Array.isArray(events) && events.includes('*'))) return ['*'];
  if (!Array.isArray(events) || !events.length) throw httpError(400, '"events" must be a list of event names, or ["*"] for all.');
  const bad = events.filter((e) => !EVENTS.includes(e));
  if (bad.length) throw httpError(400, `Unknown event${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}. Choose from: ${EVENTS.join(', ')}.`);
  return [...new Set(events)];
}

const publicHook = (h) => ({ id: h.id, url: h.url, events: h.events, description: h.description || '', active: h.active, failures: h.failures || 0, created_at: h.created_at });

async function create(business, { url, events, description } = {}) {
  if (!url) throw httpError(400, '"url" is required.');
  const u = safeHttp.parseUrl(url);
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:' && !process.env.ALLOW_PRIVATE_URLS) throw httpError(400, 'Webhook URLs must use https.');
  if (String(url).length > 500) throw httpError(400, '"url" is too long.');
  const doc = {
    _id: randomId('wh'), business, url: u.toString(), events: cleanEvents(events),
    description: String(description || '').slice(0, 120), secret: `whsec_${crypto.randomBytes(24).toString('base64url')}`,
    active: true, failures: 0, created_at: Date.now(),
  };
  if ((await db.listWebhooks(business)).length >= 20) throw httpError(409, 'A business can have at most 20 webhooks.');
  await db.createWebhook(doc);
  return { ...publicHook({ ...doc, id: doc._id }), secret: doc.secret }; // the secret is shown only now
}

// Save one delivery for every active webhook that wants this event.
const recent = new Map(); // dedupe key -> time
async function emit(business, type, data, { key } = {}) {
  try {
    if (!db.isReady()) return;
    if (key) {
      const k = `${business}|${type}|${key}`;
      if (recent.has(k)) return;
      recent.set(k, Date.now());
      if (recent.size > 2000) for (const [kk, t] of recent) if (Date.now() - t > 600000) recent.delete(kk);
    }
    const hooks = (await db.activeWebhooks(business)).filter((h) => h.events.includes('*') || h.events.includes(type));
    if (!hooks.length) return;
    const now = Date.now();
    const event = { id: randomId('evt'), type, created: new Date(now).toISOString(), business, data };
    await db.addDelivery(hooks.map((h) => ({
      _id: randomId('dlv'), business, webhook: h._id, event: type, event_id: event.id,
      body: JSON.stringify(event), status: 'pending', attempts: 0, next_at: now, created_at: now, at: new Date(now),
    })));
    setImmediate(kick);
  } catch (e) {
    console.error(`[${business}] webhook event ${type} not saved:`, e.message);
  }
}

// Send a made-up event to one webhook so its owner can check the connection.
async function test(business, id) {
  const hook = await db.getWebhook(business, id);
  if (!hook) throw httpError(404, 'Webhook not found.');
  const now = Date.now();
  const event = { id: randomId('evt'), type: 'webhook.test', created: new Date(now).toISOString(), business, data: { message: 'This is a test event.' } };
  const doc = {
    _id: randomId('dlv'), business, webhook: id, event: 'webhook.test', event_id: event.id, body: JSON.stringify(event),
    status: 'pending', attempts: 0, next_at: now, created_at: now, at: new Date(now), once: true,
  };
  await db.addDelivery([doc]);
  const done = await waitFor(business, doc._id, 15000);
  return { delivered: done.status === 'ok', status: done.last_status ?? null, error: done.last_error || null };
}

async function waitFor(business, id, ms) {
  const end = Date.now() + ms;
  kick();
  while (Date.now() < end) {
    const d = await db.getDelivery(business, id);
    if (d && (d.status === 'ok' || d.status === 'failed')) return d;
    await sleep(150);
  }
  return { status: 'failed', last_error: 'no answer in time' };
}

let running = 0;
async function deliver(d) {
  const hook = await db.getWebhook(d.business, d.webhook);
  if (!hook || (!hook.active && !d.once)) { await db.updateDelivery(d._id, { status: 'failed', last_error: 'webhook removed or switched off' }); return; }
  const ts = Math.floor(Date.now() / 1000);
  let status = null, error = null;
  try {
    const r = await safeHttp.request(hook.url, {
      method: 'POST', timeoutMs: SEND_TIMEOUT_MS, maxBytes: 1024 * 1024, body: d.body,
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'WhatsApp-Webhooks/1.0', 'Content-Length': Buffer.byteLength(d.body),
        'X-Webhook-Id': d._id, 'X-Webhook-Event': d.event, 'X-Webhook-Timestamp': String(ts), 'X-Webhook-Signature': sign(hook.secret, ts, d.body),
      },
    });
    status = r.status;
    if (status < 200 || status >= 300) error = `answered ${status}`;
  } catch (e) {
    error = e.message;
  }
  const attempts = d.attempts + 1;
  if (!error) {
    await db.updateDelivery(d._id, { status: 'ok', attempts, last_status: status, last_error: null, done_at: Date.now() });
    if (hook.failures) await db.updateWebhook(hook.id, { failures: 0 });
    return;
  }
  const delay = RETRY_DELAYS_MS[attempts];
  if (delay === undefined || d.once) {
    await db.updateDelivery(d._id, { status: 'failed', attempts, last_status: status, last_error: error, done_at: Date.now() });
    if (!d.once) {
      const failures = await db.bumpWebhookFailures(hook.id);
      if (failures >= DISABLE_AFTER_FAILED) await db.updateWebhook(hook.id, { active: false });
      if (failures >= DISABLE_AFTER_FAILED) console.error(`[${d.business}] webhook ${hook.url} switched off after ${failures} failed deliveries`);
    }
    return;
  }
  await db.updateDelivery(d._id, { status: 'pending', attempts, last_status: status, last_error: error, next_at: Date.now() + delay });
}

let kicking = false;
async function kick() {
  if (kicking || !db.isReady()) return;
  kicking = true;
  try {
    for (;;) {
      if (running >= 5) { await sleep(100); continue; }
      const d = await db.claimDelivery(Date.now());
      if (!d) break;
      running++;
      deliver(d).catch((e) => console.error('webhook delivery failed:', e.message)).finally(() => { running--; });
    }
  } catch (e) {
    console.error('webhook worker:', e.message);
  } finally {
    kicking = false;
  }
}

let timer;
function start() {
  if (timer) return;
  db.recoverDeliveries(Date.now() - 1).catch(() => {});
  timer = setInterval(kick, 3000);
  timer.unref();
}
const stop = () => { clearInterval(timer); timer = null; };

module.exports = { EVENTS, create, emit, test, start, stop, kick, publicHook, sign };
