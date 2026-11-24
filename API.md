# API guide

Connect another system (a CRM, a store, a POS, your own app) to a business: send WhatsApp messages in every format, read contacts and orders, and get told the moment something happens.

- [Quick start](#quick-start)
- [Authentication and keys](#authentication-and-keys)
- [Errors, limits and rate limits](#errors-limits-and-rate-limits)
- [Send a message](#send-a-message) · [Message types](#message-types) · [Sending files](#sending-files)
- [Message status and history](#message-status-and-history)
- [Contacts](#contacts) · [Orders](#orders) · [Business](#business)
- [Webhooks](#webhooks) · [Events](#events) · [Verifying a webhook](#verifying-a-webhook)
- [Server settings](#server-settings) · [All endpoints](#all-endpoints)

Base URL: `https://YOUR-SERVER/v1`. Everything is JSON unless stated.

---

## Quick start

1. Open the business, then the **API** tab, and create a key. Copy it now: it is shown only once.
2. Send a message:

```bash
curl https://YOUR-SERVER/v1/messages \
  -H "Authorization: Bearer wak_your_key" \
  -H "Content-Type: application/json" \
  -d '{"to":"923001234567","type":"text","text":"Your order is ready"}'
```

```json
{ "id": "3EB0C767D0A6F3A1B2", "to": "923001234567", "type": "text", "status": "sent", "timestamp": 1767200000 }
```

3. Add a webhook (API tab, or `POST /v1/webhooks`) to receive replies and delivery updates.

---

## Authentication and keys

Send the key on every request:

```
Authorization: Bearer wak_...
```

- A key belongs to **one business** and can only see that business.
- Each key has **scopes**:

| Scope | Allows |
| --- | --- |
| `read` | Read messages, contacts, orders, business status, download files |
| `send` | Send messages |
| `manage` | Change an order's status, turn auto-replies on or off, manage webhooks |

- Give each system its own key with only the scopes it needs. Remove a key in the API tab and it stops working at once.
- Only a hash of the key is stored. If you lose a key, create a new one.
- Keys are for servers. Never put one in a web page or a mobile app.
- Repeated wrong keys from one address are slowed down (`429`).

Keys are created in the dashboard (API tab), not through `/v1`, so a leaked key can never mint more keys.

---

## Errors, limits and rate limits

Every error has the same shape:

```json
{ "error": { "code": "invalid_request", "message": "\"to\" must be a phone number with the country code, for example 923001234567." } }
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Something in the request is wrong; the message says what |
| 401 | `invalid_key` | Missing, wrong or removed key |
| 403 | `missing_scope` | The key does not have the scope this needs |
| 404 | `not_found` | No such message, order, webhook or number on WhatsApp |
| 409 | `conflict` | The business is not connected to WhatsApp right now |
| 409 | `idempotency_in_progress` | The same `Idempotency-Key` is still being processed |
| 413 | `too_large` | The file or body is over the limit |
| 415 | `unsupported_media` | The file is not what the message type needs |
| 422 | `unprocessable` | A file could not be downloaded or converted |
| 429 | `rate_limited` | Too many requests; wait `Retry-After` seconds |
| 502 | `whatsapp_error` | WhatsApp did not accept the message |

**Rate limit:** 120 requests per minute per key (change with `API_RATE_PER_MIN`). Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.

**Sending pace:** messages from one business are sent one after another with a short pause, so WhatsApp does not see a burst. For large campaigns send slowly and only to people who expect to hear from you: WhatsApp bans numbers that send unwanted bulk messages.

---

## Send a message

`POST /v1/messages` (scope `send`)

| Field | Required | Notes |
| --- | --- | --- |
| `to` | yes | Phone number with the country code, digits only (`+`, spaces and dashes are ignored). The number must be on WhatsApp, or you get `404`. |
| `type` | no | One of the [types](#message-types) below. Default `text`. |
| `reply_to` | no | A message `id` from the same chat: the new message quotes it. |
| `idempotency_key` | no | Same as the `Idempotency-Key` header, see below. |

Plus the fields of the type you chose. Returns `201`:

```json
{ "id": "3EB0C767D0A6F3A1B2", "to": "923001234567", "type": "image", "status": "sent", "timestamp": 1767200000 }
```

`status` is `queued`, `sent`, `delivered`, `read`, `played` or `failed`. It usually becomes `delivered` and `read` a little later: read it with [`GET /v1/messages/:id`](#message-status-and-history) or listen for [`message.status`](#events).

### Never send the same message twice

Networks fail. If your request times out you do not know whether the message went out. Send an `Idempotency-Key` header with a value you make up (an order number, a UUID):

```bash
curl https://YOUR-SERVER/v1/messages \
  -H "Authorization: Bearer wak_your_key" \
  -H "Idempotency-Key: order-1042-ready" \
  -H "Content-Type: application/json" \
  -d '{"to":"923001234567","text":"Your order is ready"}'
```

Repeat the same request with the same key and you get the **same answer** (header `Idempotent-Replay: true`) and nothing new is sent. Keys are remembered for 24 hours. A request that failed does not use up its key, so you can retry it.

---

## Message types

| `type` | Fields | Notes |
| --- | --- | --- |
| `text` | `text` (up to 4096 characters) | |
| `image` | `media`, `caption` | JPEG, PNG, GIF or WebP, up to 5 MB |
| `video` | `media`, `caption`, `gif` | MP4, 3GP or WebM, up to 16 MB. `"gif": true` plays it as a looping GIF |
| `audio` | `media` | An audio file, up to 16 MB |
| `voice` | `media` | A **voice note** (microphone icon and waveform). Any audio format is converted to Ogg/Opus. Up to 16 MB |
| `document` | `media`, `filename`, `caption` | Any file up to 50 MB (PDF, Word, Excel, ZIP, ...) |
| `sticker` | `media` | WebP, up to 1 MB |
| `location` | `latitude`, `longitude`, `name`, `address` | `name` and `address` are optional |
| `contact` | `contacts`: `[{ "name", "phone" }]` | 1 to 10 contact cards |
| `reaction` | `message_id`, `emoji` | React to a message in the chat. An empty `emoji` removes your reaction |

Examples:

```jsonc
// text, replying to an earlier message
{ "to": "923001234567", "type": "text", "text": "Yes, it is in stock", "reply_to": "3EB0C767D0A6F3A1B2" }

// image from a link, with a caption
{ "to": "923001234567", "type": "image", "media": { "url": "https://example.com/menu.jpg" }, "caption": "Today's menu" }

// a voice note (any audio format; mimetype is optional)
{ "to": "923001234567", "type": "voice", "media": { "base64": "T2dnUwACAAAA...", "mimetype": "audio/ogg" } }

// a PDF invoice
{ "to": "923001234567", "type": "document", "media": { "url": "https://example.com/inv-1042.pdf" }, "filename": "Invoice-1042.pdf", "caption": "Your invoice" }

// location
{ "to": "923001234567", "type": "location", "latitude": 24.8607, "longitude": 67.0011, "name": "Our shop", "address": "Karachi" }

// contact card
{ "to": "923001234567", "type": "contact", "contacts": [{ "name": "Sara Ahmed", "phone": "923001234567" }] }

// reaction
{ "to": "923001234567", "type": "reaction", "message_id": "3EB0C767D0A6F3A1B2", "emoji": "👍" }
```

---

## Sending files

Give the file in one of three ways.

**1. A link** (easiest): `"media": { "url": "https://..." }`. The server downloads it (up to 3 redirects, 20 seconds). Links to private or internal addresses (`localhost`, `10.x`, `192.168.x`, cloud metadata, ...) are refused, and so are links with a username or password.

**2. Base64** inside the JSON, for small files: `"media": { "base64": "...", "mimetype": "image/png" }`. A `data:` URL prefix is accepted. Requests can be up to 70 MB.

**3. A file upload** (multipart), best for large files:

```bash
curl https://YOUR-SERVER/v1/messages \
  -H "Authorization: Bearer wak_your_key" \
  -F to=923001234567 -F type=document -F filename=report.pdf -F caption="Monthly report" \
  -F file=@./report.pdf
```

Other fields (`text`, `caption`, `latitude`, ...) are plain form fields. `contacts` is a JSON string and `gif` is `true` or `false`.

**Checks.** The server looks at the file itself, not at its name or the label you gave it: a text file called `photo.png` is refused (`415`). Size limits are WhatsApp's own: image 5 MB, video 16 MB, audio 16 MB, voice 16 MB, document 50 MB, sticker 1 MB.

**Voice notes need ffmpeg.** Ogg/Opus files are sent as they are. Anything else (MP3, WAV, M4A, ...) is converted with `ffmpeg`, which must be installed on the server. Without it you get `415` and the message tells you so. The Docker image (Railway) already includes it; if you run the server some other way, install ffmpeg or set `FFMPEG_PATH`.

---

## Message status and history

`GET /v1/messages/:id` (scope `read`): one message, sent or received.

```json
{
  "id": "3EB0C767D0A6F3A1B2", "chat_id": "923001234567@c.us", "phone": "923001234567", "name": null,
  "direction": "outbound", "type": "image", "text": "Today's menu", "timestamp": 1767200000,
  "reply_to": null, "media": { "mimetype": "image/jpeg", "url": "https://.../v1/messages/3EB0.../media?..." },
  "status": "read"
}
```

- `direction` is `inbound` or `outbound`; `status` appears on outbound messages.
- `type` is one of `text`, `image`, `video`, `audio`, `voice`, `document`, `sticker`, `location`, `contact`.
- `text` is the message text, or the caption of a file.
- `timestamp` is in **seconds**.

`GET /v1/messages?contact=923001234567&limit=50`: the latest messages with one person, oldest first (up to 200).

`GET /v1/messages/:id/media` returns the file of an image, video, voice note, audio or document message, sent or received. It needs the `read` scope, **or** the signed link from a webhook event: the `media.url` in `message.received` works without a key for one hour.

Messages are kept for 90 days (`MESSAGE_RETENTION_DAYS`); files are fetched from WhatsApp when asked for and may no longer be available for old messages (`410`).

---

## Contacts

`GET /v1/contacts?q=sara&limit=50&offset=0` (scope `read`): people this business has chatted with, newest first. `q` searches names and numbers.

```json
{ "total": 1, "limit": 50, "offset": 0, "items": [
  { "id": "923001234567@c.us", "number": "923001234567", "name": "Sara", "last_message_at": "2026-01-31T10:15:00.000Z" } ] }
```

---

## Orders

Orders are created by the AI assistant when a customer confirms one in the chat. Statuses: `confirmed`, `shipped`, `delivered`, `cancelled`.

`GET /v1/orders` (scope `read`): newest first. Filters: `status`, `contact` (phone number), `since` (a date like `2026-01-31`, or milliseconds), `limit` (1 to 100, default 50), `offset`.

```json
{ "total": 2, "limit": 50, "offset": 0, "items": [ {
  "id": 12, "chat_id": "923001234567@c.us", "customer_name": "Ali", "phone": "923001234567",
  "items": [ { "name": "Blue shirt", "quantity": 2, "price": "15" } ],
  "total": 30, "address": "House 4, Street 2, Karachi", "notes": null,
  "status": "confirmed", "created_at": 1767200000000, "updated_at": 1767200000000 } ] }
```

Order times are in **milliseconds**.

`GET /v1/orders/:id` (scope `read`) returns one order.

`PATCH /v1/orders/:id` (scope `manage`) with `{ "status": "shipped" }` changes the status and fires an `order.updated` event.

---

## Business

`GET /v1/business` (scope `read`):

```json
{ "id": "shop", "status": "ready", "connected": true, "phone": "923000000001", "name": "My Shop", "auto_reply": { "enabled": true } }
```

`PATCH /v1/business/auto-reply` (scope `manage`) with `{ "enabled": false }` turns the AI/auto replies on or off, for example while a person takes over. Turning them on is refused (`400`) until the business has what the replies need, exactly as in the dashboard.

While the business is not connected (`connected: false`), sending returns `409`.

---

## Webhooks

A webhook is a URL on your system that we call whenever something happens, so you do not have to keep asking.

- Add them in the **API** tab, or with the API (scope `manage`):
  - `POST /v1/webhooks` with `{ "url": "https://...", "events": ["message.received"], "description": "CRM" }`. Leave `events` out (or use `["*"]`) for everything. The response includes the signing `secret`, **shown once**.
  - `GET /v1/webhooks` lists them (never the secret) and the available events.
  - `DELETE /v1/webhooks/:id` removes one (`204`).
  - `POST /v1/webhooks/:id/test` sends a `webhook.test` event and tells you whether your system answered.
- Production URLs must use `https`.
- Every event is a `POST` with a JSON body:

```json
{
  "id": "evt_9f3c1a...",
  "type": "message.received",
  "created": "2026-01-31T10:15:00.000Z",
  "business": "shop",
  "data": { }
}
```

- Headers:

| Header | Value |
| --- | --- |
| `X-Webhook-Id` | One id per delivery; the same on every retry. Use it to ignore duplicates |
| `X-Webhook-Event` | The event type |
| `X-Webhook-Timestamp` | Unix time in seconds |
| `X-Webhook-Signature` | `v1=<hex>`, see [Verifying a webhook](#verifying-a-webhook) |

- **Answer with any `2xx` within 10 seconds.** Do the real work afterwards. Anything else counts as a failure.
- **Retries:** a failed delivery is retried after 10 seconds, 1 minute, 5 minutes, 30 minutes and 2 hours (6 tries in all). Retries survive a server restart. Events can arrive more than once and, rarely, out of order: use `X-Webhook-Id` and the event contents.
- **Switched off:** after 10 failed deliveries in a row a webhook is turned off (the API tab shows it). Turn it back on there once your system is fixed.

---

## Events

| Event | When |
| --- | --- |
| `message.received` | A customer sent a message (text, image, voice, ...) |
| `message.sent` | A message left this number: from the API, the AI, or typed on the phone |
| `message.status` | A message you sent was delivered or read |
| `order.created` | The AI recorded a new order |
| `order.updated` | An order's status changed |
| `question.created` | The AI passed a question on to the manager |
| `session.connected` | WhatsApp is connected |
| `session.disconnected` | The connection dropped |

`message.received` and `message.sent` `data`:

```json
{
  "id": "3EB0C767D0A6F3A1B2", "chat_id": "923001234567@c.us", "phone": "923001234567", "name": "Ali",
  "direction": "inbound", "type": "voice", "text": "", "timestamp": 1767200000, "reply_to": null, "duration": 7,
  "media": { "mimetype": "audio/ogg; codecs=opus", "url": "https://YOUR-SERVER/v1/messages/3EB0.../media?business=shop&exp=...&sig=..." }
}
```

`media` is only present for files. Its link needs no key and works for one hour (set `PUBLIC_URL` so the link is complete). Messages sent through the API also carry `"source": "api"`.

`message.status` `data`: `{ "id", "chat_id", "phone", "status": "sent" | "delivered" | "read" }`

`order.created` and `order.updated` `data`: the order, as in [Orders](#orders).

`question.created` `data`: `{ "id", "chat_id", "phone", "customer_name", "question" }`

`session.connected` `data`: `{ "phone", "name" }`. `session.disconnected` `data`: `{ "phone", "reason" }`.

---

## Verifying a webhook

Anyone can POST to your URL, so check the signature. It is an HMAC-SHA256 of `"<timestamp>.<raw body>"` using the webhook's secret. Use the **raw** body, before any JSON parsing, and reject old timestamps (5 minutes) so a captured request cannot be replayed.

Node.js (Express):

```js
const crypto = require('crypto');

app.post('/whatsapp-events', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-Webhook-Timestamp');
  const expected = 'v1=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(`${ts}.${req.body}`).digest('hex');
  const given = req.get('X-Webhook-Signature') || '';
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  res.sendStatus(200);          // answer first, work after
  handle(event);
});
```

Python (Flask):

```python
import hmac, hashlib, time, json
from flask import Flask, request, abort

@app.post("/whatsapp-events")
def events():
    ts = request.headers.get("X-Webhook-Timestamp", "")
    raw = request.get_data()
    expected = "v1=" + hmac.new(SECRET.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(request.headers.get("X-Webhook-Signature", ""), expected) or abs(time.time() - int(ts)) > 300:
        abort(401)
    handle(json.loads(raw))
    return "", 200
```

---

## Server settings

Optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | (none) | The server's public address, e.g. `https://wa.example.com`. Makes the media links in webhook events complete |
| `API_RATE_PER_MIN` | `120` | Requests per minute per key |
| `API_SEND_GAP_MS` | `400` | Pause between messages sent for one business |
| `API_URL_SECRET` | random | Signs the media links. Set it if you run several servers, so links work on all of them |
| `FFMPEG_PATH` | `ffmpeg` | Where ffmpeg is, for voice notes |
| `MESSAGE_RETENTION_DAYS` | `90` | How long messages (and so file downloads) are kept |
| `ALLOW_PRIVATE_URLS` | off | Set to `1` to let media links and webhooks point at private addresses (a server on your own network). Leave off unless you need it |

---

## All endpoints

| Method and path | Scope | What it does |
| --- | --- | --- |
| `POST /v1/messages` | send | Send a message (any type) |
| `GET /v1/messages` | read | Messages with one contact |
| `GET /v1/messages/:id` | read | One message and its status |
| `GET /v1/messages/:id/media` | read or signed link | Download a message's file |
| `GET /v1/contacts` | read | List and search contacts |
| `GET /v1/orders` | read | List orders |
| `GET /v1/orders/:id` | read | One order |
| `PATCH /v1/orders/:id` | manage | Change an order's status |
| `GET /v1/business` | read | Connection status and auto-reply switch |
| `PATCH /v1/business/auto-reply` | manage | Turn auto-replies on or off |
| `GET /v1/webhooks` | manage | List webhooks |
| `POST /v1/webhooks` | manage | Add a webhook |
| `DELETE /v1/webhooks/:id` | manage | Remove a webhook |
| `POST /v1/webhooks/:id/test` | manage | Send a test event |

Keys are created and removed in the dashboard (API tab).
