// The public API (/v1), API keys and webhooks, end to end: the real server runs in this
// process against a fake WhatsApp socket and a throwaway MongoDB database.
// Run: MONGODB_URI=mongodb://127.0.0.1:27099 node test/api-test.js   (any empty MongoDB works)
const PORT = 3991;
process.env.PORT = String(PORT);
process.env.MONGODB_DB = 'wa_test_api';
process.env.SESSIONS_DIR = require('path').join(require('os').tmpdir(), 'wa-api-test-sessions');
process.env.SUPER_ADMIN_EMAIL = 'boss@example.com';
process.env.SUPER_ADMIN_PASSWORD = 'super-secret-pass';
process.env.API_SEND_GAP_MS = '0';
process.env.API_RATE_PER_MIN = '200';
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.WEBHOOK_RETRY_DELAYS_MS = '0,200,200';
process.env.WEBHOOK_DISABLE_AFTER = '2';
process.env.LOG_RETENTION_DAYS = '1';
require('fs').rmSync(process.env.SESSIONS_DIR, { recursive: true, force: true });

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const assert = require('assert');
const { MongoClient } = require('mongodb');

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- fake WhatsApp socket that understands every kind of message ----
let nextId = 0;
const socks = new Map();
const KIND = { text: 'conversation', image: 'imageMessage', video: 'videoMessage', audio: 'audioMessage', document: 'documentMessage', sticker: 'stickerMessage', location: 'locationMessage', contacts: 'contactMessage', react: 'reactionMessage' };
class FakeSock {
  constructor(id) {
    this.ev = new EventEmitter(); this.sent = [];
    this.user = { id: '923000000001:7@s.whatsapp.net', name: 'Test Shop' };
    this.signalRepository = { lidMapping: { getPNForLID: async () => null } };
  }
  async sendMessage(jid, content, opts = {}) {
    const id = `API${++nextId}`;
    const kind = Object.keys(KIND).find((k) => k === 'text' ? content.text !== undefined : content[k] !== undefined);
    const body = kind === 'text' ? content.text : { caption: content.caption, mimetype: content.mimetype, ptt: content.ptt, fileName: content.fileName, seconds: 2 };
    const message = kind === 'text' ? { conversation: body } : { [KIND[kind]]: body };
    const msg = { key: { remoteJid: jid, id, fromMe: true }, message, messageTimestamp: Math.floor(Date.now() / 1000), status: 1 };
    this.sent.push({ jid, kind, content, quoted: opts.quoted?.key?.id || null, id });
    setTimeout(() => this.ev.emit('messages.upsert', { messages: [msg], type: 'append' }), 5);
    setTimeout(() => this.ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: jid }, update: { status: 2 } }]), 30);
    setTimeout(() => this.ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: jid }, update: { status: 3 } }]), 120);
    setTimeout(() => this.ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: jid }, update: { status: 4 } }]), 220);
    return msg;
  }
  async sendPresenceUpdate() {}
  async onWhatsApp(n) { return n === '923000000404' ? [{ exists: false }] : [{ exists: true, jid: `${n}@s.whatsapp.net` }]; }
  async query() { return {}; }
  async logout() {}
  async requestPairingCode() { return 'ABCD1234'; }
  async updateMediaMessage(m) { return m; }
  end() {}
}

// ---- a tiny client ----
async function call(method, url, { key, body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text, headers: res.headers };
}

// ---- a receiver for webhooks ----
const received = [];
let receiverMode = () => 200;
const receiver = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body: b });
    res.statusCode = receiverMode(req.url, received.length);
    res.end('ok');
  });
});

