// Manages one WhatsApp connection per business, using Baileys: it talks to WhatsApp's
// servers directly, with no browser. Each business gets its own login folder:
// <SESSIONS_DIR>/session-<id>.
//
// The auto-reply part (AI replies, voice notes, photos, manager questions, orders) is the
// same code as the WhatsApp Web version. Underneath, small adapters give it the same
// kind of message and chat objects it had with whatsapp-web.js (see "WhatsApp adapter").
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const rules = require('./rules');
const ai = require('./ai');
// Every AI call is saved with the business it was for, so the Usage page can report on it.
ai.setUsageSink((rec) => { if (db.isReady()) db.recordUsage(rec).catch(() => {}); });
const aiReply = (business, ...args) => ai.withUsage({ business }, () => ai.replyTurn(...args));
const aiProfile = (business, ...args) => ai.withUsage({ business }, () => ai.buildProfile(...args));
const db = require('./db');
const webhooks = require('./webhooks');
const media = require('./media');
const apikeys = require('./apikeys');

const DATA_DIR = path.resolve(process.env.SESSIONS_DIR || './.baileys_auth');
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5);
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_ATTEMPTS = 3;
const START_TIMEOUT_MS = 60000; // still connecting after this: try again (no browser, so it is normally quick)
const LOGIN_TIMEOUT_MS = 90000; // still finishing the login after this: reconnect from the saved login
const AI_WAIT_MS = 6000; // wait for the customer to stop typing before an AI reply

const sessions = new Map(); // id -> session state (see startSession)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCurrent = (s) => !s.removed && sessions.get(s.id) === s;

// "typing..." lasts as long as a quick typist would take to write the reply.
const TYPING_CHARS_PER_SEC = 10;
const TYPING_MIN_MS = 2000;
const TYPING_MAX_MS = 18000;

// A moment to think, then TYPING_CHARS_PER_SEC, give or take 20%, within the min/max.
function typingTimeMs(text) {
  const ms = 1200 + (text.length / TYPING_CHARS_PER_SEC) * 1000;
  return Math.round(Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, ms * (0.8 + Math.random() * 0.4))));
}

// Show "typing..." for as long as typing the reply would take. startedAt: when
// typing began, so time the AI already spent writing counts toward it.
// WhatsApp drops the indicator after ~25s, so it's re-sent every 8s.
async function typeLikeHuman(chat, text, startedAt = Date.now()) {
  const until = startedAt + typingTimeMs(text);
  while (Date.now() < until) {
    await chat.sendStateTyping().catch(() => {});
    await sleep(Math.min(8000, until - Date.now()));
  }
}

function setStatus(s, status, extra = {}) {
  if (s.status !== status) s.since = Date.now();
  s.status = status;
  Object.assign(s, extra);
}

// ---------------------------------------------------------------------------
// Auto-replies
// ---------------------------------------------------------------------------

// Only one-to-one chats: no groups, status updates, broadcasts or channels.
const isPersonalChat = (chatId) => /@(c\.us|lid)$/.test(chatId || '');
const MEDIA_LABEL = {
  image: 'photo', video: 'video', audio: 'audio', ptt: 'voice note', document: 'document',
  sticker: 'sticker', location: 'location', vcard: 'contact card',
};
const REPLY_TO_TYPES = new Set(['chat', ...Object.keys(MEDIA_LABEL)]);

