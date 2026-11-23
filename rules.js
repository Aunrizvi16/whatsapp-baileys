// Per-business auto-reply settings and the logic that decides what (if anything) to reply.
// Stored in MongoDB (collections "settings" and "chat_state"), so every server, on this
// PC or on Railway, sees the same settings. An in-memory copy is loaded at startup and
// kept in sync on every save, so reading settings is instant.
const fs = require('fs');
const path = require('path');
const { PROVIDERS, serverAi } = require('./ai');
const db = require('./db');

const DATA_DIR = path.resolve(process.env.SESSIONS_DIR || './.wwebjs_auth');

const DEFAULTS = {
  enabled: false, // off until the business has written its replies
  mode: 'rules', // 'rules' = fixed welcome/keyword replies, 'ai' = Claude or ChatGPT writes them
  welcome: '', // rules mode: sent on a customer's first message (blank = off)
  welcomeEveryHours: 24, // rules mode: greet the same customer again after this long
  keywords: [], // rules mode: [{ keywords: 'price, rate', reply: '...' }], first match wins
  fallback: '', // rules mode: when no keyword matches. AI mode: when the AI call fails (blank = off)
  repeatAfterMinutes: 30, // don't send the same fixed reply to the same chat more often
  pauseAfterHumanMinutes: 60, // stay quiet in a chat after the owner replies by hand
  contacts: {
    mode: 'all', // 'all' = everyone, 'only' = only the listed chats, 'except' = everyone but the listed chats
    list: [], // [{ id: '923001234567@c.us', name: 'Ali' }]
  },
  ai: {
    provider: 'anthropic',
    model: PROVIDERS.anthropic.defaultModel,
    apiKey: '', // never sent back to the browser
    prompt: '', // about the business: products, prices, delivery, how to order, tone
    historyMessages: 8, // recent chat messages the AI sees (the customer profile covers the rest)
    maxRepliesPerHour: 20, // per chat, caps cost and stops reply loops
    profileEveryTurns: 5, // refresh the customer profile after this many AI replies
    managerNumber: '', // gets questions the AI can't answer, and new-order alerts (blank = off)
    transcribeVoice: true, // turn customers' voice notes into text for the AI (needs an OpenAI key)
    understandImages: true, // show customers' photos to the AI (both Claude and ChatGPT can read images)
    voiceKey: '', // OpenAI key for voice notes; blank = the ChatGPT key above, or the server's OPENAI_API_KEY
  },
};

const LIMITS = { text: 2000, prompt: 20000, keywordRules: 50 };

const settings = new Map(); // business -> saved settings (copy of MongoDB "settings")

// Load everything from MongoDB at startup. Older versions kept settings in files
// (rules-<id>.json, state-<id>.json) and "welcomed" in one map per business; those are
// converted once. Imported files are renamed to *.migrated so they're never imported twice.
async function load() {
  for (const [id, doc] of await db.loadSettings()) settings.set(id, doc);
  for (const doc of await db.loadChatActivity()) {
    const { business, chat_id: chatId, updated_at, ...rest } = doc;
    Object.assign(chat(business, chatId), rest);
  }
  for (const old of await db.takeOldChatStates()) importWelcomed(old._id, old.welcomed);

  if (!fs.existsSync(DATA_DIR)) return;
  for (const file of fs.readdirSync(DATA_DIR)) {
    const m = /^(rules|state)-([a-zA-Z0-9_-]+)\.json$/.exec(file);
    if (!m) continue;
    const [, kind, id] = m;
    const full = path.join(DATA_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (kind === 'rules' && !settings.has(id)) {
        await db.saveSettings(id, data);
        settings.set(id, data);
        console.log(`[${id}] settings moved from file to MongoDB`);
      } else if (kind === 'state') {
        importWelcomed(id, data.welcomed);
      }
      fs.renameSync(full, `${full}.migrated`);
    } catch (e) {
      console.error(`Could not import ${file}:`, e.message);
    }
  }
}

