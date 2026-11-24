// MongoDB: customer profiles, orders, and questions passed to the manager.
// Every document belongs to one business (the session id). Order and question
// numbers (#5, #12) count up per business.
//
// Connection: MONGODB_URI (default: local mongodb://127.0.0.1:27017), database
// MONGODB_DB (default: whatsapp_baileys, kept apart from the WhatsApp Web version's
// "whatsapp_automation" so the two versions never run the same business twice).
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'whatsapp_baileys';
const ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled'];
const HIDE_ID = { projection: { _id: 0 } };

let client;
let col; // { customers, orders, escalations, counters }

async function init() {
  // mongodb+srv:// addresses need an SRV DNS lookup, which some office and ISP DNS
  // servers don't answer ("querySrv ETIMEOUT"). DNS_SERVERS=8.8.8.8,1.1.1.1 sends those
  // lookups to public DNS instead. Not needed on Railway.
  if (process.env.DNS_SERVERS) {
    require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(DB_NAME);
  col = {
    customers: db.collection('customers'),
    orders: db.collection('orders'),
    escalations: db.collection('escalations'),
    counters: db.collection('counters'),
    settings: db.collection('settings'), // one document per business: auto-reply settings (_id = business)
    chatState: db.collection('chat_state'), // older per-business "welcomed" map, moved to chat_activity on startup
    chatActivity: db.collection('chat_activity'), // one document per chat: pauses, reply limits, welcomed time
    transcripts: db.collection('transcripts'), // voice note text, so each note is transcribed once
    imageCache: db.collection('image_cache'), // customers' photos, so they're downloaded once
    logs: db.collection('logs'), // everything the server prints
    businesses: db.collection('businesses'), // every business card (_id = name), linked or not
    // Baileys has no WhatsApp Web keeping chats for us, so we keep what the app needs:
    waMessages: db.collection('wa_messages'), // recent messages per chat (for the AI's history)
    waChats: db.collection('wa_chats'), // one per chat: name and last message time (contacts picker, send by name)
    aiUsage: db.collection('ai_usage'), // one document per AI call: tokens, time, outcome, cost
    users: db.collection('users'), // accounts (_id = uuid): email, password hash, role, status
    authSessions: db.collection('auth_sessions'), // sign-in sessions (_id = hash of the cookie token)
    apiKeys: db.collection('api_keys'), // keys for other systems (_id = hash of the key): one business each
    webhooks: db.collection('webhooks'), // where to send events (_id = uuid)
    webhookDeliveries: db.collection('webhook_deliveries'), // each event sent to each webhook, with retries
    apiIdem: db.collection('api_idempotency'), // replies kept per Idempotency-Key
  };
  await Promise.all([
    col.customers.createIndex({ business: 1, chat_id: 1 }, { unique: true }),
    col.customers.createIndex({ business: 1, last_seen: -1 }),
    col.orders.createIndex({ business: 1, id: 1 }, { unique: true }),
    col.orders.createIndex({ business: 1, chat_id: 1, created_at: -1 }),
    col.escalations.createIndex({ business: 1, id: 1 }, { unique: true }),
    col.escalations.createIndex({ business: 1, status: 1 }),
    col.escalations.createIndex({ business: 1, manager_msg_id: 1 }),
    col.chatActivity.createIndex({ business: 1, chat_id: 1 }, { unique: true }),
    col.transcripts.createIndex({ business: 1, msg_id: 1 }, { unique: true }),
    col.imageCache.createIndex({ business: 1, msg_id: 1 }, { unique: true }),
    col.logs.createIndex({ business: 1, at: -1 }),
    col.waMessages.createIndex({ business: 1, msg_id: 1 }, { unique: true }),
    col.waMessages.createIndex({ business: 1, chat_id: 1, order: -1 }),
    col.waChats.createIndex({ business: 1, chat_id: 1 }, { unique: true }),
    col.waChats.createIndex({ business: 1, t: -1 }),
    col.aiUsage.createIndex({ business: 1, at: -1 }),
    ttlIndex(col.aiUsage, TTL_DAYS.usage),
    col.users.createIndex({ email: 1 }, { unique: true }),
    // At most one super admin can ever exist, enforced by the database itself.
    col.users.createIndex({ role: 1 }, { unique: true, partialFilterExpression: { role: 'super_admin' }, name: 'one_super_admin' }),
    col.authSessions.createIndex({ user_id: 1 }),
    col.authSessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    col.apiKeys.createIndex({ business: 1 }),
    col.webhooks.createIndex({ business: 1 }),
    col.webhookDeliveries.createIndex({ status: 1, next_at: 1 }),
    col.webhookDeliveries.createIndex({ business: 1, webhook: 1, created_at: -1 }),
    ttlIndex(col.webhookDeliveries, 14),
    col.apiIdem.createIndex({ business: 1, key: 1 }, { unique: true }),
    ttlIndex(col.apiIdem, 1),
    ttlIndex(col.waMessages, TTL_DAYS.messages),
    // MongoDB deletes these by itself once they're older than the limit.
    ttlIndex(col.transcripts, TTL_DAYS.transcripts),
    ttlIndex(col.imageCache, TTL_DAYS.images),
    ttlIndex(col.logs, TTL_DAYS.logs),
  ]);
  console.log(`MongoDB connected (${DB_NAME})`);
}

// How long cached and logged data is kept (days). Change with env vars if needed.
const TTL_DAYS = {
  transcripts: Number(process.env.TRANSCRIPT_RETENTION_DAYS || 180),
  images: Number(process.env.IMAGE_RETENTION_DAYS || 7),
  logs: Number(process.env.LOG_RETENTION_DAYS || 30),
  messages: Number(process.env.MESSAGE_RETENTION_DAYS || 90),
  usage: Number(process.env.USAGE_RETENTION_DAYS || 400),
};

// Expire documents `days` after their `at` date. If the limit was changed, update the index.
async function ttlIndex(collection, days) {
  const seconds = Math.round(days * 86400);
  try {
    await collection.createIndex({ at: 1 }, { name: 'expire_at', expireAfterSeconds: seconds });
  } catch (e) {
    if (e.codeName !== 'IndexOptionsConflict' && e.code !== 85) throw e;
    await client.db(DB_NAME).command({ collMod: collection.collectionName, index: { name: 'expire_at', expireAfterSeconds: seconds } });
  }
}

async function close() {
  await client?.close();
}

const phoneOf = (chatId) => (/^(\d+)@c\.us$/.exec(chatId) || [])[1] || null;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Next #number for this business ('order' or 'question').
async function nextNumber(business, kind) {
  const doc = await col.counters.findOneAndUpdate(
    { _id: `${kind}:${business}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return doc.seq;
}

// ---- customers ----

function getCustomer(business, chatId) {
  return col.customers.findOne({ business, chat_id: chatId }, HIDE_ID);
}

// Record that the customer messaged us; returns the customer document.
async function touchCustomer(business, chatId, { name } = {}, now = Date.now()) {
  // Update pipeline so fields are only filled when missing. The WhatsApp display
  // name is used only until the profile knows their real name.
  await col.customers.updateOne(
    { business, chat_id: chatId },
    [{
      $set: {
        business,
        chat_id: chatId,
        last_seen: now,
        first_seen: { $ifNull: ['$first_seen', now] },
        phone: { $ifNull: ['$phone', phoneOf(chatId)] },
        name: { $ifNull: ['$name', name || null] },
        profile: { $ifNull: ['$profile', null] },
        profile_updated_at: { $ifNull: ['$profile_updated_at', null] },
        turns_since_profile: { $ifNull: ['$turns_since_profile', 0] },
      },
    }],
    { upsert: true },
  );
  return getCustomer(business, chatId);
}

async function countTurn(business, chatId) {
  await col.customers.updateOne({ business, chat_id: chatId }, { $inc: { turns_since_profile: 1 } });
}

async function saveProfile(business, chatId, profile, now = Date.now()) {
  const set = { profile, profile_updated_at: now, turns_since_profile: 0 };
  if (profile?.name) set.name = profile.name;
  await col.customers.updateOne({ business, chat_id: chatId }, { $set: set });
}

async function listCustomers(business, limit = 200) {
  const [customers, counts] = await Promise.all([
    col.customers.find({ business }, HIDE_ID).sort({ last_seen: -1 }).limit(limit).toArray(),
    col.orders.aggregate([
      { $match: { business, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$chat_id', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const byChat = new Map(counts.map((c) => [c._id, c.n]));
  return customers.map((c) => ({ ...c, order_count: byChat.get(c.chat_id) || 0 }));
}

// ---- orders ----

async function addOrder(business, chatId, o, now = Date.now()) {
  const doc = {
    business,
    id: await nextNumber(business, 'order'),
    chat_id: chatId,
    customer_name: o.customer_name || null,
    phone: o.customer_phone || phoneOf(chatId),
    items: Array.isArray(o.items) ? o.items : [],
    total: Number.isFinite(o.total) ? o.total : null,
    address: o.delivery_address || null,
    notes: o.notes || null,
    status: 'confirmed',
    created_at: now,
    updated_at: now,
  };
  await col.orders.insertOne({ ...doc });
  return doc;
}

function getOrder(business, id) {
  return col.orders.findOne({ business, id }, HIDE_ID);
}

function listOrders(business, { chatId, limit = 200 } = {}) {
  const filter = chatId ? { business, chat_id: chatId } : { business };
  return col.orders.find(filter, HIDE_ID).sort({ created_at: -1 }).limit(limit).toArray();
}

// Orders for the API: optional status / customer / date filters, newest first, paged.
async function queryOrders(business, { status, chatId, since, limit = 50, offset = 0 } = {}) {
  const filter = { business };
  if (status) filter.status = status;
  if (chatId) filter.chat_id = chatId;
  if (since) filter.created_at = { $gte: since };
  const [items, total] = await Promise.all([
    col.orders.find(filter, HIDE_ID).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
    col.orders.countDocuments(filter),
  ]);
  return { items, total };
}

async function setOrderStatus(business, id, status, now = Date.now()) {
  if (!ORDER_STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${ORDER_STATUSES.join(', ')}.`);
  const doc = await col.orders.findOneAndUpdate(
    { business, id },
    { $set: { status, updated_at: now } },
    { returnDocument: 'after', ...HIDE_ID },
  );
  if (!doc) throw httpError(404, 'Order not found.');
  return doc;
}

// ---- questions passed to the manager ----

async function addEscalation(business, chatId, customerName, question, now = Date.now()) {
  const id = await nextNumber(business, 'question');
  await col.escalations.insertOne({
    business, id, chat_id: chatId, customer_name: customerName || null, question,
    manager_msg_id: null, status: 'open', answer: null, reply_sent: null, created_at: now, answered_at: null,
  });
  return id;
}

async function setEscalationMessage(business, id, managerMsgId) {
  await col.escalations.updateOne({ business, id }, { $set: { manager_msg_id: managerMsgId } });
}

function getEscalation(business, id) {
  return col.escalations.findOne({ business, id }, HIDE_ID);
}

function escalationByManagerMsg(business, managerMsgId) {
  return col.escalations.findOne({ business, manager_msg_id: managerMsgId }, HIDE_ID);
}

function openEscalations(business, chatId) {
  const filter = chatId ? { business, chat_id: chatId, status: 'open' } : { business, status: 'open' };
  return col.escalations.find(filter, HIDE_ID).sort({ id: 1 }).toArray();
}

function countOpenEscalations(business) {
  return col.escalations.countDocuments({ business, status: 'open' });
}

async function answerEscalation(business, id, answer, replySent, now = Date.now()) {
  await col.escalations.updateOne({ business, id }, { $set: { status: 'answered', answer, reply_sent: replySent, answered_at: now } });
}

function listEscalations(business, limit = 200) {
  return col.escalations.find({ business }, HIDE_ID).sort({ id: -1 }).limit(limit).toArray();
}

// ---- per-business settings and chat state (rules.js keeps an in-memory copy) ----

const isReady = () => Boolean(col);

async function loadAll(collection) {
  const docs = await col[collection].find({}).toArray();
  return new Map(docs.map(({ _id, updated_at, ...rest }) => [_id, rest]));
}

async function saveDoc(collection, business, data) {
  await col[collection].replaceOne({ _id: business }, { ...data, _id: business, updated_at: Date.now() }, { upsert: true });
}

const loadSettings = () => loadAll('settings');
const saveSettings = (business, rules) => saveDoc('settings', business, rules);
const loadChatStates = () => loadAll('chatState');
const saveChatState = (business, state) => saveDoc('chatState', business, state);

async function deleteSettings(business) {
  await Promise.all([
    col.settings.deleteOne({ _id: business }),
    col.chatState.deleteOne({ _id: business }),
    col.chatActivity.deleteMany({ business }),
  ]);
}

// ---- per-chat activity: pauses, reply limits, welcomed time ----

async function loadChatActivity() {
  return col.chatActivity.find({}, HIDE_ID).toArray();
}

async function saveChatActivity(business, chatId, data) {
  await col.chatActivity.replaceOne(
    { business, chat_id: chatId },
    { ...data, business, chat_id: chatId, updated_at: Date.now() },
    { upsert: true },
  );
}

// Older versions kept "welcomed" as one map per business; returns and removes them.
async function takeOldChatStates() {
  const docs = await col.chatState.find({}).toArray();
  if (docs.length) await col.chatState.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  return docs;
}

// ---- voice transcripts and photo cache ----

async function getTranscript(business, msgId) {
  const doc = await col.transcripts.findOne({ business, msg_id: msgId }, HIDE_ID);
  return doc ? doc.text : undefined; // undefined = never transcribed; '' = nothing usable
}

async function saveTranscript(business, msgId, chatId, text) {
  await col.transcripts.updateOne(
    { business, msg_id: msgId },
    { $set: { business, msg_id: msgId, chat_id: chatId, text, at: new Date() } },
    { upsert: true },
  );
}

// Returns { mime, data } | null (unusable photo) | undefined (not cached).
async function getCachedImage(business, msgId) {
  const doc = await col.imageCache.findOne({ business, msg_id: msgId }, HIDE_ID);
  if (!doc) return undefined;
  return doc.usable ? { mime: doc.mime, data: doc.data.toString('base64') } : null;
}

async function saveCachedImage(business, msgId, image) {
  const set = image
    ? { usable: true, mime: image.mime, data: Buffer.from(image.data, 'base64') }
    : { usable: false, mime: null, data: null };
  await col.imageCache.updateOne(
    { business, msg_id: msgId },
    { $set: { business, msg_id: msgId, ...set, at: new Date() } },
    { upsert: true },
  );
}

// ---- business list: a card exists until it's deleted on purpose ----

// owner: id of the user who created the card (null for cards found on disk at startup).
async function addBusiness(business, owner = null, now = Date.now()) {
  await col.businesses.updateOne({ _id: business }, { $setOnInsert: { created_at: now, owner } }, { upsert: true });
}

// Map of business name -> owner user id (or null).
async function listBusinessOwners() {
  const docs = await col.businesses.find({}, { projection: { owner: 1 } }).toArray();
  return new Map(docs.map((b) => [b._id, b.owner || null]));
}

async function getBusinessOwner(business) {
  const doc = await col.businesses.findOne({ _id: business }, { projection: { owner: 1 } });
  return doc ? { owner: doc.owner || null } : null; // null: no such business
}

// Cards without an owner (made before accounts existed) go to `owner`.
async function assignUnownedBusinesses(owner) {
  const r = await col.businesses.updateMany({ owner: null }, { $set: { owner } });
  return r.modifiedCount;
}

async function setBusinessOwner(business, owner) {
  return (await col.businesses.updateOne({ _id: business }, { $set: { owner } })).matchedCount;
}

async function reassignBusinesses(from, to) {
  return (await col.businesses.updateMany({ owner: from }, { $set: { owner: to } })).modifiedCount;
}

async function listBusinesses() {
  return (await col.businesses.find({}).sort({ created_at: 1 }).toArray()).map((b) => b._id);
}

// ---- logs ----

async function insertLogs(entries) {
  if (entries.length) await col.logs.insertMany(entries, { ordered: false });
}

// Newest first. business: one business's lines; null: lines not tied to a business.
function listLogs({ business, server, level, limit = 300, before } = {}) {
  const filter = {};
  if (server) filter.server = server;
  if (business !== undefined) filter.business = business;
  if (level) filter.level = level;
  if (before) filter.at = { $lt: new Date(before) };
  return col.logs.find(filter, HIDE_ID).sort({ at: -1 }).limit(Math.min(limit, 1000)).toArray();
}

// The business was removed from the dashboard: drop all its data.
async function deleteBusiness(business) {
  await Promise.all([
    col.customers.deleteMany({ business }),
    col.orders.deleteMany({ business }),
    col.escalations.deleteMany({ business }),
    col.counters.deleteMany({ _id: { $in: [`order:${business}`, `question:${business}`] } }),
    col.chatActivity.deleteMany({ business }),
    col.transcripts.deleteMany({ business }),
    col.imageCache.deleteMany({ business }),
    col.logs.deleteMany({ business }),
    col.waMessages.deleteMany({ business }),
    col.waChats.deleteMany({ business }),
    col.aiUsage.deleteMany({ business }),
    col.businesses.deleteOne({ _id: business }),
    col.apiKeys.deleteMany({ business }),
    col.webhooks.deleteMany({ business }),
    col.webhookDeliveries.deleteMany({ business }),
    col.apiIdem.deleteMany({ business }),
  ]);
}

// ---- WhatsApp messages and chats (Baileys version) ----
// Message documents: { business, chat_id, msg_id, from_me, ts (seconds), type, body,
// caption, duration, push_name, raw (JSON, only for media: needed to download it), at }.
async function saveWaMessages(business, docs) {
  if (!docs.length) return;
  await col.waMessages.bulkWrite(docs.map((d) => ({
    updateOne: { filter: { business, msg_id: d.msg_id }, update: { $set: { ...d, business, at: new Date((d.ts || Date.now() / 1000) * 1000) } }, upsert: true },
  })), { ordered: false });
}

// The newest `limit` messages of a chat, oldest first.
async function recentWaMessages(business, chatId, limit) {
  const docs = await col.waMessages.find({ business, chat_id: chatId }, HIDE_ID).sort({ order: -1, ts: -1 }).limit(limit).toArray();
  return docs.reverse();
}

async function getWaMessage(business, msgId) {
  return col.waMessages.findOne({ business, msg_id: msgId }, HIDE_ID);
}

// Chat documents: { business, chat_id, name, is_group, t (seconds of the last message) }.
async function saveWaChats(business, chats) {
  if (!chats.length) return;
  await col.waChats.bulkWrite(chats.map((c) => {
    const set = { business, chat_id: c.chat_id };
    if (c.name) set.name = c.name;
    if (c.is_group !== undefined) set.is_group = c.is_group;
    const update = { $set: set };
    if (c.t) update.$max = { t: c.t };
    return { updateOne: { filter: { business, chat_id: c.chat_id }, update, upsert: true } };
  }), { ordered: false });
}

function listWaChats(business, { since = 0, limit = 5000 } = {}) {
  return col.waChats.find({ business, ...(since ? { t: { $gte: since } } : {}) }, HIDE_ID).sort({ t: -1 }).limit(limit).toArray();
}

const countWaChats = (business) => col.waChats.countDocuments({ business });

// ---- accounts and sign-in sessions ----

const userOut = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

const createUser = (doc) => col.users.insertOne(doc);
const findUserByEmail = async (email) => userOut(await col.users.findOne({ email }));
const getUser = async (id) => userOut(await col.users.findOne({ _id: id }));
const getSuperAdmin = async () => userOut(await col.users.findOne({ role: 'super_admin' }));
const updateUser = (id, set) => col.users.updateOne({ _id: id }, { $set: set });
const deleteUser = (id) => col.users.deleteOne({ _id: id });
async function listUsers() {
  return (await col.users.find({}).sort({ created_at: 1 }).toArray()).map(userOut);
}

const createAuthSession = (doc) => col.authSessions.insertOne(doc);
const getAuthSession = (hash) => col.authSessions.findOne({ _id: hash });
const deleteAuthSession = (hash) => col.authSessions.deleteOne({ _id: hash });
// All of a user's sign-ins, except the one named in `keep`.
const deleteUserSessions = (userId, keep) => col.authSessions.deleteMany(keep ? { user_id: userId, _id: { $ne: keep } } : { user_id: userId });

// ---- AI usage ----

const recordUsage = (doc) => col.aiUsage.insertOne(doc);

const SUM = {
  requests: { $sum: 1 },
  ok: { $sum: { $cond: ['$ok', 1, 0] } },
  input: { $sum: '$input_tokens' }, output: { $sum: '$output_tokens' },
  cacheRead: { $sum: '$cache_read_tokens' }, cacheWrite: { $sum: '$cache_write_tokens' },
  ms: { $sum: '$ms' }, cost: { $sum: '$cost' }, costed: { $sum: { $cond: [{ $ne: ['$cost', null] }, 1, 0] } },
};

// businesses: array of allowed names, or null for all. Returns totals, per-day, and breakdowns.
async function usageReport({ businesses, since, tz = 'UTC', recent = 100 }) {
  const match = { at: { $gte: since } };
  if (businesses) match.business = { $in: businesses };
  const run = (zone) => col.aiUsage.aggregate([
    { $match: match },
    { $facet: {
      totals: [{ $group: { _id: null, ...SUM } }],
      daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: zone } }, ...SUM } }, { $sort: { _id: 1 } }],
      byBusiness: [{ $group: { _id: '$business', ...SUM } }, { $sort: { requests: -1 } }],
      byKind: [{ $group: { _id: '$kind', ...SUM } }, { $sort: { requests: -1 } }],
      byModel: [{ $group: { _id: { provider: '$provider', model: '$model' }, ...SUM } }, { $sort: { requests: -1 } }],
      recent: [{ $sort: { at: -1 } }, { $limit: recent }, { $project: { _id: 0 } }],
    } },
  ]).toArray();
  let out;
  try { [out] = await run(tz); } catch { [out] = await run('UTC'); } // unknown time zone name
  return { ...out, totals: out.totals[0] || null };
}

