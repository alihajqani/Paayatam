# ADR-0018: A moderator's Telegram identity, and moderation inside the bot

- **Status:** Accepted (2026-08-30)
- **Decides:** how a moderation case is decided from Telegram
- **Amends:** ADR-0010, whose second decision this narrows rather than replaces
- **Invariant owned:** the bot's admin session is the intersection of a role's permissions with a hard-coded allowlist; nothing outside that allowlist is reachable from Telegram, ever

## Context

ADR-0010's second decision reads:

> **The identity system is separate, and the separation is the security control.**
> `admin_user` has no foreign key to `user`, the session namespace is disjoint from the Mini App's,
> and the token format is different. A privilege-escalation bug in user-facing code therefore cannot
> become an admin compromise, and **admin access does not follow from a staff member's personal
> Telegram being taken over.**

That last clause is the one this record qualifies, and it should be read as a real cost rather than
a formality.

The forces on the other side are concrete:

- **The queue is the one admin surface with a clock on it.** An event opened as `PENDING_MODERATION`
  by a BLOCK verdict is invisible until somebody decides it. A host who is not advertising a scam
  waits for a moderator to reach a laptop, and the automation that flagged them cannot tell the
  difference between an hour and a day.
- **The panel needs a laptop, a password, a TOTP code and a session cookie.** All four are correct
  for moving currency or unsealing a private conversation. None of them is proportionate to reading
  «six people reported this event for کلاهبرداری» and answering «yes, hide it».
- **Every other surface of this product moved into the chat.** ADR-0017 took consent, profiles and
  event authoring there, and v0.4.6 removed the last Mini App button. Moderation was the only
  operational loop still requiring a different device.

Doing nothing has a cost the threat model does not usually count: a queue nobody works is a safety
control that exists on paper.

## Decision

**A staff account may be linked to exactly one Telegram account, and that link grants a strictly
bounded moderation session inside the bot — nothing else.**

### The link

`admin_telegram_link` — one row per admin, one per Telegram id, both UNIQUE in the database.

- **Granted, never derived.** `AdminTelegramService.link` asserts `role.manage`, requires a reason of
  at least three characters, and writes an `audit_log` row. Nothing about signing into the panel,
  and nothing about a Telegram display name matching an admin's, creates one.
- **Granted by somebody else.** `tools/link-admin-telegram.ts` takes `--by` and `--email` and refuses
  when they are the same account. ADR-0010's fourth rule — nobody grants themselves a capability —
  applied to a grant that is not a role change but is the same kind of decision.
- **Still no foreign key to `user`.** The Telegram id is carried in the row directly. The two
  identity systems remain disjoint tables, which is the structural half of ADR-0010's separation and
  is untouched.
- **Revoked by a delete**, exactly as a role revocation is, with its own audit row.
- **`telegram_user_id` is invariant 7's column here too.** It is not in the audit row, not in any API
  response, not in a log line. There is deliberately **no admin endpoint** that takes one: a route
  would put it in request logs, browser history and a Vue bundle at once.

### The session

`AdminTelegramService.sessionFor(telegramUserId)` resolves a link to an `AdminSession` whose
permissions are `permissionsFor(roles) ∩ BOT_PERMISSIONS`, where `BOT_PERMISSIONS` is a **hard-coded
allowlist in code**:

```
event.moderate
report.review
```

- The intersection direction matters: the bot can never *grant* what a role does not hold. An
  `ANALYST` who somehow acquires a link gets a session with no permissions and every operation
  refuses it.
- A `SUPER_ADMIN` on the bot is a moderator and no more. No `coin.adjust`, no `trust.adjust`, no
  `chat.read`, no `role.manage`, no `user.ban`, no `settings.manage`, no `user.telegram.read`, no
  `message.broadcast`.
- **It is a list in code, not a role, because it is the boundary of a channel rather than a job.**
  A role is data an operator edits. What a password-less, TOTP-less, cookie-less channel may reach
  is a decision for people reading the file. Adding a line to it is another ADR.
- A suspended admin resolves to `null`, identically to no link at all. Distinguishing the two in a
  bot reply would tell whoever holds the Telegram account that it *is* linked to staff.

### The surface

- **No advertised command.** `moderate` is not in `BOT_COMMANDS`, so it is neither in
  `setMyCommands` nor in `/help`. The way in is a persistent-menu button that only a linked
  moderator's keyboard carries.
- **A non-moderator who guesses the word gets the unknown-command sentence, byte for byte.** Both
  paths go through one method so they cannot drift apart. The same is true of `ad:` callbacks, which
  answer «این دکمه دیگر کار نمی‌کند» — the reply a stale or tampered button gets.
- **The menu label always resolves.** `menuCommandFor('🛡 داوری')` returns `moderate` for everybody,
  because a label that failed to resolve would be **relayed into an anonymous chat** — the one thing
  `onText` must never do with a menu label. Resolving it is not authorising it.