async function handleMessage(s, msg) {
  if (msg.fromMe || msg.isStatus || !isPersonalChat(msg.from) || !REPLY_TO_TYPES.has(msg.type)) return;
  const r = rules.getRules(s.id);
  if (!r.enabled) return;
  // Server-wide off switch (e.g. a second copy started only to log numbers out).
  if (process.env.AUTO_REPLY === 'off') return;
  // Optional: only these businesses reply on this server (comma-separated ids), so a
  // number linked on two servers doesn't answer twice.
  const only = (process.env.AUTO_REPLY_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (only.length && !only.includes(s.id)) return;
  // The manager's chat never gets auto-replies: their messages are answers to pass on.
  if (r.mode === 'ai' && r.ai.managerNumber && await isFromManager(msg, r.ai.managerNumber)) return handleManagerMessage(s, msg, r);
  // "Who gets auto-replies": everyone, only selected contacts, or everyone except selected.
  if (!rules.contactAllowed(r, msg.from)) {
    console.log(`[${s.id}] no auto-reply to ${msg.from}: not allowed by "Who gets auto-replies"`);
    return;
  }
  if (r.mode === 'ai') return queueAiReply(s, msg);

  const texts = rules.decideReplies(s.id, msg.from, msg.body || '');
  if (!texts.length) return;
  const chat = await msg.getChat();
  const name = msg._data?.notifyName || '';
  for (const text of texts) {
    const body = rules.fillPlaceholders(text, { name });
    await typeLikeHuman(chat, body);
    markBotSending(s, msg.from, body);
    await chat.sendMessage(body);
  }
  await chat.clearState().catch(() => {});
  console.log(`[${s.id}] auto-replied ${texts.length}x to ${msg.from}`);
}

// AI mode: customers often send several short messages in a row. Wait until they
// pause, then answer everything at once with one reply.
function queueAiReply(s, msg) {
  const chatId = msg.from;
  if (!rules.aiAllowed(s.id, chatId)) {
    console.log(`[${s.id}] no auto-reply to ${chatId}: ${rules.isPaused(s.id, chatId) ? 'paused because a person replied from the phone' : 'hourly reply limit reached'}`);
    return;
  }
  const p = s.aiChats.get(chatId) || {};
  p.name = msg._data?.notifyName || p.name || '';
  clearTimeout(p.timer);
  if (p.running) p.again = true; // a reply is being written; go again after it
  else p.timer = setTimeout(() => runAiReply(s, chatId), AI_WAIT_MS);
  s.aiChats.set(chatId, p);
}

async function runAiReply(s, chatId) {
  const p = s.aiChats.get(chatId);
  if (!p || !isCurrent(s) || s.status !== 'ready') return;
  p.running = true;
  let chat;
  try {
    const r = rules.getRules(s.id);
    if (!rules.aiAllowed(s.id, chatId)) return;
    chat = await s.client.getChatById(chatId);
    const history = await recentHistory(s, r, chat);
    if (history.at(-1)?.role !== 'user') return; // someone already answered

    const typingFrom = Date.now();
    await chat.sendStateTyping().catch(() => {});
    const customer = await db.touchCustomer(s.id, chatId, { name: p.name });
    const profile = customer.profile || await firstProfile(s, r, chat, chatId, history.length);

    let out = null;
    try {
      out = await aiReply(s.id, r.ai, history, {
        customerName: p.name,
        profile: hasContent(profile) ? profile : null,
        orders: await db.listOrders(s.id, { chatId, limit: 5 }),
        waiting: await db.openEscalations(s.id, chatId),
      });
      s.aiError = null;
    } catch (e) {
      s.aiError = e.message;
      console.error(`[${s.id}] AI reply failed:`, e.message);
    }

    let reply = out?.reply?.trim();
    if (!reply) {
      // AI failed or declined: send the business's fallback text, if any (not repeatedly).
      if (!r.fallback || !rules.canSendFixed(s.id, chatId, 'fallback')) return;
      reply = rules.fillPlaceholders(r.fallback, { name: p.name });
    }
    // The owner may have replied by hand while the AI was writing.
    if (!rules.aiAllowed(s.id, chatId) || !isCurrent(s)) return;
    await typeLikeHuman(chat, reply, typingFrom);
    // Check again: the owner may have jumped in while "typing..." showed.
    if (!rules.aiAllowed(s.id, chatId) || !isCurrent(s)) return;
    markBotSending(s, chatId, reply);
    await chat.sendMessage(reply);
    rules.noteAiReply(s.id, chatId);
    await db.countTurn(s.id, chatId);
    console.log(`[${s.id}] AI replied to ${chatId}`);

    if (out) await afterReply(s, r, chatId, p.name, out);
  } catch (e) {
    console.error(`[${s.id}] AI reply to ${chatId} failed:`, e.message);
  } finally {
    if (chat) chat.clearState().catch(() => {});
    p.running = false;
    if (p.again && isCurrent(s)) {
      p.again = false;
      p.timer = setTimeout(() => runAiReply(s, chatId), AI_WAIT_MS);
    } else {
      s.aiChats.delete(chatId);
    }
  }
}

const hasContent = (profile) => profile && Object.values(profile).some((v) => (Array.isArray(v) ? v.length : v));
const PROFILE_FULL_READ = 300; // messages read once, the first time the AI meets a customer
const PROFILE_REFRESH_READ = 40; // messages read when updating a profile later

// First AI reply to this customer: if they have older chat history, read all of it
// once and write a profile, so later replies only need the last few messages.
async function firstProfile(s, r, chat, chatId, recentCount) {
  let profile = {};
  try {
    const full = toHistory(await chat.fetchMessages({ limit: PROFILE_FULL_READ }));
    if (full.length > recentCount) {
      profile = (await aiProfile(s.id, r.ai, full, null)) || {};
      console.log(`[${s.id}] built profile for ${chatId} from ${full.length} chat turns`);
    }
  } catch (e) {
    console.error(`[${s.id}] profile build failed:`, e.message);
  }
  await db.saveProfile(s.id, chatId, profile); // {} = "seen"; it fills in on the next refresh
  return profile;
}

// Update the profile in the background: every few replies, and right after an order or complaint.
async function refreshProfile(s, r, chatId) {
  const key = `profile:${chatId}`;
  if (s.busy.has(key)) return;
  s.busy.add(key);
  try {
    const chat = await s.client.getChatById(chatId);
    const transcript = toHistory(await chat.fetchMessages({ limit: PROFILE_REFRESH_READ }), s.transcripts);
    const current = (await db.getCustomer(s.id, chatId))?.profile;
    const profile = await aiProfile(s.id, r.ai, transcript, hasContent(current) ? current : null);
    if (profile) await db.saveProfile(s.id, chatId, profile);
  } catch (e) {
    console.error(`[${s.id}] profile refresh failed:`, e.message);
  } finally {
    s.busy.delete(key);
  }
}

// Act on the structured parts of an AI reply: orders, manager questions, profile updates.
async function afterReply(s, r, chatId, customerName, out) {
  const name = out.order?.customer_name || customerName || (await db.getCustomer(s.id, chatId))?.name || 'a customer';
  const phone = db.phoneOf(chatId);

  if (out.order_confirmed && out.order?.items?.length) {
    const order = await db.addOrder(s.id, chatId, out.order);
    console.log(`[${s.id}] order #${order.id} recorded for ${chatId}`);
    webhooks.emit(s.id, 'order.created', orderEvent(order));
    if (r.ai.managerNumber) {
      const lines = order.items.map((i) => `- ${i.quantity} x ${i.name}${i.price ? ` (${i.price})` : ''}`).join('\n');
      const text = `New order #${order.id} from ${name}${phone ? ` (+${phone})` : ''}\n${lines}\nTotal: ${order.total ?? '?'}\nAddress: ${order.address || '-'}${order.notes ? `\nNotes: ${order.notes}` : ''}`;
      await sendToNumber(s, r.ai.managerNumber, text).catch((e) => { s.aiError = `Could not alert the manager: ${e.message}`; });
    }
  }

  if (out.escalate_to_manager && out.manager_question?.trim()) {
    const id = await db.addEscalation(s.id, chatId, name, out.manager_question.trim());
    console.log(`[${s.id}] question #${id} for the manager from ${chatId}`);
    webhooks.emit(s.id, 'question.created', { id, chat_id: chatId, phone, customer_name: name, question: out.manager_question.trim() });
    if (r.ai.managerNumber) {
      const text = `Question #${id} from ${name}${phone ? ` (+${phone})` : ''}:\n${out.manager_question.trim()}\n\nReply to this message with the answer and I'll pass it on to the customer.`;
      try {
        const sent = await sendToNumber(s, r.ai.managerNumber, text);
        await db.setEscalationMessage(s.id, id, sent.id._serialized);
      } catch (e) {
        s.aiError = `Could not message the manager: ${e.message}`;
      }
    }
  }

  const turns = (await db.getCustomer(s.id, chatId))?.turns_since_profile || 0;
  if (out.order_confirmed || out.complaint || turns >= r.ai.profileEveryTurns) refreshProfile(s, r, chatId);
}

async function sendToNumber(s, number, text) {
  const numberId = await s.client.getNumberId(number);
  if (!numberId) throw new Error(`+${number} is not on WhatsApp.`);
  return s.client.sendMessage(numberId._serialized, text);
}

async function isFromManager(msg, number) {
  if (msg.from === `${number}@c.us`) return true;
  if (!msg.from.endsWith('@lid')) return false; // newer WhatsApp ids hide the number; ask the contact
  const contact = await msg.getContact().catch(() => null);
  return contact?.number === number;
}

// The manager replied. Find which question it answers, have the AI pass the answer
// on to the customer, and confirm back to the manager.
async function handleManagerMessage(s, msg, r) {
  const text = (msg.body || '').trim();
  if (!text) return;
  let esc = null;
  if (msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    if (quoted) esc = await db.escalationByManagerMsg(s.id, quoted.id._serialized);
  }
  const tag = /#(\d+)/.exec(text);
  if (!esc && tag) esc = await db.getEscalation(s.id, Number(tag[1]));
  const open = await db.openEscalations(s.id);
  if (!esc && open.length === 1) esc = open[0];
  if (!esc) {
    if (open.length) {
      await msg.reply(`There are ${open.length} questions waiting. Swipe right on the question you're answering and reply to it, or start with its number, e.g. "#${open[0].id} yes, available".`);
    }
    return; // no open questions: a normal chat with the manager, ignore
  }
  if (esc.status !== 'open') {
    await msg.reply(`Question #${esc.id} was already answered.`);
    return;
  }

  const answer = text.replace(/#\d+\s*/, '').trim();
  try {
    const sentText = await answerCustomer(s, r, esc, answer);
    await msg.reply(`Sent to ${esc.customer_name || 'the customer'}:\n${sentText}`);
  } catch (e) {
    console.error(`[${s.id}] passing on answer #${esc.id} failed:`, e.message);
    await msg.reply(`Couldn't send the answer to the customer: ${e.message}`);
  }
}

// Pass an answer to a waiting question on to the customer. polish: let the AI rewrite
// it in the business's tone and the customer's language; false sends it word for word.
// Used for the manager's WhatsApp replies and for answers typed on the dashboard.
async function answerCustomer(s, r, esc, answer, { polish = true } = {}) {
  // One answer per question, even if the manager and the dashboard answer at the same time.
  const lock = `question:${esc.id}`;
  if (s.busy.has(lock)) throw httpError(409, `Question #${esc.id} is already being answered.`);
  s.busy.add(lock);
  try {
    const fresh = await db.getEscalation(s.id, esc.id);
    if (fresh?.status !== 'open') throw httpError(409, `Question #${esc.id} was already answered.`);

    const chat = await s.client.getChatById(esc.chat_id);
    const typingFrom = Date.now();
    await chat.sendStateTyping().catch(() => {});

    let reply = null;
    if (polish) {
      const history = await recentHistory(s, r, chat);
      // The chat usually ends with our "checking with the team" message; the AI needs a
      // customer turn last, so add a note telling it what to do.
      if (history.at(-1)?.role !== 'user') history.push({ role: 'user', text: '[The team has replied to my question. Please tell me their answer.]' });
      const customer = await db.getCustomer(s.id, esc.chat_id);
      try {
        const out = await aiReply(s.id, r.ai, history, {
          customerName: customer?.name,
          profile: hasContent(customer?.profile) ? customer.profile : null,
          orders: await db.listOrders(s.id, { chatId: esc.chat_id, limit: 5 }),
          waiting: [],
          managerAnswer: { question: esc.question, answer },
        });
        reply = out?.reply?.trim();
      } catch (e) {
        s.aiError = e.message;
      }
    }
    if (!reply) reply = answer; // word for word, or the AI was unavailable

    await typeLikeHuman(chat, reply, typingFrom);
    markBotSending(s, esc.chat_id, reply);
    await chat.sendMessage(reply);
    await chat.clearState().catch(() => {});
    await db.answerEscalation(s.id, esc.id, answer, reply);
    console.log(`[${s.id}] passed answer #${esc.id} to ${esc.chat_id}${polish ? '' : ' (as written)'}`);
    return reply;
  } finally {
    s.busy.delete(lock);
  }
}

// Answer a waiting question from the dashboard.
async function answerQuestion(id, questionId, answer, { polish = true } = {}) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  if (s.status !== 'ready') throw httpError(409, 'This WhatsApp number is not connected right now, so the answer can\'t be sent.');
  const text = String(answer || '').trim();
  if (!text) throw httpError(400, 'Type an answer first.');
  if (text.length > 2000) throw httpError(400, 'Answer is too long (max 2000 characters).');
  const esc = await db.getEscalation(id, Number(questionId));
  if (!esc) throw httpError(404, 'Question not found.');
  const sent = await answerCustomer(s, rules.getRules(id), esc, text, { polish: polish !== false });
  return { sent };
}

const VOICE_TYPES = new Set(['ptt', 'audio']);
const VOICE_MAX_SECONDS = 300; // longer voice notes aren't transcribed
const TRANSCRIPT_CACHE_MAX = 3000;

// Recent chat for the AI, with customers' voice notes turned into text and their
// photos attached as images.
async function recentHistory(s, r, chat) {
  const msgs = await chat.fetchMessages({ limit: r.ai.historyMessages });
  if (r.ai.transcribeVoice) await transcribeVoiceNotes(s, r, msgs);
  const images = r.ai.understandImages ? await loadCustomerImages(s, msgs) : new Map();
  return toHistory(msgs, s.transcripts, images);
}

const IMAGES_PER_REPLY = 3; // only the most recent customer photos are shown to the AI
const IMAGE_MAX_BYTES = 4.5 * 1024 * 1024; // the AI services reject images over ~5 MB
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_CACHE_MAX = 40; // per WhatsApp number, so photos aren't re-downloaded every reply

// Download the customer's most recent photos in this window (cached). Returns id -> { mime, data }.
async function loadCustomerImages(s, msgs) {
  s.images ||= new Map();
  const wanted = msgs.filter((m) => m.type === 'image' && !m.fromMe && m.id?._serialized).slice(-IMAGES_PER_REPLY);
  const out = new Map();
  for (const m of wanted) {
    const id = m.id._serialized;
    if (!s.images.has(id)) {
      // Saved in MongoDB already (maybe before a restart)? Use that instead of downloading.
      let img = db.isReady() ? await db.getCachedImage(s.id, id).catch(() => undefined) : undefined;
      if (img === undefined) {
        img = null;
        try {
          const media = await m.downloadMedia();
          const mime = (media?.mimetype || '').split(';')[0].trim();
          const bytes = media?.data ? Math.floor(media.data.length * 0.75) : 0;
          if (IMAGE_TYPES.has(mime) && bytes && bytes <= IMAGE_MAX_BYTES) img = { mime, data: media.data };
        } catch (e) {
          console.error(`[${s.id}] photo not downloaded:`, e.message);
          continue; // try again next reply
        }
        // null = unusable (too big, wrong type, expired); remembered so it isn't retried
        if (db.isReady()) await db.saveCachedImage(s.id, id, img).catch((e) => console.error(`[${s.id}] photo not saved:`, e.message));
      }
      s.images.set(id, img);
      if (s.images.size > IMAGE_CACHE_MAX) s.images.delete(s.images.keys().next().value);
    }
    if (s.images.get(id)) out.set(id, s.images.get(id));
  }
  return out;
}

// Each voice note is transcribed once; the text is cached so later replies reuse it.
async function transcribeVoiceNotes(s, r, msgs) {
  for (const m of msgs) {
    const id = m.id?._serialized;
    if (!VOICE_TYPES.has(m.type) || m.fromMe || !id || s.transcripts.has(id)) continue;
    if (Number(m.duration) > VOICE_MAX_SECONDS) { s.transcripts.set(id, ''); continue; }
    try {
      // Transcribed before (maybe before a restart)? Use the saved text.
      const saved = db.isReady() ? await db.getTranscript(s.id, id) : undefined;
      if (saved !== undefined) { s.transcripts.set(id, saved); continue; }
      const media = await m.downloadMedia();
      if (!media?.data) continue;
      const text = await ai.withUsage({ business: s.id }, () => ai.transcribe(r.ai, media));
      s.transcripts.set(id, text || '');
      if (db.isReady()) await db.saveTranscript(s.id, id, m.from, text || '');
      console.log(`[${s.id}] transcribed a ${m.duration || '?'}s voice note`);
    } catch (e) {
      s.aiError = e.message;
      console.error(`[${s.id}] voice note not transcribed:`, e.message);
      return; // likely a key or billing problem: don't try the rest now
    }
    if (s.transcripts.size > TRANSCRIPT_CACHE_MAX) s.transcripts.delete(s.transcripts.keys().next().value);
  }
}

// WhatsApp messages -> [{ role, text, images? }] for the AI, oldest first, starting with
// the customer. images: customer photos to attach, id -> { mime, data }.
function toHistory(msgs, transcripts = new Map(), images = new Map()) {
  const out = [];
  for (const m of msgs) {
    if (!REPLY_TO_TYPES.has(m.type)) continue;
    const id = m.id?._serialized;
    let text = m.type === 'chat' ? (m.body || '').trim() : (m._data?.caption || '').trim();
    // Voice notes: use the transcript if we have one.
    if (VOICE_TYPES.has(m.type) && !text) text = transcripts.get(id) || '';
    // Photos: say whether the image itself is attached, so the AI knows if it can look.
    const image = m.type === 'image' ? images.get(id) : null;
    if (m.type === 'image') text = `[photo${image ? ', attached' : ''}]${text ? ` ${text}` : ''}`;
    else if (m.type !== 'chat') text = `[${MEDIA_LABEL[m.type]}]${text ? ` ${text}` : ''}`;
    if (!text) continue;
    const role = m.fromMe ? 'assistant' : 'user';
    let last = out.at(-1);
    if (last?.role === role) last.text += `\n${text}`;
    else out.push(last = { role, text });
    if (image) (last.images ||= []).push(image);
  }
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

// Remember what the bot is sending, so 'message_create' can tell bot replies
// apart from the owner typing on their phone.
function markBotSending(s, chatId, body) {
  const key = `${chatId}|${body}`;
  s.botSending.set(key, (s.botSending.get(key) || 0) + 1);
  setTimeout(() => {
    const n = (s.botSending.get(key) || 1) - 1;
    n > 0 ? s.botSending.set(key, n) : s.botSending.delete(key);
  }, 60000);
}

function onOwnMessage(s, msg) {
  if (!msg.fromMe || !isPersonalChat(msg.to)) return;
  if (s.apiSent.has(msg.id._serialized)) return; // sent by another system through the API
  const key = `${msg.to}|${msg.body}`;
  const n = s.botSending.get(key) || 0;
  if (n > 0) {
    n > 1 ? s.botSending.set(key, n - 1) : s.botSending.delete(key);
    return; // the bot's own reply
  }
  rules.pauseChat(s.id, msg.to); // the owner replied by hand: bot stays out of this chat for a while
}

// ---------------------------------------------------------------------------
// WhatsApp adapter: Baileys underneath, whatsapp-web.js-style objects on top
// ---------------------------------------------------------------------------

// Baileys is an ES module; load it once.
let baileysLib;
const baileys = async () => (baileysLib ||= await import('baileys'));
const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });

