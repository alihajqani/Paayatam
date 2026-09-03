# The Admin Panel

**`apps/admin` — Vue 3 + Vite + Pinia + Tailwind, RTL Persian, desktop-first.**
Built in M19; closes blocker B2. Every screen talks to `/admin/v1`, which has existed and been
authorised since M12 ([ADR-0010](adr/0010-admin-auth-rbac-and-break-glass.md)).

| Read this for | Go here instead for |
|---|---|
| How to run it, what each screen does, what it cannot do | [ADR-0010](adr/0010-admin-auth-rbac-and-break-glass.md) — why staff identity is separate |
| The permission each screen needs | [ADR-0016](adr/0016-gift-code-campaigns-and-admin-panel.md) — why a gift code is a bearer secret |
| Setup and deployment | [`project-review.md`](project-review.md) §5.2 — the route list |

---

## 1. Running it

```bash
make dev                        # starts postgres, redis, tsc, api, worker, mini app, admin
open http://127.0.0.1:5174
```

`make status` reports it beside the others. `make logs SERVICE=admin` tails it.

Standalone, if you only want the panel:

```bash
pnpm --filter @payetam/admin dev      # http://127.0.0.1:5174
```

### The one thing that will bite you

**The panel and the API must be the same origin.** The session is an `HttpOnly` cookie scoped to
`/admin`, and the API sets **no CORS headers at all** — so a panel served from a different origin is
signed out on every request with no useful error to read.

- In development, Vite proxies `/admin` → `http://localhost:3000`. That is why the panel is reached
  at `127.0.0.1:5174` and not at the API's port.
- In production, nginx serves the built bundle and proxies `/admin/v1` to the API. `VITE_ADMIN_API_BASE_URL`
  exists for neither of those cases and pointing it at another origin fails on the cookie, not on the
  fetch.

The cookie is set `Secure`. Browsers treat `http://localhost` and `http://127.0.0.1` as trustworthy
origins, so this works in development — but it will **not** work over plain HTTP to a LAN address or
a remote host. Use `https` anywhere that is not loopback.

### Creating the first staff account

There is no self-service sign-up and there is not going to be one: `admin_user` has no foreign key to
`user`, and the separation is the security control. Accounts are created through
`AdminAccessService.createAdmin`, which returns the TOTP secret **once**:

```bash
pnpm seed:rbac        # roles and permissions, from the code catalogue — required first
pnpm create-admin --email you@example.com --name 'Your Name' --roles SUPER_ADMIN
```

`tools/create-admin.ts` calls `createAdmin` rather than reimplementing it, so the row, the roles and
the audit entry are still written in one transaction. It asks for the password on the terminal —
never as an argument, because `ps` is world-readable — and prints the TOTP secret to stdout, once,
with an `otpauth://` URI you can turn into a QR code.

Provision it into an authenticator immediately and sign in once to confirm before closing the
terminal. The secret is encrypted at rest and is never readable again; a lost authenticator is an
out-of-band recovery procedure, not an endpoint — which is also the argument for making a **second**
account while you are here.

In production it asks you to type `create` first. That is the same rail `tools/seed-guard.ts` puts in
front of every other production write, and for the same reason: the mistake worth catching is not
"did you mean to do this" but "are you pointed at the database you think you are".

### Sample data for the gift-code screens

`make seed-gift-codes-dev` writes six named fixtures — one per redemption outcome — plus a fresh
batch of 25, so every state on those screens has something in it. It refuses under any `NODE_ENV`
other than `development` or `test`, with no `ALLOW_PROD_SEED` escape hatch, because there is no
correct way to run it against production.

---

## 2. Signing in

Email **and** password **and** a TOTP code. All three, always (D11). Five failures start a lockout
that grows: 1, 5, 15, 60, 240 minutes.

Every refusal answers identically — `INVALID_CREDENTIALS` — whether the email is unknown, the
password is wrong, the code is wrong, or the account is suspended. That is deliberate: telling them
apart turns the endpoint into an oracle for which staff addresses exist. The panel repeats the
server's sentence rather than improving on it.

### The session, and why a reload works

Two values, split on purpose:

| | Where it lives | Why |
|---|---|---|
| Session token | `HttpOnly` cookie, `SameSite=Lax`, `Secure`, path `/admin` | Script on the origin cannot read it, so script cannot steal it |
| CSRF token | The Pinia store, in memory, for the lifetime of the tab | `SameSite=Lax` still permits top-level GET navigations, so the cookie alone is not enough for a mutation |

