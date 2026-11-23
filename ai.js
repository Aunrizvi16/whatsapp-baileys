// AI-written replies with Claude (Anthropic SDK) or ChatGPT (OpenAI SDK).
// Both return structured JSON so the bot can also record orders, pass questions to
// the manager, and keep a profile of each customer.
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'ChatGPT',
    defaultModel: 'gpt-5-mini', // change in the dashboard to any model your OpenAI account has
    models: [],
    envKey: 'OPENAI_API_KEY',
  },
};

// ---------------------------------------------------------------------------
// Prompts and output shapes
// ---------------------------------------------------------------------------

const REPLY_RULES = `You answer WhatsApp messages from customers on behalf of the business described in <business_information>. You respond with JSON; the "reply" field is the WhatsApp message sent to the customer.

How to write "reply":
- Use the customer's language and script (English, Urdu, Roman Urdu, and so on).
- Keep it short, like a real shop assistant on WhatsApp: usually 1 to 4 sentences, plain text, no markdown or headings.
- Only state facts (prices, stock, sizes, delivery, payment, hours, policies) that appear in the business information. Never invent prices, discounts or promises.
- "[voice note]" followed by text is a transcript of a voice message: treat it as what the customer said. Transcripts can have small errors and may be in Urdu script even if the customer usually types Roman Urdu; reply in the language and script they normally type in. "[voice note]" with nothing after it couldn't be transcribed, so ask them to type it.
- "[photo, attached]" means the customer sent a photo and the image is attached: look at it. It may be a product they want, a screenshot of a post or ad, a payment receipt, a damaged item, or an address. Match it to the business information where you can; if it shows something the business doesn't sell or you can't tell, say so honestly. Never invent details you can't see. "[photo]" without "attached" couldn't be loaded, so ask them to describe it.
- Other text in [square brackets] describes media you can't see, such as [video] or [document], so ask them to describe it if you need the details.

Using what you know about this customer:
- <customer_profile> is what was learned from earlier chats. Use it naturally: their name, saved address, likes and dislikes. Don't ask again for details you already have, but confirm the saved address before placing an order.
- <recent_orders> lists their orders with status. Use it to answer questions about existing orders.

The other fields:
- escalate_to_manager: true when the customer needs something the business information doesn't cover or that needs a person to decide: unlisted products or prices, special discounts, changing or cancelling an existing order, a complaint that needs action, or anything you're unsure about. Write a clear, self-contained question in manager_question with the details the manager needs. In "reply", tell the customer you're checking with the team and will get back to them shortly. Don't escalate a question that's already listed in <waiting_for_manager>; just tell the customer it's being checked. When not escalating, manager_question is "".
- order_confirmed: true only in the message where the customer has clearly confirmed a new order and you have every detail the business information asks for. Fill "order" with those details, and in "reply" confirm the order and the total. Never record an order that is already in <recent_orders>. When false, fill "order" with empty values.
- complaint: true if the customer is unhappy about something.

When <manager_answer> is present, the manager has answered a question this customer asked earlier. Pass the answer on to the customer in your own words in "reply" (the customer's last message may just be a placeholder asking for the answer), and set escalate_to_manager and order_confirmed to false.`;

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'escalate_to_manager', 'manager_question', 'order_confirmed', 'order', 'complaint'],
  properties: {
    reply: { type: 'string' },
    escalate_to_manager: { type: 'boolean' },
    manager_question: { type: 'string' },
    order_confirmed: { type: 'boolean' },
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'total', 'delivery_address', 'customer_name', 'customer_phone', 'notes'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'quantity', 'price'],
            properties: { name: { type: 'string' }, quantity: { type: 'integer' }, price: { type: 'number' } },
          },
        },
        total: { type: 'number' },
        delivery_address: { type: 'string' },
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    complaint: { type: 'boolean' },
  },
};

