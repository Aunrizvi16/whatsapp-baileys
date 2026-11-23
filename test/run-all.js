// End-to-end test of the Baileys version against a fake WhatsApp socket and a fake
// OpenAI server. Uses a throwaway MongoDB database (wa_test_baileys), dropped at the end.
// Run: node --env-file=../atlas-credentials.env --env-file=.env test/run-all.js
process.env.MONGODB_DB = 'wa_test_baileys';
process.env.SESSIONS_DIR = require('path').join(require('os').tmpdir(), 'wa-baileys-test-auth');
process.env.LOG_RETENTION_DAYS = '1';

const http = require('http');
const { EventEmitter } = require('events');
const assert = require('assert');

// ---- fake OpenAI ----
const aiCalls = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/audio/transcriptions')) {
      aiCalls.push({ kind: 'transcribe' });
      return res.end(JSON.stringify({ text: 'I want two blue shirts' }));
    }
    const j = JSON.parse(body);
    const schema = j.response_format?.json_schema?.name;
    aiCalls.push({ kind: schema, body: j });
    let out;
    if (schema === 'customer_profile') {
      out = { name: 'Ali', address: '', alternate_phone: '', language: 'English', regular_customer: false, preferences: [], dislikes: [], complaints: [], notes: '' };
    } else {
      const last = j.messages.filter((m) => m.role === 'user').at(-1);
      const text = typeof last.content === 'string' ? last.content : last.content.map((p) => p.text || '[image]').join(' ');
      const hasImage = Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url');
      const sys = j.messages[0].content;
      const managerAnswer = /Manager's answer:/.test(sys);
      out = {
        reply: managerAnswer ? 'Good news, the team says: yes it is available.' : hasImage ? 'Nice photo, that model is in stock.' : `AI says hi. You wrote: ${text.slice(-60)}`,
        escalate_to_manager: !managerAnswer && /manager/i.test(text),
        manager_question: /manager/i.test(text) ? 'Is the red bag available?' : '',
        order_confirmed: false,
        order: { items: [], total: 0, delivery_address: '', customer_name: '', customer_phone: '', notes: '' },
        complaint: false,
      };
    }
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'gpt-test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out) } }] }));
  });
});