**Neither is persisted by the panel.** Putting the CSRF token in `localStorage` would hand the second
half of the pair to anything that runs on the origin, and the reason they are split would be gone.

A reload therefore starts from `GET /admin/v1/me`, which returns the identity **and the CSRF token**.
That is the ordinary synchroniser-token delivery and it is safe for the reason the pattern works at
all: a cross-site page can *cause* an authenticated request with the cookie attached and can never
**read** the response. Nothing here is reachable by JSONP or a form post, and there are no CORS
headers.

Sessions idle out after twelve hours, refreshed on every request. Revocation is immediate — the
session is re-read from Redis on every request rather than verified from a signature.

If the API ever answers 401 mid-session, the client clears the store and the router lands on the
login screen with the path you were on, so signing in finishes the journey.

---

## 3. Screens, and the permission each needs

Navigation is built from the router's `meta`, filtered by what the session holds — one declaration,
two consumers, so a menu entry cannot point at a page the guard refuses.

| Screen | Permission | What it does |
|---|---|---|
| نمای کلی (dashboard) | `dashboard.read` | Users, events, participations, chats, reports, cases, coin supply, referrals, gift codes, failed redemptions, moderation backlog, and live database/Redis health |
| کاربران | `user.read` | Search by name or `publicId`, filter by status, paginate |
| پروندهٔ کاربر | `user.read` | Profile, reputation, balance and where it came from, events, participations, referrals, gift codes, reports both ways. Suspend/ban/restore needs `user.ban`; manual coin and trust adjustment need `coin.adjust` / `trust.adjust` |
| فعالیت‌ها | `event.moderate` | Search, filter, hide, restore |
| گزارش‌های تخلف | `report.review` | The report queue, oldest first, with filters and decisions |
| گزارش‌های مشکل | `report.review` | What users say is broken about the **product** — see §13 |
| پرونده‌های بررسی | `event.moderate` | The moderation cases the automation opens, with the `falsePositive` classification |
| کدهای هدیه | `giftcode.manage` | Mint one, mint a batch, campaign roll-up, filter, find an exact code |
| گزارش کد هدیه | `giftcode.manage` | Per-code analytics, redemption history, retune, disable |
| کدهای هدیه (list) | `giftcode.manage` | Disabling and re-enabling a code is on the **list** as well as the detail page (v0.6.5) — see §4 |
| معرفی دوستان | `referral.manage` | The fraud queue, with reject and reinstate |
| دفتر سکه | `ledger.read` | Search the ledger, and reconcile balances against it |
| گزارش رخدادها | `audit.read` | The audit trail, filterable, with payloads |
| تنظیمات | `settings.manage` | Every policy number in `app_setting` |
| تفریحات | `catalog.manage` | Activity tags and the places they belong to (M21) |
| پیام‌ها | `message.send` | Telegram messages and broadcasts — see §9. A broadcast additionally needs `message.broadcast` |
| کانال‌های اجباری | `channel.manage` | The channels users must join, in order, and whether the requirement is on — see §11 |
| شهرها و استان‌ها | `catalog.manage` | Provinces and cities: create, rename, reorder, activate — see §10 |
| اسناد حقوقی | `policy.read` | Terms, privacy and rules. Editing a draft needs `policy.manage`, publishing needs `policy.publish`, and the acceptance log needs `policy.consent.read` — see §12 |

**The guard is a courtesy, not a control.** Every one of those permissions is checked again in the
service layer, which is where invariant 12 lives. An operator who edits the URL reaches a page that
answers 403 to everything on it. What the guard buys is that they land on «دسترسی ندارید» with the
missing permission named, rather than on a page full of red boxes.

An `ANALYST` — `dashboard.read` and nothing else, by ADR-0010 — sees one link.

### Which release you are looking at (M22)

The foot of the sidebar shows two version strings: **پنل**, the bundle this tab is
running, and **سرور**, the release the API reports. They come apart during a
deploy and that is normal — nginx serves the new bundle the moment its container
is up, while the API is behind its own start-up and its own migration step. A
minute of disagreement is a rollout; a persistent one means a container was not
replaced, and `curl -s https://app.paayatam.online/api/v1/version` is the way to
confirm from outside.

---

