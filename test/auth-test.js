// Accounts and roles, end to end: starts the real server against a throwaway MongoDB
// database (wa_test_auth, dropped at the end) and talks to it over HTTP.
// Run: node --env-file=../atlas-credentials.env test/auth-test.js   (or set MONGODB_URI)
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { MongoClient } = require('mongodb');

const PORT = 3990;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'wa_test_auth';
const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const SUPER = { email: 'boss@example.com', password: 'super-secret-pass' };

// A tiny HTTP client that keeps its own cookie.
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})), setCookie: set };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

async function signup(name, email, password = 'a-long-password') {
  return client().post('/auth/signup', { name, email, password });
}
async function signin(email, password = 'a-long-password') {
  const c = client();
  const r = await c.post('/auth/signin', { email, password });
  return { c, r };
}

(async () => {
  const mongo = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 10000 });
  await mongo.db(DB).dropDatabase();
  const sessionsDir = require('os').tmpdir() + '/wa-auth-test-sessions';
  require('fs').rmSync(sessionsDir, { recursive: true, force: true }); // a clean slate: no logins left from an earlier run
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, MONGODB_DB: DB, MONGODB_URI: URI, SUPER_ADMIN_EMAIL: SUPER.email, SUPER_ADMIN_PASSWORD: SUPER.password, SESSIONS_DIR: sessionsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !/Dashboard on/.test(log); i++) await new Promise((r) => setTimeout(r, 200));
  assert(/Dashboard on/.test(log), `server did not start:\n${log}`);

  let n = 0;
  const step = async (name, fn) => { n++; try { await fn(); console.log(`ok ${n} - ${name}`); } catch (e) { console.error(`FAIL ${n} - ${name}\n`, e.message); throw e; } };

  try {
    await step('API refuses anonymous visitors', async () => {
      assert.strictEqual((await client().get('/api/sessions')).status, 401);
      assert.strictEqual((await client().get('/api/admin/users')).status, 401);
      assert.strictEqual((await client().get('/auth/me')).status, 401);
    });

    await step('sign-up validates input and never reveals existing emails', async () => {
      assert.strictEqual((await signup('X', 'not-an-email')).status, 400);
      assert.strictEqual((await signup('X', 'x@example.com', 'short')).status, 400);
      assert.strictEqual((await signup('', 'x@example.com')).status, 400);
      const a = await signup('Alice', 'alice@example.com');
      const again = await signup('Alice 2', 'ALICE@example.com'); // same email, other case
      assert.strictEqual(a.status, 202);
      assert.strictEqual(again.status, 202);
      assert.deepStrictEqual(again.body, a.body);
      assert.strictEqual((await signup('Bob', 'bob@example.com')).status, 202);
      assert.strictEqual((await signup('Carol', 'carol@example.com')).status, 202);
      assert.strictEqual(await mongo.db(DB).collection('users').countDocuments({ email: 'alice@example.com' }), 1);
    });

    await step('pending accounts cannot sign in; wrong password looks the same for unknown emails', async () => {
      const pending = await signin('alice@example.com');
      assert.strictEqual(pending.r.status, 403);
      assert(!pending.r.setCookie);
      const bad = await signin('alice@example.com', 'wrong-password-1');
      const none = await signin('nobody@example.com', 'wrong-password-1');
      assert.strictEqual(bad.r.status, 401);
      assert.deepStrictEqual(bad.r.body, none.r.body);
    });

    const sa = client();
    await step('super admin signs in and sees everyone', async () => {
      const r = await sa.post('/auth/signin', SUPER);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.role, 'super_admin');
      assert(/HttpOnly/.test(r.setCookie) && /SameSite=Strict/.test(r.setCookie));
      assert(!JSON.stringify(r.body).includes('password'));
      const users = (await sa.get('/api/admin/users')).body;
      assert.strictEqual(users.length, 4);
      assert(users.every((u) => !('password_hash' in u)));
    });

    const idOf = async (email) => (await sa.get('/api/admin/users')).body.find((u) => u.email === email).id;
    await step('super admin approves accounts', async () => {
      for (const e of ['alice@example.com', 'bob@example.com']) assert.strictEqual((await sa.patch(`/api/admin/users/${await idOf(e)}`, { status: 'active' })).status, 200);
    });

    const alice = (await signin('alice@example.com')).c;
    const bob = (await signin('bob@example.com')).c;
    await step('regular users cannot reach admin or server-wide endpoints', async () => {
      assert.strictEqual((await alice.get('/api/admin/users')).status, 403);
      assert.strictEqual((await alice.post('/api/restart-all')).status, 403);
      assert.strictEqual((await alice.get('/api/logs')).status, 403);
      assert.strictEqual((await alice.patch(`/api/admin/users/${await idOf('bob@example.com')}`, { status: 'disabled' })).status, 403);
    });

    await step('businesses belong to the user who created them', async () => {
      assert.strictEqual((await alice.post('/api/sessions', { id: 'alice-shop' })).status, 201);
      assert.strictEqual((await alice.get('/api/sessions')).body.length, 1);
      assert.deepStrictEqual((await bob.get('/api/sessions')).body, []);
      for (const url of ['/api/sessions/alice-shop', '/api/sessions/alice-shop/orders', '/api/sessions/alice-shop/rules', '/api/sessions/alice-shop/logs']) {
        assert.strictEqual((await bob.get(url)).status, 404, url);
      }
      assert.strictEqual((await bob.del('/api/sessions/alice-shop')).status, 404);
      assert.strictEqual((await bob.post('/api/sessions', { id: 'ALICE-shop' })).status, 409); // name taken, case-insensitive
      assert.strictEqual((await alice.get('/api/sessions/alice-shop/orders')).status, 200);
      assert.strictEqual((await sa.get('/api/sessions')).body.length, 1); // admins see all
      assert.strictEqual((await sa.get('/api/sessions/alice-shop')).status, 200);
    });

    await step('AI usage: users see only their own businesses, admins see everything', async () => {
      const usersCol = mongo.db(DB).collection('users');
      const aliceId = (await usersCol.findOne({ email: 'alice@example.com' }))._id;
      const row = (business, ok = true) => ({ at: new Date(), business, kind: 'reply', provider: 'anthropic', model: 'm', ms: 900, ok, error: ok ? null : 'failed', input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0.001 });
      await mongo.db(DB).collection('ai_usage').insertMany([row('alice-shop'), row('alice-shop', false), row('someone-elses-shop')]);
      const mine = (await alice.get('/api/usage?days=7')).body;
      assert.strictEqual(mine.totals.requests, 2);
      assert.deepStrictEqual(mine.byBusiness.map((b) => b._id), ['alice-shop']);
      assert.deepStrictEqual(mine.byUser.map((u) => u._id), [aliceId]);
      assert.strictEqual((await alice.get('/api/usage?days=7&business=someone-elses-shop')).status, 404);
      assert.strictEqual((await bob.get('/api/usage?days=7&business=alice-shop')).status, 404); // not bob's business
      const all = (await sa.get('/api/usage?days=7')).body;
      assert.strictEqual(all.totals.requests, 3);
      assert.strictEqual((await client().get('/api/usage')).status, 401);
    });

    await step('admins can give a business to its owner with a new login; regular users cannot', async () => {
      assert.strictEqual((await alice.post('/api/sessions/alice-shop/access', { name: 'Dana', email: 'dana@example.com', password: 'dana-long-password' })).status, 403);
      assert.strictEqual((await alice.get('/api/sessions/alice-shop/access')).status, 403);
      assert.strictEqual((await sa.post('/api/sessions/alice-shop/access', { name: 'Dana', email: 'dana@example.com', password: 'short' })).status, 400);
      assert.strictEqual((await sa.post('/api/sessions/alice-shop/access', { name: 'Alice again', email: 'alice@example.com', password: 'another-long-password' })).status, 409); // already has an account
      const made = await sa.post('/api/sessions/alice-shop/access', { name: 'Dana', email: 'Dana@Example.com', password: 'dana-long-password' });
      assert.strictEqual(made.status, 201);
      assert.strictEqual(made.body.owner.email, 'dana@example.com');
      assert(!JSON.stringify(made.body).includes('password'));
      const dana = (await signin('dana@example.com', 'dana-long-password')).c; // active at once, no approval step
      assert.deepStrictEqual((await dana.get('/api/sessions')).body.map((b) => b.id), ['alice-shop']);
      assert.strictEqual((await dana.get('/api/sessions/alice-shop')).status, 200);
      assert.strictEqual((await alice.get('/api/sessions/alice-shop')).status, 404); // alice no longer owns it
      assert.strictEqual((await dana.get('/api/admin/users')).status, 403);
      // move it back to alice
      const aliceId = (await sa.get('/api/admin/users')).body.find((u) => u.email === 'alice@example.com').id;
      assert.strictEqual((await sa.put('/api/sessions/alice-shop/access', { userId: 'nope' })).status, 404);
      assert.strictEqual((await sa.put('/api/sessions/alice-shop/access', { userId: aliceId })).body.owner.email, 'alice@example.com');
      assert.strictEqual((await alice.get('/api/sessions/alice-shop')).status, 200);
      assert.strictEqual((await dana.get('/api/sessions/alice-shop')).status, 404);
    });

    await step('only the super admin changes roles; admins manage users but not admins', async () => {
      const bobId = await idOf('bob@example.com'), aliceId = await idOf('alice@example.com'), carolId = await idOf('carol@example.com');
      assert.strictEqual((await alice.patch(`/api/admin/users/${bobId}`, { role: 'admin' })).status, 403);
      assert.strictEqual((await sa.patch(`/api/admin/users/${bobId}`, { role: 'admin' })).status, 200);
      assert.strictEqual((await sa.patch(`/api/admin/users/${bobId}`, { role: 'super_admin' })).status, 400); // no second super admin
      assert.strictEqual((await sa.patch(`/api/admin/users/${bobId}`, { role: 'root' })).status, 400);
      // Bob (admin) now sees every business and can approve sign-ups...
      assert.strictEqual((await bob.get('/api/sessions')).body.length, 1);
      assert.strictEqual((await bob.patch(`/api/admin/users/${carolId}`, { status: 'active' })).status, 200);
      // ...but cannot touch roles, himself, or the super admin.
      assert.strictEqual((await bob.patch(`/api/admin/users/${aliceId}`, { role: 'admin' })).status, 403);
      assert.strictEqual((await bob.patch(`/api/admin/users/${bobId}`, { status: 'disabled' })).status, 400);
      const saId = (await sa.get('/auth/me')).body.id;
      assert.strictEqual((await bob.patch(`/api/admin/users/${saId}`, { status: 'disabled' })).status, 403);
      assert.strictEqual((await bob.del(`/api/admin/users/${saId}`)).status, 403);
      assert.strictEqual((await bob.post(`/api/admin/users/${saId}/password`, { password: 'hacked-password' })).status, 403);
      assert.strictEqual((await sa.patch(`/api/admin/users/${saId}`, { status: 'disabled' })).status, 400); // not even themself
    });

    await step('the database allows only one super admin', async () => {
      await assert.rejects(mongo.db(DB).collection('users').insertOne({ _id: 'x', email: 'second@example.com', role: 'super_admin', status: 'active' }), /E11000/);
    });

    await step('disabling a user ends their sign-in immediately', async () => {
      const aliceId = await idOf('alice@example.com');
      assert.strictEqual((await bob.patch(`/api/admin/users/${aliceId}`, { status: 'disabled' })).status, 200);
      assert.strictEqual((await alice.get('/api/sessions')).status, 401);
      assert.strictEqual((await signin('alice@example.com')).r.status, 403);
      assert.strictEqual((await sa.patch(`/api/admin/users/${aliceId}`, { status: 'active' })).status, 200);
    });

    await step('password change signs out other devices; admin reset works', async () => {
      const a1 = (await signin('alice@example.com')).c, a2 = (await signin('alice@example.com')).c;
      assert.strictEqual((await a1.post('/auth/password', { current: 'nope-nope-nope', next: 'brand-new-password' })).status, 400);
      assert.strictEqual((await a1.post('/auth/password', { current: 'a-long-password', next: 'short' })).status, 400);
      assert.strictEqual((await a1.post('/auth/password', { current: 'a-long-password', next: 'brand-new-password' })).status, 200);
      assert.strictEqual((await a1.get('/auth/me')).status, 200);
      assert.strictEqual((await a2.get('/auth/me')).status, 401);
      assert.strictEqual((await signin('alice@example.com', 'a-long-password')).r.status, 401);
      assert.strictEqual((await signin('alice@example.com', 'brand-new-password')).r.status, 200);
      assert.strictEqual((await sa.post(`/api/admin/users/${await idOf('alice@example.com')}/password`, { password: 'reset-by-admin-1' })).status, 200);
      assert.strictEqual((await a1.get('/auth/me')).status, 401);
      assert.strictEqual((await signin('alice@example.com', 'reset-by-admin-1')).r.status, 200);
    });

    await step('sign-out ends the session', async () => {
      const c = (await signin('carol@example.com')).c;
      assert.strictEqual((await c.get('/auth/me')).status, 200);
      assert.strictEqual((await c.post('/auth/signout')).status, 200);
      assert.strictEqual((await c.get('/auth/me')).status, 401);
    });

    await step('cross-site posts are refused', async () => {
      const r = await sa.post('/api/sessions', { id: 'evil' }, { origin: 'https://evil.example' });
      assert.strictEqual(r.status, 403);
      assert.strictEqual((await client().post('/auth/signin', SUPER, { origin: 'https://evil.example' })).status, 403);
    });

    await step('deleting a user keeps their businesses and moves them to the deleter', async () => {
      const aliceId = await idOf('alice@example.com');
      const r = await sa.del(`/api/admin/users/${aliceId}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.businessesMoved, 1);
      assert.strictEqual((await alice.get('/auth/me')).status, 401);
      assert.strictEqual((await mongo.db(DB).collection('businesses').findOne({ _id: 'alice-shop' })).owner, (await sa.get('/auth/me')).body.id);
    });

    await step('repeated wrong passwords are rate limited', async () => {
      let last;
      for (let i = 0; i < 6; i++) last = (await signin('bob@example.com', 'wrong-password-x')).r.status;
      assert.strictEqual(last, 429);
      assert.strictEqual((await signin('bob@example.com')).r.status, 429); // even the right one, until the window passes
    });

    console.log(`\nAll ${n} auth steps passed.`);
  } finally {
    server.kill('SIGTERM');
    await mongo.db(DB).dropDatabase().catch(() => {});
    await mongo.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
