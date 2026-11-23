// Accounts, sign-in sessions and roles.
//
// Roles (lowest to highest):
//   user         sees and manages only the businesses they created
//   admin        sees every business, approves/disables/deletes regular users
//   super_admin  exactly ONE. Everything admins can do, plus: promote/demote admins,
//                manage admins, restart the whole server. Cannot be changed or removed
//                through the app. Created from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD.
//
// Sign-up creates a "pending" account; an admin or the super admin approves it.
// Passwords: scrypt. Sign-in: random token in an HttpOnly cookie; only its hash is stored.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'sid';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const RANK = { user: 1, admin: 2, super_admin: 3 };
const MIN_PASSWORD = 10;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isAdmin = (u) => (RANK[u?.role] || 0) >= RANK.admin;
const isSuperAdmin = (u) => u?.role === 'super_admin';
const outranks = (actor, target) => RANK[actor.role] > RANK[target.role];

// ---- passwords ----

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// Compared against when the email is unknown, so "no such account" takes as long as "wrong password".
let dummyHash;
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(12).toString('hex')));

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (password.length > 128) throw httpError(400, 'Password is too long (128 characters at most).');
}

function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'Enter a valid email address.');
  return e;
}

function checkName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 80) throw httpError(400, 'Enter your name (80 characters at most).');
  return n;
}

// ---- rate limiting (in memory, per server) ----

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60000).unref();
  return {
    blocked(key) { const v = hits.get(key); return Boolean(v) && v.reset > Date.now() && v.n >= max; },
    hit(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset < now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      v.n++;
    },
    clear(key) { hits.delete(key); },
  };
}
const signinByEmail = limiter(5, 15 * 60000);
const signinByIp = limiter(30, 15 * 60000);
const signupByIp = limiter(5, 60 * 60000);

