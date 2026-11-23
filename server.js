// First: copy everything printed from here on into MongoDB's "logs" collection.
const logger = require('./logger');
logger.install();

const express = require('express');
const path = require('path');
const wa = require('./sessions');
const rules = require('./rules');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false); // Railway/Docker: one proxy in front
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { // same-origin dashboard only
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

// Sign up, sign in, sign out, who am I.
app.use('/auth', auth.authRouter);

// Everything under /api needs a signed-in, approved user.
app.use('/api', auth.sameOrigin, auth.authenticate);
// User management: admins and the super admin.
app.use('/api/admin', auth.requireAdmin, auth.adminRouter);

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

// Every /api/sessions/:id/... route: regular users may only touch their own businesses.
// Someone else's business looks the same as one that doesn't exist.
app.param('id', async (req, res, next, id) => {
  try {
    const found = await db.getBusinessOwner(id);
    if (found && auth.canAccessBusiness(req.user, found.owner)) return next();
    if (!found && auth.isAdmin(req.user)) return next(); // not in the database yet: the session code answers
    res.status(404).json({ error: 'Session not found.' });
  } catch (e) {
    next(e);
  }
});

app.get('/api/sessions', wrap(async (req, res) => {
  const all = await wa.listSessions();
  if (auth.isAdmin(req.user)) return res.json(all);
  const owners = await db.listBusinessOwners();
  res.json(all.filter((s) => owners.get(s.id) === req.user.id));
}));
app.post('/api/sessions', wrap(async (req, res) => {
  const { id, phone } = req.body || {};
  if (phone && !/^\d{7,15}$/.test(String(phone).replace(/[\s+()-]/g, ''))) {
    return res.status(400).json({ error: 'Phone must include country code, digits only, e.g. 923001234567.' });
  }
  // Names are unique ignoring case. Taking over a name that belongs to someone else is not allowed.
  const owners = await db.listBusinessOwners();
  const same = [...owners].find(([name]) => name.toLowerCase() === String(id || '').toLowerCase());
  if (same && !auth.canAccessBusiness(req.user, same[1])) {
    return res.status(409).json({ error: 'That business name is already taken.' });
  }
  const s = wa.startSession(id, { phone }); // validates the name first
  await db.addBusiness(id, req.user.id); // the card is kept, on every server, until it's deleted
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
app.post('/api/restart-all', auth.requireAdmin, wrap((req, res) => res.json(wa.restartAll()))); // affects every business
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
// Body: { enabled }: the auto-replies switch. Everything else stays as saved.
app.patch('/api/sessions/:id/rules', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await rules.setEnabled(req.params.id, req.body?.enabled));
}));
// Body: { rules: <editor values>, message: 'customer text' }. Calls the AI, sends nothing on WhatsApp.
app.post('/api/sessions/:id/ai-test', wrap(async (req, res) => {
  res.json(await wa.testAiReply(req.params.id, req.body?.rules, req.body?.message));
}));
// Chats from the last 2 weeks, for the "who gets auto-replies" picker.
app.get('/api/sessions/:id/contacts', wrap(async (req, res) => {
  res.json(await wa.listContacts(req.params.id, 300, { forSending: req.query.for === 'send' }));
}));
// ---- Logs (stored in MongoDB, kept LOG_RETENTION_DAYS) ----
// ?level=error to filter, ?before=<ISO time> to page back.
// ?all=1 includes lines from the other servers sharing this database.
const logQuery = (req) => ({ server: req.query.all && auth.isAdmin(req.user) ? undefined : logger.SERVER, level: req.query.level || undefined, before: req.query.before || undefined, limit: Number(req.query.limit) || 300 });
app.get('/api/sessions/:id/logs', wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await db.listLogs({ business: req.params.id, ...logQuery(req) }));
}));
// Server-wide lines that don't belong to one business (startup, database, errors).
app.get('/api/logs', auth.requireAdmin, wrap(async (req, res) => {
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

// Anything else that goes wrong (bad JSON, ...) answers in JSON too.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || err.statusCode || 500).json({ error: err.status || err.statusCode ? err.message : 'Server error.' });
});

// ---- Who owns a business, and giving its owner a login (admins) ----
async function ownerView(id) {
  const found = await db.getBusinessOwner(id);
  const u = found?.owner ? await db.getUser(found.owner) : null;
  return { owner: u ? auth.publicUser(u) : null };
}
app.get('/api/sessions/:id/access', auth.requireAdmin, wrap(async (req, res) => {
  wa.getSession(req.params.id);
  res.json(await ownerView(req.params.id));
}));
// Body: { name, email, password }. Creates an active login and makes it the owner. The password is shown once to the admin.
app.post('/api/sessions/:id/access', auth.requireAdmin, wrap(async (req, res) => {
  wa.getSession(req.params.id);
  const user = await auth.createActiveUser(req.body || {});
  await db.setBusinessOwner(req.params.id, user.id);
  console.log(`${req.user.email} created a login for ${user.email} and gave them "${req.params.id}"`);
  res.status(201).json(await ownerView(req.params.id));
}));
// Body: { userId }. Moves the business to an existing active account.
app.put('/api/sessions/:id/access', auth.requireAdmin, wrap(async (req, res) => {
  wa.getSession(req.params.id);
  const user = await db.getUser(String(req.body?.userId || ''));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.status !== 'active') return res.status(400).json({ error: 'That account is not active.' });
  await db.setBusinessOwner(req.params.id, user.id);
  console.log(`${req.user.email} gave "${req.params.id}" to ${user.email}`);
  res.json(await ownerView(req.params.id));
}));