## 4. Gift codes: what changed, and what it means for you

[ADR-0016](adr/0016-gift-code-campaigns-and-admin-panel.md) reclassified a gift code as a **bearer
secret**: whoever holds the string gets the coins. Three consequences you will notice.

### The panel never shows you a code

Lists render `NOWR••••4F2Z`. The plaintext is returned **once**, by the call that created it, and
nothing in the product returns it again. A stolen admin session can therefore watch every campaign
and spend none of them.

### Disabling one, from the list (v0.6.5)

The kill switch lived only on «گزارش کد هدیه» — so switching off a leaked code was
find it, open it, scroll, confirm, repeated per code, in an incident, with the last
one staying live longest. It is now on the list too, beside «گزارش», and it is the
same endpoint either way.

Disabling asks for confirmation; re-enabling does not. One of the two directions
makes a live code unusable for everybody holding it, and asking twice about the
reversible half teaches people to click through the dialog that matters.

When the incident is bigger than one campaign, `giftcode.enabled` in §7 turns
redemption off everywhere at once.

### Bulk codes are gone when you close the tab

`POST /admin/v1/gift-codes/batch` generates on the server with a CSPRNG and hands the list back once.
The panel offers a download built in your browser from what is already on screen. If you lose them,
the recovery is: disable the batch (findable by its `batchId`) and mint another.

### Everything is addressed by `public_id`

A code in a URL path is a code in the nginx access log, in every proxy between you and the database,
and in your browser history. So:

| Was (M18) | Is (M19) |
|---|---|
| `POST /admin/v1/gift-codes/NOWRUZ1405/active` | `POST /admin/v1/gift-codes/:publicId/active` |
| `GET /admin/v1/gift-codes` → `codes[].code` | `GET /admin/v1/gift-codes` → `codes[].codeMasked` + `codes[].publicId` |

**Finding a specific code** is still possible: `GET /admin/v1/gift-codes?code=NOWRUZ1405` matches
**exactly**, normalized server-side. An operator holding a code a user quoted at them finds its row;
an operator holding nothing cannot enumerate a campaign. A prefix search would have handed the
campaign over, which is why there is not one.

### A code is matched **exactly** (v0.6.5)

Case, spaces and dashes all count. Until v0.6.5 the input was upper-cased and
stripped of separators before anything compared it — the same normalization
referral codes use — so a campaign code `test1` was also redeemable as `test 1`,
`TEST-1` and `T E S T 1`. Coins were granted for codes nobody had issued.

That normalization is right for a referral code: it is generated from a fixed
alphabet, and «abc-123» and «ABC123» are the same nine characters read aloud. It
is wrong for a gift code, whose text you choose and which is worth money — every
string within one edit of a real code was a live code.

What this means for you: **the code you type when you mint one is the code**. It
is stored exactly as written, lower case included, and the panel refuses a code
with a space in it — a code with a space will be mistyped by somebody, and mistyped
now means refused. Leading and trailing whitespace is still forgiven, because it is
invisible and comes from pasting.

Bulk codes are unaffected: they are generated from `CODE_ALPHABET` in upper case
and always were.

**Check your live campaigns before you announce this one.** Codes minted *before*
v0.6.5 were transformed on the way into the table, so a code you created as
`summer-24` is stored as `SUMMER24` — and from this release on, `SUMMER24` is the
only string that redeems it. Nothing in the database changed and no code stopped
working; what changed is that only one spelling of it works now, and it is the
stored one rather than the one you typed.

The stored spelling is what the «کدهای هدیه» list has always displayed, so a code
you hand out by copying it off that screen is already correct. The one that bites
is a code printed on something — a poster, a channel post, a partner's message —
in the form you originally typed. Search for the campaign in the list, read the
code as it appears there, and either use that spelling from now on or mint a
replacement in the casing you want and disable the old one.

### `perUserLimit` is 1

For anything created from now on. A campaign is bounded by two numbers — the global cap and the
per-user limit — and loosening the second collapses them into one. The *column* is deliberately not
constrained, so historical codes above 1 keep working exactly as they did and their reports carry a
note saying so.

### Editing changes the future only

`gift_code_redemption.coins` snapshots what was granted, and `coin_ledger` is append-only under a
trigger. Retune a campaign from 50 coins to 80 and every past redemption still reads 50 — visible in
the redemption table on the report page. The editor says so before you save.

---