// ---- cookies and sign-in sessions ----

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function setCookie(req, res, value, maxAgeSeconds) {
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${req.secure ? '; Secure' : ''}`);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.createAuthSession({
    _id: hashToken(token), user_id: user.id, created_at: now,
    expires_at: new Date(now + SESSION_DAYS * 86400000), agent: String(req.get('user-agent') || '').slice(0, 200),
  });
  setCookie(req, res, token, SESSION_DAYS * 86400);
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
  created_at: u.created_at, last_login_at: u.last_login_at || null,
});

// ---- middleware ----

// Cross-site form posts can't carry our SameSite=Strict cookie, but refuse them outright anyway.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  next();
}

// Sets req.user (or answers 401).
async function authenticate(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    const session = token && await db.getAuthSession(hashToken(token));
    if (!session || session.expires_at < new Date()) return res.status(401).json({ error: 'Please sign in.' });
    const user = await db.getUser(session.user_id);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Please sign in.' });
    req.user = user;
    req.sessionId = session._id;
    next();
  } catch (e) {
    next(e);
  }
}

const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only.' }));
const requireSuperAdmin = (req, res, next) => (isSuperAdmin(req.user) ? next() : res.status(403).json({ error: 'Super admin only.' }));

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); }
};

// ---- routes: /auth ----

const authRouter = express.Router();
authRouter.use(sameOrigin);

authRouter.post('/signup', wrap(async (req, res) => {
  const ip = req.ip;
  if (signupByIp.blocked(ip)) return res.status(429).json({ error: 'Too many sign-ups from this address. Try again later.' });
  const { name, email, password } = req.body || {};
  const cleanName = checkName(name);
  const cleanEmail = normEmail(email);
  checkPassword(password);
  signupByIp.hit(ip); // only well-formed attempts count
  const password_hash = await hashPassword(password);
  // Same answer whether or not the email is already registered, so sign-up can't be used to probe for accounts.
  if (!await db.findUserByEmail(cleanEmail)) {
    try {
      await db.createUser({ _id: crypto.randomUUID(), name: cleanName, email: cleanEmail, password_hash, role: 'user', status: 'pending', created_at: Date.now(), last_login_at: null });
      console.log(`New sign-up waiting for approval: ${cleanEmail}`);
    } catch (e) {
      if (e.code !== 11000) throw e; // duplicate email from a simultaneous request: same answer
    }
  }
  res.status(202).json({ message: 'Account created. Waiting for admin approval.' });
}));

authRouter.post('/signin', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const key = String(email || '').trim().toLowerCase();
  if (signinByIp.blocked(req.ip) || signinByEmail.blocked(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const user = key && typeof password === 'string' ? await db.findUserByEmail(key) : null;
  const ok = typeof password === 'string' && await verifyPassword(password, user ? user.password_hash : await getDummyHash());
  if (!user || !ok) {
    signinByIp.hit(req.ip); signinByEmail.hit(key);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  // Status is only revealed after the password is right.
  if (user.status === 'pending') return res.status(403).json({ error: 'Your account is waiting for administrator approval.' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Your account has been disabled.' });
  signinByEmail.clear(key);
  await db.updateUser(user.id, { last_login_at: Date.now() });
  await startSession(req, res, user);
  res.json(publicUser({ ...user, last_login_at: Date.now() }));
}));

authRouter.post('/signout', wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await db.deleteAuthSession(hashToken(token));
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}));

authRouter.get('/me', authenticate, (req, res) => res.json(publicUser(req.user)));

authRouter.post('/password', authenticate, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (signinByEmail.blocked(req.user.email)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  if (typeof current !== 'string' || !await verifyPassword(current, req.user.password_hash)) {
    signinByEmail.hit(req.user.email);
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  checkPassword(next);
  await db.updateUser(req.user.id, { password_hash: await hashPassword(next) });
  await db.deleteUserSessions(req.user.id, req.sessionId); // sign out everywhere else
  res.json({ ok: true });
}));

// ---- routes: /api/admin (mounted behind authenticate + requireAdmin) ----

const adminRouter = express.Router();

adminRouter.get('/users', wrap(async (req, res) => {
  res.json((await db.listUsers()).map(publicUser));
}));

async function targetUser(req) {
  const target = await db.getUser(req.params.uid);
  if (!target) throw httpError(404, 'User not found.');
  if (target.id === req.user.id) throw httpError(400, 'You can\'t change your own account here.');
  if (!outranks(req.user, target)) throw httpError(403, 'You don\'t have permission to manage this account.');
  return target;
}

// Body: { status: 'active' | 'disabled' } and/or { role: 'user' | 'admin' } (role: super admin only).
adminRouter.patch('/users/:uid', wrap(async (req, res) => {
  const target = await targetUser(req);
  const { status, role } = req.body || {};
  const set = {};
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) throw httpError(400, 'Status must be active or disabled.');
    set.status = status;
  }
  if (role !== undefined) {
    if (!isSuperAdmin(req.user)) throw httpError(403, 'Only the super admin can change roles.');
    if (!['user', 'admin'].includes(role)) throw httpError(400, 'Role must be user or admin.');
    set.role = role;
  }
  if (!Object.keys(set).length) throw httpError(400, 'Nothing to change.');
  await db.updateUser(target.id, set);
  if (set.status === 'disabled') await db.deleteUserSessions(target.id);
  console.log(`${req.user.email} changed ${target.email}: ${JSON.stringify(set)}`);
  res.json(publicUser({ ...target, ...set }));
}));

adminRouter.post('/users/:uid/password', wrap(async (req, res) => {
  const target = await targetUser(req);
  checkPassword(req.body?.password);
  await db.updateUser(target.id, { password_hash: await hashPassword(req.body.password) });
  await db.deleteUserSessions(target.id);
  console.log(`${req.user.email} reset the password of ${target.email}`);
  res.json({ ok: true });
}));

// Their businesses are not deleted: they move to whoever deletes the account.
adminRouter.delete('/users/:uid', wrap(async (req, res) => {
  const target = await targetUser(req);
  await db.deleteUserSessions(target.id);
  const moved = await db.reassignBusinesses(target.id, req.user.id);
  await db.deleteUser(target.id);
  console.log(`${req.user.email} deleted ${target.email} (${moved} business(es) moved to them)`);
  res.json({ ok: true, businessesMoved: moved });
}));

// An admin gives a business owner their own login: active at once, regular user, no approval step.
async function createActiveUser({ name, email, password }) {
  const cleanName = checkName(name);
  const cleanEmail = normEmail(email);
  checkPassword(password);
  if (await db.findUserByEmail(cleanEmail)) throw httpError(409, 'This email already has an account. Transfer the business to them instead.');
  const doc = { _id: crypto.randomUUID(), name: cleanName, email: cleanEmail, password_hash: await hashPassword(password), role: 'user', status: 'active', created_at: Date.now(), last_login_at: null };
  try { await db.createUser(doc); } catch (e) { if (e.code === 11000) throw httpError(409, 'This email already has an account. Transfer the business to them instead.'); throw e; }
  return publicUser({ ...doc, id: doc._id });
}

// ---- startup: the one super admin ----

// Creates the super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD when there is none yet.
// After that the env values are ignored, so changing them can't create a second one.
// To recover a lost password: set SUPER_ADMIN_PASSWORD and SUPER_ADMIN_RESET=1, restart, then remove RESET.
async function ensureSuperAdmin() {
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const existing = await db.getSuperAdmin();
  if (existing) {
    if (password && process.env.SUPER_ADMIN_RESET === '1') {
      checkPassword(password);
      await db.updateUser(existing.id, { password_hash: await hashPassword(password), status: 'active' });
      await db.deleteUserSessions(existing.id);
      console.warn(`Super admin password reset from SUPER_ADMIN_PASSWORD. Remove SUPER_ADMIN_RESET now.`);
    }
    return existing;
  }
  if (!process.env.SUPER_ADMIN_EMAIL || !password) {
    console.error('No super admin exists. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD and restart to create one.');
    return null;
  }
  const email = normEmail(process.env.SUPER_ADMIN_EMAIL);
  checkPassword(password);
  const password_hash = await hashPassword(password);
  const known = await db.findUserByEmail(email);
  if (known) {
    await db.updateUser(known.id, { role: 'super_admin', status: 'active', password_hash });
  } else {
    await db.createUser({ _id: crypto.randomUUID(), name: 'Super Admin', email, password_hash, role: 'super_admin', status: 'active', created_at: Date.now(), last_login_at: null });
  }
  console.log(`Super admin created: ${email}`);
  return db.getSuperAdmin();
}

// Can this user open this business? (owner is the user id stored on the business, or null.)
const canAccessBusiness = (user, owner) => isAdmin(user) || (Boolean(owner) && owner === user.id);

module.exports = {
  authRouter, adminRouter, authenticate, requireAdmin, requireSuperAdmin, sameOrigin,
  ensureSuperAdmin, canAccessBusiness, isAdmin, isSuperAdmin, createActiveUser, publicUser,
  hashPassword, verifyPassword, // exported for tests
};