function importWelcomed(id, welcomed = {}) {
  for (const [chatId, at] of Object.entries(welcomed)) {
    const c = chat(id, chatId);
    if ((c.welcomed_at || 0) < at) { c.welcomed_at = at; persistChat(id, chatId); }
  }
}

// Businesses that have saved settings.
const businessIds = () => [...settings.keys()];

function getRules(id) {
  const saved = settings.get(id) || {};
  return {
    ...DEFAULTS,
    ...saved,
    ai: { ...DEFAULTS.ai, ...(saved.ai || {}) },
    contacts: { ...DEFAULTS.contacts, ...(saved.contacts || {}) },
  };
}

// Does this chat get auto-replies under the business's "who gets auto-replies" setting?
function contactAllowed(rules, chatId) {
  const { mode, list } = rules.contacts || DEFAULTS.contacts;
  if (mode === 'all') return true;
  const listed = list.some((c) => c.id === chatId);
  return mode === 'only' ? listed : !listed;
}

const CHAT_ID_RE = /^[\w.-]+@(c\.us|lid)$/;
const MAX_CONTACTS = 500;

function cleanContacts(input = {}) {
  const mode = ['all', 'only', 'except'].includes(input.mode) ? input.mode : 'all';
  const raw = Array.isArray(input.list) ? input.list : [];
  if (raw.length > MAX_CONTACTS) throw badRequest(`Select at most ${MAX_CONTACTS} contacts.`);
  const seen = new Set();
  const list = [];
  for (const c of raw) {
    const id = String(c?.id || '');
    if (!CHAT_ID_RE.test(id)) throw badRequest('One of the selected contacts is not a valid WhatsApp chat.');
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: String(c?.name || '').slice(0, 100) });
  }
  return { mode, list };
}