## 5. Referrals: rejecting one

`referral.status = REJECTED` was an enum value nothing wrote until M19. T6 records velocity signals
*for admin review* and deliberately does not enforce them, because a wrong automatic rejection
silently steals a real user's reward — so the signals go in front of a human, and this is the human's
button.

- **Nothing here pays anybody.** Rejecting withholds a reward that has not been earned; reinstating
  restores the chance to earn one, and `ReferralService` still checks the attendance condition itself.
- **A qualified referral cannot be rejected.** Two `coin_ledger` rows say it paid and the ledger is
  append-only; a status contradicting them would be a record disagreeing with itself. Clawing coins
  back is `CoinService.reverse`, a separate and deliberate act.
- **There is no `REJECTED → QUALIFIED`.** An admin may restore a chance and may not grant a reward.
- A reason **code** and a written note are both required. The code is countable; the note is internal
  and the user never sees either, because naming the signal that fired to the person it fired on is
  telling a farmer what to change.

The user is told the status and nothing else. `WalletView` renders «این دعوت تأیید نشد» rather than
leaving «در انتظار» on a referral that will never pay.

---

## 6. What the panel deliberately does not do

Each of these is a gap in the **API**, and the panel does not mock one up.

Two entries left this table in **v0.7.0** and are recorded here rather than
deleted, because "why is there no assign button" is a question somebody asked
once and will ask again:

| Was missing | Now |
|---|---|
| **Claim / assign a report or case** | `POST /admin/v1/moderation/cases/:id/triage` with `CLAIM` writes `assigned_admin_id` and moves the case to `IN_REVIEW`; `RELEASE` hands it back. Two moderators no longer collide on the decision |
| **Escalate a case** | The same endpoint with `ESCALATE`. The assignment is **kept** — an escalated case is still somebody's until a decision closes it |
| **Read the case before deciding it** | `GET /admin/v1/moderation/cases/:id` returns the activity, its owner and every complaint with the reporter's own words. Never who wrote them, and the screen says so |

What is still missing:

| Missing | Why |
|---|---|
| **Break-glass chat unseal** | The API has it (`POST /chats/:id/unseal`) and it is deliberately **not** on a screen yet. It needs an open case, a written reason and a 15-minute box, and every message read is audited individually (T14) — a workflow that deserves designing rather than a button |
| **Role changes / four-eyes approval** | `POST /roles/requests` and its approval exist. Same reasoning: a capability that lets one account become every role wants a considered screen |
| **Blacklist and policy management** | §6 lists them; no API was built for them in M12 and none is invented here. **Catalog management shipped in M21** — see §7.1 |
| **CSV export of the ledger or the audit trail** | Both are paginated reads. An export is a decision about where a file of user records is allowed to go, and it belongs with a retention answer |

---

## 7. Settings

Every tunable number in `app_setting`, from the **code** catalogue (`SETTING_DEFAULTS`) rather than
from the table — a key in the database and not in the code is a leftover nothing reads, and putting
it on a screen would invite tuning it. There is no free-form key field and the service refuses
anything outside the catalogue, so there is no path that could become an "edit any environment
variable" screen. Secrets are environment variables the process reads at boot and have never been in
this table.

Each row shows its documented default beside its current value. A change needs a reason and lands in
`audit_log`.

**When a change takes effect:**

| | |
|---|---|
| Most values | The next request. `SettingsService` reads through to the database every time |
| Rate limits (`RATE_LIMITS`) | **Never** — they are deliberately compile-time constants, and the reason is in `rate-limit.service.ts`: a limiter that reads Postgres on the hot path stops working when the database is the thing under strain |
| Scheduled sweeps | Their next tick. A job keeps what it has already read |

No setting needs a restart.

**Three switches worth knowing by name** (v0.6.5). Each is `1` for on and `0` for
off, and each turns a whole feature rather than tuning a number:

| Key | Off means |
|---|---|
| `channel.enabled` | The product stops writing to the Telegram channel. A kill switch rather than a feature flag: a public surface the product cannot stop posting to keeps posting through an incident |
| `giftcode.enabled` | **No gift code can be redeemed, on any surface.** `gift_code.is_active` stops one campaign; this stops all of them, for the case where a code has leaked to a large channel and the answer is "no codes until we know what happened". Minting and disabling keep working while it is off — you have to be able to clean up during the incident you turned it off for |
| `release.announce_enabled` | A deploy no longer tells every user that it happened. Read by the **worker at boot**, so flipping it takes effect on the next deploy, which is when the decision is made. Leave it on unless you are shipping three hotfixes in an afternoon |