// Chat ids are kept in the WhatsApp Web style the rest of the app (and saved settings)
// use: "<number>@c.us" for phone numbers, "<id>@lid" for hidden-number ids.
const toAppId = (jid) => (jid || '').replace(/@s\.whatsapp\.net$/, '@c.us');
const toWaJid = (id) => (id || '').replace(/@c\.us$/, '@s.whatsapp.net');
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 14); // older history from the phone is skipped
const HISTORY_PER_CHAT = 60; // at most this many messages per chat are kept from the phone's history
const MEMORY_PER_CHAT = 40; // recent messages kept in memory per chat (the rest is in MongoDB)
const REPLY_MAX_AGE_S = 600; // messages older than this (arrived while offline) get no auto-reply

// One chat id per person: if WhatsApp gives a hidden-number id (@lid) and we know the
// phone number, use the phone number. That keeps one chat per customer and lets orders
// show the phone.
async function appChatId(s, key) {
  const B = await baileys();
  let jid = B.jidNormalizedUser(key.remoteJid || '');
  if (B.isLidUser(jid)) {
    const alt = key.remoteJidAlt && B.jidNormalizedUser(key.remoteJidAlt);
    const pn = (alt && B.isPnUser(alt) ? alt : null) || await pnForLid(s, jid);
    if (pn) jid = pn;
  }
  return toAppId(jid);
}

async function pnForLid(s, lid) {
  if (s.lidToPn.has(lid)) return s.lidToPn.get(lid);
  let pn = null;
  try { pn = await s.sock?.signalRepository?.lidMapping?.getPNForLID(lid); } catch {}
  if (pn) pn = (await baileys()).jidNormalizedUser(pn);
  if (pn) s.lidToPn.set(lid, pn); // unknown ones are asked again next time
  return pn || null;
}

// Baileys message content -> the WhatsApp Web message type names the app uses.
function readContent(B, message) {
  const content = B.normalizeMessageContent(message);
  if (!content) return null;
  const kind = B.getContentType(content);
  const m = kind ? content[kind] : null;
  if (m === null || m === undefined) return null;
  const ctx = m.contextInfo || null;
  switch (kind) {
    case 'conversation': return { type: 'chat', body: content.conversation || '' };
    case 'extendedTextMessage': return { type: 'chat', body: m.text || '', ctx };
    case 'imageMessage': return { type: 'image', caption: m.caption || '', mimetype: m.mimetype, ctx };
    case 'audioMessage': return { type: m.ptt ? 'ptt' : 'audio', duration: m.seconds || 0, mimetype: m.mimetype, ctx };
    case 'videoMessage': case 'ptvMessage': return { type: 'video', caption: m.caption || '', mimetype: m.mimetype, ctx };
    case 'documentMessage': return { type: 'document', caption: m.caption || m.fileName || '', mimetype: m.mimetype, ctx };
    case 'stickerMessage': return { type: 'sticker', mimetype: m.mimetype, ctx };
    case 'locationMessage': case 'liveLocationMessage': return { type: 'location', caption: m.name || m.address || '', ctx };
    case 'contactMessage': case 'contactsArrayMessage': return { type: 'vcard', caption: m.displayName || '', ctx };
    default: return null; // reactions, edits, deletes, protocol messages: not chat turns
  }
}

const MEDIA_TYPES = new Set(['image', 'audio', 'ptt', 'video', 'document', 'sticker']);
const STATUS_TO_ACK = { 0: -1, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 }; // Baileys status -> WhatsApp Web ack

// A raw Baileys message -> the stored form (MongoDB). Only one-to-one chats are kept.
async function toRecord(s, raw) {
  const B = await baileys();
  if (!raw?.key?.id || !raw.message) return null;
  const remote = raw.key.remoteJid || '';
  if (remote === 'status@broadcast' || B.isJidGroup(remote) || remote.endsWith('@newsletter') || remote.endsWith('@broadcast')) return null;
  const c = readContent(B, raw.message);
  if (!c) return null;
  const chatId = await appChatId(s, raw.key);
  const rec = {
    msg_id: raw.key.id, chat_id: chatId, from_me: !!raw.key.fromMe,
    ts: Number(raw.messageTimestamp || 0) || Math.floor(Date.now() / 1000),
    // Exact order: WhatsApp times are whole seconds, so a reply and the next customer
    // message can share one. Live messages use the time we saw them, in milliseconds.
    order: 0,
    type: c.type, body: c.body || '', caption: c.caption || '', duration: c.duration || 0,
    mimetype: c.mimetype || null, push_name: raw.pushName || null,
    quoted_id: c.ctx?.stanzaId || null,
  };
  rec.order = Date.now() / 1000 - rec.ts < 120 ? Date.now() : rec.ts * 1000;
  if (MEDIA_TYPES.has(c.type)) {
    // Keep what's needed to download the media later, minus the preview picture.
    const slim = JSON.parse(JSON.stringify(raw, B.BufferJSON.replacer));
    stripThumbnails(slim);
    rec.raw = JSON.stringify(slim);
  }
  return rec;
}

function stripThumbnails(o) {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    if (/^(jpegThumbnail|thumbnailDirectPath|thumbnailSha256|thumbnailEncSha256)$/.test(k)) delete o[k];
    else stripThumbnails(o[k]);
  }
}

// Stored record -> the message object the auto-reply code expects (whatsapp-web.js style).
function toMessage(s, rec) {
  const chatId = rec.chat_id;
  const me = s.me?.number ? `${s.me.number}@c.us` : '';
  return {
    id: { _serialized: rec.msg_id },
    fromMe: rec.from_me,
    from: rec.from_me ? me : chatId,
    to: rec.from_me ? chatId : me,
    isStatus: false,
    type: rec.type,
    body: rec.type === 'chat' ? rec.body : rec.caption,
    duration: rec.duration,
    timestamp: rec.ts,
    _data: { notifyName: rec.push_name || '', caption: rec.caption },
    hasQuotedMsg: !!rec.quoted_id,
    getQuotedMessage: async () => (rec.quoted_id ? { id: { _serialized: rec.quoted_id } } : null),
    getContact: async () => contactOf(s, chatId),
    getChat: async () => s.client.getChatById(chatId),
    reply: (text) => s.client.sendMessage(chatId, text, { quotedId: rec.msg_id }),
    downloadMedia: () => downloadMedia(s, rec),
  };
}