// What the dashboard sees: the API key is replaced by a hint.
function publicRules(id) {
  const r = getRules(id);
  const { apiKey, voiceKey, ...ai } = r.ai; // keys are never sent to the browser
  const sv = serverAi();
  return {
    ...r,
    ai: { ...ai, provider: sv.provider, model: sv.model },
    // What the server is set up with (env), shown read-only.
    server: { provider: sv.provider, label: sv.label, model: sv.model, aiReady: Boolean(process.env[sv.envKey]), aiEnvKey: sv.envKey, voiceReady: Boolean(process.env.OPENAI_API_KEY) },
  };
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanText(v, field, max = LIMITS.text) {
  const t = String(v ?? '').trim();
  if (t.length > max) throw badRequest(`${field} is too long (max ${max} characters).`);
  return t;
}

function cleanNumber(v, field, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return n;
}

// Validate settings from the dashboard. ai.apiKey: a new key replaces the saved one,
// blank keeps it, ai.clearApiKey removes it.
function cleanRules(id, input = {}) {
  const old = getRules(id);
  const keywords = Array.isArray(input.keywords) ? input.keywords : [];
  if (keywords.length > LIMITS.keywordRules) throw badRequest(`Max ${LIMITS.keywordRules} keyword rules.`);
  const inAi = input.ai || {};
  const sv = serverAi(); // provider and model come from the server's env, not from the dashboard
  const mode = input.mode === 'ai' ? 'ai' : 'rules';

  const rules = {
    enabled: Boolean(input.enabled),
    mode,
    welcome: cleanText(input.welcome, 'Welcome message'),
    welcomeEveryHours: cleanNumber(input.welcomeEveryHours ?? DEFAULTS.welcomeEveryHours, 'Greet again after (hours)', 1, 720),
    keywords: keywords
      .map((k, i) => ({
        keywords: cleanText(k?.keywords, `Keywords in rule ${i + 1}`),
        reply: cleanText(k?.reply, `Reply in rule ${i + 1}`),
      }))
      .filter((k) => k.keywords && k.reply),
    fallback: cleanText(input.fallback, 'Fallback reply'),
    repeatAfterMinutes: cleanNumber(input.repeatAfterMinutes ?? DEFAULTS.repeatAfterMinutes, 'Repeat after (minutes)', 0, 1440),
    pauseAfterHumanMinutes: cleanNumber(input.pauseAfterHumanMinutes ?? DEFAULTS.pauseAfterHumanMinutes, 'Pause after manual reply (minutes)', 0, 1440),
    contacts: cleanContacts(input.contacts),
    ai: {
      provider: sv.provider,
      model: sv.model,
      apiKey: '',
      prompt: cleanText(inAi.prompt, 'AI prompt', LIMITS.prompt),
      historyMessages: cleanNumber(inAi.historyMessages ?? DEFAULTS.ai.historyMessages, 'Messages the AI reads', 1, 50),
      maxRepliesPerHour: cleanNumber(inAi.maxRepliesPerHour ?? DEFAULTS.ai.maxRepliesPerHour, 'Max AI replies per chat per hour', 1, 200),
      profileEveryTurns: cleanNumber(inAi.profileEveryTurns ?? DEFAULTS.ai.profileEveryTurns, 'Update profile every (replies)', 1, 100),
      managerNumber: cleanManager(inAi.managerNumber),
      transcribeVoice: inAi.transcribeVoice ?? old.ai.transcribeVoice,
      understandImages: Boolean(inAi.understandImages ?? old.ai.understandImages),
      voiceKey: '',
    },
  };

  if (rules.enabled && rules.contacts.mode === 'only' && !rules.contacts.list.length) {
    throw badRequest('Pick at least one contact for "Only selected contacts", or choose Everyone.');
  }
  rules.ai.transcribeVoice = Boolean(rules.ai.transcribeVoice);
  if (rules.enabled && mode === 'ai') {
    if (!rules.ai.prompt) throw badRequest('Write the AI prompt (about the business) before turning AI replies on.');
    if (!process.env[sv.envKey]) throw badRequest(`AI replies are not set up on this server yet (missing ${sv.envKey}).`);
  }
  if (rules.enabled && mode === 'rules' && !rules.welcome && !rules.fallback && !rules.keywords.length) {
    throw badRequest('Add at least one reply before turning auto-replies on.');
  }
  return rules;
}

function cleanManager(v) {
  const digits = String(v ?? '').replace(/[\s+()-]/g, '');
  if (!digits) return '';
  if (!/^\d{7,15}$/.test(digits)) throw badRequest('Manager number must include country code, digits only, e.g. 923001234567.');
  return digits;
}

// Validate, update the in-memory copy right away, then save to MongoDB.
async function saveRules(id, input) {
  const clean = cleanRules(id, input);
  const previous = settings.get(id);
  settings.set(id, clean);
  if (db.isReady()) {
    try {
      await db.saveSettings(id, clean);
    } catch (e) {
      previous ? settings.set(id, previous) : settings.delete(id); // keep memory and database in step
      throw Object.assign(new Error(`Could not save settings: ${e.message}`), { status: 503 });
    }
  }
  return publicRules(id);
}

async function deleteRules(id) {
  settings.delete(id);
  activity.delete(id);
  if (db.isReady()) await db.deleteSettings(id);
}

// ---- Per-chat activity (MongoDB "chat_activity", with an in-memory copy) ----
// welcomed_at: last welcome, paused_until: owner is handling the chat until then,
// last_sent: { replyKey: time } for "don't repeat", ai_times: AI replies in the last hour.
const activity = new Map(); // business -> Map(chatId -> record)
const saveTimers = new Map();

function chat(id, chatId) {
  let chats = activity.get(id);
  if (!chats) activity.set(id, (chats = new Map()));
  let c = chats.get(chatId);
  if (!c) chats.set(chatId, (c = { welcomed_at: 0, paused_until: 0, last_sent: {}, ai_times: [] }));
  return c;
}

// Save a chat's record shortly after it changes (several quick changes = one write).
function persistChat(id, chatId) {
  const key = `${id}|${chatId}`;
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    if (!db.isReady()) return;
    db.saveChatActivity(id, chatId, chat(id, chatId)).catch((e) => console.error(`[${id}] chat activity save failed:`, e.message));
  }, 1000));
}

