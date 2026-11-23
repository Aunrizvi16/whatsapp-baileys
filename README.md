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
npm start          # http://localhost:3124, API key from .env (localtest)
```

It reads `../atlas-credentials.env` (MONGODB_URI) and `./.env` (API_KEY, PORT, DNS_SERVERS).

## Test

```
node --env-file=../atlas-credentials.env --env-file=.env test/run-all.js
```

Runs 20 end-to-end steps against a fake WhatsApp connection and a fake OpenAI server, in a
throwaway database (`wa_test_baileys`, dropped afterwards): QR, pairing code, linking, AI
text reply with typing, history, voice note, photo, hidden-number (@lid) customers, manager
question and answer, owner pause, contacts list, dashboard send (by number and by name),
reconnect, logout, reload everything, delete business.

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

## Deploy (Railway)

Deploy this folder as its own service (root directory `baileys`), with a volume at `/data`
and the same `MONGODB_URI` and `API_KEY` variables. The Dockerfile has no Chrome, so the
image is small and 512 MB to 1 GB of RAM is plenty for several businesses.