async function contactOf(s, chatId) {
  if (chatId.endsWith('@c.us')) return { number: chatId.split('@')[0] };
  const pn = await pnForLid(s, toWaJid(chatId));
  return { number: pn ? pn.split('@')[0] : null };
}

// Test hook: replaces the media download (automated tests have no real WhatsApp).
let downloader = null;

async function downloadMedia(s, rec) {
  if (downloader) return downloader(s, rec);
  const B = await baileys();
  let raw = rec.raw;
  if (!raw && db.isReady()) raw = (await db.getWaMessage(s.id, rec.msg_id))?.raw;
  if (!raw) throw new Error('media details not available for this message');
  const msg = JSON.parse(raw, B.BufferJSON.reviver);
  const buf = await B.downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: s.sock.updateMediaMessage });
  return { mimetype: rec.mimetype || 'application/octet-stream', data: Buffer.from(buf).toString('base64'), filename: null };
}

const byOrder = (a, b) => (a.order || a.ts * 1000) - (b.order || b.ts * 1000);

// Remember messages: a few per chat in memory, all in MongoDB (kept MESSAGE_RETENTION_DAYS).
async function remember(s, recs) {
  for (const r of recs) {
    const list = s.recent.get(r.chat_id) || [];
    if (list.some((x) => x.msg_id === r.msg_id)) continue;
    list.push(r);
    list.sort(byOrder);
    if (list.length > MEMORY_PER_CHAT) list.splice(0, list.length - MEMORY_PER_CHAT);
    s.recent.set(r.chat_id, list);
  }
  if (!db.isReady() || !recs.length) return;
  await db.saveWaMessages(s.id, recs).catch((e) => console.error(`[${s.id}] messages not saved:`, e.message));
  const chats = new Map();
  for (const r of recs) {
    const c = chats.get(r.chat_id) || { chat_id: r.chat_id, is_group: false, t: 0 };
    c.t = Math.max(c.t, r.ts);
    const name = s.names.get(r.chat_id) || (!r.from_me && r.push_name) || null;
    if (name) c.name = name;
    chats.set(r.chat_id, c);
  }
  await db.saveWaChats(s.id, [...chats.values()]).catch(() => {});
}

// Newest `limit` messages of a chat, oldest first, as app message objects.
async function fetchMessages(s, chatId, limit) {
  let recs = s.recent.get(chatId) || [];
  if (recs.length < limit && db.isReady()) {
    const stored = await db.recentWaMessages(s.id, chatId, limit);
    const seen = new Set(stored.map((r) => r.msg_id));
    recs = [...stored, ...recs.filter((r) => !seen.has(r.msg_id))].sort(byOrder);
  }
  return recs.slice(-limit).map((r) => toMessage(s, r));
}

// The `client` the auto-reply code talks to (the same calls it made on whatsapp-web.js).
function makeClient(s) {
  const chat = (chatId) => ({
    id: { _serialized: chatId },
    sendStateTyping: () => s.sock.sendPresenceUpdate('composing', toWaJid(chatId)),
    clearState: () => s.sock.sendPresenceUpdate('paused', toWaJid(chatId)),
    sendMessage: (text) => s.client.sendMessage(chatId, text),
    fetchMessages: ({ limit = 50 } = {}) => fetchMessages(s, chatId, limit),
  });
  return {
    getChatById: async (chatId) => chat(chatId),
    getNumberId: async (number) => {
      const [hit] = (await s.sock.onWhatsApp(String(number))) || [];
      return hit?.exists ? { _serialized: toAppId((await baileys()).jidNormalizedUser(hit.jid)) } : null;
    },
    sendMessage: async (chatId, text, { quotedId } = {}) => {
      let quoted;
      if (quotedId) {
        const q = (s.recent.get(chatId) || []).find((r) => r.msg_id === quotedId);
        if (q) quoted = { key: { remoteJid: toWaJid(chatId), id: q.msg_id, fromMe: q.from_me }, message: { conversation: q.body || q.caption || '' } };
      }
      const sent = await s.sock.sendMessage(toWaJid(chatId), { text }, quoted ? { quoted } : {});
      const id = sent?.key?.id;
      if (id) s.acks.set(id, STATUS_TO_ACK[sent.status] ?? 0);
      const rec = sent && await toRecord(s, sent);
      if (rec) {
        rec.chat_id = chatId; // keep the chat id we were asked to use
        await remember(s, [rec]);
      }
      return { id: { _serialized: id }, ack: s.acks.get(id) ?? 0 };
    },
    getMessageById: async (id) => ({ id: { _serialized: id }, ack: s.acks.get(id) ?? 0 }),
  };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function sessionDir(id) {
  return path.join(DATA_DIR, `session-${id}`);
}

// WhatsApp's current protocol version, looked up once (Baileys' built-in one can lag).
let waVersion;
async function latestVersion(B) {
  if (waVersion !== undefined) return waVersion;
  try {
    const v = await Promise.race([B.fetchLatestBaileysVersion(), sleep(10000).then(() => null)]);
    waVersion = v?.version || null;
  } catch {
    waVersion = null;
  }
  return waVersion;
}

// Test hook: tests pass a fake socket factory (no real WhatsApp).
let socketFactory = null;

async function connect(s) {
  const B = await baileys();
  let sock;
  if (socketFactory) {
    sock = socketFactory(s);
  } else {
    fs.mkdirSync(sessionDir(s.id), { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(sessionDir(s.id));
    const version = await latestVersion(B);
    if (!isCurrent(s)) return;
    sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: B.Browsers.macOS('Chrome'), // how the device is listed under "Linked devices"
      markOnlineOnConnect: false, // so the phone keeps getting notifications
      syncFullHistory: false, // only the phone's recent history, not everything
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      // WhatsApp asks for a message again when the recipient couldn't decrypt it.
      getMessage: async (key) => {
        const rec = (s.recent.get(await appChatId(s, key)) || []).find((r) => r.msg_id === key.id);
        return rec ? { conversation: rec.body || rec.caption || '' } : undefined;
      },
    });
    sock.ev.on('creds.update', saveCreds);
  }
  if (!isCurrent(s)) { try { sock.end(undefined); } catch {} return; }
  s.sock = sock;
  attachEvents(s, sock);
}

function attachEvents(s, sock) {
  const { id } = s;
  const live = () => isCurrent(s) && s.sock === sock;

  sock.ev.on('connection.update', (u) => {
    if (!live()) return;
    onConnection(s, sock, u).catch((e) => console.error(`[${id}] connection update failed:`, e.message));
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!live()) return;
    const recs = [];
    for (const raw of messages || []) {
      try {
        const rec = await toRecord(s, raw);
        if (rec) recs.push(rec);
      } catch (e) {
        console.error(`[${id}] could not read a message:`, e.message);
      }
    }
    await remember(s, recs);
    const now = Date.now() / 1000;
    for (const rec of recs) {
      const msg = toMessage(s, rec);
      const fresh = now - rec.ts < REPLY_MAX_AGE_S;
      if (fresh && isPersonalChat(rec.chat_id) && (rec.from_me || type === 'notify')) {
        if (!(rec.from_me && s.apiSent.has(rec.msg_id))) { // API sends announce themselves
          webhooks.emit(id, rec.from_me ? 'message.sent' : 'message.received', eventMessage({ ...rec, business: id }), { key: rec.msg_id });
        }
      }
      if (rec.from_me) {
        // Sent from the phone (or by the bot): same handling as WhatsApp Web's message_create.
        if (fresh) { try { onOwnMessage(s, msg); } catch {} }
      } else if (type === 'notify' && fresh) {
        handleMessage(s, msg).catch((e) => console.error(`[${id}] auto-reply failed:`, e.message));
      }
    }
  });

  // Delivery ticks for messages we sent.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates || []) {
      if (u.key?.fromMe && u.update?.status !== undefined && u.update.status !== null) {
        const ack = STATUS_TO_ACK[u.update.status];
        if (ack !== undefined && ack > (s.acks.get(u.key.id) ?? -2)) {
          s.acks.set(u.key.id, ack);
          const chat = toAppId(u.key.remoteJid || '');
          if (isPersonalChat(chat)) webhooks.emit(id, 'message.status', { id: u.key.id, chat_id: chat, phone: db.phoneOf(chat), status: ACK_API[ack] || String(ack) }, { key: `${u.key.id}|${ack}` });
        }
      }
    }
    if (s.acks.size > 2000) s.acks.delete(s.acks.keys().next().value);
  });

  // The phone's recent history, sent once after linking. Only a small part is kept:
  // one-to-one chats from the last HISTORY_DAYS days, at most HISTORY_PER_CHAT messages each.
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings }) => {
    if (!live()) return;
    try {
      for (const m of lidPnMappings || []) if (m?.lid && m?.pn) s.lidToPn.set(m.lid, m.pn);
      noteContacts(s, contacts || []);
      const since = Date.now() / 1000 - HISTORY_DAYS * 86400;
      const byChat = new Map();
      for (const raw of messages || []) {
        if (Number(raw.messageTimestamp || 0) < since) continue;
        const rec = await toRecord(s, raw).catch(() => null);
        if (!rec) continue;
        const list = byChat.get(rec.chat_id) || [];
        list.push(rec);
        byChat.set(rec.chat_id, list);
      }
      const recs = [];
      for (const list of byChat.values()) recs.push(...list.sort(byOrder).slice(-HISTORY_PER_CHAT));
      await remember(s, recs);
      await saveChatList(s, chats || []);
      if (recs.length) console.log(`[${id}] kept ${recs.length} recent messages from ${byChat.size} chats of the phone's history`);
    } catch (e) {
      console.error(`[${id}] history not saved:`, e.message);
    }
  });

  sock.ev.on('contacts.upsert', (c) => live() && noteContacts(s, c));
  sock.ev.on('contacts.update', (c) => live() && noteContacts(s, c));
  sock.ev.on('chats.upsert', (c) => live() && saveChatList(s, c).catch(() => {}));
  sock.ev.on('lid-mapping.update', (m) => { if (m?.lid && m?.pn) s.lidToPn.set(m.lid, m.pn); });
}