// The owner replied by hand from their phone: let them handle this chat for a while.
function pauseChat(id, chatId, now = Date.now()) {
  const minutes = getRules(id).pauseAfterHumanMinutes;
  if (minutes > 0) {
    chat(id, chatId).paused_until = now + minutes * 60000;
    persistChat(id, chatId);
  }
}

const isPaused = (id, chatId, now = Date.now()) => (chat(id, chatId).paused_until || 0) > now;

function matchKeyword(rules, text) {
  const t = text.toLowerCase();
  for (let i = 0; i < rules.keywords.length; i++) {
    const words = rules.keywords[i].keywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.some((w) => t.includes(w))) return { key: `kw${i}`, reply: rules.keywords[i].reply };
  }
  return null;
}

// Rules mode: returns the list of texts to send for this incoming message (may be empty).
function decideReplies(id, chatId, text, now = Date.now()) {
  const rules = getRules(id);
  if (!rules.enabled || rules.mode !== 'rules' || isPaused(id, chatId, now)) return [];
  const c = chat(id, chatId);

  const out = [];
  const welcomeDue = rules.welcome && now - (c.welcomed_at || 0) > rules.welcomeEveryHours * 3600000;
  if (welcomeDue) {
    out.push(rules.welcome);
    c.welcomed_at = now;
    persistChat(id, chatId);
  }

  const kw = matchKeyword(rules, text);
  if (kw) {
    if (canSendFixed(id, chatId, kw.key, now)) out.push(kw.reply);
  } else if (!welcomeDue && rules.fallback && canSendFixed(id, chatId, 'fallback', now)) {
    // Fallback only when we didn't just greet them, so new customers get one message, not two.
    out.push(rules.fallback);
  }
  return out;
}

// Same fixed reply to the same chat at most once per repeatAfterMinutes. Marks it as sent.
function canSendFixed(id, chatId, key, now = Date.now()) {
  const c = chat(id, chatId);
  if (now - (c.last_sent[key] || 0) < getRules(id).repeatAfterMinutes * 60000) return false;
  c.last_sent[key] = now;
  persistChat(id, chatId);
  return true;
}

// AI mode: is an AI reply allowed for this chat right now? (on, not paused, under the hourly cap)
function aiAllowed(id, chatId, now = Date.now()) {
  const rules = getRules(id);
  if (!rules.enabled || rules.mode !== 'ai' || isPaused(id, chatId, now)) return false;
  const c = chat(id, chatId);
  c.ai_times = (c.ai_times || []).filter((t) => now - t < 3600000);
  return c.ai_times.length < rules.ai.maxRepliesPerHour;
}

function noteAiReply(id, chatId, now = Date.now()) {
  const c = chat(id, chatId);
  c.ai_times = [...(c.ai_times || []).filter((t) => now - t < 3600000), now];
  persistChat(id, chatId);
}

function fillPlaceholders(text, vars) {
  return text.replace(/\{name\}/gi, vars.name || '').replace(/\s+([,.!?])/g, '$1').replace(/ {2,}/g, ' ').trim();
}

// The on/off switch: keeps every other setting as it is and runs the same checks as a full save
// (for example, AI replies can't be turned on without business info).
async function setEnabled(id, enabled) {
  return saveRules(id, { ...getRules(id), enabled: Boolean(enabled) });
}

module.exports = { setEnabled, isPaused,
  load, businessIds, getRules, publicRules, cleanRules, saveRules, deleteRules, decideReplies, canSendFixed,
  aiAllowed, noteAiReply, pauseChat, fillPlaceholders, contactAllowed, DEFAULTS,
};