// ---- fake WhatsApp socket ----
let nextId = 0;
const socks = new Map(); // business -> latest fake socket
class FakeSock {
  constructor(id) {
    this.businessId = id;
    this.ev = new EventEmitter();
    this.sent = [];
    this.presence = [];
    this.user = { id: '923000000001:7@s.whatsapp.net', name: 'Test Shop' };
    this.signalRepository = { lidMapping: { getPNForLID: async (lid) => (lid === '111222333@lid' ? '923111111111@s.whatsapp.net' : null) } };
  }
  async sendMessage(jid, content, opts = {}) {
    const id = `BOT${++nextId}`;
    const msg = { key: { remoteJid: jid, id, fromMe: true }, message: { conversation: content.text }, messageTimestamp: Math.floor(Date.now() / 1000), status: 1 };
    this.sent.push({ jid, text: content.text, quoted: opts.quoted?.key?.id || null, id });
    setTimeout(() => this.ev.emit('messages.upsert', { messages: [msg], type: 'append' }), 5);
    setTimeout(() => this.ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: jid }, update: { status: 3 } }]), 40);
    return msg;
  }
  async sendPresenceUpdate(type, jid) { this.presence.push({ type, jid }); }
  async onWhatsApp(n) { return [{ exists: true, jid: `${n}@s.whatsapp.net` }]; }
  async query() { return {}; }
  async logout() { this.loggedOut = true; }
  async requestPairingCode() { return 'ABCD1234'; }
  async updateMediaMessage(m) { return m; }
  end() { this.ended = true; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
async function until(cond, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
const incoming = (sock, from, message, extra = {}) => {
  const raw = { key: { remoteJid: from, id: `IN${++nextId}`, fromMe: false, ...(extra.key || {}) }, message, messageTimestamp: now(), pushName: extra.pushName || 'Ali' };
  sock.ev.emit('messages.upsert', { messages: [raw], type: 'notify' });
  return raw;
};

let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`ok  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

(async () => {
  await new Promise((r) => fakeAi.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}/v1`;

  const logger = require('../logger');
  logger.install();
  const db = require('../db');
  const rules = require('../rules');
  const wa = require('../sessions');
  const { MongoClient } = require('mongodb');
  await db.init();
  await rules.load();
  wa._test.setSocketFactory((s) => { const k = new FakeSock(s.id); socks.set(s.id, k); return k; });
  const sock = () => socks.get('shop');
  const CUSTOMER = '923222222222@s.whatsapp.net';
  const CUSTOMER_APP = '923222222222@c.us';
  const MANAGER = '923999999999';

  try {
    await step('new business shows a QR', async () => {
      wa.startSession('shop');
      await until(() => sock(), 5000, 'socket');
      sock().ev.emit('connection.update', { qr: '2@fake-qr-ref,abc,def' });
      await until(() => wa.getSession('shop').status === 'qr', 5000, 'qr status');
      assert.match(wa.getSession('shop').qr, /^data:image\/png;base64,/);
    });

    await step('switch to pairing code and back to QR', async () => {
      await wa.restartSession('shop', '923000000001');
      await until(() => wa.getSession('shop').status === 'code', 5000, 'code status');
      assert.strictEqual(wa.getSession('shop').code, 'ABCD-1234');
      await wa.restartSession('shop', null);
      assert.strictEqual(wa.getSession('shop').status, 'qr');
    });

    await step('linking: authenticated, then connected with number and health', async () => {
      sock().ev.emit('connection.update', { isNewLogin: true });
      await until(() => wa.getSession('shop').status === 'authenticated', 3000, 'authenticated');
      sock().ev.emit('connection.update', { connection: 'open' });
      await until(() => wa.getSession('shop').status === 'ready', 5000, 'ready');
      assert.strictEqual(wa.getSession('shop').me.number, '923000000001');
      await until(() => wa.getSession('shop').web?.level === 'ok', 8000, 'health check');
    });

    await step('auto-replies off: customer message gets no reply', async () => {
      incoming(sock(), CUSTOMER, { conversation: 'hello?' });
      await sleep(8000);
      assert.strictEqual(sock().sent.length, 0);
    });

    await rules.saveRules('shop', {
      enabled: true, mode: 'ai', fallback: 'A team member will reply soon.', contacts: { mode: 'all', list: [] },
      ai: { provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', prompt: 'We sell shirts and bags.', managerNumber: MANAGER, transcribeVoice: true, understandImages: true, historyMessages: 8 },
    });

    await step('text message: AI reply with typing indicator', async () => {
      incoming(sock(), CUSTOMER, { conversation: 'Do you have blue shirts?' });
      await until(() => sock().sent.some((m) => m.jid === CUSTOMER), 45000, 'AI reply');
      const reply = sock().sent.find((m) => m.jid === CUSTOMER);
      assert.match(reply.text, /AI says hi/);
      assert.match(reply.text, /blue shirts/);
      assert.ok(sock().presence.some((p) => p.type === 'composing' && p.jid === CUSTOMER), 'typing shown');
      await until(() => sock().presence.some((p) => p.type === 'paused'), 5000, 'typing cleared');
    });

    await step('history: the AI saw the earlier message and its own reply', async () => {
      incoming(sock(), CUSTOMER, { extendedTextMessage: { text: 'And in size L?' } });
      try {
        await until(() => sock().sent.filter((m) => m.jid === CUSTOMER).length >= 2, 45000, 'second reply');
      } catch (e) {
        const s = wa._test.sessions.get('shop');
        console.log('DEBUG recent', JSON.stringify((s.recent.get(CUSTOMER_APP) || []).map((r) => [r.ts, r.from_me, r.type, r.body])));
        console.log('DEBUG paused', rules.isPaused('shop', CUSTOMER_APP), 'aiChats', [...s.aiChats.keys()]);
        throw e;
      }
      const call = aiCalls.filter((c) => c.kind === 'whatsapp_reply').at(-1).body;
      const roles = call.messages.slice(1).map((m) => m.role);
      assert.deepStrictEqual(roles.slice(-3), ['user', 'assistant', 'user']);
    });

    await step('voice note is transcribed and answered', async () => {
      wa._test.setDownloader(async (s, rec) => (rec.type === 'ptt'
        ? { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('fake-ogg').toString('base64') }
        : { mimetype: 'image/png', data: Buffer.from('fake-png').toString('base64') }));
      const before = sock().sent.length;
      incoming(sock(), CUSTOMER, { audioMessage: { ptt: true, seconds: 4, mimetype: 'audio/ogg; codecs=opus', url: 'x', mediaKey: Buffer.from('k') } });
      await until(() => sock().sent.length > before, 45000, 'reply to voice note');
      assert.ok(aiCalls.some((c) => c.kind === 'transcribe'), 'transcribed');
      assert.match(sock().sent.at(-1).text, /two blue shirts/);
    });

    await step('photo is shown to the AI', async () => {
      const before = sock().sent.length;
      incoming(sock(), CUSTOMER, { imageMessage: { caption: 'this one?', mimetype: 'image/png', url: 'x', mediaKey: Buffer.from('k') } });
      await until(() => sock().sent.length > before, 45000, 'reply to photo');
      assert.match(sock().sent.at(-1).text, /Nice photo/);
    });

    await step('hidden-number (@lid) customer is matched to their phone number', async () => {
      const before = sock().sent.length;
      incoming(sock(), '111222333@lid', { conversation: 'hi from lid' }, { pushName: 'Sara' });
      await until(() => sock().sent.length > before, 45000, 'reply to lid customer');
      assert.strictEqual(sock().sent.at(-1).jid, '923111111111@s.whatsapp.net');
    });

    let question;
    await step('question for the manager is sent to the manager', async () => {
      incoming(sock(), CUSTOMER, { conversation: 'Please ask your manager about the red bag' });
      await until(() => sock().sent.some((m) => m.jid === `${MANAGER}@s.whatsapp.net`), 45000, 'manager message');
      question = sock().sent.find((m) => m.jid === `${MANAGER}@s.whatsapp.net`);
      assert.match(question.text, /Question #1/);
      assert.match(question.text, /red bag/);
    });

    await step("manager's reply (swiped) is passed to the customer and confirmed", async () => {
      const before = sock().sent.length;
      incoming(sock(), `${MANAGER}@s.whatsapp.net`, { extendedTextMessage: { text: 'yes, 3 left', contextInfo: { stanzaId: question.id } } }, { pushName: 'Boss' });
      await until(() => sock().sent.length >= before + 2, 50000, 'answer + confirmation');
      const toCustomer = sock().sent.slice(before).find((m) => m.jid === CUSTOMER);
      const toManager = sock().sent.slice(before).find((m) => m.jid === `${MANAGER}@s.whatsapp.net`);
      assert.match(toCustomer.text, /yes it is available/);
      assert.match(toManager.text, /^Sent to /);
      assert.ok(toManager.quoted, 'confirmation quotes the manager message');
    });

    await step('owner replying from the phone pauses the bot in that chat', async () => {
      const raw = { key: { remoteJid: CUSTOMER, id: `PHONE${++nextId}`, fromMe: true }, message: { conversation: 'I will handle this myself' }, messageTimestamp: now() };
      sock().ev.emit('messages.upsert', { messages: [raw], type: 'notify' });
      await sleep(300);
      assert.ok(rules.isPaused('shop', CUSTOMER_APP), 'paused');
      const before = sock().sent.length;
      incoming(sock(), CUSTOMER, { conversation: 'hello again' });
      await sleep(8000);
      assert.strictEqual(sock().sent.length, before, 'no reply while paused');
    });

    await step('contacts picker lists recent chats with names', async () => {
      const list = await wa.listContacts('shop');
      const ali = list.find((c) => c.id === CUSTOMER_APP);
      assert.ok(ali, 'customer listed');
      assert.strictEqual(ali.name, 'Ali');
      assert.strictEqual(ali.number, '923222222222');
      assert.ok(list.some((c) => c.id === '923111111111@c.us'), 'lid customer listed under phone number');
    });

    await step('dashboard send by number confirms delivery', async () => {
      const r = await wa.sendMessage('shop', '+92 344 4444444', 'Your order is ready');
      assert.strictEqual(r.status, 'delivered');
      assert.strictEqual(sock().sent.at(-1).jid, '923444444444@s.whatsapp.net');
      assert.ok(!rules.isPaused('shop', '923444444444@c.us'), 'dashboard send does not pause the bot');
    });

    await step('dashboard send by chat name', async () => {
      const r = await wa.sendMessage('shop', 'sara', 'Hi Sara');
      assert.strictEqual(sock().sent.at(-1).jid, '923111111111@s.whatsapp.net');
      assert.strictEqual(r.sentTo, 'Sara');
    });

    await step('customer data saved: profile, question answered', async () => {
      const customers = await db.listCustomers('shop');
      assert.ok(customers.some((c) => c.chat_id === CUSTOMER_APP));
      const qs = await db.listEscalations('shop');
      assert.strictEqual(qs[0].status, 'answered');
    });

    await step('connection drop reconnects from the saved login', async () => {
      const old = sock();
      old.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      await until(() => wa.getSession('shop').status === 'retrying', 3000, 'retrying');
      await until(() => sock() !== old, 10000, 'new socket');
      sock().ev.emit('connection.update', { connection: 'open' });
      await until(() => wa.getSession('shop').status === 'ready', 5000, 'ready again');
    });

    await step('unlinked from the phone: same card shows a new QR', async () => {
      const old = sock();
      old.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
      await until(() => sock() !== old, 5000, 'new socket');
      const v = wa.getSession('shop');
      assert.strictEqual(v.newLogin, true);
      sock().ev.emit('connection.update', { qr: '2@another,qr' });
      await until(() => wa.getSession('shop').status === 'qr', 5000, 'qr after logout');
    });

    await step('reload everything reconnects every business', async () => {
      sock().ev.emit('connection.update', { connection: 'open' });
      await until(() => wa.getSession('shop').status === 'ready', 5000, 'ready');
      const old = sock();
      const r = wa.restartAll();
      assert.strictEqual(r.count, 1);
      await until(() => sock() !== old, 5000, 'reconnect');
      sock().ev.emit('connection.update', { connection: 'open' });
      await until(() => wa.getSession('shop').status === 'ready', 5000, 'ready after reload');
    });

    await step('delete business removes the card and its data', async () => {
      await wa.deleteBusiness('shop');
      assert.throws(() => wa.getSession('shop'));
      assert.strictEqual((await db.listCustomers('shop')).length, 0);
      assert.strictEqual(await db.countWaChats('shop'), 0);
    });

    console.log(`\nALL ${passed} STEPS PASSED`);
  } catch (e) {
    console.error(`\nFAILED after ${passed} steps:`, e.stack || e.message);
    process.exitCode = 1;
  } finally {
    await wa.shutdown();
    const c = await MongoClient.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
    await c.db('wa_test_baileys').dropDatabase();
    await c.close();
    await logger.flushNow().catch(() => {});
    await db.close();
    fakeAi.close();
    setTimeout(() => process.exit(), 200);
  }
})();