// Contact names: the name saved on the phone, else the name they set themselves.
function noteContacts(s, contacts) {
  const updates = [];
  for (const c of contacts || []) {
    const jid = c.phoneNumber || c.id;
    if (!jid || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
    if (c.lid && c.phoneNumber) s.lidToPn.set(c.lid, c.phoneNumber);
    const name = c.name || c.verifiedName || c.notify;
    if (!name) continue;
    const chatId = toAppId(jid);
    if (s.names.get(chatId) === name) continue;
    s.names.set(chatId, name);
    updates.push({ chat_id: chatId, name });
  }
  // Names only for chats we already know; new chats get theirs when a message arrives.
  if (updates.length && db.isReady()) {
    db.listWaChats(s.id).then((known) => {
      const ids = new Set(known.map((c) => c.chat_id));
      return db.saveWaChats(s.id, updates.filter((u) => ids.has(u.chat_id)));
    }).catch(() => {});
  }
}

// Chat list entries (names and times; groups too, so "send by name" finds them).
async function saveChatList(s, chats) {
  const B = await baileys();
  const docs = [];
  for (const c of chats || []) {
    if (!c?.id || c.id === 'status@broadcast' || c.id.endsWith('@newsletter')) continue;
    const isGroup = B.isJidGroup(c.id);
    const chatId = isGroup ? c.id : await appChatId(s, { remoteJid: c.id, remoteJidAlt: c.pnJid || undefined });
    const t = Number(c.conversationTimestamp || c.lastMessageRecvTimestamp || 0);
    const name = c.name || s.names.get(chatId) || null;
    if (!t && !name) continue;
    docs.push({ chat_id: chatId, name, is_group: isGroup, t });
  }
  if (docs.length && db.isReady()) await db.saveWaChats(s.id, docs);
}

async function onConnection(s, sock, u) {
  const { id } = s;
  const B = await baileys();
  if (u.qr) {
    clearTimeout(s.watchdog);
    s.deadline = null;
    s.pageReady = true; // connected to WhatsApp: the login method can change without a restart
    if (s.phone) {
      s.lastQr = { data: await QRCode.toDataURL(u.qr, { width: 300, margin: 1 }), at: Date.now() };
      if (!s.codeRequested) {
        s.codeRequested = true;
        s.requestCode();
      }
      return; // in code mode, don't show the QR
    }
    s.qr = await QRCode.toDataURL(u.qr, { width: 300, margin: 1 });
    s.lastQr = { data: s.qr, at: Date.now() };
    if (!s.phone && isCurrent(s)) setStatus(s, 'qr', { code: null });
    return;
  }
  if (u.isNewLogin) {
    // Scanned / code entered: WhatsApp now restarts the connection once (normal).
    setStatus(s, 'authenticated', { qr: null, code: null, progress: null });
    console.log(`[${id}] linked; finishing login`);
    armWatchdog(s, 'authenticated', LOGIN_TIMEOUT_MS, s.attempt, 'stuck after login');
  }
  if (u.connection === 'open') {
    clearTimeout(s.watchdog);
    s.reconnects = 0;
    const me = B.jidDecode(sock.user?.id || '')?.user || null;
    setStatus(s, 'ready', { error: null, deadline: null, progress: null, qr: null, code: null, newLogin: false, me: { number: me, name: sock.user?.name || sock.user?.notify || '' } });
    console.log(`[${id}] ready as ${me}`);
    watchConnection(s);
    webhooks.emit(id, 'session.connected', { phone: me, name: sock.user?.name || sock.user?.notify || '' });
    return;
  }
  if (u.connection !== 'close') return;

  const code = u.lastDisconnect?.error?.output?.statusCode;
  const reason = B.DisconnectReason[code] || (code ? `code ${code}` : 'connection closed');
  clearInterval(s.health);
  if (s.removed) return;
  const wasReady = s.status === 'ready';
  if (wasReady) webhooks.emit(id, 'session.disconnected', { phone: s.me?.number || null, reason });

  if (code === B.DisconnectReason.loggedOut) {
    // Unlinked from the phone: drop the dead login and show a fresh QR on the same card.
    console.log(`[${id}] disconnected: LOGOUT`);
    await relaunch(s, { phone: null, newLogin: true, wipe: true });
    return;
  }
  if (code === B.DisconnectReason.restartRequired) {
    // Always happens once right after linking: reconnect with the new login.
    await relaunch(s, { attempt: s.attempt, keepStatus: true });
    return;
  }
  if (code === B.DisconnectReason.connectionReplaced) {
    console.log(`[${id}] disconnected: opened somewhere else with the same login`);
    s.removed = true;
    setStatus(s, 'error', { error: 'This login was opened on another server or computer, so this one stopped. Click Retry to take it back.', deadline: null });
    return;
  }
  if (code === B.DisconnectReason.forbidden) {
    console.log(`[${id}] disconnected: WhatsApp refused this number (${reason})`);
    s.removed = true;
    setStatus(s, 'error', { error: 'WhatsApp refused this number. Check the phone, then click Retry.', deadline: null });
    return;
  }
  if (code === B.DisconnectReason.badSession || code === B.DisconnectReason.multideviceMismatch) {
    console.log(`[${id}] saved login is broken (${reason}); showing a new QR`);
    await relaunch(s, { phone: s.phone, newLogin: true, wipe: true });
    return;
  }
  if (!wasReady && ['qr', 'code', 'requesting_code', 'loading_qr'].includes(s.status)) {
    // The QR (or code) expired without being used: get a fresh one, quietly.
    await relaunch(s, { attempt: 1, keepStatus: true });
    return;
  }
  // Connection lost: reconnect from the saved login, waiting a bit longer each time.
  s.reconnects = (s.reconnects || 0) + 1;
  const wait = Math.min(60000, 2000 * 2 ** Math.min(5, s.reconnects - 1));
  console.log(`[${id}] disconnected: ${reason}; reconnecting in ${Math.round(wait / 1000)}s`);
  setStatus(s, 'retrying', { error: null, deadline: Date.now() + wait });
  const reconnects = s.reconnects;
  setTimeout(() => {
    if (isCurrent(s)) relaunch(s, { attempt: 1 }).then((n) => { n.reconnects = reconnects; }).catch((e) => console.error(`[${id}] reconnect failed:`, e.message));
  }, wait);
}

// Close this session's connection and start it again from its saved login.
// The card stays on the dashboard while it reconnects.
async function relaunch(s, { phone = s.phone, attempt = 1, newLogin = s.newLogin, wipe = false, keepStatus = false } = {}) {
  s.removed = true; // ignore any further events from the old connection
  clearTimeout(s.watchdog);
  if (!keepStatus) setStatus(s, 'restarting', { qr: null, code: null, deadline: null, error: null });
  closeSocket(s);
  if (wipe) {
    console.log(`[${s.id}] clearing the saved login and starting fresh`);
    await sleep(500);
    removeSessionFiles(s.id);
  }
  if (sessions.get(s.id) === s) sessions.delete(s.id);
  const next = startSession(s.id, { phone, attempt, newLogin });
  if (keepStatus && s.status === 'authenticated') {
    setStatus(next, 'authenticated', {});
    armWatchdog(next, 'authenticated', LOGIN_TIMEOUT_MS, attempt, 'stuck after login');
  } else if (keepStatus && s.status === 'qr' && s.qr) {
    setStatus(next, 'qr', { qr: s.qr }); // keep showing the old QR until the new one arrives
  }
  return next;
}

function closeSocket(s) {
  clearInterval(s.health);
  try { s.sock?.ev?.removeAllListeners?.(); } catch {}
  try { s.sock?.end(undefined); } catch {}
}

// Restart if the session stays in `status` for `ms`. Counts toward MAX_ATTEMPTS.
function armWatchdog(s, status, ms, attempt, why) {
  clearTimeout(s.watchdog);
  s.deadline = Date.now() + ms;
  s.watchdog = setTimeout(async () => {
    if (!isCurrent(s) || s.status !== status) return;
    console.log(`[${s.id}] ${why} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    if (attempt < MAX_ATTEMPTS) {
      relaunch(s, { attempt: attempt + 1 }).catch((e) => console.error(`[${s.id}] restart failed:`, e.message));
    } else {
      s.removed = true;
      closeSocket(s);
      sessions.set(s.id, s); // keep the card so the Retry button shows
      setStatus(s, 'error', { error: 'Could not connect to WhatsApp after 3 tries. Check the server\'s internet, then click Retry.', deadline: null });
    }
  }, ms);
}

// phone (optional): link with an 8-character code on the phone instead of a QR.
// newLogin: started right after a logout, so the card says "Getting a new QR code".
function startSession(id, { phone, attempt = 1, newLogin = false } = {}) {
  if (!ID_RE.test(id || '')) throw httpError(400, 'Name must be letters, numbers, - or _ (max 40).');
  phone = normalizePhone(phone);
  if (sessions.has(id)) return sessions.get(id);
  // "Ali" and "ali" would share one login folder on Windows/macOS: treat names as the same.
  const clash = [...sessions.keys()].find((k) => k.toLowerCase() === id.toLowerCase());
  if (clash) throw httpError(409, `A business named "${clash}" already exists. Names are not case-sensitive.`);
  if (sessions.size >= MAX_SESSIONS) throw httpError(429, `Limit of ${MAX_SESSIONS} sessions reached.`);

  const s = {
    id, status: 'starting', since: Date.now(), deadline: null, attempt, progress: null, newLogin,
    qr: null, code: null, phone, me: null, error: null, aiError: null,
    botSending: new Map(), apiSent: new Set(), sendChain: Promise.resolve(), aiChats: new Map(), busy: new Set(), transcripts: new Map(), images: new Map(),
    recent: new Map(), names: new Map(), lidToPn: new Map(), acks: new Map(),
  };
  s.client = makeClient(s);
  sessions.set(id, s);
  armWatchdog(s, 'starting', START_TIMEOUT_MS, attempt, 'stuck while connecting');

  // Code login: ask for the code once connected to WhatsApp (the first QR event).
  s.requestCode = async function requestCode() {
    const number = s.phone;
    setStatus(s, 'requesting_code', { qr: null, code: null, error: null });
    for (let i = 1; i <= 3; i++) {
      if (!isCurrent(s) || s.phone !== number || ['authenticated', 'ready'].includes(s.status)) return;
      try {
        const code = await s.sock.requestPairingCode(number);
        if (!isCurrent(s) || s.phone !== number) return;
        setStatus(s, 'code', { code: code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code });
        return;
      } catch (e) {
        console.error(`[${id}] pairing code request failed (try ${i}/3):`, e?.message || e);
        if (i < 3) await sleep(5000);
      }
    }
    if (!isCurrent(s) || s.phone !== number) return;
    setStatus(s, 'error', { error: 'WhatsApp refused the code request. Too many tries on one number can block it for a while. Use the QR code, or retry later.' });
  };

  connect(s).catch(async (e) => {
    console.error(`[${id}] failed to start (attempt ${attempt}/${MAX_ATTEMPTS}):`, e?.message || String(e));
    if (!isCurrent(s)) return;
    clearTimeout(s.watchdog);
    if (attempt < MAX_ATTEMPTS) {
      setStatus(s, 'retrying', { error: null, deadline: Date.now() + 5000 });
      setTimeout(() => { if (isCurrent(s)) relaunch(s, { attempt: attempt + 1 }).catch(() => {}); }, 5000);
    } else {
      setStatus(s, 'error', { error: `Could not start: ${e?.message || e}`, deadline: null });
    }
  });
  return s;
}

// Manual restart from the dashboard for any session that isn't connected yet:
// retry after an error, "Restart now" when stuck, or switch between QR and code.
// phone: undefined = keep the current method, a number = code login, null = QR.
async function restartSession(id, phone) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  if (s.status === 'ready') throw httpError(409, 'Session is already connected.');
  if (phone !== undefined && phone !== null && !normalizePhone(phone)) {
    throw httpError(400, 'Phone must include country code, digits only, e.g. 923001234567.');
  }
  // Still connecting: just remember the choice; the first QR event applies it.
  if (phone !== undefined && isCurrent(s) && !s.pageReady && s.status === 'starting') {
    s.phone = phone ? normalizePhone(phone) : null;
    s.codeRequested = false;
    return view(s);
  }
  // Already on the login screen: switch QR <-> code right there.
  const onLoginScreen = isCurrent(s) && s.pageReady && ['qr', 'code', 'requesting_code'].includes(s.status);
  if (phone !== undefined && onLoginScreen) {
    if (phone) {
      s.phone = normalizePhone(phone);
      s.codeRequested = true;
      s.requestCode();
      return view(s);
    }
    s.phone = null;
    s.codeRequested = false;
    // WhatsApp replaces the QR about every 20 s; show the latest one if it's still current.
    if (s.lastQr && Date.now() - s.lastQr.at < 18000) setStatus(s, 'qr', { qr: s.lastQr.data, code: null, error: null });
    else setStatus(s, 'loading_qr', { qr: null, code: null, error: null }); // the next QR event fills it in
    return view(s);
  }
  return view(await relaunch(s, { phone: phone === undefined ? s.phone : phone }));
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\s+()-]/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

// A finished link leaves creds.json with "registered": true (or a "me" entry).
function isLinked(id) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'creds.json'), 'utf8'));
    return !!(creds.registered || creds.me);
  } catch {
    return false;
  }
}

function removeSessionFiles(id) {
  try {
    fs.rmSync(sessionDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    console.error(`[${id}] could not delete session files:`, e.message);
  }
}

// Close this server's connection for the business and delete its local login.
async function stopSession(id, { logout }) {
  const s = sessions.get(id);
  if (s) {
    const wasLinked = s.status === 'ready';
    s.removed = true;
    clearTimeout(s.watchdog);
    setStatus(s, 'logging_out', { qr: null, code: null, deadline: null }); // card stays meanwhile
    try { if (logout && wasLinked) await Promise.race([s.sock.logout(), sleep(15000)]); } catch {}
    closeSocket(s);
    if (sessions.get(id) === s) sessions.delete(id);
  }
  await sleep(500);
  removeSessionFiles(id);
}

// Log out: WhatsApp unlinks this device, and the same card starts over with a fresh QR
// (or code login). Settings, customers, orders and logs all stay in MongoDB.
async function logoutSession(id) {
  if (!sessions.has(id)) throw httpError(404, 'Session not found.');
  await stopSession(id, { logout: true });
  console.log(`[${id}] logged out; showing a new QR code`);
  return view(startSession(id, { newLogin: true }));
}

// Delete business: log out, remove the card, and delete all its data from MongoDB
// (settings, API keys, customers, orders, questions, logs, messages).
const deleting = new Set(); // businesses being deleted: never restarted meanwhile
async function deleteBusiness(id) {
  deleting.add(id);
  try {
    await stopSession(id, { logout: true });
    await rules.deleteRules(id);
    await db.deleteBusiness(id);
    console.log(`Business "${id}" deleted with all its data`);
  } finally {
    deleting.delete(id);
  }
}

// Start every business on boot: those with a saved login reconnect, the rest show a QR.
// The list comes from MongoDB plus any login folders found on disk.
async function restoreSessions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const onDisk = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
    .map((e) => e.name.slice('session-'.length));
  let known = [];
  if (db.isReady()) {
    for (const id of [...onDisk, ...rules.businessIds()]) await db.addBusiness(id).catch(() => {});
    known = await db.listBusinesses();
  }
  // One per name ignoring case; prefer the one with saved settings, then a login folder.
  const withSettings = new Set(rules.businessIds());
  const score = (id) => (withSettings.has(id) ? 2 : 0) + (onDisk.includes(id) ? 1 : 0);
  const byName = new Map();
  for (const id of [...new Set([...known, ...onDisk])]) {
    const key = id.toLowerCase();
    const prev = byName.get(key);
    if (!prev || score(id) > score(prev)) byName.set(key, id);
    if (prev) console.warn(`Businesses "${prev}" and "${id}" differ only in upper/lower case; using "${byName.get(key)}".`);
  }
  for (const id of byName.values()) {
    if (sessions.has(id) || deleting.has(id)) continue; // already running, or being deleted
    try { startSession(id); console.log(`[${id}] ${isLinked(id) ? 'restoring saved session' : 'not linked here yet, showing QR'}`); }
    catch (e) { console.error(`[${id}] skipped:`, e.message); continue; }
    // Connecting is quick without a browser, but still one at a time.
    const until = Date.now() + 30000;
    while (Date.now() < until && ['starting', 'authenticated', 'retrying'].includes(sessions.get(id)?.status)) await sleep(500);
  }
}


// ---------------------------------------------------------------------------
// For other systems (the public API and webhooks)
// ---------------------------------------------------------------------------

const API_TYPE = { chat: 'text', ptt: 'voice', vcard: 'contact' }; // WhatsApp Web names -> API names
const ACK_API = { '-1': 'failed', 0: 'queued', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
const SEND_GAP_MS = Number(process.env.API_SEND_GAP_MS ?? 400); // pause between API sends, so WhatsApp doesn't see a burst

const orderEvent = (o) => { const { business, ...rest } = o; return rest; };

// A stored message in the shape webhooks and the API show it.
function eventMessage(rec) {
  const type = API_TYPE[rec.type] || rec.type;
  const out = {
    id: rec.msg_id, chat_id: rec.chat_id, phone: db.phoneOf(rec.chat_id), name: rec.from_me ? null : rec.push_name || null,
    direction: rec.from_me ? 'outbound' : 'inbound', type,
    text: rec.type === 'chat' ? rec.body : rec.caption || rec.body || '',
    timestamp: rec.ts, reply_to: rec.quoted_id || null,
  };
  if (rec.duration) out.duration = rec.duration;
  if (MEDIA_TYPES.has(rec.type)) out.media = { mimetype: rec.mimetype || null, url: apikeys.mediaLink(rec.business || '', rec.msg_id) };
  return out;
}

async function setOrderStatus(id, orderId, status) {
  const order = await db.setOrderStatus(id, orderId, status);
  webhooks.emit(id, 'order.updated', orderEvent(order));
  return order;
}

function readySession(id) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Business not found.');
  if (s.status !== 'ready') throw httpError(409, `This business is not connected to WhatsApp (status: ${s.status}).`);
  return s;
}

// Phone number (digits, or <digits>@c.us) -> chat id, after checking it is on WhatsApp.
async function resolveRecipient(s, to) {
  const raw = String(to ?? '').trim();
  const idMatch = /^(\d{6,15})@(c\.us|s\.whatsapp\.net)$/.exec(raw);
  const digits = idMatch ? idMatch[1] : raw.replace(/[\s+()-]/g, '');
  if (!/^\d{6,15}$/.test(digits)) throw httpError(400, '"to" must be a phone number with the country code, for example 923001234567.');
  const numberId = await s.client.getNumberId(digits);
  if (!numberId) throw httpError(404, `${digits} is not on WhatsApp.`);
  return { chatId: numberId._serialized, number: digits };
}

async function findRecord(s, msgId) {
  for (const list of s.recent.values()) { const r = list.find((x) => x.msg_id === msgId); if (r) return { ...r, business: s.id }; }
  const r = db.isReady() ? await db.getWaMessage(s.id, msgId) : null;
  return r ? { ...r, business: s.id } : null;
}

const vcardOf = (c) => {
  const name = String(c?.name || '').replace(/[\r\n;,]/g, ' ').trim();
  const phone = String(c?.phone || '').replace(/\D/g, '');
  if (!name || !/^\d{6,15}$/.test(phone)) throw httpError(400, 'Each contact needs a "name" and a "phone" (digits with the country code).');
  return { name, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${phone}:+${phone}\nEND:VCARD` };
};

const TYPES = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'reaction'];
const needText = (v, field, max) => {
  if (typeof v !== 'string' || !v.trim()) throw httpError(400, `"${field}" is required.`);
  if (v.length > max) throw httpError(400, `"${field}" can be at most ${max} characters.`);
  return v;
};
const optText = (v, field, max) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw httpError(400, `"${field}" must be text of at most ${max} characters.`);
  return v;
};

// The Baileys content for one API message.
async function buildContent(s, chatId, input) {
  const type = input.type || 'text';
  if (!TYPES.includes(type)) throw httpError(400, `"type" must be one of: ${TYPES.join(', ')}.`);
  switch (type) {
    case 'text': return { type, content: { text: needText(input.text, 'text', 4096) }, label: input.text };
    case 'image': case 'video': {
      const f = await media.load(type, input.media, input.upload);
      const caption = optText(input.caption, 'caption', 1024);
      return { type, content: { [type]: f.data, mimetype: f.mimetype, ...(caption ? { caption } : {}), ...(type === 'video' && input.gif ? { gifPlayback: true } : {}) }, label: caption || '' };
    }
    case 'audio': {
      const f = await media.load('audio', input.media, input.upload);
      return { type, content: { audio: f.data, mimetype: f.mimetype, ptt: false }, label: '' };
    }
    case 'voice': {
      const f = await media.voice(await media.load('voice', input.media, input.upload));
      return { type, content: { audio: f.data, mimetype: f.mimetype, ptt: true }, label: '' };
    }
    case 'document': {
      const f = await media.load('document', input.media, input.upload);
      const caption = optText(input.caption, 'caption', 1024);
      const fileName = String(input.filename || f.filename || 'file').replace(/[\\/\r\n]/g, '_').slice(0, 120);
      return { type, content: { document: f.data, mimetype: f.mimetype, fileName, ...(caption ? { caption } : {}) }, label: caption || '' };
    }
    case 'sticker': {
      const f = await media.load('sticker', input.media, input.upload);
      return { type, content: { sticker: f.data, mimetype: f.mimetype }, label: '' };
    }
    case 'location': {
      const lat = Number(input.latitude), lon = Number(input.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw httpError(400, '"latitude" and "longitude" are required numbers.');
      const name = optText(input.name, 'name', 120), address = optText(input.address, 'address', 250);
      return { type, content: { location: { degreesLatitude: lat, degreesLongitude: lon, ...(name ? { name } : {}), ...(address ? { address } : {}) } }, label: '' };
    }
    case 'contact': {
      if (!Array.isArray(input.contacts) || !input.contacts.length || input.contacts.length > 10) throw httpError(400, '"contacts" must be a list of 1 to 10 people.');
      const cards = input.contacts.map(vcardOf);
      return { type, content: { contacts: { displayName: cards.length === 1 ? cards[0].name : `${cards.length} contacts`, contacts: cards.map((c) => ({ vcard: c.vcard })) } }, label: '' };
    }
    case 'reaction': {
      const target = await findRecord(s, String(input.message_id || ''));
      if (!target || target.chat_id !== chatId) throw httpError(404, 'That message_id was not found in this chat.');
      const emoji = typeof input.emoji === 'string' ? input.emoji : '';
      if (emoji.length > 8) throw httpError(400, '"emoji" must be a single emoji (or empty to remove the reaction).');
      return { type, content: { react: { text: emoji, key: { remoteJid: toWaJid(chatId), id: target.msg_id, fromMe: target.from_me } } }, label: '' };
    }
  }
}

// Send one message for another system. input: { to, type, text | media | ..., reply_to }.
async function sendApi(id, input) {
  const s = readySession(id);
  const { chatId, number } = await resolveRecipient(s, input.to);
  const built = await buildContent(s, chatId, input); // slow work (downloads, conversion) before taking a place in the queue
  let quoted;
  if (input.reply_to) {
    const q = await findRecord(s, String(input.reply_to));
    if (!q || q.chat_id !== chatId) throw httpError(404, 'reply_to: that message was not found in this chat.');
    quoted = { key: { remoteJid: toWaJid(chatId), id: q.msg_id, fromMe: q.from_me }, message: { conversation: q.body || q.caption || '' } };
  }
  return enqueueSend(s, async () => {
    if (s.status !== 'ready') throw httpError(409, `This business is not connected to WhatsApp (status: ${s.status}).`);
    markBotSending(s, chatId, built.label || '');
    let sent;
    try {
      sent = await s.sock.sendMessage(toWaJid(chatId), built.content, quoted ? { quoted } : {});
    } catch (e) {
      throw httpError(502, `WhatsApp could not send the message: ${e.message}`);
    }
    const msgId = sent?.key?.id;
    if (!msgId) throw httpError(502, 'WhatsApp did not accept the message.');
    s.apiSent.add(msgId);
    if (s.apiSent.size > 1000) s.apiSent.delete(s.apiSent.values().next().value);
    s.acks.set(msgId, STATUS_TO_ACK[sent.status] ?? 0);
    const rec = await toRecord(s, sent).catch(() => null);
    if (rec) { rec.chat_id = chatId; await remember(s, [rec]); }
    webhooks.emit(id, 'message.sent', { ...(rec ? eventMessage({ ...rec, business: id }) : { id: msgId, chat_id: chatId, phone: number, direction: 'outbound', type: built.type }), source: 'api' }, { key: msgId });
    for (let i = 0; i < 6 && (s.acks.get(msgId) ?? 0) < 1; i++) await sleep(500); // give WhatsApp a moment to confirm
    const ack = s.acks.get(msgId) ?? 0;
    if (ack < 0) throw httpError(502, 'WhatsApp could not send the message.');
    const result = { id: msgId, to: number, type: built.type, status: ACK_API[ack] || 'sent', timestamp: Number(sent.messageTimestamp) || Math.floor(Date.now() / 1000) };
    return result;
  });
}

function enqueueSend(s, fn) {
  const run = s.sendChain.then(async () => { try { return await fn(); } finally { if (SEND_GAP_MS) await sleep(SEND_GAP_MS); } });
  s.sendChain = run.catch(() => {});
  return run;
}

async function messageInfo(id, msgId) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Business not found.');
  const rec = await findRecord(s, String(msgId));
  if (!rec) throw httpError(404, 'Message not found.');
  const out = eventMessage(rec);
  if (rec.from_me) out.status = ACK_API[s.acks.get(rec.msg_id) ?? 1] || 'sent'; // older than the server's memory: it was sent
  return out;
}

// Received or sent media, for download.
async function messageMedia(id, msgId) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Business not found.');
  const rec = await findRecord(s, String(msgId));
  if (!rec || !MEDIA_TYPES.has(rec.type)) throw httpError(404, 'This message has no file.');
  const file = await downloadMedia(s, rec).catch((e) => { throw httpError(410, `The file is no longer available: ${e.message}`); });
  return { mimetype: file.mimetype, data: Buffer.from(file.data, 'base64') };
}