// Raw rows for the CSV export (newest first).
function usageRows({ businesses, since, limit = 50000 }) {
  const match = { at: { $gte: since } };
  if (businesses) match.business = { $in: businesses };
  return col.aiUsage.find(match, HIDE_ID).sort({ at: -1 }).limit(limit).toArray();
}

// ---- API keys, webhooks, idempotency (for other systems) ----
const strip = (d) => { if (d) { d.id = d._id; delete d._id; } return d; };
const createApiKey = (doc) => col.apiKeys.insertOne(doc);
const getApiKey = (hash) => col.apiKeys.findOne({ _id: hash });
const touchApiKey = (hash, now = Date.now()) => col.apiKeys.updateOne({ _id: hash }, { $set: { last_used_at: now } });
async function listApiKeys(business) {
  const docs = await col.apiKeys.find({ business }, { projection: { _id: 1, name: 1, prefix: 1, scopes: 1, created_at: 1, last_used_at: 1 } }).sort({ created_at: -1 }).toArray();
  return docs.map(strip);
}
async function deleteApiKey(business, id) { return (await col.apiKeys.deleteOne({ _id: id, business })).deletedCount > 0; }

const createWebhook = (doc) => col.webhooks.insertOne(doc);
const getWebhook = (business, id) => col.webhooks.findOne({ _id: id, business }).then(strip);
async function listWebhooks(business) {
  return (await col.webhooks.find({ business }, { projection: { secret: 0 } }).sort({ created_at: -1 }).toArray()).map(strip);
}
const activeWebhooks = (business) => col.webhooks.find({ business, active: true }).toArray();
// Count one more failed delivery in a row (atomic: deliveries run side by side); returns the new count.
async function bumpWebhookFailures(id) {
  const doc = await col.webhooks.findOneAndUpdate({ _id: id }, { $inc: { failures: 1 } }, { returnDocument: 'after', projection: { failures: 1 } });
  return doc?.failures || 0;
}
const updateWebhook = (id, set) => col.webhooks.updateOne({ _id: id }, { $set: set });
async function deleteWebhook(business, id) {
  const ok = (await col.webhooks.deleteOne({ _id: id, business })).deletedCount > 0;
  if (ok) await col.webhookDeliveries.deleteMany({ business, webhook: id });
  return ok;
}
const addDelivery = (doc) => col.webhookDeliveries.insertMany(doc);
const claimDelivery = (now) => col.webhookDeliveries.findOneAndUpdate(
  { status: 'pending', next_at: { $lte: now } },
  { $set: { status: 'sending', next_at: now + 120000 } }, // if the server dies mid-send it is picked up again
  { sort: { next_at: 1 }, returnDocument: 'after' },
);
const updateDelivery = (id, set) => col.webhookDeliveries.updateOne({ _id: id }, { $set: set });
const recoverDeliveries = (now) => col.webhookDeliveries.updateMany({ status: 'sending', next_at: { $lte: now } }, { $set: { status: 'pending' } });
async function listDeliveries(business, webhook, limit = 30) {
  return (await col.webhookDeliveries.find({ business, ...(webhook ? { webhook } : {}) }, { projection: { body: 0 } }).sort({ created_at: -1 }).limit(limit).toArray()).map(strip);
}
const getDelivery = (business, id) => col.webhookDeliveries.findOne({ _id: id, business });