// ---- a file server for media.url ----
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const files = http.createServer((req, res) => {
  if (req.url === '/logo.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG); }
  if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', '/logo.png'); return res.end(); }
  if (req.url === '/notes.txt') { res.setHeader('content-type', 'text/plain'); return res.end('hello there, this is a text file'); }
  res.statusCode = 404; res.end();
});

function wav(seconds = 0.3) {
  const rate = 8000, n = Math.floor(rate * seconds), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

(async () => {
  const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const mongo = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 10000 });
  await mongo.db('wa_test_api').dropDatabase();
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  const HOOK = `http://127.0.0.1:${receiver.address().port}`;
  const FILES = `http://127.0.0.1:${files.address().port}`;

  const safeHttp = require('../safe-http');
  const wa = require('../sessions');
  const db = require('../db');
  wa._test.setSocketFactory((s) => { const k = new FakeSock(s.id); socks.set(s.id, k); return k; });
  wa._test.setDownloader(async () => ({ mimetype: 'image/png', data: PNG.toString('base64'), filename: null }));
  require('../server.js');
  await until(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok && db.isReady(), 20000, 'server');
  const sock = () => socks.get('shop');
  const last = () => sock().sent.at(-1);
  const CUSTOMER = '923222222222';

  let KEY, READ_KEY, boss;
  try {
    await step('no key, wrong key and malformed key are all refused in the same way', async () => {
      for (const key of [undefined, 'wak_notarealkeynotarealkeynotarealkey', 'nonsense']) {
        const r = await call('GET', '/v1/business', { key });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.error.code, 'invalid_key');
      }
      assert.strictEqual((await call('GET', '/v1/nothing', { key: 'x' })).status, 401);
    });

    await step('dashboard: create a business and connect it, create keys', async () => {
      // sign in as the super admin
      const si = await fetch(`${BASE}/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD }) });
      assert.strictEqual(si.status, 200);
      const cookie = si.headers.getSetCookie()[0].split(';')[0];
      boss = async (method, url, body) => {
        const r = await fetch(BASE + url, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      assert.strictEqual((await boss('POST', '/api/sessions', { id: 'shop' })).status, 201);
      await until(() => sock(), 5000, 'socket');
      sock().ev.emit('connection.update', { connection: 'open' });
      await until(() => wa.getSession('shop').status === 'ready', 5000, 'ready');

      assert.strictEqual((await boss('POST', '/api/sessions/shop/api-keys', { name: '' })).status, 400);
      assert.strictEqual((await boss('POST', '/api/sessions/shop/api-keys', { name: 'x', scopes: ['root'] })).status, 400);
      const k = await boss('POST', '/api/sessions/shop/api-keys', { name: 'CRM', scopes: ['read', 'send', 'manage'] });
      assert.strictEqual(k.status, 201);
      assert.match(k.body.key, /^wak_/);
      KEY = k.body.key;
      READ_KEY = (await boss('POST', '/api/sessions/shop/api-keys', { name: 'Reports', scopes: ['read'] })).body.key;
      const list = await boss('GET', '/api/sessions/shop/api-keys');
      assert.strictEqual(list.body.keys.length, 2);
      assert(!JSON.stringify(list.body).includes(KEY), 'the key must never be listed again');
      assert(list.body.keys.every((x) => /^wak_/.test(x.prefix) && x.prefix.length === 12));
      const stored = await mongo.db('wa_test_api').collection('api_keys').find().toArray();
      assert(stored.every((d) => d._id.length === 64 && !JSON.stringify(d).includes(KEY)), 'only a hash is stored');
    });

    await step('GET /v1/business, and scopes are enforced', async () => {
      const r = await call('GET', '/v1/business', { key: KEY });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual({ connected: r.body.connected, phone: r.body.phone, id: r.body.id }, { connected: true, phone: '923000000001', id: 'shop' });
      assert(r.headers.get('ratelimit-limit'));
      const denied = await call('POST', '/v1/messages', { key: READ_KEY, body: { to: CUSTOMER, text: 'hi' } });
      assert.strictEqual(denied.status, 403);
      assert.strictEqual(denied.body.error.code, 'missing_scope');
      assert.strictEqual((await call('PATCH', '/v1/orders/1', { key: READ_KEY, body: { status: 'shipped' } })).status, 403);
      assert.strictEqual((await call('GET', '/v1/webhooks', { key: READ_KEY })).status, 403);
    });

    await step('send text, then read its status as WhatsApp confirms it', async () => {
      const r = await call('POST', '/v1/messages', { key: KEY, body: { to: `+${CUSTOMER.slice(0, 2)} ${CUSTOMER.slice(2)}`, type: 'text', text: 'Your order is ready' } });
      assert.strictEqual(r.status, 201, r.text);
      assert.deepStrictEqual({ to: r.body.to, type: r.body.type }, { to: CUSTOMER, type: 'text' });
      assert.strictEqual(last().content.text, 'Your order is ready');
      assert.strictEqual(last().jid, `${CUSTOMER}@s.whatsapp.net`);
      await until(async () => (await call('GET', `/v1/messages/${r.body.id}`, { key: KEY })).body.status === 'read', 5000, 'read status');
      const m = (await call('GET', `/v1/messages/${r.body.id}`, { key: KEY })).body;
      assert.deepStrictEqual({ direction: m.direction, type: m.type, text: m.text }, { direction: 'outbound', type: 'text', text: 'Your order is ready' });
      assert.strictEqual((await call('GET', '/v1/messages/NOPE', { key: KEY })).status, 404);
    });

    await step('type defaults to text, and bad requests say what is wrong', async () => {
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'no type given' } })).status, 201);
      const cases = [
        [{ to: 'abc', text: 'x' }, 400, /phone number/],
        [{ text: 'x' }, 400, /phone number/],
        [{ to: CUSTOMER }, 400, /"text" is required/],
        [{ to: CUSTOMER, text: 'x'.repeat(4097) }, 400, /at most 4096/],
        [{ to: CUSTOMER, type: 'fax', text: 'x' }, 400, /"type" must be one of/],
        [{ to: CUSTOMER, type: 'image' }, 400, /"media"/],
        [{ to: '923000000404', text: 'x' }, 404, /not on WhatsApp/],
        [{ to: CUSTOMER, type: 'location', latitude: 'north', longitude: 1 }, 400, /latitude/],
        [{ to: CUSTOMER, type: 'contact', contacts: [{ name: 'A' }] }, 400, /phone/],
      ];
      for (const [body, status, re] of cases) {
        const r = await call('POST', '/v1/messages', { key: KEY, body });
        assert.strictEqual(r.status, status, `${JSON.stringify(body).slice(0, 60)} -> ${r.text}`);
        assert.match(r.body.error.message, re);
      }
      const bad = await call('POST', '/v1/messages', { key: KEY, raw: '{not json', headers: { 'content-type': 'application/json' } });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.error.code, 'invalid_request');
    });

    await step('images, videos and documents from base64, with captions', async () => {
      let r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { base64: PNG.toString('base64') }, caption: "Today's menu" } });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(last().kind, 'image');
      assert(last().content.image.equals(PNG));
      assert.deepStrictEqual({ mime: last().content.mimetype, cap: last().content.caption }, { mime: 'image/png', cap: "Today's menu" });
      // data: URLs work too
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { base64: `data:image/png;base64,${PNG.toString('base64')}` } } });
      assert.strictEqual(r.status, 201);
      // a PDF as a document with a file name
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 'x')]);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'document', media: { base64: pdf.toString('base64') }, filename: 'Invoice-1042.pdf', caption: 'Your invoice' } });
      assert.strictEqual(r.status, 201, r.text);
      assert.deepStrictEqual({ kind: last().kind, name: last().content.fileName, mime: last().content.mimetype }, { kind: 'document', name: 'Invoice-1042.pdf', mime: 'application/pdf' });
      // a gif-style video
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'video', media: { base64: mp4.toString('base64') }, gif: true } });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(last().content.gifPlayback, true);
    });

    await step('files are checked: real type, size, emptiness', async () => {
      const text = Buffer.from('this is plainly not a picture').toString('base64');
      let r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { base64: text, mimetype: 'image/png' } } });
      assert.strictEqual(r.status, 415, 'a text file labelled image/png must be refused');
      assert.match(r.body.error.message, /does not look like a image/);
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { base64: big } } });
      assert.strictEqual(r.status, 413);
      assert.match(r.body.error.message, /at most 5 MB/);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { base64: '!!!' } } });
      assert.strictEqual(r.status, 400);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'sticker', media: { base64: PNG.toString('base64') } } });
      assert.strictEqual(r.status, 415, 'stickers must be webp');
    });

    await step('voice notes: any audio is converted to an Ogg/Opus voice message; audio stays a file', async () => {
      const ffmpeg = require('child_process').spawnSync('ffmpeg', ['-version']);
      if (ffmpeg.error) { console.log('   (ffmpeg not installed: voice conversion skipped)'); return; }
      let r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'voice', media: { base64: wav().toString('base64') } } });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(last().content.ptt, true);
      assert.strictEqual(last().content.mimetype, 'audio/ogg; codecs=opus');
      assert.strictEqual(last().content.audio.subarray(0, 4).toString('latin1'), 'OggS');
      assert(last().content.audio.includes(Buffer.from('OpusHead')));
      // already Ogg/Opus: sent as it is
      const ogg = last().content.audio;
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'voice', media: { base64: ogg.toString('base64') } } });
      assert.strictEqual(r.status, 201);
      assert(last().content.audio.equals(ogg));
      // plain audio: not a voice note
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'audio', media: { base64: wav().toString('base64') } } });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(last().content.ptt, false);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'voice', media: { base64: Buffer.from('not audio at all, just words').toString('base64') } } });
      assert([415, 422].includes(r.status), `garbage audio refused (${r.status})`);
    });

    await step('location, contact cards, reactions and replies', async () => {
      let r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'location', latitude: 24.8607, longitude: 67.0011, name: 'Our shop', address: 'Karachi' } });
      assert.strictEqual(r.status, 201, r.text);
      assert.deepStrictEqual(last().content.location, { degreesLatitude: 24.8607, degreesLongitude: 67.0011, name: 'Our shop', address: 'Karachi' });
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'contact', contacts: [{ name: 'Sara; Ahmed', phone: '+92 300 1234567' }] } });
      assert.strictEqual(r.status, 201, r.text);
      assert.match(last().content.contacts.contacts[0].vcard, /FN:Sara  Ahmed\nTEL;type=CELL;waid=923001234567:\+923001234567/);
      const first = (await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'Question?' } })).body.id;
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'The answer', reply_to: first } });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(last().quoted, first);
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'x', reply_to: 'MISSING' } })).status, 404);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'reaction', message_id: first, emoji: '👍' } });
      assert.strictEqual(r.status, 201, r.text);
      assert.deepStrictEqual({ text: last().content.react.text, id: last().content.react.key.id }, { text: '👍', id: first });
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'reaction', message_id: 'MISSING', emoji: '👍' } })).status, 404);
    });

    await step('multipart upload sends a real file', async () => {
      const form = new FormData();
      form.set('to', CUSTOMER); form.set('type', 'document'); form.set('filename', 'menu.png'); form.set('caption', 'Menu');
      form.set('file', new Blob([PNG], { type: 'image/png' }), 'upload.png');
      const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: form });
      assert.strictEqual(res.status, 201, await res.text());
      assert.deepStrictEqual({ kind: last().kind, name: last().content.fileName }, { kind: 'document', name: 'menu.png' });
      assert(last().content.document.equals(PNG));
    });

    await step('media.url: downloads the file, follows redirects, and refuses private addresses', async () => {
      let r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { url: `${FILES}/logo.png` } } });
      assert.strictEqual(r.status, 400, 'a loopback address must be refused by default');
      assert.match(r.body.error.message, /private network/);
      for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::1]:80/x', 'http://10.0.0.5/x', 'file:///etc/passwd', 'ftp://example.com/a.png', 'http://user:pw@example.com/a.png']) {
        r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { url } } });
        assert.strictEqual(r.status, 400, url);
      }
      safeHttp._test.setAllowPrivate(true); // the test file server is on this machine
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { url: `${FILES}/redirect` } } });
      assert.strictEqual(r.status, 201, r.text);
      assert(last().content.image.equals(PNG));
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { url: `${FILES}/missing.png` } } });
      assert.strictEqual(r.status, 422);
      r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, type: 'image', media: { url: `${FILES}/notes.txt` } } });
      assert.strictEqual(r.status, 415);
      safeHttp._test.setAllowPrivate(false);
    });

    await step('Idempotency-Key: the same request is sent only once', async () => {
      const before = sock().sent.length;
      const headers = { 'idempotency-key': 'order-1042-ready' };
      const [a, b] = await Promise.all([
        call('POST', '/v1/messages', { key: KEY, headers, body: { to: CUSTOMER, text: 'Once only' } }),
        call('POST', '/v1/messages', { key: KEY, headers, body: { to: CUSTOMER, text: 'Once only' } }),
      ]);
      assert.deepStrictEqual([a.status, b.status].sort(), [201, 409].sort(), 'at the same time: one is sent, one is told to wait');
      const c = await call('POST', '/v1/messages', { key: KEY, headers, body: { to: CUSTOMER, text: 'Once only' } });
      assert.strictEqual(c.status, 201);
      assert.strictEqual(c.headers.get('idempotent-replay'), 'true');
      assert.strictEqual(c.body.id, (a.status === 201 ? a : b).body.id);
      assert.strictEqual(sock().sent.length, before + 1);
      // a failed send does not use up the key
      const failing = { 'idempotency-key': 'will-fail' };
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, headers: failing, body: { to: 'bad', text: 'x' } })).status, 400);
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, headers: failing, body: { to: CUSTOMER, text: 'now fine' } })).status, 201);
    });

    await step('contacts and message history', async () => {
      const c = await call('GET', '/v1/contacts', { key: READ_KEY });
      assert.strictEqual(c.status, 200);
      assert(c.body.items.some((x) => x.number === CUSTOMER));
      assert.strictEqual((await call('GET', `/v1/contacts?q=${CUSTOMER.slice(-6)}`, { key: KEY })).body.total, 1);
      assert.strictEqual((await call('GET', '/v1/contacts?q=nobody-by-this-name', { key: KEY })).body.total, 0);
      const h = await call('GET', `/v1/messages?contact=${CUSTOMER}&limit=5`, { key: KEY });
      assert.strictEqual(h.body.items.length, 5);
      assert.strictEqual((await call('GET', '/v1/messages', { key: KEY })).status, 400);
    });

    await step('orders: list with filters, read one, change status', async () => {
      await db.addOrder('shop', `${CUSTOMER}@c.us`, { items: [{ name: 'Shirt', quantity: 2 }], total: 30, customer_name: 'Ali' });
      await db.addOrder('shop', '923111111111@c.us', { items: [{ name: 'Bag', quantity: 1 }], total: 12 });
      let r = await call('GET', '/v1/orders', { key: READ_KEY });
      assert.strictEqual(r.body.total, 2);
      assert(r.body.items.every((o) => !('business' in o)));
      assert.strictEqual((await call('GET', `/v1/orders?contact=${CUSTOMER}`, { key: KEY })).body.total, 1);
      assert.strictEqual((await call('GET', '/v1/orders?status=shipped', { key: KEY })).body.total, 0);
      assert.strictEqual((await call('GET', '/v1/orders?status=bogus', { key: KEY })).status, 400);
      assert.strictEqual((await call('GET', '/v1/orders?since=2999-01-01', { key: KEY })).body.total, 0);
      assert.strictEqual((await call('GET', '/v1/orders?limit=1', { key: KEY })).body.items.length, 1);
      assert.strictEqual((await call('GET', '/v1/orders/1', { key: KEY })).body.items[0].name, 'Shirt');
      assert.strictEqual((await call('GET', '/v1/orders/99', { key: KEY })).status, 404);
      assert.strictEqual((await call('GET', '/v1/orders/abc', { key: KEY })).status, 404);
      r = await call('PATCH', '/v1/orders/1', { key: KEY, body: { status: 'shipped' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.status, 'shipped');
      assert.strictEqual((await call('PATCH', '/v1/orders/1', { key: KEY, body: { status: 'lost' } })).status, 400);
      assert.strictEqual((await call('PATCH', '/v1/orders/99', { key: KEY, body: { status: 'shipped' } })).status, 404);
    });

    await step('auto-reply switch through the API', async () => {
      // switching on is refused until the business has what the replies need, exactly like in the dashboard
      const on = await call('PATCH', '/v1/business/auto-reply', { key: KEY, body: { enabled: true } });
      assert.strictEqual(on.status, 400);
      assert(on.body.error.message.length > 10);
      const off = await call('PATCH', '/v1/business/auto-reply', { key: KEY, body: { enabled: false } });
      assert.strictEqual(off.body.auto_reply.enabled, false);
      assert.strictEqual((await call('PATCH', '/v1/business/auto-reply', { key: KEY, body: { enabled: 'yes' } })).status, 400);
    });

    let hook;
    await step('webhooks: register, list, secret shown once', async () => {
      // (the receiver is on this machine, so private addresses are allowed for the rest of the test)
      safeHttp._test.setAllowPrivate(true);
      let r = await call('POST', '/v1/webhooks', { key: KEY, body: { url: 'not a url' } });
      assert.strictEqual(r.status, 400);
      r = await call('POST', '/v1/webhooks', { key: KEY, body: { url: `${HOOK}/events`, events: ['nope'] } });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error.message, /Unknown event/);
      r = await call('POST', '/v1/webhooks', { key: KEY, body: { url: `${HOOK}/events`, events: ['message.received', 'message.sent', 'message.status', 'order.updated', 'session.connected', 'session.disconnected'], description: 'CRM' } });
      assert.strictEqual(r.status, 201, r.text);
      assert.match(r.body.secret, /^whsec_/);
      hook = r.body;
      const list = await call('GET', '/v1/webhooks', { key: KEY });
      assert.strictEqual(list.body.items.length, 1);
      assert(!JSON.stringify(list.body).includes(hook.secret), 'the secret is never listed');
      assert(list.body.events.includes('question.created'));
    });

    const events = () => received.filter((x) => x.url === '/events').map((x) => ({ ...x, json: JSON.parse(x.body) }));
    await step('webhook test button delivers a signed event', async () => {
      const r = await call('POST', `/v1/webhooks/${hook.id}/test`, { key: KEY });
      assert.deepStrictEqual({ delivered: r.body.delivered, status: r.body.status }, { delivered: true, status: 200 });
      const e = events().at(-1);
      assert.strictEqual(e.json.type, 'webhook.test');
      const ts = e.headers['x-webhook-timestamp'];
      const want = `v1=${crypto.createHmac('sha256', hook.secret).update(`${ts}.${e.body}`).digest('hex')}`;
      assert.strictEqual(e.headers['x-webhook-signature'], want, 'signature = HMAC-SHA256(secret, "<timestamp>.<body>")');
      assert.strictEqual(e.headers['x-webhook-event'], 'webhook.test');
      assert.match(e.headers['content-type'], /application\/json/);
    });

    await step('incoming messages reach the webhook, with a working download link for files', async () => {
      const before = events().length;
      sock().ev.emit('messages.upsert', { type: 'notify', messages: [{
        key: { remoteJid: `${CUSTOMER}@s.whatsapp.net`, id: 'IN1', fromMe: false }, pushName: 'Ali', messageTimestamp: Math.floor(Date.now() / 1000),
        message: { imageMessage: { caption: 'is this in stock?', mimetype: 'image/png' } },
      }] });
      await until(() => events().some((e) => e.json.type === 'message.received'), 5000, 'message.received');
      const e = events().slice(before).find((x) => x.json.type === 'message.received').json;
      assert.strictEqual(e.business, 'shop');
      assert.match(e.id, /^evt_/);
      assert.deepStrictEqual({ phone: e.data.phone, name: e.data.name, type: e.data.type, text: e.data.text, direction: e.data.direction }, { phone: CUSTOMER, name: 'Ali', type: 'image', text: 'is this in stock?', direction: 'inbound' });
      assert.match(e.data.media.url, /^http:\/\/127\.0\.0\.1:3991\/v1\/messages\/IN1\/media\?/);
      // the link works without a key
      const file = await fetch(e.data.media.url);
      assert.strictEqual(file.status, 200);
      assert.strictEqual(file.headers.get('content-type'), 'image/png');
      assert(Buffer.from(await file.arrayBuffer()).equals(PNG));
      // tampered or expired links do not
      assert.strictEqual((await fetch(e.data.media.url.replace(/sig=([0-9a-f])/, (m, c) => `sig=${c === '0' ? '1' : '0'}`))).status, 403);
      assert.strictEqual((await fetch(e.data.media.url.replace(/exp=\d+/, 'exp=1'))).status, 403);
      assert.strictEqual((await fetch(e.data.media.url.replace('/messages/IN1/', '/messages/IN2/'))).status, 403);
      // with a key it also works, and needs the read scope
      assert.strictEqual((await call('GET', '/v1/messages/IN1/media', { key: READ_KEY })).status, 200);
      assert.strictEqual((await call('GET', '/v1/messages/IN1/media')).status, 401);
      // and the message can be fetched through the API
      assert.strictEqual((await call('GET', '/v1/messages/IN1', { key: KEY })).body.type, 'image');
    });

    await step('sent messages and delivery changes reach the webhook once each', async () => {
      const r = await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'for the webhook' } });
      await until(() => events().some((e) => e.json.type === 'message.status' && e.json.data.id === r.body.id && e.json.data.status === 'read'), 5000, 'read status event');
      await sleep(300); // nothing more should arrive
      const mine = events().filter((e) => e.json.data.id === r.body.id);
      assert.strictEqual(mine.filter((e) => e.json.type === 'message.sent').length, 1, 'message.sent exactly once');
      assert.strictEqual(mine.find((e) => e.json.type === 'message.sent').json.data.source, 'api');
      assert.deepStrictEqual(mine.filter((e) => e.json.type === 'message.status').map((e) => e.json.data.status), ['sent', 'delivered', 'read']);
    });

    await step('order and connection events', async () => {
      await call('PATCH', '/v1/orders/2', { key: KEY, body: { status: 'delivered' } });
      await until(() => events().some((e) => e.json.type === 'order.updated' && e.json.data.id === 2), 5000, 'order.updated');
      assert.strictEqual(events().find((e) => e.json.type === 'order.updated' && e.json.data.id === 2).json.data.status, 'delivered');
      sock().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
      await until(() => events().some((e) => e.json.type === 'session.disconnected'), 5000, 'session.disconnected');
      await until(() => wa.getSession('shop').status === 'retrying', 5000, 'retrying');
      assert.strictEqual((await call('POST', '/v1/messages', { key: KEY, body: { to: CUSTOMER, text: 'x' } })).status, 409, 'cannot send while disconnected');
      await until(() => socks.get('shop') && wa.getSession('shop').status === 'ready' || (sock().ev.emit('connection.update', { connection: 'open' }), false), 20000, 'reconnected');
      await until(() => events().some((e) => e.json.type === 'session.connected'), 5000, 'session.connected');
    });

    await step('failed deliveries are retried, and a webhook that keeps failing is switched off', async () => {
      let flakyHits = 0;
      receiverMode = (url) => (url === '/flaky' ? (++flakyHits === 1 ? 500 : 200) : url === '/dead' ? 503 : 200);
      const flaky = (await call('POST', '/v1/webhooks', { key: KEY, body: { url: `${HOOK}/flaky`, events: ['order.updated'] } })).body;
      await call('PATCH', '/v1/orders/1', { key: KEY, body: { status: 'delivered' } });
      await until(() => received.filter((x) => x.url === '/flaky').length >= 2, 5000, 'retry');
      const tries = received.filter((x) => x.url === '/flaky');
      assert.strictEqual(tries[0].headers['x-webhook-id'], tries[1].headers['x-webhook-id'], 'a retry is the same delivery');
      await until(async () => (await mongo.db('wa_test_api').collection('webhook_deliveries').findOne({ webhook: flaky.id }))?.status === 'ok', 5000, 'delivery ok');
      const d = await mongo.db('wa_test_api').collection('webhook_deliveries').findOne({ webhook: flaky.id });
      assert.strictEqual(d.attempts, 2);

      const dead = (await call('POST', '/v1/webhooks', { key: KEY, body: { url: `${HOOK}/dead`, events: ['order.updated'] } })).body;
      for (let i = 0; i < 2; i++) await call('PATCH', '/v1/orders/1', { key: KEY, body: { status: i ? 'shipped' : 'delivered' } });
      await until(async () => (await mongo.db('wa_test_api').collection('webhooks').findOne({ _id: dead.id })).active === false, 15000, 'webhook switched off');
      const hooks = (await boss('GET', '/api/sessions/shop/webhooks')).body.webhooks;
      assert.strictEqual(hooks.find((h) => h.id === dead.id).active, false);
      assert.strictEqual((await boss('PATCH', `/api/sessions/shop/webhooks/${dead.id}`, { active: true })).status, 200);
      assert.strictEqual((await boss('GET', `/api/sessions/shop/webhooks/${dead.id}/deliveries`)).body.deliveries.length > 0, true);
      receiverMode = () => 200;
    });

    await step('rate limit: too many requests are told to slow down', async () => {
      const k = (await boss('POST', '/api/sessions/shop/api-keys', { name: 'Noisy', scopes: ['read'] })).body.key;
      let limited;
      for (let i = 0; i < 205 && !limited; i++) { const r = await call('GET', '/v1/business', { key: k }); if (r.status === 429) limited = r; }
      assert(limited, 'the 201st request in a minute must be refused');
      assert.strictEqual(limited.body.error.code, 'rate_limited');
      assert(Number(limited.headers.get('retry-after')) >= 1);
      assert.strictEqual((await call('GET', '/v1/business', { key: KEY })).status, 200, 'other keys are not affected');
    });

    await step('removing a key stops it at once; keys only work for their own business', async () => {
      const keys = (await boss('GET', '/api/sessions/shop/api-keys')).body.keys;
      const reports = keys.find((x) => x.name === 'Reports');
      assert.strictEqual((await boss('DELETE', `/api/sessions/shop/api-keys/${reports.id}`)).status, 200);
      assert.strictEqual((await call('GET', '/v1/business', { key: READ_KEY })).status, 401);
      assert.strictEqual((await boss('DELETE', `/api/sessions/shop/api-keys/${reports.id}`)).status, 404);
      // a second business: its key cannot see the first one's data
      assert.strictEqual((await boss('POST', '/api/sessions', { id: 'other' })).status, 201);
      const other = (await boss('POST', '/api/sessions/other/api-keys', { name: 'X', scopes: ['read', 'manage'] })).body.key;
      assert.strictEqual((await call('GET', '/v1/orders', { key: other })).body.total, 0);
      assert.strictEqual((await call('GET', '/v1/messages/IN1', { key: other })).status, 404);
      assert.strictEqual((await call('PATCH', '/v1/orders/1', { key: other, body: { status: 'shipped' } })).status, 404);
      assert.strictEqual((await call('GET', '/v1/webhooks', { key: other })).body.items.length, 0);
      assert.strictEqual((await call('DELETE', `/v1/webhooks/${hook.id}`, { key: other })).status, 404);
      assert.strictEqual((await call('GET', '/v1/business', { key: other })).body.id, 'other');
    });

    await step('the dashboard side needs a sign-in, and deleting a business removes its keys and webhooks', async () => {
      assert.strictEqual((await call('GET', '/api/sessions/shop/api-keys')).status, 401);
      assert.strictEqual((await call('GET', '/api/sessions/shop/webhooks')).status, 401);
      assert.strictEqual((await call('DELETE', `/v1/webhooks/${hook.id}`, { key: KEY })).status, 204);
      assert.strictEqual((await boss('DELETE', '/api/sessions/shop')).status, 200);
      const c = mongo.db('wa_test_api');
      assert.strictEqual(await c.collection('api_keys').countDocuments({ business: 'shop' }), 0);
      assert.strictEqual(await c.collection('webhooks').countDocuments({ business: 'shop' }), 0);
      assert.strictEqual((await call('GET', '/v1/business', { key: KEY })).status, 401);
    });

    console.log(`\nALL ${passed} STEPS PASSED`);
  } catch (e) {
    console.error(`\nFAILED after ${passed} steps:`, e.stack || e.message);
    if (process.env.DEBUG_API) { const c = mongo.db('wa_test_api'); console.error(JSON.stringify(await c.collection('webhook_deliveries').find({}, { projection: { body: 0 } }).toArray(), null, 1)); console.error(JSON.stringify(await c.collection('webhooks').find({}, { projection: { secret: 0 } }).toArray(), null, 1)); }
    process.exitCode = 1;
  } finally {
    try { await wa.shutdown(); } catch {}
    await mongo.db('wa_test_api').dropDatabase().catch(() => {});
    await mongo.close();
    setTimeout(() => process.exit(), 200);
  }
})();