### 7.1 Activity tags — «تفریحات» (M21)

`catalog.manage` sat in the permission catalogue from M12 with nothing behind it: the panel could
authorise an act nobody could perform. **پنل مدیریت → سیستم → تفریحات** (`/activities`) is that act.

Add, rename, re-icon, reorder, enable, disable and delete the activity tags a host files an event
under — and set which cities each is offered in. Adding an activity used to mean editing
`tools/seed-catalog.ts`, getting a review and shipping a release, which is the wrong shape for a
list whose job is to grow every time the product enters a city it has not served.

Four refusals the screen surfaces rather than discovers:

- **A slug cannot be renamed.** There is no slug field on the update endpoint at all. It is the
  identifier seeds, tests and documentation refer to.
- **A tag with events cannot be deleted.** `event.category_id` is `RESTRICT`; the row carries its
  `eventCount`, so the button is disabled with the count in the tooltip. Deactivate instead.
- **Reordering is one request.** Up/down sends the whole order in a transaction, so a half-applied
  change cannot leave the list in an order nobody chose.
- **A city restriction can only name a real city.** The picker is fed by `GET /admin/v1/places`.

The «عنوان دلخواه» checkbox is the «سایر» behaviour: hosts type their own activity name, which is
blacklist-scanned like the event title. It is a column (`category.allows_custom_label`), not a
`slug === 'other'` check, so renaming the row or adding a second catch-all needs no release.

Everything writes `audit_log` (`catalog.tag.created` / `.updated` / `.deleted` / `.reordered`).

Cities, districts and interests stay seed-managed — cities are now generated data with a provenance,
and a screen for hand-editing 1,252 generated rows would invite the drift the generator prevents.
[`docs/activities-and-places.md`](activities-and-places.md) is the full guide, including how to do
any of this from a seed file instead.

---


### 7.2 The daily activity limit, and the number that used to lie about it

`events.max_per_day` and `events.max_concurrent_active` are two different quotas.
Until v0.6.5 both refused with one error code whose Persian named the **daily**
limit — so a host stopped by the *concurrency* quota was told they had hit a daily
cap, and an operator who then raised `events.max_per_day` from 5 to 30 watched the
product carry on refusing and reasonably reported the setting as broken.

They are now separate codes with separate messages, and the bot's message names
the number you actually configured. If a host says they cannot create an activity,
the message they were shown now tells you which of the two to look at.

The daily quota also counts **created**, not *live*: an event created and then
cancelled has still spent a slot for that Tehran day.

## 8. Deploying it

The bundle is static, and in production it is **baked into the nginx image** and served from a host of
its own. The working configuration is `docker/sites-available/admin.paayatam.online.conf`; the whole
procedure is in [`DEPLOYMENT.md`](../DEPLOYMENT.md).

`pnpm --filter @payetam/admin build` writes `apps/admin/dist`. `pnpm build` builds it alongside the
Mini App, and `docker/Dockerfile`'s `web` target copies both into the image — which is what makes a
rollback restore the panel as well as the API.

### A dedicated host, not a sub-path

This section used to show `location /admin { alias …; }`. **That cannot work with this build**, and it
is worth saying why rather than just deleting it: neither `vite.config.ts` sets `base`, so the bundle
references its assets at `/assets/…`. Mounted under `/admin`, every one of them 404s — the page loads
and stays blank, which reads like a JavaScript error rather than like a path problem.

So the panel gets `admin.paayatam.online` and is served at `/`, which is what the build already assumes.
The alternative — adding `base: '/admin/'` to `apps/admin/vite.config.ts` — is a real option, but it is
a code change, and it would put the panel on the same origin as the Mini App, where the two CSPs have
to differ (the Mini App must allow framing by Telegram; the panel must not be framed at all).

### Same origin as the admin API, which is not optional

`admin.paayatam.online` serves the bundle *and* proxies `/admin/v1/` to the API. Both halves are forced:

- The API sends **no CORS headers** (`apps/api/src/common/security-headers.ts`).
- The session cookie is `Secure`, `SameSite=Lax`, `path=/admin`, and sets no `Domain` — so it is
  host-only. A panel on a different origin would simply never send it, and every request would 401
  with nothing in the browser console to explain why.