async function listMessages(id, { contact, limit = 50 } = {}) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Business not found.');
  const digits = String(contact || '').replace(/\D/g, '');
  if (!digits) throw httpError(400, '"contact" (a phone number) is required.');
  const recs = await db.recentWaMessages(id, `${digits}@c.us`, Math.min(200, Math.max(1, limit)));
  return recs.map((r) => { const m = eventMessage({ ...r, business: id }); if (r.from_me) m.status = ACK_API[s.acks.get(r.msg_id) ?? 1] || 'sent'; return m; });
}

// People this business has chatted with, newest first.
async function listApiContacts(id, { q = '', limit = 50, offset = 0 } = {}) {
  if (!sessions.has(id)) throw httpError(404, 'Business not found.');
  const needle = String(q).trim().toLowerCase();
  const all = (await db.listWaChats(id, { limit: 5000 })).filter((c) => !c.is_group && isPersonalChat(c.chat_id));
  const hit = needle ? all.filter((c) => (c.name || '').toLowerCase().includes(needle) || (db.phoneOf(c.chat_id) || '').includes(needle.replace(/\D/g, '') || '\0')) : all;
  return {
    total: hit.length,
    items: hit.slice(offset, offset + limit).map((c) => ({ id: c.chat_id, number: db.phoneOf(c.chat_id), name: c.name || null, last_message_at: c.t ? new Date(c.t * 1000).toISOString() : null })),
  };
}

