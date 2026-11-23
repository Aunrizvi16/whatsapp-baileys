// First: copy everything printed from here on into MongoDB's "logs" collection.
const logger = require('./logger');
logger.install();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const wa = require('./sessions');
const rules = require('./rules');
const db = require('./db');

const PORT = process.env.PORT || 3000;
let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  API_KEY = crypto.randomBytes(16).toString('hex');
  console.warn(`API_KEY not set. Using a temporary key for this run: ${API_KEY}`);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

// Everything under /api needs the key (dashboard sends it as x-api-key).
app.use('/api', (req, res, next) => {
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  next();
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

app.get('/api/sessions', wrap(async (req, res) => res.json(await wa.listSessions())));
app.post('/api/sessions', wrap(async (req, res) => {
  const { id, phone } = req.body || {};
  if (phone && !/^\d{7,15}$/.test(String(phone).replace(/[\s+()-]/g, ''))) {
    return res.status(400).json({ error: 'Phone must include country code, digits only, e.g. 923001234567.' });
  }
  const s = wa.startSession(id, { phone }); // validates the name first
  await db.addBusiness(id); // the card is kept, on every server, until it's deleted
  res.status(201).json(wa.view(s));
}));
app.get('/api/sessions/:id', wrap((req, res) => res.json(wa.getSession(req.params.id))));
// Log out: unlink WhatsApp; the card stays and shows a new QR. Settings and data are kept.
app.post('/api/sessions/:id/logout', wrap(async (req, res) => {
  res.json(await wa.logoutSession(req.params.id));
}));
// Delete business: removes the card and ALL its data from MongoDB, for every server.
app.delete('/api/sessions/:id', wrap(async (req, res) => {
  await wa.deleteBusiness(req.params.id);
  res.json({ ok: true });
}));
// Body: {} to retry as before, { phone } to switch to a pairing code, { phone: null } to switch to QR.
app.post('/api/sessions/:id/restart', wrap(async (req, res) => {
  res.json(await wa.restartSession(req.params.id, req.body?.phone));
}));
// Full restart from the saved login (works while connected too): closes the browser,
// kills leftover Chrome processes, opens WhatsApp Web again. No new scan needed.
app.post('/api/restart-all', wrap((req, res) => res.json(wa.restartAll())));
app.post('/api/sessions/:id/hard-restart', wrap(async (req, res) => {
  res.json(await wa.hardRestart(req.params.id));
}));
app.get('/api/sessions/:id/screenshot', wrap(async (req, res) => {
  res.type('png').send(await wa.screenshot(req.params.id));
}));
app.get('/api/sessions/:id/rules', wrap((req, res) => {
  wa.getSession(req.params.id); // 404 if unknown
  res.json(rules.publicRules(req.params.id)); // API key is masked
}));
app.put('/api/sessions/:id/rules', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await rules.saveRules(req.params.id, req.body));
}));
// Body: { rules: <editor values>, message: 'customer text' }. Calls the AI, sends nothing on WhatsApp.
app.post('/api/sessions/:id/ai-test', wrap(async (req, res) => {
  res.json(await wa.testAiReply(req.params.id, req.body?.rules, req.body?.message));
}));
// Chats from the last 2 weeks, for the "who gets auto-replies" picker.
app.get('/api/sessions/:id/contacts', wrap(async (req, res) => {
  res.json(await wa.listContacts(req.params.id));
}));
// ---- Logs (stored in MongoDB, kept LOG_RETENTION_DAYS) ----
// ?level=error to filter, ?before=<ISO time> to page back.
// ?all=1 includes lines from the other servers sharing this database.
const logQuery = (req) => ({ server: req.query.all ? undefined : logger.SERVER, level: req.query.level || undefined, before: req.query.before || undefined, limit: Number(req.query.limit) || 300 });
app.get('/api/sessions/:id/logs', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.listLogs({ business: req.params.id, ...logQuery(req) }));
}));
// Server-wide lines that don't belong to one business (startup, database, errors).
app.get('/api/logs', wrap(async (req, res) => {
  res.json(await db.listLogs({ business: null, ...logQuery(req) }));
}));

// ---- Customers, orders, and questions for the manager (stored in MongoDB) ----
app.get('/api/sessions/:id/customers', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.listCustomers(req.params.id));
}));
app.get('/api/sessions/:id/orders', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.listOrders(req.params.id));
}));
app.patch('/api/sessions/:id/orders/:orderId', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.setOrderStatus(req.params.id, Number(req.params.orderId), req.body?.status));
}));
app.get('/api/sessions/:id/questions', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.listEscalations(req.params.id));
}));
// Body: { answer, polish }. polish (default true): the AI rewrites it before sending.
app.post('/api/sessions/:id/questions/:questionId/answer', wrap(async (req, res) => {
  res.json(await wa.answerQuestion(req.params.id, req.params.questionId, req.body?.answer, { polish: req.body?.polish }));
}));
app.post('/api/sessions/:id/send', wrap(async (req, res) => {
  res.json(await wa.sendMessage(req.params.id, req.body?.to, req.body?.message));
}));

// Connect to MongoDB first: sessions need it as soon as messages arrive. If it's not
// reachable yet, keep retrying instead of exiting, so the app recovers by itself
// (for example once the Atlas IP allowlist is fixed) rather than crash-looping.
async function connectDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.init();
      return;
    } catch (e) {
      const wait = Math.min(60, 5 * attempt);
      const hint = /alert number 80|ssl|tls/i.test(e.message)
        ? 'MongoDB Atlas refused the connection: add this server\'s IP (or 0.0.0.0/0) under Atlas > Network Access.'
        : /ENOTFOUND|querySrv|ETIMEOUT/.test(e.message)
          ? 'Could not look up the database address: check MONGODB_URI (and DNS_SERVERS on networks that block SRV lookups).'
          : 'Check MONGODB_URI.';
      console.error(`Could not connect to MongoDB (try ${attempt}): ${e.message.split('\n')[0]}\n${hint} Retrying in ${wait}s.`);
      await db.close().catch(() => {});
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

connectDb().then(async () => {
  await rules.load(); // settings from MongoDB (and a one-time import of old settings files)
  app.listen(PORT, () => {
    console.log(`Dashboard on http://localhost:${PORT}`);
    wa.restoreSessions();
  });
});

// Last line of defense: one broken session must never take down the others.
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e?.message || e));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('Shutting down, sessions kept.');
    await wa.shutdown();
    await logger.flushNow().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  });
}
