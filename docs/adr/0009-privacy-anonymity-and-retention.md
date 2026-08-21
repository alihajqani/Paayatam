# ADR-0009: The anonymity boundary, chat encryption, retention and data minimisation

- **Status:** Accepted (2026-08-15) — **layer 3 amended by [ADR-0014](0014-conversation-titles-and-reputation-display.md)** (2026-08-20)
- **Decides:** D4 (age model), D5 (chat storage/retention), D10 (edit/delete propagation)
- **Invariant owned:** `telegram_user_id` never appears in an API response, a log line, or a frontend bundle

## Context

Anonymous chat is the product's competitive advantage. Two strangers negotiate a real-world meeting before
exchanging any identity. If identity leaks even once, the feature is worse than not shipping it — users
believed they were anonymous and acted accordingly.

Telegram makes leakage easy to cause accidentally:

- `forwardMessage` attaches `forward_from` with the origin user's id and display name.
- A `text_mention` message entity carries a **raw numeric user id** in its payload, even when the visible
  text contains no username.
- Link previews can expose profile links.
- A user can simply type their own `@username` or phone number.

Meanwhile the spec requires messages to be stored for moderation, encrypted where feasible, admin-accessible
under audit, and subject to a retention policy — requirements that pull against each other.

## Decision

### The anonymity boundary — five independent layers

1. **Storage separation.** `telegram_user_id` lives only in `telegram_account`. Only the `identity` module
   may read that table. Everything else uses `user.public_id`, a random UUID.
2. **DTO allowlist.** Responses are built by explicit mappers in `packages/shared`. Entities are never spread
   into a response. A global serializer runs `@Exclude()`-by-default.
3. **Per-chat aliases.** `chat_participant.alias` is assigned per chat («میهمان ۱»), not per user. **The same
   person in two different chats gets two different aliases**, so a host who runs many events cannot correlate
   a guest across them.

   > **Amended by ADR-0014 (2026-08-20).** The alias is still assigned per chat and is still what a *message*
   > is attributed to. A conversation is now **titled** by the counterpart's profile display name beside the
   > event — «علی رضایی — سفر شمال» — falling back to the alias when there is no profile. The correlation this
   > clause describes was already available to a host through `GET /events/:publicId/participants`, which has
   > returned every requester's display name since M6; ADR-0014 records the reasoning and the cost.
   > **Stable per-user aliases remain rejected**, and nothing here reaches `telegram_account`.
4. **Relay hardening.** Every relayed message: `sendMessage` **never** `forwardMessage`; **all** message
   entities stripped; link previews disabled; body scanned for phone numbers, `@usernames`, `t.me/` links and
   emails, which are masked («حذف شد») during the anonymous stage and logged for moderation.
5. **Automated leak test in CI.** A test walks every public endpoint's response and fails if it finds a
   Telegram-id-shaped integer belonging to a known account, an `@username`, a `t.me/` link, or a phone
   pattern. It runs from M5 onward, so a leak introduced in M12 fails the build immediately.

Layers 1–3 prevent leaks by design; layer 4 handles user-supplied content; layer 5 catches regressions. No
single layer is trusted alone.

Contact exchange requires an `OPEN` chat (post-acceptance), an explicit button, a native confirmation dialog,
and writes both `consent` and `chat_action`. The platform never reveals contact details on its own.

### Message storage — text-only, encrypted, 90 days

- **Text only in MVP.** Media is refused with a Persian message and nothing is stored. This removes file
  upload handling, CSAM exposure and storage cost from the highest-risk feature in the product.
- **`body_ciphertext`** is AES-256-GCM with a `key_version` column for rotation; the key comes from
  `CHAT_ENCRYPTION_KEY` (32-byte base64), injected via environment, never committed.
- **Metadata stays in clear** (`chat_id`, `sender_participant_id`, `seq`, timestamps) so moderation can query
  patterns without decrypting content.
- **Retention: 90 days after chat close**, then hard-purged by the daily job. `chat_message` is partitioned
  monthly so the purge is cheap.

> **Honest limitation, to be stated in user-facing documentation and never overstated:** application-level
> encryption protects **database dumps, backups and a stolen disk**. It does **not** protect against a
> compromised application server, which by design holds the key. Claiming end-to-end encryption would be
> false.

### Edit and delete propagation (D10)

`chat_message.telegram_message_ids` maps our message to the per-recipient Telegram message ids. On
`edited_message` we edit the relayed copy; on sender-delete we replace the relayed copy with «پیام حذف شد».
The original stays in our database marked redacted — the recipient's view respects the sender's intent while
the evidentiary record for abuse investigation survives.

### Age and identity minimisation (D4)

- **`birth_year` (INT) only** — never a full date of birth. Sufficient to compute an age band and serve the
  age-range filter; substantially weaker as an identifier if the database leaks.
- **18+ is a hard block** at onboarding. It is **self-declared and unverified** — a consciously accepted
  residual risk, recorded in `docs/threat-model.md`.
- **Phone numbers are never stored.** They may be exchanged in-chat after consent; we relay, we do not persist.
- **IP addresses are never stored raw** — HMAC-hashed with a server pepper in `consent` and `audit_log`.
- Gender is optional, three-valued, used only for host-side eligibility filtering, and never present in a
  public DTO.

## Consequences

**Positive**
- Anonymity holds under all five layers independently; a mistake in one does not become a leak.
- Text-only removes the largest attack surface from the riskiest feature.
- Minimised PII means a breach exposes markedly less.

**Negative**
- Text-only is a real product limitation — users will want to share photos of a venue. Deferred to v1.1
  behind a feature flag, with `copyMessage` (which does not leak origin) as the mechanism.
- The 90-day window means abuse reported later has no evidence. An accepted trade against indefinite
  retention of private conversation.
- Per-chat aliases mean a returning guest is not recognisable to a host, which slightly weakens repeat-guest
  UX. That was the intended cost of preventing correlation — **and ADR-0014 accepts that cost back**, having
  found the correlation was never actually prevented: the participant list gave a host the same names in an
  easier form, while the alias made their conversation list unreadable.
- Key rotation needs a background re-encrypt job. `key_version` exists from day one so this is possible
  without a migration.

## Alternatives considered

- **Plaintext storage.** Rejected: one database compromise exposes every private conversation permanently.
- **True end-to-end encryption.** Rejected: it is incompatible with the spec's requirement that moderators
  investigate abuse, and the bot is necessarily a man-in-the-middle by design.
- **Metadata-only, 7-day content.** Strongest privacy posture, and seriously considered. Rejected because
  abuse reported after a week — the common case for offline harm — would be uninvestigable.
- **Stable per-user aliases.** Rejected: enables cross-chat correlation by an active host.
- **Full date of birth.** Rejected: a strong identifier with no benefit the age band does not already provide.
