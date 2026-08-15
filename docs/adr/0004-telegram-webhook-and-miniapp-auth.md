# ADR-0004: Telegram webhook mode and Mini App `initData` authentication

- **Status:** Accepted (2026-08-15)
- **Decides:** Telegram transport, Mini App session model

## Context

Two distinct trust problems:

1. **Bot updates.** The bot must receive updates from Telegram. Anything reachable on the public internet
   that accepts updates is also reachable by an attacker who wants to forge them.
2. **Mini App identity.** The Mini App runs in a WebView we do not control, and calls our API. The only
   thing it can prove about its user is Telegram's signed `initData` blob — and that blob is trivially
   replayable if we do not defend against it.

## Decision

### Webhook, not long polling

`setWebhook` to `https://<host>/telegram/webhook/<random-secret-path>` with a `secret_token`.

Verification, in order, before any processing:
1. The secret path segment matches (constant-time compare).
2. The `X-Telegram-Bot-Api-Secret-Token` header matches (constant-time compare).
3. Optionally, the source IP is inside Telegram's published ranges (`149.154.160.0/20`, `91.108.4.0/22`).

The handler **always returns 200**, whatever it decides internally. A 4xx would let an attacker distinguish
"unknown user" from "rejected content" by probing.

Webhook handlers do the minimum synchronous work — validate, persist, enqueue — and return. All outbound
Telegram calls happen in the worker (see ADR-0005).

### Mini App authentication

`POST /api/v1/auth/telegram` with the raw `initData` string. Validation:

1. Parse into key/value pairs, remove `hash`, sort remaining keys, join as `k=v` with `\n`.
2. `secret = HMAC_SHA256(key="WebAppData", message=botToken)`.
3. `expected = HMAC_SHA256(key=secret, message=dataCheckString)`.
4. **Constant-time compare** against the supplied `hash`.
5. Reject if `auth_date` is older than **5 minutes**.
6. Reject if this exact `hash` has been seen before — stored in Redis with a TTL slightly longer than the
   `auth_date` window. **This is the replay defence**; steps 1–5 alone allow unlimited reuse of a captured
   blob within the window.
7. Reject if the `user` field is absent.

On success we issue our own tokens: a **15-minute JWT access token** and a **7-day refresh token** stored in
Redis. Refresh rotates the token and detects reuse — a replayed refresh token revokes the entire family.

`Authorization: Bearer`, not cookies: cookie behaviour inside Telegram's WebView is inconsistent across
platforms, and bearer tokens sidestep CSRF entirely for this surface. (The Admin Panel, a normal browser
app, uses cookies **with** CSRF protection — see ADR-0010.)

## Consequences

**Positive**
- No polling loop, no idle cost, lower notification latency.
- `initData` is exchanged for our own session exactly once, so the expensive HMAC check does not run on every
  request and the 5-minute freshness window can stay tight without harming usability.
- Short access tokens bound the damage from a leaked token; refresh-reuse detection catches theft.

**Negative**
- Requires a public HTTPS endpoint with a valid certificate — no local development against real Telegram
  without a tunnel. Mitigated by a documented tunnel recipe and a `TELEGRAM_MODE=polling` development
  override that is **refused when `NODE_ENV=production`**.
- A webhook outage silently drops updates after Telegram's retry budget. Mitigated by monitoring
  `getWebhookInfo().pending_update_count` in M16.
- Bearer tokens live in the WebView's storage and are readable by any XSS. This is why `v-html` is banned
  repo-wide (ADR-0009, T9).

## Alternatives considered

- **Long polling.** Simpler locally, no public endpoint. Rejected for production: an always-on outbound loop,
  higher latency, and awkward behaviour with more than one API replica.
- **Trusting `initDataUnsafe`.** Rejected outright — it is unsigned client input. Its name is a warning.
- **Using `initData` as the session credential on every request.** Rejected: it forces either a long
  `auth_date` window (weakening replay defence) or constant re-authentication.
- **Session cookies for the Mini App.** Rejected: unreliable in Telegram WebViews and adds CSRF surface.