### On restricting access

**No network restriction is applied.** That is a recorded decision rather than an omission — see
[`SECURITY.md`](../SECURITY.md) §4, risk 1: the operator has no fixed address and no VPN, and a control
they cannot administer is one they will disable during an incident. What stands in front of the panel
is TOTP plus the session cookie, which is genuinely two-factor, and nginx rate-limits `/admin/v1/`
below `ADMIN_LOGIN`'s own per-address limit.

An `allow`/`deny` block is pre-written and commented in the site file, at **server** level so it covers
the API and the bundle together — an allowlist on `/admin/v1/` alone leaves the login page reachable,
and one on `/` alone leaves the API reachable, which is the half that matters. Uncomment it the day
there is a fixed address to allow.

---

## 9. Messages — «پیام‌ها» (M22)

Two things behind one screen, and the difference matters more than the shared UI
suggests.

**A direct message** goes to one person. `message.send` is enough.

**A broadcast** goes to a filtered slice of the user base. It additionally needs
`message.broadcast`, which by default only `SUPER_ADMIN` holds.

### Nothing sends until you confirm, and the confirmation is typed

The flow is deliberately three steps: **compose → preview → confirm**.

The preview is a real dry run. It resolves the filter against the live database
and tells you how many people match — and it writes no outbox row, charges
nothing and sends nothing. A campaign created from it sits in `DRAFT` and stays
there.

Confirming asks you to type the recipient count back. That is not a checkbox
being awkward: a checkbox is a reflex, and the number is the one fact worth
checking twice. If the count changed between preview and confirm — somebody
signed up, somebody was banned — the confirmation is refused and you preview
again. You cannot broadcast to more people than you looked at.

### After it starts

The campaign screen shows `PENDING` / `SENT` / `FAILED` / `SKIPPED` per campaign
and updates as the worker drains the queue. Three controls:

- **توقف (pause)** stops delivery where it is. Already-sent messages are sent;
  Telegram has no unsend.
- **ادامه (resume)** picks up from the first `PENDING` recipient. It cannot
  re-send, because a recipient row moves out of `PENDING` before the send and the
  unique `(campaign, user)` index is what makes that stick.
- **لغو (cancel)** ends it. A cancelled campaign cannot be resumed.

### What it will not do

- It will not send to somebody who has blocked the bot. `telegram_account.bot_blocked`
  is part of the filter, and a `403` from Telegram sets it — so the second
  broadcast is smaller than the first, and that is correct rather than a bug.
- It will not retry a permanent failure. A blocked bot, a deleted account and a
  malformed chat id are terminal; the recipient is marked `FAILED` with a reason
  and never touched again.
- It will not exceed Telegram's rate limit. Delivery is one queue with bounded
  concurrency, and a `429` carrying `retry_after` parks the whole queue for
  exactly that long rather than hammering through it.

---

## 10. Cities and provinces — «شهرها و استان‌ها» (M22)

Provinces group cities; nothing else references a province, so renaming or
reordering one is cosmetic.

**A city is referenced by profiles and events**, which is why deactivating and
deleting are different acts and only one of them exists. There is no delete. A
city you turn off disappears from the picker and from search, and every profile
and event already pointing at it is untouched — the reference stays valid, the
history stays readable, and nobody's profile silently loses its city.

`slug` is unique and permanent. `nameFa` is what people read and can be corrected
freely; `name_normalized` is recomputed from it on save, which is what keeps
«قايم» finding «قائم‌شهر» after a rename.

Reordering sets `sort_order`, which is the order the picker shows before anybody
types.

---

## 11. Required channels — «کانال‌های اجباری» (M22, several channels in v0.3.1)

Two independent things on one screen.

**Which channels there are.** A list, in an order you set. Each row carries a
title (what the *user* reads above the join button — «کانال اصلی پایه‌تم», not
`@payetam_main`), a chat identifier, an optional public username and an invite
link. «↑» and «↓» change the order, which is the order users are shown them in
and asked to join them in.

The link is validated and *rebuilt* on save: only `https://t.me/…` and
`https://telegram.me/…` are accepted, and what gets stored is the scheme, the host
and the path — any query string, fragment or embedded credentials are dropped
rather than echoed back. That is a security control, not tidiness: this value
becomes an `href` in a button every user sees.