function businessInfo(id) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Business not found.');
  return { id: s.id, status: s.status, connected: s.status === 'ready', phone: s.me?.number || null, name: s.me?.name || null, auto_reply: { enabled: Boolean(rules.getRules(s.id).enabled) } };
}

// ---------------------------------------------------------------------------
// Dashboard actions
// ---------------------------------------------------------------------------

// `to` is a phone number with country code (digits) or a chat/group name.
// Send from the dashboard, then wait a few seconds for WhatsApp to confirm it left the
// phone. ack: -1 failed, 0 waiting (clock icon), 1 sent (one tick), 2 delivered, 3 read.
const ACK_TEXT = { '-1': 'failed', 0: 'still waiting to send', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
async function sendAndConfirm(s, chatId, text, label) {
  console.log(`[${s.id}] sending a dashboard message to ${label} (${chatId})`);
  markBotSending(s, chatId, text); // not a person replying from the phone: don't pause the bot
  const msg = await s.client.sendMessage(chatId, text);
  const msgId = msg?.id?._serialized;
  let ack = msg?.ack ?? 0;
  for (let i = 0; i < 8 && ack < 1 && msgId; i++) {
    await sleep(1000);
    ack = (await s.client.getMessageById(msgId)).ack;
  }
  const status = ACK_TEXT[ack] || `ack ${ack}`;
  console.log(`[${s.id}] dashboard message to ${label}: ${status}`);
  if (ack < 0) throw httpError(502, `WhatsApp could not send the message to ${label}.`);
  return { status, delivered: ack >= 1 };
}

async function sendMessage(id, to, text) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  if (s.status !== 'ready') throw httpError(409, `Session is not ready (status: ${s.status}).`);
  if (!to || !text) throw httpError(400, '"to" and "message" are required.');

  const digits = String(to).replace(/[\s+()-]/g, '');
  if (/^\d{6,15}$/.test(digits)) {
    const numberId = await s.client.getNumberId(digits);
    if (!numberId) throw httpError(404, `${to} is not on WhatsApp.`);
    return { sentTo: digits, ...(await sendAndConfirm(s, numberId._serialized, text, digits)) };
  }

  const chats = await lightChats(s);
  const wanted = String(to).trim().toLowerCase();
  let matches = chats.filter((c) => (c.name || '').trim().toLowerCase() === wanted);
  if (!matches.length) matches = chats.filter((c) => (c.name || '').toLowerCase().includes(wanted));
  if (!matches.length) throw httpError(404, `No chat found matching "${to}".`);
  if (matches.length > 1) {
    throw httpError(409, `Several chats match "${to}": ${matches.slice(0, 10).map((c) => c.name).join(', ')}`);
  }
  return { sentTo: matches[0].name, ...(await sendAndConfirm(s, matches[0].id._serialized, text, matches[0].name)) };
}