- **The decision is a wizard**, `ADMIN_CASE`, on the same machinery as every other bot form:
  `last_update_id` idempotency, one message edited in place, the seven-day sweep. It is a form and
  not two buttons because `decideCase` requires a note — §7's rule that a terminal state carries
  `decided_by` *and* `decision_note` — and a bot that wrote an empty one would be the single surface
  where a moderation decision is unaccountable.
- **The session is resolved again at submit.** A wizard can be open for seven days; a link can be
  revoked and a role removed inside that window. Deciding from the session that opened the form would
  let a revoked moderator finish work they started before losing access, which is exactly what a
  revocation exists to prevent.
- **Invariant 12 is unchanged and is what actually authorises the act.**
  `AdminOperationsService.decideCase` asserts `event.moderate` in the service layer and writes the
  audit row naming `session.adminUserId`. `BotService` holds no permission check of its own beyond
  having a session at all — a check in the bot would protect the bot, and the whole point of putting
  it in the service is that it protects callers that do not exist yet.

### What the bot may show

Bounded twice: by the two permissions, and by the fact that a Telegram message can be forwarded out
of the chat it was sent to.

- **An event's own title and description**, in full. They are already public — on a discovery screen
  and possibly in a channel — and judging them is what `event.moderate` is.
- **Report reasons, counted, never quoted.** "Six people said کلاهبرداری" is what sorts a queue. The
  paragraphs behind it belong on a screen that is not a forwardable chat message.
- **Blacklist matches, counted, never named.** `matched_terms` has always been an allowlisted
  projection excluding the scanned text; this keeps one step further back.
- **A `MESSAGE` case carries nothing, and says so.** Private conversations are behind break-glass — a
  permission, a case, a reason and a fifteen-minute clock — and no amount of convenience makes a bot
  the surface for one. A moderator deciding on metadata alone is told that is what they are doing.

## Consequences

**Positive**

- The queue is worked from a phone, which is where the time-sensitivity of `PENDING_MODERATION`
  actually bites.
- The blast radius of a compromised moderator Telegram account is a case queue: bad, recoverable,
  fully audited under the moderator's name, and revocable in one command that takes effect on the
  next tap.
- **There is no session token to steal.** A Telegram update carries its sender on every call,
  verified by the webhook secret and by Telegram itself, so the session is derived per update.
  Nothing expires, nothing is cached, and nothing is left signed in on a shared machine. In that one
  respect this channel is stronger than the panel.
- The decision path is the panel's path. One `decideCase`, one permission check, one audit row — so
  «who decided this, and why» has the same answer whichever surface it came from.

**Negative — what we are accepting**

- **ADR-0010's clause is now qualified.** A staff member whose Telegram is taken over does gain an
  attacker a moderation queue. That is the trade, stated plainly. It is bounded by the allowlist, by
  the audit trail, and by the fact that the link is a deliberate grant somebody signed for — but it
  is not zero, and it is why `BOT_PERMISSIONS` is short.
- **There is no second factor on this channel.** Telegram account security is the moderator's own,
  and the product cannot enforce a policy on it. The mitigation is scope, not strength: nothing
  behind the link is irreversible and nothing behind it is private data.
- **Moderators are named to Telegram.** A linked account's ownership of a moderator role is a fact
  Telegram's own infrastructure now correlates with our bot. Accepted: it is one row per staff
  member, and the alternative was no bot queue.
- **One more table and two more migrations** to keep in the runbook, including a non-transactional
  `ALTER TYPE`.

## Alternatives considered

- **A one-time code typed into the bot to prove panel identity.** Genuinely close, and it is what a
  second factor would look like. Rejected for now because it moves the grant from "an admin decides,
  with a reason, in an audit row" to "whoever holds the panel session at that moment", and the panel
  session is the thing most likely to be open on a shared machine. It is the natural upgrade if the
  linking friction becomes a real problem.
- **Read-only queue in the bot, decisions in the panel.** Halves the benefit and keeps all of the
  cost: the moderator still needs a laptop for the act, and the link — the part ADR-0010 objects to —
  still exists.
- **Giving the bot session the moderator's full permission set.** Rejected outright. It would put
  `coin.adjust`, `chat.read` and `user.ban` behind a channel with no second factor, and the first two
  are the capabilities ADR-0010 spends the most words protecting.
- **Reusing `admin_user.email` matched against a Telegram username.** Rejected: a Telegram username
  is changeable by its owner and by anyone who releases one, so it is an identifier that can be
  acquired rather than proven.
- **Notifying moderators of new cases instead of a queue.** Not an alternative — it is the obvious
  next feature, and it needs exactly this link to address a message to a moderator at all.