**Whether membership is required.** Off by default, and it stays off until
somebody deliberately turns it on. When on, a user must be a member of **every
active channel** — joining one of three is not enough — and you choose which
actions the requirement gates. An empty list means the requirement is inert.

### The five gated actions

| Action | Enforced by |
| --- | --- |
| `APP_ACCESS` | **The bot's router** (v0.6.5), and the Mini App's. Every command, message and tap is refused with the join screen. |
| `EVENT_CREATE` | `EventService.create` |
| `EVENT_JOIN` | `ParticipationService.join` |
| `EVENT_CHANNEL_SEND` | `EventService.publishToChannel` |
| `EVENT_INVITE` | `InvitationService.inviteTop` |

`APP_ACCESS` is the odd one and the panel says so under the checkbox. The other
four name a server-enforced operation and no client can talk its way past them.
`APP_ACCESS` has no single operation behind it — it means "do not let this person
use the product at all", which is a navigation rule. It is deliberately *not*
in `AuthGuard`: a gate over every authenticated route would also refuse `/me`,
`/me/policies` and the membership check, which are the three calls the screen
that clears the gate is built from, so switching it on would lock the product
shut with no way back.

### What changed in v0.6.5, and why the requirement looked broken

Three things, and together they were the whole of "the channels are configured
and nothing happens".

**`APP_ACCESS` was enforced by nothing on the bot.** It was documented as the
Mini App router's job, and the Mini App is being retired — so an operator who
switched the requirement on, chose the widest action and watched the bot carry on
answering was reading the feature correctly. The bot's router is the equivalent
place: one point every update passes through. `/start` and `/help` are exempt,
because a gate over account creation would refuse the deep links the join screen
sends people back through, and somebody stuck behind a wall has to be able to
read what the product is.

**The gate fired once and never again.** The only call site was immediately after
the consent step, so anybody who had accepted the terms before you configured a
channel was never asked again.

**The refusal was a sentence with no buttons.** When `EventService.create` or
`ParticipationService.join` refused, the bot rendered the generic Persian message
and threw away the channel list and join links the refusal carried — so a user was
told to join a channel and given no way to. The join screen is now drawn from the
refusal itself, and it has a «بررسی دوباره» button that drops the probe's cache
and asks Telegram again. Without it the only way to clear the gate was to guess
that repeating the action might work, and for the length of the cache it would
not.

### The gate fails open, on purpose

A user is refused only on an **authoritative** `NOT_MEMBER` from Telegram.
Telegram being slow, rate-limiting us, returning an error, or the bot not being an
admin of a channel all resolve to "let them through". A membership requirement
that locks the product when Telegram has a bad afternoon is a worse outcome than
one that occasionally lets a non-member create an event.

With several channels this matters more, not less: the outcomes are combined by
"does any channel *authoritatively* refuse", never by "did every channel say
yes" — so one misconfigured channel in a list of four degrades that channel's
check rather than emptying the product.

### Two things the panel refuses outright

- **Requiring membership with no channel to send anybody to.** The one warning
  that is also an error, because it locks users out of a product with no way
  forward on the screen.
- **Removing the last active channel while the requirement is on.** That leaves a
  gate with nothing behind it: the user is told to join something and shown no
  button. Turn the requirement off first — the switch is one click away, and it
  is the operator saying what they mean.

### What is not here

`TELEGRAM_CHANNEL_ID` and `TELEGRAM_BOT_TOKEN`. Both are environment variables:
the bot's *posting* destination editable from a web session is a destination an
attacker with a session can redirect, and a token in a form is a token in a
browser's memory. This screen holds only what is public either way — usernames,
invite links, titles.

Every change to this screen is audited with the before and after.

---

## 12. Legal documents — «اسناد حقوقی» (M22)

Terms, privacy policy and community rules, each versioned independently.

### Versions are immutable once published

A published version cannot be edited. Not "should not" — the `consent` table is
append-only by a database trigger, and a published `policy_version` is what those
acceptance rows point at. Correcting a published document means publishing the
next version.

A draft can be edited freely and is visible to nobody.

### Publishing asks you to type the version number

For the same reason the broadcast asks for the recipient count. Publishing is the
act that asks **every user** to re-accept: the moment a new current version
exists, everybody who has not accepted it is routed to the terms screen and stays
there until they do. That is the intended behaviour and it is also the most
disruptive button in the panel.