// ---- AI usage reports ----
// Admins see every business; everyone else sees only their own. ?days=30&business=name&tz=Asia/Karachi
async function usageScope(req) {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
  const since = new Date(Date.now() - days * 86400000);
  let businesses = null;
  if (!auth.isAdmin(req.user)) {
    const owners = await db.listBusinessOwners();
    businesses = [...owners].filter(([, o]) => o === req.user.id).map(([name]) => name);
  }
  const one = req.query.business && req.query.business !== 'all' ? String(req.query.business) : null;
  if (one) {
    if (businesses && !businesses.includes(one)) throw Object.assign(new Error('Business not found.'), { status: 404 });
    businesses = [one];
  }
  return { days, since, businesses };
}
app.get('/api/usage', wrap(async (req, res) => {
  const { days, since, businesses } = await usageScope(req);
  const sv = require('./ai').serverAi();
  const report = await db.usageReport({ businesses, since, tz: String(req.query.tz || 'UTC') });
  // Per user: a business belongs to the account that created it. Admins see everyone; others only themselves.
  const owners = await db.listBusinessOwners();
  const who = new Map();
  if (auth.isAdmin(req.user)) for (const u of await db.listUsers()) who.set(u.id, { name: u.name, email: u.email });
  else who.set(req.user.id, { name: req.user.name, email: req.user.email });
  const KEYS = ['requests', 'ok', 'input', 'output', 'cacheRead', 'cacheWrite', 'ms', 'cost', 'costed'];
  const users = new Map();
  for (const b of report.byBusiness) {
    const owner = owners.get(b._id) || null;
    const cur = users.get(owner) || { _id: owner, ...(who.get(owner) || { name: owner ? 'Deleted user' : 'Unassigned', email: '' }), businesses: [], ...Object.fromEntries(KEYS.map((k) => [k, 0])) };
    for (const k of KEYS) cur[k] += b[k] || 0;
    cur.businesses.push(b._id);
    users.set(owner, cur);
  }
  report.byUser = [...users.values()].sort((a, b) => b.requests - a.requests);
  res.json({
    days, ...report,
    config: { provider: sv.provider, label: sv.label, model: sv.model, aiReady: Boolean(process.env[sv.envKey]), aiEnvKey: sv.envKey, pricesSet: Boolean(process.env.AI_PRICE_INPUT_PER_M) && Boolean(process.env.AI_PRICE_OUTPUT_PER_M) },
  });
}));
app.get('/api/usage/export', wrap(async (req, res) => {
  const { days, since, businesses } = await usageScope(req);
  const rows = await db.usageRows({ businesses, since });
  const cols = ['at', 'business', 'kind', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'ms', 'ok', 'cost', 'error'];
  const cell = (v) => { const t = v instanceof Date ? v.toISOString() : v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ai-usage-last-${days}-days.csv"` });
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
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
  const superAdmin = await auth.ensureSuperAdmin();
  // Businesses made before accounts existed belong to the super admin (admins see all anyway).
  if (superAdmin) await db.assignUnownedBusinesses(superAdmin.id);
  app.listen(PORT, () => {
    console.log(`Dashboard on http://localhost:${PORT}`);
    Promise.resolve(wa.restoreSessions())
      .then(() => superAdmin && db.assignUnownedBusinesses(superAdmin.id)) // cards found on disk
      .catch((e) => console.error('Restoring sessions failed:', e.message));
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