const PROFILE_RULES = `You keep a short profile of one customer of the business described in <business_information>, built from their WhatsApp chat. The profile is shown to the assistant that answers this customer, so it can greet them by name, remember their address, and avoid things they disliked.

Use only what the chat shows; leave a field empty when it's unknown. If <current_profile> is given, update it: keep what's still true, add new information, and change what the chat shows has changed. Keep each list item short. regular_customer is true when they have ordered before or clearly buy repeatedly.`;

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'address', 'alternate_phone', 'language', 'regular_customer', 'preferences', 'dislikes', 'complaints', 'notes'],
  properties: {
    name: { type: 'string' },
    address: { type: 'string' },
    alternate_phone: { type: 'string' },
    language: { type: 'string' },
    regular_customer: { type: 'boolean' },
    preferences: { type: 'array', items: { type: 'string' } },
    dislikes: { type: 'array', items: { type: 'string' } },
    complaints: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

// One customer turn. history: [{ role: 'user' | 'assistant', text }] ending with the customer.
// Returns the parsed REPLY_SCHEMA object, or null if the model declined.
async function replyTurn(ai, history, ctx = {}) {
  const context = [
    ctx.customerName ? `The customer's WhatsApp name is ${ctx.customerName}.` : '',
    `<customer_profile>\n${ctx.profile ? JSON.stringify(ctx.profile, null, 1) : 'New customer, nothing known yet.'}\n</customer_profile>`,
    `<recent_orders>\n${ctx.orders?.length ? ctx.orders.map(formatOrder).join('\n') : 'None.'}\n</recent_orders>`,
    `<waiting_for_manager>\n${ctx.waiting?.length ? ctx.waiting.map((e) => `- ${e.question}`).join('\n') : 'Nothing.'}\n</waiting_for_manager>`,
    ctx.managerAnswer ? `<manager_answer>\nQuestion: ${ctx.managerAnswer.question}\nManager's answer: ${ctx.managerAnswer.answer}\n</manager_answer>` : '',
  ].filter(Boolean).join('\n\n');
  return callJSON(ai, {
    stable: `${REPLY_RULES}\n\n${businessBlock(ai)}`,
    dynamic: context,
    messages: history,
    schema: REPLY_SCHEMA,
    schemaName: 'whatsapp_reply',
  });
}

// Write or update a customer profile from their chat. transcript: [{ role, text }].
async function buildProfile(ai, transcript, currentProfile) {
  const chat = transcript.map((m) => `${m.role === 'user' ? 'Customer' : 'Business'}: ${m.text}`).join('\n');
  const text = `${currentProfile ? `<current_profile>\n${JSON.stringify(currentProfile, null, 1)}\n</current_profile>\n\n` : ''}<chat>\n${chat}\n</chat>`;
  return callJSON(ai, {
    stable: `${PROFILE_RULES}\n\n${businessBlock(ai)}`,
    messages: [{ role: 'user', text }],
    schema: PROFILE_SCHEMA,
    schemaName: 'customer_profile',
  });
}

function resolveKey(ai) {
  return ai.apiKey || process.env[PROVIDERS[ai.provider]?.envKey] || '';
}

// ---------------------------------------------------------------------------
// Voice notes -> text (OpenAI speech-to-text; Claude doesn't take audio input)
// ---------------------------------------------------------------------------

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';

// Voice-note key: its own key, else the ChatGPT key when replies use ChatGPT, else the server's.
function voiceKey(ai) {
  return ai.voiceKey || (ai.provider === 'openai' ? ai.apiKey : '') || process.env.OPENAI_API_KEY || '';
}

// media: whatsapp-web.js MessageMedia { mimetype, data (base64) }. Returns the text, or null.
async function transcribe(ai, media) {
  const apiKey = voiceKey(ai);
  if (!apiKey) throw friendly('No OpenAI key for voice notes. Add one in the AI settings.');
  const mime = (media.mimetype || 'audio/ogg').split(';')[0].trim();
  const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm' }[mime] || 'ogg';
  try {
    const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
    const file = await OpenAI.toFile(Buffer.from(media.data, 'base64'), `voice-note.${ext}`, { type: mime });
    const result = await client.audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL });
    return result.text?.trim() || null;
  } catch (e) {
    throw explainError(e, 'OpenAI (voice notes)');
  }
}

// ---------------------------------------------------------------------------
// Provider plumbing
// ---------------------------------------------------------------------------

