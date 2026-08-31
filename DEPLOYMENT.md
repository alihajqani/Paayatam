# Deploying PayeTam

Step by step, for one Ubuntu 24.04 VPS running everything in Docker Compose.

Written for somebody who has not done this before. Every command is meant to be
pasted as written, and every one that could lose data says so before you run it.

> **On the domain.** Everything below uses `paayatam.online`. If yours is different,
> change it in three places and nowhere else: the two filenames under
> `docker/sites-available/`, the `server_name` and `ssl_certificate` lines inside
> them, and `PUBLIC_API_URL` in `.env`. Then `grep -rn paayatam.online docker/` to
> confirm nothing is left.

---

## Contents

1. [What you need before you start](#1-what-you-need-before-you-start)
2. [The server](#2-the-server)
3. [DNS](#3-dns)
4. [Getting the code](#4-getting-the-code)
5. [The environment file](#5-the-environment-file)
6. [Certificates](#6-certificates)
7. [The first deploy](#7-the-first-deploy)
8. [Seeding](#8-seeding)
9. [The first administrator](#9-the-first-administrator)
10. [Backups](#10-backups)
11. [Monitoring](#11-monitoring)
12. [The Telegram webhook](#12-the-telegram-webhook)
13. [Deploying again](#13-deploying-again)
14. [Rolling back](#14-rolling-back)
15. [Pre-production checklist](#15-pre-production-checklist)
16. [Acceptance tests](#16-acceptance-tests)
17. [Readiness matrix](#17-readiness-matrix)
18. [When something is wrong](#18-when-something-is-wrong)

---

## 1. What you need before you start

| | What | Notes |
|---|---|---|
| ☐ | A VPS | Ubuntu 24.04 LTS, amd64, **2 GB RAM minimum**, 20 GB disk. 1 GB will not build the images. |
| ☐ | A domain | `paayatam.online`, with access to its DNS records. |
| ☐ | A Telegram bot | From [@BotFather](https://t.me/BotFather). Keep the token somewhere safe. |
| ☐ | A password manager | You are about to generate eight secrets. One of them can never be rotated without destroying data. |
| ☐ | An email address | Let's Encrypt sends certificate expiry warnings there. |

Optional, and worth having before real users exist rather than after:

| | What | Why |
|---|---|---|
| ☐ | A Telegram group for alerts | Job failures and failed deploys go there instead of into a log nobody reads. |
| ☐ | Somewhere off-host for backups | A backup on the same disk as the database is not a backup of that disk failing. |
| ☐ | A GPG key pair | So backups are encrypted with a key that is **not** on the server. |

---

## 2. The server

### 2.1 A user that is not root

```bash
# As root, once.
adduser --disabled-password --gecos '' deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Log out, log back in as `deploy`, and confirm `sudo -v` works **before** you turn
off root login — locking yourself out of a fresh VPS is a rebuild, not a fix.

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### 2.2 The firewall

Three ports, and nothing else. Postgres and Redis are deliberately absent: they
publish no host port at all, so there is nothing to allow.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp     # required: Let's Encrypt validates over plain HTTP
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

> **80 is not optional.** Closing it does not make anything safer — nginx serves
> only a redirect and the ACME challenge there — and it makes every future
> certificate renewal fail, silently, until the site goes down 90 days later.

### 2.3 Docker

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git rsync

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in, then check:

```bash
docker compose version   # must be v2.x
docker run --rm hello-world
```

> **`docker` group membership is root.** Anyone in it can mount the host
> filesystem into a container. Treat it as equivalent to sudo, and do not add
> accounts to it that should not have root.

Node and pnpm are **not** installed, and must not be. Everything is built inside
containers; a Node on the host is only a second version to drift from the one the
image was built with.

### 2.4 Swap and time

A 2 GB VPS building four images will use more than 2 GB briefly.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

timedatectl                       # NTP must say active
sudo timedatectl set-ntp true
```

> **The clock matters more than usual here.** Telegram's `initData` signature has
> a freshness window, and a server minutes out of step rejects every sign-in with
> an error that says nothing about clocks.

Keep the host patched:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 3. DNS

Two A records, both pointing at the server's public address, both **DNS-only**.

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `app` | your server's IPv4 | DNS only |
| A | `admin` | your server's IPv4 | DNS only |

> **No Cloudflare proxy.** Two reasons, and the second is the one that bites.
> A proxy terminates TLS itself, so Let's Encrypt's HTTP challenge never reaches
> nginx; and it inserts a hop that rewrites `X-Forwarded-For`, which changes what
> `TRUST_PROXY` has to say — get that wrong and the API believes a client-supplied
> address. If you want a CDN later, revisit `docker/snippets/proxy.conf` and
> `TRUST_PROXY` **together**.

Wait for propagation, then check from your own machine — not from the server,
where the answer may come from a local cache:

```bash
dig +short app.paayatam.online
dig +short admin.paayatam.online
```

Both must print the server's address. Do not go on until they do: the next step
spends Let's Encrypt quota, and a wrong DNS record is the most common way to
burn it.

---

## 4. Getting the code

```bash
sudo mkdir -p /srv/payetam
sudo chown deploy:deploy /srv/payetam
git clone https://github.com/alihajqani/Paayatam.git /srv/payetam
cd /srv/payetam
git checkout v0.1.0     # a tag, never a branch — see §13
```

---

## 5. The environment file

```bash
cd /srv/payetam
cp .env.production.example .env
chmod 600 .env
```

Generate the secrets. Run these **on the server**, paste each result into `.env`,
and store the whole set in your password manager:

```bash
openssl rand -hex 24      # TELEGRAM_WEBHOOK_SECRET_PATH
openssl rand -hex 32      # TELEGRAM_WEBHOOK_SECRET_TOKEN
openssl rand -base64 32   # CHAT_ENCRYPTION_KEY
openssl rand -base64 32   # PII_HASH_PEPPER
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 24   # REDIS_PASSWORD
```

Then `nano .env` and fill in every `CHANGE_ME`. Three things people get wrong:

- **`POSTGRES_PASSWORD` is written twice** — once on its own line and once inside
  `DATABASE_URL`. Neither Compose's `env_file` nor Node's `--env-file` expands
  `${…}`, so they really are two copies and they really must match. Same for
  `REDIS_PASSWORD` and `REDIS_URL`.
- **`TRUST_PROXY=172.28.0.0/24`** is not optional behind nginx. Without it the API
  sees nginx as every caller: one IP rate-limit bucket shared by the whole
  internet, and one identical `ip_hash` on every audit row.
- **Delete any `TEST_DATABASE_URL` line.** The integration suite `TRUNCATE`s
  every table it can reach.

Now check it:

```bash
./scripts/check-env.sh
```

It refuses on a placeholder that still parses, on a password that does not match
its URL, and on a hostname that only works outside a container. Fix everything it
prints before going on.

### Which secrets you can change later

| Variable | Changing it after there is data |
|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | ✅ Safe. Everyone is signed out; the Mini App signs back in by itself. |
| `TELEGRAM_WEBHOOK_SECRET_PATH` / `_TOKEN` | ✅ Safe, **but re-register the webhook immediately** (§12) or the bot goes deaf. |
| `POSTGRES_PASSWORD` | ✅ Safe if you change it in Postgres at the same time. |
| `PII_HASH_PEPPER` | ⚠️ No data lost, but old IP hashes stop comparing to new ones. |
| `QUEUE_PREFIX` | ⚠️ Queued jobs are abandoned. The outbox is in Postgres so nothing is lost, but delivery is delayed. |
| `TELEGRAM_BOT_TOKEN` | ⚠️ It becomes a different bot. Existing users are talking to the old one. |
| `CHAT_ENCRYPTION_KEY` | ⛔ **Never.** Every chat message and every administrator's TOTP secret is encrypted under it. Change it without a re-encryption job and no operator can sign in and no message can be read. |

---

## 6. Certificates

```bash
./scripts/init-letsencrypt.sh --email you@example.com --staging
```

**Staging first.** Let's Encrypt allows five failed validations per hostname per
hour; a wrong DNS record or a closed port 80 spends that in one sitting, and then
the real attempt has to wait. The staging certificate is untrusted by browsers,
which is exactly the point — it proves the plumbing without spending quota.

When that succeeds:

```bash
./scripts/init-letsencrypt.sh --email you@example.com --force
```

What it does, and why it is not just "run certbot": nginx refuses to start
without its certificate files, and the certificate cannot be issued until nginx
is running to answer the challenge. The script breaks that circle by writing a
self-signed placeholder first, starting nginx on it, then replacing it.

Renewal is automatic from here — `certbot-renew` tries twice a day and nginx
reloads every twelve hours to pick up a new file.

---

## 7. The first deploy

```bash
cd /srv/payetam
./scripts/deploy.sh
```

Expect **10–25 minutes** the first time: it is compiling TypeScript, two Vite
bundles and a dependency tree inside Docker. Later deploys reuse the layer cache
and take two or three.

It stops on the first thing that is wrong, and it stops *before* touching what is
running whenever it can. Check it:

```bash
./scripts/compose.sh ps        # every service Up, api and postgres healthy
curl -f https://app.paayatam.online/health
curl -sI https://admin.paayatam.online/ | head -1
```

---

## 8. Seeding

`scripts/migrate.sh` already ran `seed:rbac`, and re-runs it on every deploy: it
upserts the permission catalogue the admin panel's screens are checked against,
and it is idempotent by construction.

**Every other seed is a decision, and each overwrites something.** Run them once
on a brand-new database, never on one with data you care about:

> **Set `PAYETAM_VERSION` on every one of these.** The `tools` service is tagged
> `payetam/tools:${PAYETAM_VERSION:-local}`, and `deploy.sh` exports the release
> when it calls `migrate.sh`. A bare `compose.sh` call does not — it falls back
> to `:local`, which is whatever was last built on the host by hand. The symptom
> is a seed that fails with `Command "seed:xyz" not found` because the image
> predates the script, and the worse symptom is an old seed running silently
> because the script *did* exist back then.

```bash
cd /srv/payetam
export PAYETAM_VERSION="$(cat .deploy/current-release)"

seed() { ./scripts/compose.sh --profile tools run --rm -e ALLOW_PROD_SEED=1 tools pnpm "$@"; }

seed seed:policies                        # cancellation windows, thresholds
seed seed:geography --activate=capitals   # 31 provinces, 1,252 cities
seed seed:catalog                         # activity tags, interests, districts
seed seed:blacklist                       # the moderation word list
seed seed:settings                        # default runtime settings
```

Each of these stops and asks you to **type the database name** (`payetam`) before
it writes anything. That is the M17 rail and it is not a formality: the mistake it
catches is not "did you mean to seed" but "are you pointed at the database you
think you are". It refuses outright when stdin is not a terminal, so run these
from an interactive shell — piping an answer is not an answer.

Run `seed:geography` **before** `seed:catalog`: districts attach to a city looked
up by slug, and the other way round they are skipped with a warning.

**`seed:geography` is the one seed on this list that is safe to re-run on a live
database.** It can only ever *widen* availability — a city that is active stays
active whatever `--activate` says — because a seed that could switch a served city
off is one that can take a city's users offline by being run at the wrong moment.
Pass `--activate=capitals` or `--activate=none` for a staged rollout; see
[`docs/activities-and-places.md`](docs/activities-and-places.md) §3.

| Seed | Writes | Safe to re-run? |
|---|---|---|
| `seed:rbac` | Roles and permissions | ✅ Yes — the deploy does it every time |
| `seed:policies` | Policy thresholds | ⚠️ Overwrites anything edited in the panel |
| `seed:geography` | Provinces and cities | ✅ Yes — never deactivates a served city |
| `seed:catalog` | Activity tags, interests, districts | ⚠️ Overwrites names and ordering |
| `seed:blacklist` | Blocked words | ⚠️ Overwrites the list |
| `seed:settings` | Runtime settings | ⚠️ Overwrites settings edited in the panel |
| `seed:events` | **Fake events** | ⛔ Never in production |
| `seed:gift-codes-dev` | **Coins** | ⛔ Refuses to run outside development |

> `ALLOW_PROD_SEED` stays at `0`. The API **refuses to start** if it is `1` in
> production, which is deliberate: the flag exists to be turned on for the length
> of one command and turned straight off again.

---

## 9. The first administrator

The panel has no sign-up. The first account is created by hand, and **the TOTP
secret is shown exactly once** — if you lose it before it is in your
authenticator, delete the account and make another.

```bash
cd /srv/payetam
./scripts/compose.sh --profile tools run --rm -it tools \
  pnpm create-admin --email you@example.com --name 'Your Name' --roles SUPER_ADMIN
```

`-it` is not optional: the password is asked for on the terminal, never passed as
an argument, because `ps` is world-readable and a command line ends up in shell
history. The roles are `SUPER_ADMIN`, `MODERATOR`, `SUPPORT` and `ANALYST` —
`docs/admin-panel.md` §3 has what each can reach.

Then, at `https://admin.paayatam.online`:

1. Sign in with the username, the password, and the six-digit code.
2. Confirm the session survives a page reload (it is an `HttpOnly` cookie scoped
   to `/admin`, re-read through `GET /admin/v1/me`).
3. Open one screen from each group in the navigation and confirm none of them
   403s — a 403 there means `seed:rbac` did not run.

> **A second administrator account is not optional.** TOTP secrets get lost with
> phones, and one account means one lost phone locks everybody out of moderation.

---

## 10. Backups

### 10.1 A key that is not on the server

Generate it **on your own machine**, not on the VPS. The point is that the server
holds only the public half, so an attacker who takes the server cannot read last
month's backups — and those contain every chat message and every administrator's
TOTP secret.

```bash
# On your laptop:
gpg --full-generate-key            # RSA 4096, no expiry, a strong passphrase
gpg --list-secret-keys --keyid-format=long
gpg --export --armor <KEY_ID> > payetam-backup.pub

# Copy the public half to the server:
scp payetam-backup.pub deploy@your-server:/tmp/
```

```bash
# On the server:
gpg --import /tmp/payetam-backup.pub && rm /tmp/payetam-backup.pub
gpg --list-keys --keyid-format=long
```

Back up the **private** key and its passphrase somewhere that is not the server
and not the same place as each other. A backup regime whose key is lost is a
backup regime with no backups.

### 10.2 Configure and schedule

```bash
sudo mkdir -p /etc/payetam
sudo tee /etc/payetam/backup.env > /dev/null <<'EOF'
PAYETAM_BACKUP_DIR=/var/backups/payetam
PAYETAM_BACKUP_RETAIN_DAYS=14
PAYETAM_BACKUP_GPG_RECIPIENT=YOUR_KEY_ID_HERE
PAYETAM_BACKUP_REMOTE=user@backup-host:/backups/payetam
PAYETAM_BACKUP_REQUIRE_ENCRYPTION=1
EOF
sudo chmod 600 /etc/payetam/backup.env
sudo chown deploy:deploy /etc/payetam/backup.env

sudo mkdir -p /var/backups/payetam
sudo chown deploy:deploy /var/backups/payetam
sudo chmod 700 /var/backups/payetam
```

Run one by hand before trusting the schedule:

```bash
./scripts/backup.sh
ls -lh /var/backups/payetam
```

Then, as `deploy`, `crontab -e`:

```cron
# Nightly at 03:15 UTC. Output goes to the log; failures also alert to Telegram.
15 3 * * * /srv/payetam/scripts/backup.sh >> /var/log/payetam-backup.log 2>&1

# A restore rehearsal every Sunday. A backup nobody has restored is a hope.
30 4 * * 0 /srv/payetam/scripts/restore-rehearsal.sh >> /var/log/payetam-restore.log 2>&1
```

```bash
sudo touch /var/log/payetam-backup.log /var/log/payetam-restore.log
sudo chown deploy:deploy /var/log/payetam-*.log
```

### 10.3 Rehearse a real restore

The weekly rehearsal restores into a scratch database on the server, which proves
the archive and the schema. It does **not** prove you can decrypt — the private
key is deliberately elsewhere. Once a quarter, prove the whole chain on the
machine that holds the key:

```bash
# On the machine with the private key:
scp deploy@your-server:/var/backups/payetam/payetam-<stamp>.dump.gpg .
gpg --decrypt --output restored.dump payetam-<stamp>.dump.gpg
pg_restore --list restored.dump | head
```

Write the date, the archive size and the duration into
`docs/runbook-backup-restore.md`. A rehearsal nobody recorded is one nobody can
quote when they are asked how long recovery takes.

---

## 11. Monitoring

### 11.1 The alert group

1. Create a Telegram group and add your bot to it.
2. Make the bot an administrator, or turn off its privacy mode in @BotFather —
   otherwise it cannot see its own messages and you cannot read the chat id.
3. Post any message in the group, then:

```bash
cd /srv/payetam
BOT="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | tail -1)"
curl -s "https://api.telegram.org/bot${BOT}/getUpdates" | grep -o '"chat":{"id":-[0-9]*' | head -1
unset BOT
```

Put that id (it is negative) into `MONITORING_CHAT_ID` in `.env`, then:

```bash
./scripts/compose.sh up -d worker
./scripts/notify-telegram.sh info 'Monitoring is wired up'
```

The message should appear in the group. What arrives there afterwards: jobs that
exhausted their retries, failed backups, failed deploys, and rollbacks. Nothing
routine — a channel that fires on the ordinary is a channel people mute.

### 11.2 What the worker alerts on

Five sources, and no others. Each one is a thing a person has to do something
about:

| Alert key | Raised when | What it means |
| --- | --- | --- |
| `job-exhausted:<queue>:<job>` | A job used its last retry | The queue is dropping work |
| `job-failure-write` | The failed-job record itself could not be written | The failure log has a hole in it |
| `campaign-paused:<id>` | A campaign was rate-limited three times in a row | The breaker tripped; the campaign is paused, not lost |
| `ledger.drift` | A coin balance disagrees with its ledger (nightly, 04:30) | Something wrote to `coin_account` outside `CoinService` |
| `outbox.stale` | The oldest undelivered outbox row is over 15 minutes old | Notifications are silently not being delivered |

The last two are sweeps rather than reactions, because both failures are
**invisible**: nobody complains about a notification they were never told
existed, and a drifted balance is discovered by a user disputing it weeks later.
Neither writes anything — a drift is reported, never "corrected", because
choosing between overwriting a balance somebody is holding and writing a plug
entry into an append-only ledger is a judgement call with money attached.

Every alert carries `severity`, `service`, `env`, a stable `code` and a UTC
timestamp, and **none of them carries a user id, a phone number or a message
body**. If you need to know *which* accounts drifted, the panel's
**دفتر سکه → «تطبیق موجودی‌ها با دفتر»** button asks the same question behind
`ledger.read` — because a person asking is an authorised, audited read, and an
alert is a Telegram group.

Four knobs, all in `.env` and all read by the worker at start-up:

| Variable | Default | What it does |
| --- | --- | --- |
| `MONITORING_CHAT_ID` | *(empty)* | Where alerts go. Empty disables delivery. |
| `MONITORING_ENABLED` | `1` | Kill switch. `0` silences delivery without clearing the chat id. |
| `MONITORING_MIN_LEVEL` | `warn` | Floor: `info` \| `warn` \| `error`. |
| `MONITORING_ALERT_COOLDOWN_SECONDS` | `300` | Shortest gap between two alerts sharing a key. |
| `MONITORING_ENVIRONMENT` | `NODE_ENV` | Stamped on every alert. Set it once staging also alerts. |

Turning alerting off — by either the chat id or the kill switch — **loses
delivery, not information**. Everything still goes to the container log at its
own level, so `./scripts/compose.sh logs worker | grep -i alert` is the offline
version of the group.

After changing any of them:

```bash
./scripts/compose.sh up -d worker
```

### 11.3 What to look at

```bash
./scripts/compose.sh ps                          # health of every service
./scripts/compose.sh logs -f api worker          # live, structured JSON
./scripts/compose.sh logs --tail 200 nginx
docker stats --no-stream                         # memory against the limits
df -h /                                          # the one that fills silently
```

Metrics are Prometheus format at `/metrics`, reachable **only from inside** the
compose network — see §16 for why that is checked rather than assumed:

```bash
./scripts/compose.sh exec api wget -qO- http://127.0.0.1:3000/metrics | head -30
```

Container logs are capped at 10 MB × 5 files per service by the compose file, so
they cannot fill the disk. Postgres and the backups can, which is why `df -h` is
on the list.

---

## 12. The Telegram webhook

```bash
cd /srv/payetam
./scripts/set-webhook.sh
```

It proves `https://app.paayatam.online/health` answers from the public internet
*before* it calls Telegram. That order matters: **a failed `setWebhook` deletes
the webhook the bot already had**, so a broken deploy would otherwise also make
the bot deaf.

Check what Telegram thinks:

```bash
./scripts/set-webhook.sh --info
```

| Field | Healthy |
|---|---|
| Registered host | your production hostname |
| Path | `matches .env ✓` |
| Pending updates | `0`, or a number going down |
| Last error | nothing |

The script never prints the secret path — it is a credential, and printing it
puts it in your scrollback.

### Migration 0025 and the conversation store

ADR-0017 adds `conversation_state`, which holds a user's half-filled bot form.
Nothing about the deploy changes — the migration is additive, so the previous
release runs unchanged against the new schema — but two operational facts are
worth knowing:

- **It is in the daily backup already.** `backup.sh` dumps the whole database;
  there is no table list to add to. A restore brings drafts back with everything
  else, and a draft older than seven days is swept on the next run regardless.
- **The sweep is `CONVERSATION_PURGE`, daily at 04:15 Tehran**, just after the
  retention purge. If the worker is down, drafts simply live longer; nothing
  else depends on the sweep having run.

The table is small — one row per user *currently filling in a form* — and
`form_data_ciphertext` is encrypted under `CHAT_ENCRYPTION_KEY`. **A restore into
an environment with a different key cannot read existing drafts**; they are
discarded on read and the user starts their form again, which is why this is a
note rather than a warning.

### Migrations 0029–0032 and what they switch on

Four additive migrations, and **two of them are inert on the day they land**.

| # | What it adds | Effect on deploy day |
|---|---|---|
| 0029 | `EVENT_JOIN_SPEND` on `coin_ledger_type` | **None.** `economy.event_join_coins` defaults to `0`, and the service writes no ledger row at zero — `coin_ledger.amount` may not be zero, and a row claiming somebody paid nothing is worse than no row |
| 0030 | `admin_telegram_link` | **None until a row exists**, and no row exists until somebody runs the linking tool below |
| 0031 | `ADMIN_CASE` on `conversation_kind` | **None.** A value nothing writes until a moderator is linked |
| 0032 | `REDEEM_CODE` on `conversation_kind` | **Live immediately**, and it is the one that changes a screen: `/wallet` grows «🎁 کد هدیه دارم», `/referral` grows «🎟 کد معرفی دارم», and bare `/gift` opens a form instead of reciting its own syntax. Nothing is charged and no setting gates it |

**0029, 0031 and 0032 are `ALTER TYPE … ADD VALUE`, which Postgres cannot run
inside a transaction.** That is why they are separate files, and why a later
failure does not roll them back. They are additive-only, so a partial apply is
safe — but the runbook has to say so rather than leave somebody to discover it
during an incident.

**0032 wants its containers replaced before it is worth anything, and tolerates
the reverse.** The value is written only by a build that knows the wizard, and
an old build never reads it — so the migration landing first (which is the order
`deploy.sh` runs things in) is a no-op, not a window. Rolling *back* to a release
without the wizard is also safe: a draft row of that kind is simply never
resumed, and the seven-day sweep removes it.

#### If the code form has to be switched off

`ENABLE_CONVERSATION_WIZARD=0` is the lever, and it is the same one every other
bot form is behind. With it off, `/gift <code>` still redeems — the command path
does not go through the wizard — and the two buttons are not drawn at all. What
is lost is entering a **referral** code by hand, which has no other route.

Codes are redeemed at ten an hour per account, enforced in the bot from v0.6.4
on the same `GIFT_CODE_REDEEM` bucket the API has used since M18. Before that the
bot's path was unmetered, so the limit protected one of two surfaces.

#### Charging for a join, if you ever want to

`economy.event_join_coins` is the price of *asking* to join, and it is `0`
everywhere until an operator changes it. It exists because the channel post's
«شرکت می‌کنم» button reaches the same `ParticipationService.join` the in-bot
button does: shipping a non-zero default would have started charging for every
join on every surface as a side effect of adding a button to a channel post.

Setting it is one row and needs no deploy — the admin panel's settings screen, or:

```sql
INSERT INTO app_setting (key, value, updated_at)
VALUES ('economy.event_join_coins', '15'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
```

A waitlisted request is charged like a seated one — what is paid for is the ask,
which consumes a host's attention whether or not a seat was free. There is no
refund on rejection; making it one would be a deposit, which is a different
product decision.

#### Linking a moderator to Telegram

Optional, and nothing else in the release depends on it. It is what makes the
«🛡 داوری» menu button appear for one staff member.
[ADR-0018](docs/adr/0018-admin-moderation-in-the-bot.md) is the argument,
including what it costs — it qualifies ADR-0010's clause that admin access does
not follow from a staff member's personal Telegram being taken over.

```bash
cd /srv/payetam
pnpm link-admin-telegram --by boss@example.com \
  --email mod@example.com --telegram 573914882 \
  --reason 'on-call moderation from a phone'
```

- `--by` and `--email` must be **different accounts**, and `--by` must hold
  `role.manage`. Nobody grants themselves a capability.
- The numeric Telegram user id, not an `@username`: a username is changeable by
  its owner and by whoever releases one, so it is an identifier that can be
  acquired rather than proven. The moderator can read theirs from any of the
  several bots that report it.
- Under `NODE_ENV=production` it asks you to type `link` before writing, the same
  rail every other production write script has.
- Revoke with `--revoke` and a reason. It takes effect on their **next tap** —
  the session is derived per update and nothing is cached.

What the link grants inside the bot is a hard-coded allowlist: `event.moderate`
and `report.review`. A `SUPER_ADMIN` on the bot is a moderator and no more.

### The command menu

The webhook is what lets the bot *hear*; `setMyCommands` is what lets anybody
*find* what to say. Without it Telegram's "/" autocomplete and the blue Menu
button are empty, and every command is invisible unless the user has already
read `/help` — which they could only find by guessing.

```bash
pnpm set-bot-commands            # publish what BOT_COMMANDS says
pnpm set-bot-commands --info     # read back what Telegram currently has
```

Run it **once per bot**, and again whenever `BOT_COMMANDS` changes. It is not a
per-deploy step: the list is global to the token rather than to a deployment, so
two environments sharing a token would overwrite each other on every restart —
which is why this is a script rather than something the API does at boot.

The list comes from `packages/telegram/src/commands.ts`, the same array `/help`
renders from, so the menu and the help text cannot disagree. Telegram validates
the whole array and rejects **all** of it for one bad entry; `commands.test.ts`
checks the shape before it ever gets there.

---

## 13. Deploying again

```bash
# Tag the release, from your own machine:
git tag -a v0.2.0 -m 'M20: containerised deployment'
git push origin v0.2.0
```

Then either let `.github/workflows/deploy.yml` do it, or on the server:

```bash
cd /srv/payetam
./scripts/deploy.sh v0.2.0
```

**A tag, never a branch.** A deploy needs a name you can say out loud in an
incident, and "the tip of main at about four o'clock" is not one.

What happens, in order — and the order is the point:

1. `check-env.sh`. A placeholder found here costs a minute; found later it costs
   a crash loop.
2. The current release is written to `.deploy/previous-release`. Before anything
   changes, because after a failure is when it cannot be worked out.
3. The tag is checked out. Uncommitted changes on the server abort the deploy.
4. Images are built. **Nothing is stopped yet** — a failed build leaves the
   previous release serving traffic.
5. A backup is taken, then migrations run. This is the point of no return: a
   migration is the one part of a deploy that `rollback.sh` cannot undo.
6. Containers are replaced and nginx is reloaded.
7. Health check, then smoke tests. A deploy nobody verified is one whose failure
   is discovered by a user.

Expect a few seconds of downtime at step 6. Telegram redelivers webhook updates
it could not deliver, and the outbox lives in Postgres, so nothing queued is lost.

### Confirming which release is actually running

From M22 the release string is visible in three places, and they are the same
string: `deploy.sh` exports `PAYETAM_VERSION` from the tag, Compose tags every
image with it, passes it into the `web` build so both bundles are compiled with
it, and hands it to the API through `environment:`.

```bash
curl -s https://app.paayatam.online/api/v1/version    # {"version":"v0.3.0"}
```

`smoke-tests.sh` asserts this automatically and fails the deploy if it disagrees
with the release being deployed — which is the one symptom of a container that
was never actually replaced.

The two frontends show it too: the foot of the Mini App's home screen, and the
foot of the panel's sidebar. The panel shows the API's release beside its own,
because the two roll separately — nginx serves the new bundle as soon as its
container is up while the API is behind its own start-up and its own migration
step. A minute of disagreement there is normal; a persistent one is not.

The Mini App additionally tells a user when their bundle is behind the server,
because a Telegram WebView caches hard and reopens without asking. That is the
state that makes a bug report unreproducible, so it says so on the screen rather
than leaving it to be worked out.

**If nothing was passed**, all of it reads `local` — which is a wrong answer to
"which release is this" and a deliberate one: it is obviously fake, where a blank
or a literal `${PAYETAM_VERSION}` is just confusing.

---

## 14. Rolling back

```bash
cd /srv/payetam
./scripts/rollback.sh            # to whatever the last deploy replaced
./scripts/rollback.sh v0.1.9     # or to a named tag
```

It rebuilds the images at the old tag, restarts, and verifies. Because the SPA
bundles are baked into the nginx image, the frontend goes back too — a rollback
that left today's Mini App talking to yesterday's API would be worse than none.

**It does not undo migrations.** The script counts the migrations applied since
the target and makes you read them:

- Only `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX` → the old code ignores what
  it does not know about, and the rollback is clean.
- Any `DROP` or `RENAME` → the old code will query something that is gone. Stop,
  and restore instead:

```bash
./scripts/restore.sh /var/backups/payetam/payetam-pre-v0.2.0-<stamp>.dump.gpg
```

That backup exists because `deploy.sh` takes one immediately before migrating.

---

## 15. Pre-production checklist

Everything here should be true before the first real user.

**Server**

- [ ] SSH is key-only and root login is off
- [ ] `ufw status` shows exactly 22, 80, 443
- [ ] `timedatectl` reports NTP active
- [ ] Swap is on, and `df -h /` shows plenty free
- [ ] `unattended-upgrades` is enabled

**Secrets**

- [ ] `./scripts/check-env.sh` passes with no warnings you have not read
- [ ] `ls -l .env` shows `-rw-------`
- [ ] Every secret is in a password manager
- [ ] `git status` shows no `.env` — and CI fails the build if one is ever tracked

**TLS and DNS**

- [ ] Both names resolve to the server, DNS-only
- [ ] Both origins serve a trusted certificate
- [ ] `http://` redirects to `https://` on both
- [ ] `/.well-known/acme-challenge/` is **not** redirected

**Application**

- [ ] Every service is `Up`; `api` and `postgres` are `healthy`
- [ ] `seed:rbac` has run and the panel opens every screen without a 403
- [ ] Two administrator accounts exist, both TOTP secrets stored
- [ ] The webhook is registered, with no `last_error_message`

**Closed from outside**

- [ ] `/metrics` returns **404** on both origins
- [ ] `/ready` returns 404 on both origins
- [ ] `/api/` returns 404 on the admin origin
- [ ] `docker ps` shows a published port only for nginx

**Backups**

- [ ] A backup has run and produced an encrypted file
- [ ] A restore rehearsal has passed, and the duration is written down
- [ ] The off-host copy works
- [ ] The private key is **not** on the server, and is itself backed up

**Monitoring**

- [ ] An alert reaches the Telegram group
- [ ] `docker stats` shows every container inside its limit

---

## 16. Acceptance tests

Most of this is automated:

```bash
cd /srv/payetam
./scripts/smoke-tests.sh
```

It asserts, one line each: every container is running; the API's dependencies are
reachable; `/health` answers 200 with the right body; both bundles are served and
their hashed assets resolve; history-mode routing falls back to `index.html`;
`/metrics` and `/ready` are 404 from outside; the webhook route answers 200 to a
wrong secret (which is the designed behaviour — a 401 would let an attacker probe
for valid secrets); the admin API 401s without a session; the Mini App API is not
exposed on the admin origin; the panel refuses to be framed; HTTP redirects but
the ACME path does not; the worker registered its processors; and a backup both
completes and restores.

> **The check most worth understanding** is `/metrics`. The application's own
> guard allows private addresses — sensible, and behind a proxy it means *every*
> request looks private. Only the nginx rule stands between queue depths and the
> public internet, so both the smoke tests and the deploy workflow assert it, in
> two places nobody can quietly delete at once.

What still has to be done by hand, in Telegram, with real accounts:

| | Test | Passes when |
|---|---|---|
| ☐ | Open the Mini App from the bot | Onboarding appears, in Persian, RTL |
| ☐ | Complete onboarding | Profile saves and survives a reload |
| ☐ | Create an activity | It appears in discovery |
| ☐ | Join from a second account | Capacity decreases; a notification arrives |
| ☐ | Fill an activity, then join with a third | Waitlisted, not rejected |
| ☐ | Cancel a confirmed join | A waitlisted user is promoted and notified |
| ☐ | Send a chat message | It arrives, and both sides stay anonymous |
| ☐ | Leave feedback from both sides | Neither is visible until both are in |
| ☐ | Report something | It appears in the panel's moderation queue |
| ☐ | Redeem a gift code | Coins land; the ledger balances |
| ☐ | Suspend an account from the panel | The Mini App refuses it immediately |
| ☐ | Run the B4 privacy gate | Per `docs/b4-privacy-gate.md` |

---

## 17. Readiness matrix

| Area | State | What is missing |
|---|---|---|
| Images and compose | ✅ Ready | — |
| TLS and renewal | ✅ Ready | Needs the domain to exist |
| Migrations and RBAC | ✅ Ready | — |
| Deploy and rollback | ✅ Ready | — |
| Backups | ⚠️ Ready, unconfigured | A GPG key and an off-host destination are yours to choose |
| Alerting | ⚠️ Ready, unconfigured | `MONITORING_CHAT_ID` |
| Automated verification | ✅ Ready | — |
| Manual acceptance | ⛔ Not done | §16's table, in real Telegram |
| Administrator accounts | ⛔ Not done | §9, twice |
| Load testing | ⛔ Not done | No figures exist for this product under load |
| WAL archiving / PITR | ⛔ Not set up | Nightly dumps only: the worst day loses up to 24 hours. `docs/runbook-backup-restore.md` has the procedure |

**Honest summary.** The deployment is repeatable, verifiable and reversible. What
stands between it and real users is not infrastructure: it is the manual
acceptance pass, two administrator accounts, and a backup destination you have
chosen and restored from at least once.

---

## 18. When something is wrong

**`docker compose config` complains about `.env`** — you ran it from somewhere
that is not the repository root. Use `./scripts/compose.sh`, which always passes
an absolute path.

**nginx will not start: "cannot load certificate"** — the certificate files do
not exist yet. Run `./scripts/init-letsencrypt.sh --email you@example.com`.

**Every proxied route returns 502** — the API is not up, or nginx cached its old
address. `./scripts/compose.sh logs --tail 50 api`, then
`./scripts/compose.sh exec nginx nginx -s reload`.

**The API exits immediately** — it validated the environment and refused. The
reason is the first thing in its log, and it lists every problem at once:

```bash
./scripts/compose.sh logs --tail 40 api
```

**`password authentication failed`, but Postgres is up** — `DATABASE_URL`'s
embedded password has drifted from `POSTGRES_PASSWORD`. `./scripts/check-env.sh`
names it. Note that changing `POSTGRES_PASSWORD` after the volume exists does not
change the password *in* Postgres; use `ALTER USER` for that.

**Rate limits refuse ordinary users** — `TRUST_PROXY` is unset or wrong, so every
caller shares one bucket. It must be `172.28.0.0/24`, matching the frontend
network in the compose file.

**The bot has gone silent** — `./scripts/set-webhook.sh --info`. A
`last_error_message` or a growing pending count means Telegram cannot reach the
endpoint; fix that first, then re-register.

**Certificates are close to expiry** — `./scripts/compose.sh logs certbot-renew`.
Usually port 80 got closed, or the challenge path is being redirected.

**The disk is full** — in order of likelihood: old images
(`docker image prune -a`), the build cache (`docker builder prune`), backups
(check the retention setting), then Postgres itself.

**A deploy failed halfway** — read what it printed. If it stopped before the
migration, nothing changed and you can fix and rerun. If it stopped after,
`./scripts/rollback.sh` and read what it says about the migrations in between.
