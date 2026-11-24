# WhatsApp automation, Baileys version

Same app as the parent folder (dashboard, AI replies, voice notes, photos, customer
profiles, orders, manager questions, logs), but connected to WhatsApp with
[Baileys](https://github.com/WhiskeySockets/Baileys) instead of whatsapp-web.js.
There is no browser: Baileys talks to WhatsApp's servers directly.

| | WhatsApp Web version (parent folder) | This version |
|---|---|---|
| RAM, one business | about 1 GB | about 110 MB for the whole server |
| Time to show a QR | 30 to 90 s | about 2 s |
| Chats loaded on linking | all recent history and every contact | last 14 days, at most 60 messages per one-to-one chat |
| Database (default) | `whatsapp_automation` | `whatsapp_baileys` |
| Local port | 3123 | 3124 |

## Run locally

```
cd baileys
npm install
npm start          # http://localhost:3124, sign in with the super admin from .env
```

It reads `../atlas-credentials.env` (MONGODB_URI) and `./.env` (SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, PORT, DNS_SERVERS).

## Test

```
node --env-file=../atlas-credentials.env --env-file=.env test/run-all.js
```

`npm run test:auth` (needs a MongoDB; `MONGODB_URI`) starts the real server and checks sign-up,
sign-in, approval, roles, business ownership, the single super admin, session revocation and rate limits.

`npm run test:api` (needs an empty MongoDB; `MONGODB_URI`) checks the public API end to end: keys and
scopes, every message type, file checks, voice conversion, idempotency, orders, webhooks (signing,
retries, switching off), rate limits and isolation between businesses.

Runs 20 end-to-end steps against a fake WhatsApp connection and a fake OpenAI server, in a
throwaway database (`wa_test_baileys`, dropped afterwards): QR, pairing code, linking, AI
text reply with typing, history, voice note, photo, hidden-number (@lid) customers, manager
question and answer, owner pause, contacts list, dashboard send (by number and by name),
reconnect, logout, reload everything, delete business.

## Accounts and roles

The dashboard needs an account. Sign-up creates a **pending** account; an administrator
approves it under **Users** before it can sign in.

| Role | Can do |
|---|---|
| `user` | Create and manage their own businesses only. Other people's businesses don't exist for them. |
| `admin` | See every business. Approve, disable, enable, reset the password of, and delete regular users. Reload everything, read server logs. |
| `super_admin` | Exactly **one**. Everything an admin can do, plus promote/demote admins and manage admins. Cannot be changed, disabled or deleted through the app; the database refuses a second one. |

The super admin is created on first start from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`
(10+ characters). Changing them later does nothing. Lost the password? Set
`SUPER_ADMIN_PASSWORD` to a new value and `SUPER_ADMIN_RESET=1`, restart, then remove `SUPER_ADMIN_RESET`.

To give a business to its owner, open the business and go to **Access** (admins only): create a login
for them (email and a temporary password, shown once so you can send it) or transfer the business to an
existing user. The owner signs in at once and sees only their own business.

Businesses created before accounts existed are assigned to the super admin on first start.
Deleting a user keeps their businesses and moves them to whoever deleted the account.

Security: scrypt password hashes; sign-in token in an `HttpOnly`, `SameSite=Strict` cookie
(only its hash is stored, 7 days, `SESSION_DAYS`); failed sign-ins are rate limited; sign-up
and sign-in don't reveal whether an email is registered; disabling a user or changing their
password ends their sessions at once. The old shared `API_KEY` is gone.
Serve it over HTTPS (Railway does); the cookie is marked `Secure` automatically then.

## API for other systems

Other systems can send messages (text, images, video, voice notes, documents, stickers, locations,
contact cards, reactions), read contacts and orders, and receive events by webhook. Each business
has its own keys and webhooks in its **API** tab. The full guide is in [API.md](API.md).

## AI usage

Every AI call (replies, customer profiles, voice notes, test replies) is recorded with its business,
tokens, time taken, result and, when prices are set, estimated cost. **Usage** in the sidebar shows
requests, tokens, cost, response time and success rate over 24 hours to 90 days, a chart per day,
breakdowns **by user**, business, type and model, and the latest requests. Each business also has a
**Usage** tab. **Export CSV** downloads the rows. Regular users see only their own businesses;
admins see everything. Cost is an estimate from your own price settings, not from the provider's bill.

## What's different inside

- `sessions.js`: the auto-reply code is the same as the parent folder's. Underneath, an
  adapter gives it the same message/chat objects whatsapp-web.js did, built from Baileys.
- Messages are kept in MongoDB (`wa_messages`, 90 days; `MESSAGE_RETENTION_DAYS`) and chat
  names/times in `wa_chats`, because there is no WhatsApp Web keeping them.
- Chat ids stay in the WhatsApp Web style (`923001234567@c.us`, `...@lid`), so saved
  settings and the contacts picker work the same. Hidden-number (@lid) customers are
  matched to their phone number when WhatsApp tells us.
- The phone keeps getting notifications (the server doesn't mark itself "online").
- Card status line: pings WhatsApp every minute; 3 missed pings reconnect automatically.
- No screenshot endpoint (no browser).

## Settings (env)

| Variable | Default | |
|---|---|---|
| `MONGODB_DB` | `whatsapp_baileys` | Use `whatsapp_automation` to share data with the old version (never run the same business on both) |
| `SESSIONS_DIR` | `./.baileys_auth` (Docker: `/data/sessions`) | Login folders |
| `HISTORY_DAYS` | `14` | Older history from the phone is skipped |
| `MESSAGE_RETENTION_DAYS` | `90` | Stored messages are deleted after this |
| `BAILEYS_LOG` | `silent` | Baileys' own log level (`warn`, `info`, `debug`) |
| `MAX_SESSIONS` | `5` | Businesses per server |
| `AI_PROVIDER` | `anthropic` | `anthropic` (Claude) or `openai` (ChatGPT). The same for every business |
| `AI_MODEL` | provider default | Model name used for replies and customer profiles |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | (none) | Required for AI replies. `OPENAI_API_KEY` is also needed for voice notes |
| `AI_PRICE_INPUT_PER_M` / `AI_PRICE_OUTPUT_PER_M` | (none) | USD per 1M tokens for your model. Without them the Usage page shows tokens but no cost. Optional: `AI_PRICE_CACHE_READ_PER_M`, `AI_PRICE_CACHE_WRITE_PER_M`, `AI_PRICE_VOICE_INPUT_PER_M`, `AI_PRICE_VOICE_OUTPUT_PER_M` |
| `USAGE_RETENTION_DAYS` | `400` | How long AI usage records are kept |
| `PUBLIC_URL` | (none) | Public address of this server; makes media links in webhook events complete |
| `API_RATE_PER_MIN` | `120` | API requests per minute per key |
| `API_SEND_GAP_MS` | `400` | Pause between API messages sent for one business |
| `API_URL_SECRET` | random | Signs media links; set it when running several servers |
| `FFMPEG_PATH` | `ffmpeg` | For converting audio to voice notes (included in the Docker image) |
| `ALLOW_PRIVATE_URLS` | off | `1` lets media links and webhooks point at private addresses |

## Deploy (Railway)

Deploy this folder as its own service (root directory `baileys`), with a volume at `/data`
and the same `MONGODB_URI` variable, plus `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` for the first sign-in. The Dockerfile has no Chrome, so the
image is small and 512 MB to 1 GB of RAM is plenty for several businesses.