function businessBlock(ai) {
  return `<business_information>\n${ai.prompt.trim()}\n</business_information>`;
}

function formatOrder(o) {
  const items = o.items.map((i) => `${i.quantity} x ${i.name}${i.price ? ` @ ${i.price}` : ''}`).join(', ');
  return `- Order #${o.id} on ${new Date(o.created_at).toISOString().slice(0, 10)}: ${items}. Total ${o.total ?? '?'}. Status: ${o.status}.`;
}

// Calls the provider with a JSON schema and returns the parsed object (or null on refusal).
async function callJSON(ai, { stable, dynamic, messages, schema, schemaName }) {
  const provider = PROVIDERS[ai.provider];
  if (!provider) throw friendly(`Unknown AI provider "${ai.provider}".`);
  const apiKey = resolveKey(ai);
  if (!apiKey) throw friendly(`No ${provider.label} API key set.`);
  if (!ai.prompt?.trim()) throw friendly('The AI prompt is empty. Describe the business first.');
  const model = ai.model || provider.defaultModel;

  try {
    const text = ai.provider === 'anthropic'
      ? await claudeJSON({ apiKey, model, stable, dynamic, messages, schema })
      : await openaiJSON({ apiKey, model, stable, dynamic, messages, schema, schemaName });
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) throw Object.assign(new Error(`${provider.label} returned an unreadable answer.`), { status: 502, friendly: true });
    throw explainError(e, provider.label);
  }
}

async function claudeJSON({ apiKey, model, stable, dynamic, messages, schema }) {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  const params = {
    model,
    max_tokens: 16000,
    // Low effort keeps chat replies fast; the schema guarantees valid JSON back.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [
      // Rules + business info never change between customers: cache them.
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      ...(dynamic ? [{ type: 'text', text: dynamic }] : []),
    ],
    messages: messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })), { type: 'text', text: m.text }]
        : m.text,
    })),
  };
  // Server-side fallback: if a model declines, the API retries on a fallback model
  // within the same call. Haiku has no server-side fallback, so call it plainly.
  const response = model.includes('haiku')
    ? await client.messages.create(params)
    : await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  if (response.stop_reason === 'refusal') return null;
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function openaiJSON({ apiKey, model, stable, dynamic, messages, schema, schemaName }) {
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    messages: [
      { role: 'system', content: [stable, dynamic].filter(Boolean).join('\n\n') },
      ...messages.map((m) => ({
        role: m.role,
        // OpenAI accepts images only in user messages.
        content: m.images?.length && m.role === 'user'
          ? [...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })), { type: 'text', text: m.text }]
          : m.text,
      })),
    ],
  });
  const msg = response.choices[0]?.message;
  if (!msg || msg.refusal) return null;
  return msg.content;
}

function friendly(message) {
  return Object.assign(new Error(message), { status: 400, friendly: true });
}

// Turn SDK errors into messages a business owner can act on.
function explainError(e, label) {
  if (e.friendly) return e;
  const SDK = label === 'Claude' ? Anthropic : OpenAI; // ChatGPT and voice notes both use OpenAI
  let msg;
  if (e instanceof SDK.AuthenticationError) msg = `${label} rejected the API key. Check it and save again.`;
  else if (e instanceof SDK.PermissionDeniedError) msg = `${label} API key doesn't have access to this model.`;
  else if (e instanceof SDK.NotFoundError) msg = `${label} doesn't know this model name. Check the model field.`;
  else if (e instanceof SDK.RateLimitError) msg = `${label} rate limit or credit limit reached. Check your billing.`;
  else if (e instanceof SDK.BadRequestError) msg = `${label} rejected the request: ${e.message}`;
  else if (e instanceof SDK.APIConnectionError) msg = `Could not reach ${label}. Check the server's internet connection.`;
  else if (e instanceof SDK.APIError) msg = `${label} error ${e.status}: ${e.message}`;
  else msg = `${label} error: ${e.message}`;
  return Object.assign(new Error(msg), { status: 502, friendly: true });
}

module.exports = { replyTurn, buildProfile, transcribe, voiceKey, resolveKey, PROVIDERS, REPLY_SCHEMA, PROFILE_SCHEMA };
