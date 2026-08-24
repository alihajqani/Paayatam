# Security

The deployment half of PayeTam's security posture: what the production stack
exposes, what protects it, what is deliberately accepted, and how to rotate a
secret without breaking the product.

The application half — threats T1–T15, the twelve invariants, and the controls in
the code — lives in [`docs/threat-model.md`](docs/threat-model.md) and is not
repeated here. This document is about the machine.

---

## 1. Reporting a vulnerability

Do not open a public issue. Email the maintainer at the address on the GitHub
profile of [@alihajqani](https://github.com/alihajqani), with enough detail to
reproduce. You will get an acknowledgement within a few days.

If a report includes a credential, a session token or another user's data, say so
in the first line so it can be handled before it is read further.

---

## 2. What is exposed

| Reachable from | What | Notes |
|---|---|---|
| The internet | `443/tcp` on nginx | Both origins |
| The internet | `80/tcp` on nginx | A redirect, plus the ACME challenge. Nothing else |
| The internet | SSH | Key-only, root login off |
| Nothing else | Postgres, Redis, API, worker | No published port at all |

The API is not published. It is reachable from nginx over the `frontend` Docker
network and from nowhere else; Postgres and Redis are reachable from the API and
the worker over `internal`. `expose:` in the compose file documents a port for a
reader — it does not open one.

### Endpoints closed at the proxy

| Path | Public | Why |
|---|---|---|
| `/health` | ✅ 200 | Discloses that the process is up and for how long |
| `/ready` | ⛔ 404 | Names *which* dependency is down — the fact an attacker most wants during an outage |
| `/metrics` | ⛔ 404 | Request volumes, error rates, queue depths |

> **`/metrics` is the one to understand.** The application already refuses it:
> `apps/api/src/metrics/metrics.controller.ts` returns 404 to anything that is not
> a private address. But behind a reverse proxy *every* request arrives from a
> private address, so that guard passes for the whole internet and the endpoint
> would be world-readable while the code reads as though it were shut. Only the
> nginx rule actually closes it.
>
> Which is why it is asserted in two places that would have to be deleted
> together: `scripts/smoke-tests.sh` checks it on both origins after every deploy,
> and `.github/workflows/deploy.yml` checks it from a GitHub runner, outside the
> network entirely.

---

## 3. Controls, and what each is for

### Transport

- TLS 1.2 and 1.3 only; session tickets off, so a key that never rotates cannot
  remove forward secrecy from a resumed TLS 1.2 session.
- HSTS, two years, `includeSubDomains`, on the document as well as on the API's
  JSON.
- HTTP→HTTPS on both origins — except `/.well-known/acme-challenge/`, which must
  stay plaintext or every future renewal fails silently.
- Certificates per hostname rather than one covering both, so a renewal failure
  on one does not take the other down.

### Headers

Both origins get `nosniff`, `no-referrer`, `same-origin` COOP and a CSP with no
`unsafe-inline` or `unsafe-eval` in `script-src`. They differ in exactly two
places, and both differences are forced:

- **The Mini App has no `X-Frame-Options: DENY`.** Telegram Web loads a Mini App
  *inside an iframe*, so `DENY` would leave the product working in the phone
  clients and blank on desktop web — a failure only one tester would ever see.
  `frame-ancestors https://telegram.org https://*.telegram.org` does the same job
  with the one exception that has to exist.
- **The Mini App's `script-src` allows `https://telegram.org`.** That is where
  `telegram-web-app.js` comes from, and it is what injects
  `window.Telegram.WebApp`. The font is self-hosted precisely so the list stays
  one entry long (ADR-0003). The admin panel's CSP has no outside origin at all.

The admin panel adds `X-Frame-Options: DENY`, `frame-ancestors 'none'` and
`X-Robots-Tag: noindex`.

> An nginx footgun worth knowing about: `add_header` inside a `location`
> **replaces** the inherited set rather than adding to it. Any location that sets
> its own `Cache-Control` would otherwise ship with no CSP. That is why the
> headers live in `docker/snippets/` and are included in each such location.

### Rate limiting

Two layers, doing different jobs:

- **nginx**, per address, coarse — 20 r/s general, 1 r/s on the authentication
  paths. It exists for the flood that should never reach Node at all, because
  refusing it there still costs a worker, a database connection and a Redis round
  trip.
- **The application**, per subject and per endpoint class, aware of what the
  request is trying to do, and recording a crossing in `audit_log`
  (`packages/platform/src/ratelimit`).

**`TRUST_PROXY` is what makes the second layer work.** Without it Fastify reports
nginx's address as `request.ip`, and three things break at once: every IP bucket
becomes one bucket shared by the whole internet (`AUTH`'s 30-a-minute becomes a
global cap real users exhaust), every `ip_hash` in `audit_log` becomes the same
hash, and `/metrics`' private-address check passes for everyone.

It names the frontend subnet, never `true`. `true` means "believe whatever
`X-Forwarded-For` says", which hands an attacker the rate limiter and the audit
trail together — and `packages/config/src/env.ts` refuses that spelling outright.
nginx *replaces* `X-Forwarded-For` with `$remote_addr` rather than appending to
it, so the header contains exactly one address and it is the one nginx measured.

> If a CDN is ever put in front of this, that decision has to be revisited in
> `docker/snippets/proxy.conf` and `TRUST_PROXY` **together**. Changing one is how
> a deployment ends up trusting a client-supplied address.

### Containers

- Nothing runs as root except nginx's master process, which needs it to bind 80
  and 443. The API and the worker run as uid 1000 with `read_only: true` and a
  tmpfs `/tmp` — a container that cannot rewrite its own code is one less thing
  an RCE turns into persistence.
- `no-new-privileges` everywhere; resource limits everywhere, so one runaway
  service cannot take the host with it.
- Redis has `maxmemory` below its container limit with `noeviction`. The default
  means the cgroup kills it and every queued job goes at once; `allkeys-lru`
  would be worse, evicting jobs and sessions silently. Refusing a write is loud
  and recoverable.
- Logs are capped at 10 MB × 5 per service. An unrotated json-file log is the
  most common way a small VPS runs out of disk.
- The Redis password is written to a file inside the container rather than passed
  as `--requirepass <value>`, so it is not in the process list; health checks use
  `REDISCLI_AUTH` for the same reason.

### Secrets

- `.env`, mode 600, never committed. `.gitignore` covers it, CI fails the build
  if a tracked `.env` or a private key ever appears, and `require_env_file` fixes
  the mode if it has drifted.
- **No secret is interpolated by Compose.** `${POSTGRES_PASSWORD}` is resolved
  while parsing, so `docker compose config` would print the database password,
  the bot token and both JWT secrets to stdout — into a terminal, a CI log, or a
  pasted bug report. Every service reads `env_file` instead.
- No script puts a token on a command line. `ps` is world-readable, so
  `notify-telegram.sh`, `set-webhook.sh` and the deploy workflow all write the
  bot URL into a mode-600 curl config file.
- `scripts/set-webhook.sh` never prints the webhook secret path, and nginx has
  `access_log off` on that location: the path *is* a credential and it is in the
  URL, so every access line would write a live secret to disk.
- Alerts go through M15's `redact()` before they reach a group chat, which may
  contain people who are not administrators of this system.

---

## 4. Accepted risks

Written down because an accepted risk that is not written down is an oversight
that has not been found yet.

| # | Risk | Why it is accepted | What would change it |
|---|---|---|---|
| 1 | **The admin panel is reachable from any address.** Only TOTP plus a session cookie stands in front of it. | The operator has no fixed address and no VPN, and a network control they cannot administer is one they will disable during an incident. The login is genuinely two-factor. | An `allow`/`deny` block is pre-written and commented in `docker/sites-available/admin.paayatam.online.conf`, at server level so it covers the API and the bundle together. Uncomment it the day there is a fixed address. |
| 2 | **`CHAT_ENCRYPTION_KEY` lives on the app server.** | ADR-0009 is explicit: it protects dumps, backups and a stolen disk, not a compromised app server, which must hold the key to do its job. | A KMS or an HSM, which is a different architecture. |
| 3 | **Anyone in the `docker` group is root.** Compose's `env_file` also puts secrets in `docker inspect`. | Both follow from the group membership, not from this design. A bind-mounted `.env` would move the exposure without removing it, and would add uid-matching problems on every deploy. | Keeping the group to accounts that should have root — which is the actual control. |
| 4 | **One host.** Postgres, Redis, the API, the worker and nginx share a machine. | Deliberate for a controlled first trial. A second host is cost and operational surface that nothing here yet needs. | Real traffic. |
| 5 | **Nightly dumps, no WAL archiving.** The worst day loses up to 24 hours. | Point-in-time recovery needs continuous archiving and somewhere to put it, neither of which exists yet. | Real user data. `docs/runbook-backup-restore.md` has the procedure. |
| 6 | **No load testing.** No figures exist for this product under load. | Nothing has run in production. Numbers invented before that would be fiction. | Before any announcement wider than a controlled trial. |
| 7 | **The images are built on the production host.** | One VPS, no registry, and therefore no registry credentials to keep anywhere. | A second environment. |

---

## 5. Rotating a secret

`scripts/check-env.sh` will catch a mismatch after any of these; run it before
restarting.

| Secret | Effect | Procedure |
|---|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ✅ Safe. Everyone is signed out; the Mini App signs back in by itself. | Edit `.env`, `scripts/compose.sh up -d api worker`. |
| `TELEGRAM_WEBHOOK_SECRET_PATH`, `_TOKEN` | ✅ Safe, but the bot is deaf until the webhook is re-registered. | Edit `.env`, restart the API, then **`scripts/set-webhook.sh` immediately**. |
| `POSTGRES_PASSWORD` | ✅ Safe if changed in both places at once. | `ALTER USER payetam WITH PASSWORD '…'`, then `.env` — both the standalone line and the one inside `DATABASE_URL` — then restart. Changing `.env` alone does nothing to Postgres; the variable only seeds a *new* volume. |
| `REDIS_PASSWORD` | ⚠️ Queued jobs are dropped when Redis restarts without its AOF password. | Edit `.env` (twice, as above), `scripts/compose.sh up -d redis api worker`. Drain the queues first if you can. |
| `PII_HASH_PEPPER` | ⚠️ No data lost; old IP hashes stop comparing to new ones. | Edit and restart. Historical correlation in `audit_log` breaks at that point. |
| `TELEGRAM_BOT_TOKEN` | ⚠️ It is a different bot. Existing users are talking to the old one. | Only for a compromise. Revoke in @BotFather, update `.env`, restart, re-register the webhook. |
| `CHAT_ENCRYPTION_KEY` | ⛔ **Destroys data.** Every chat message and every administrator's TOTP secret is encrypted under it. | There is no safe procedure without a re-encryption job, which does not exist. `key_version` is in the schema so one can be written. Until then: do not. |

### If the server is compromised

In this order, because the order is what limits the damage:

1. **Revoke the bot token** in @BotFather. It is full control of the bot and the
   one credential that is useful off the machine.
2. Take the host off the network — do not shut it down; memory and the container
   state are evidence.
3. Assume every secret in `.env` is known. That includes `CHAT_ENCRYPTION_KEY`,
   which means every stored message and every TOTP secret must be treated as
   read.
4. Rebuild on a new host from a known-good tag, with fresh secrets for everything
   in the ✅ and ⚠️ rows above.
5. Restore from a backup taken **before** the compromise, and check
   `audit_log` for what was done in between.
6. Reset every administrator account. Their TOTP secrets were in the database and
   the key was on the machine.

This is also the argument for the public-key backup setup in DEPLOYMENT.md §10:
with the private half off the server, backups taken before the compromise stay
unreadable to whoever took it.

---

## 6. Keeping it current

| When | Do |
|---|---|
| Every deploy | `scripts/smoke-tests.sh` runs itself. Read the output. |
| Weekly | The restore rehearsal cron entry. Read the log. |
| Monthly | `docker compose pull` for the base images, then redeploy. Check `sudo ufw status` and `df -h`. |
| Quarterly | A real decrypt-and-restore on the machine holding the private key. Record it in `docs/runbook-backup-restore.md`. |
| Quarterly | Re-read this file and `docs/threat-model.md` against what the product now does. |
| On any dependency advisory | `pnpm audit`, then rebuild and redeploy. |

`docs/threat-model.md` §6 lists the changes that should trigger a review of the
application-level model: a new external integration, a new data category, a
change to how anonymity works, or anything that touches the ledger.