const contactsLabel = (c) => {
  const n = c?.list?.length || 0;
  if (c?.mode === 'only') return `, only ${n} contact${n === 1 ? '' : 's'}`;
  if (c?.mode === 'except' && n) return `, ${n} excluded`;
  return '';
};

const CONTACTS_RECENT_DAYS = 14;

// The chat list, from what this server has seen (MongoDB): id, name, time, group or not.
async function lightChats(s) {
  const docs = db.isReady() ? await db.listWaChats(s.id) : [];
  return docs.map((c) => {
    const [user, server] = c.chat_id.split('@');
    return {
      id: { _serialized: c.chat_id, user, server },
      name: c.name || s.names.get(c.chat_id) || '',
      isGroup: !!c.is_group,
      timestamp: c.t || 0,
    };
  });
}

// One-to-one chats with a message in the last 2 weeks, for the "who gets
// auto-replies" picker, newest first.
// forSending: the "send a message" picker also wants groups and chats older than the recent window.
async function listContacts(id, limit = 300, { forSending = false } = {}) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  if (s.status !== 'ready') throw httpError(409, 'Connect this WhatsApp number first to load its contacts.');
  const since = forSending ? 0 : Date.now() / 1000 - CONTACTS_RECENT_DAYS * 86400;
  const chats = (await lightChats(s)).filter((c) => (forSending || !c.isGroup) && (c.timestamp || 0) >= since);
  return chats
    .filter((c) => (c.isGroup ? forSending : isPersonalChat(c.id._serialized)))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit)
    .map((c) => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      number: c.isGroup ? null : c.id.server === 'c.us' ? c.id.user : null,
      isGroup: Boolean(c.isGroup),
      lastMessageAt: c.timestamp ? c.timestamp * 1000 : null,
    }));
}

// Try the AI with the settings currently in the editor, without touching WhatsApp.
// A blank API key falls back to the saved one.
async function testAiReply(id, input, message) {
  if (!sessions.has(id)) throw httpError(404, 'Session not found.');
  if (!String(message || '').trim()) throw httpError(400, 'Type a customer message to test with.');
  const r = rules.cleanRules(id, { ...input, enabled: false });
  const out = await ai.withUsage({ business: id, kind: 'test' }, () => ai.replyTurn(r.ai, [{ role: 'user', text: String(message).trim() }], { customerName: 'Test Customer' }));
  if (!out) return { reply: '(The AI declined to answer this message. The fallback reply would be sent instead.)' };
  return {
    reply: out.reply,
    managerQuestion: out.escalate_to_manager ? out.manager_question : null,
    order: out.order_confirmed ? out.order : null,
    complaint: out.complaint,
  };
}

// Connection health, shown on the card. Every minute: ping WhatsApp's server and time
// the answer. No answer 3 times in a row: reconnect from the saved login.
const HEALTH_EVERY_MS = 60000;
const HEALTH_TIMEOUT_MS = 30000;
const HEALTH_MISSES_TO_RESTART = 3;

async function checkConnection(s) {
  const B = await baileys();
  const started = Date.now();
  const ping = s.sock.query({ tag: 'iq', attrs: { to: B.S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] });
  const r = await Promise.race([ping.then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message })),
    sleep(HEALTH_TIMEOUT_MS).then(() => ({ ok: false, error: `no answer in ${HEALTH_TIMEOUT_MS / 1000}s` }))]);
  const chats = db.isReady() ? await db.countWaChats(s.id).catch(() => null) : null;
  return { ...r, conn: r.ok ? 'CONNECTED' : null, chats, ms: Date.now() - started, at: Date.now() };
}

function watchConnection(s) {
  s.web = { ok: true, misses: 0, at: Date.now(), conn: 'CONNECTED' };
  s.readyAt = Date.now();
  clearInterval(s.health);
  const tick = async () => {
    if (!isCurrent(s) || s.status !== 'ready') return clearInterval(s.health);
    const r = await checkConnection(s).catch((e) => ({ ok: false, error: e.message, at: Date.now(), ms: null }));
    const misses = r.ok ? 0 : (s.web?.misses || 0) + 1;
    if (!r.ok && misses === 1) console.warn(`[${s.id}] WhatsApp did not answer: ${r.error}`);
    if (r.ok && s.web && !s.web.ok) console.log(`[${s.id}] WhatsApp is answering again`);
    s.web = { ...r, misses };
    if (misses >= HEALTH_MISSES_TO_RESTART && isCurrent(s) && s.status === 'ready') {
      console.error(`[${s.id}] WhatsApp stopped answering (${misses} checks); reconnecting from the saved login`);
      clearInterval(s.health);
      relaunch(s).catch((e) => console.error(`[${s.id}] restart failed:`, e.message));
    }
  };
  s.health = setInterval(tick, HEALTH_EVERY_MS);
  s.health.unref?.();
  setTimeout(tick, 3000);
}

// For the card: is this business's connection to WhatsApp actually working?
function webView(s) {
  if (s.status !== 'ready' || !s.web) return null;
  const w = s.web;
  let level = 'ok';
  let text = 'Connected to WhatsApp';
  if (!w.ok) {
    level = 'bad';
    text = `Not responding (${w.misses} of ${HEALTH_MISSES_TO_RESTART} checks missed). Reconnects by itself after ${HEALTH_MISSES_TO_RESTART}.`;
  } else if (w.ms > 5000) {
    level = 'warn';
    text = `Slow: WhatsApp took ${Math.round(w.ms / 1000)}s to answer. Check the server's internet.`;
  }
  return { level, text, chats: w.chats ?? null, checkedAt: w.at || null, ms: w.ms ?? null };
}

// "Reload everything": settings fresh from MongoDB, then every business reconnects,
// one at a time. Returns right away; runs in the background.
let restartingAll = false;
function restartAll() {
  if (restartingAll) throw httpError(409, 'Already reloading everything. Wait for it to finish.');
  const ids = [...sessions.keys()].filter((id) => sessions.get(id).status !== 'logging_out');
  restartingAll = true;
  console.log(`Reloading everything: ${ids.join(', ') || 'no businesses'}`);
  (async () => {
    await rules.load().catch((e) => console.error('Reloading settings failed:', e.message));
    for (const id of ids) {
      if (!sessions.has(id) || deleting.has(id)) continue;
      await hardRestart(id).catch((e) => console.error(`[${id}] restart failed:`, e.message));
      const until = Date.now() + 60000;
      while (Date.now() < until && ['starting', 'authenticated', 'retrying', 'restarting'].includes(sessions.get(id)?.status)) await sleep(500);
    }
    await restoreSessions();
  })().catch((e) => console.error('Reloading everything failed:', e.message))
    .finally(() => { restartingAll = false; console.log('Reloading everything: done'); });
  return { count: ids.length };
}

// "Restart": close this business's connection and open it again from the saved login.
async function hardRestart(id) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  console.log(`[${id}] full restart requested from the dashboard`);
  return view(await relaunch(s, { phone: s.status === 'ready' ? null : s.phone }));
}

async function screenshot(id) {
  if (!sessions.has(id)) throw httpError(404, 'Session not found.');
  throw httpError(409, 'This version has no browser, so there is no page to take a picture of.');
}

function view(s) {
  const r = rules.getRules(s.id);
  return {
    id: s.id, status: s.status, since: s.since, deadline: s.deadline, attempt: s.attempt, progress: s.progress, newLogin: s.newLogin,
    qr: s.qr, code: s.code, phone: s.phone, me: s.me, error: s.error, aiError: s.aiError,
    openQuestions: s.openQuestions || 0,
    web: webView(s),
    autoReply: r.enabled ? `${r.mode === 'ai' ? `AI (${ai.serverAi().label})` : 'Fixed replies'}${contactsLabel(r.contacts)}` : null,
  };
}

// Refreshes each card's "questions waiting" count from the database.
async function listSessions() {
  const all = [...sessions.values()];
  await Promise.all(all.map(async (s) => {
    s.openQuestions = await db.countOpenEscalations(s.id).catch(() => s.openQuestions || 0);
  }));
  return all.map(view);
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw httpError(404, 'Session not found.');
  return view(s);
}

async function shutdown() {
  // Close connections but keep login data, so sessions restore on next boot.
  for (const s of sessions.values()) { s.removed = true; closeSocket(s); }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = {
  hardRestart, restartAll,
  startSession, restartSession, logoutSession, deleteBusiness, screenshot, restoreSessions, sendMessage, testAiReply, listContacts, answerQuestion,
  sendApi, messageInfo, messageMedia, listMessages, listApiContacts, businessInfo, setOrderStatus, MESSAGE_TYPES: TYPES,
  listSessions, getSession, shutdown, view, toHistory,
  _test: {
    sessions, runAiReply, handleManagerMessage, typingTimeMs, webView, toRecord, toMessage, readContent, baileys,
    setSocketFactory: (f) => { socketFactory = f; },
    setDownloader: (f) => { downloader = f; },
  }, // for automated tests only
};