// Reserve an Idempotency-Key. Returns null when it is new, or the earlier record.
async function reserveIdem(business, key, now = Date.now()) {
  try {
    await col.apiIdem.insertOne({ business, key, state: 'working', at: new Date(now) });
    return null;
  } catch (e) {
    if (e.code !== 11000) throw e;
    return col.apiIdem.findOne({ business, key });
  }
}
const finishIdem = (business, key, status, response) => col.apiIdem.updateOne({ business, key }, { $set: { state: 'done', status, response } });
const releaseIdem = (business, key) => col.apiIdem.deleteOne({ business, key });

module.exports = {
  createApiKey, getApiKey, touchApiKey, listApiKeys, deleteApiKey,
  createWebhook, getWebhook, listWebhooks, activeWebhooks, updateWebhook, bumpWebhookFailures, deleteWebhook,
  addDelivery, claimDelivery, updateDelivery, recoverDeliveries, listDeliveries, getDelivery,
  reserveIdem, finishIdem, releaseIdem,
  recordUsage, usageReport, usageRows,
  createUser, findUserByEmail, getUser, getSuperAdmin, updateUser, deleteUser, listUsers,
  createAuthSession, getAuthSession, deleteAuthSession, deleteUserSessions,
  listBusinessOwners, getBusinessOwner, assignUnownedBusinesses, reassignBusinesses, setBusinessOwner,
  saveWaMessages, recentWaMessages, getWaMessage, saveWaChats, listWaChats, countWaChats,
  init, close, ORDER_STATUSES, phoneOf,
  getCustomer, touchCustomer, countTurn, saveProfile, listCustomers,
  addOrder, getOrder, listOrders, queryOrders, setOrderStatus,
  addEscalation, setEscalationMessage, getEscalation, escalationByManagerMsg, openEscalations,
  countOpenEscalations, answerEscalation, listEscalations,
  deleteBusiness,
  isReady, loadSettings, saveSettings, deleteSettings, loadChatStates, saveChatState,
  loadChatActivity, saveChatActivity, takeOldChatStates,
  getTranscript, saveTranscript, getCachedImage, saveCachedImage,
  insertLogs, listLogs, TTL_DAYS, addBusiness, listBusinesses,
};