Exactly one version per type can be current; the database enforces it with a
partial unique index rather than trusting the application.

**Type it in whichever digits your keyboard produces** (v0.6.5). The panel renders
every number in Persian digits, so the dialog says «۳» — and until v0.6.5 the
confirmation was parsed with `Number()`, for which `'۳'` is `NaN`. The publish
button therefore never enabled for anybody typing on a Persian keyboard, which is
everybody who uses this panel: the only way to satisfy it was to switch layouts,
which the screen did not say to do. Persian, Arabic-Indic and Latin digits are now
all read the same way.

### The acceptance log

«پذیرش‌ها», behind `policy.consent.read`, is the evidence: who accepted which
version, when, and from what app version. It is append-only and it is the answer
to a legal question, so it is a separate permission from reading the documents
themselves.

---

## 13. Bug reports — «گزارش‌های مشکل» (v0.6.5)

What users say is broken about the product, filed from the bot with `/bug` or the
«🐞 گزارش مشکل» button. Behind `report.review`, so both `MODERATOR` and `SUPPORT`
see it — support is who somebody writing «دکمه کار نمی‌کند» is really addressing.

### It is not the report queue, and the tables are not shared

«گزارش‌های تخلف» is moderation: every row is about a person or something they
posted, it counts distinct reporters against `moderation.report_threshold`,
enough of them auto-hide the subject, and `UNIQUE (target_type, target_id,
reporter_user_id)` means one report per subject per person **forever**.

None of that is right for a bug. There is no subject to hide, three people
hitting the same broken button is not grounds to hide anything, and a user who
finds three problems in an afternoon has to be able to send three. `bug_report`
is its own table with its own lifecycle, and `BugReportService` carries the
argument in full.

### The screenshots are not shown, and cannot be

A screenshot is stored as a Telegram **`file_id`** — a handle scoped to this
deployment's bot token, not a URL. `<img src>` would resolve to nothing, and the
alternative is proxying every image through the API with an auth check, a cache
and a bandwidth question for pictures somebody opens a handful of a day. The
panel shows the count and the ids; opening one is `getFile` from the bot, which
is where the token already lives.

The images are never copied into this deployment. That is deliberate: a copy
would mean owning a retention policy, a deletion path and a scanning question for
a file the reporter has already handed to the bot.

### The release is recorded, not asked for

Every report carries the release the reporter was on. It is the single most
useful field on a bug report and the one nobody remembers to include, so the bot
attaches it rather than asking.

### Your note is not a reply

`adminNote` is a triage annotation and the reporter never sees it. A channel back
to them would need a tone, a sender and somebody answerable for what it says;
writing to a reporter is a deliberate act on «پیام‌ها», by a person.

### Statuses

`OPEN` → `ACKNOWLEDGED` / `RESOLVED` / `DISMISSED`, and back to `OPEN` if you
reopen one. Anything other than `OPEN` records **who** settled it and **when**; a
CHECK on the table keeps those three moving together, and reopening clears them.

---

---

## 14. Conventions, if you are adding a screen

- **A route declares its permission in `meta`.** The navigation and the guard both read it. A route
  with a `group` and no `permission` fails `router.test.ts`.
- **Never write a hex value.** The panel has its own palette (it is not a Telegram surface, §3.7), and
  dark mode is those tokens redefined under `prefers-color-scheme` — not per-component branches.
- **Logical properties only** (`border-e`, `ps-`, `me-`). `dir="ltr"` on the document is then the whole
  of an LTR locale.
- **Wrap every Latin identifier in `<bdi>`.** Inside RTL text a UUID renders with its segments
  reversed, and these are strings operators copy into reports.
- **Persian digits at the view layer only** (`format/fa.ts`). Internal values stay Latin so sorting and
  arithmetic are unaffected.
- **`null` is not zero.** A Trust Score with no row is «تازه‌وارد»; a balance with no account is 0.
- **Every list gets `StateBlock` and `PagerBar`.** Loading, empty, error-with-retry, and a total
  behind the page — "is that all of them?" is the question an operator asks before they stop looking.
- **Every irreversible action gets `ConfirmDialog`**, with the reason field the API demands and the
  same minimum length it enforces, so the refusal happens before the request.
- **Re-read after a mutation.** The server is what decided; a screen that patches its own state is a
  screen that disagrees with the server after the first refusal.
