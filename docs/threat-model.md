# PayeTam — Threat Model

**Status:** living document. Update whenever a milestone adds an attack surface.
**Method:** asset-driven. We enumerate what is worth attacking, then how it would be attacked, then what
stops it — and we name the controls that do **not** yet exist rather than implying full coverage.

---

## 1. Assets, ranked by damage if compromised

| # | Asset | Why it matters | Damage if lost |
|---|---|---|---|
| A1 | **Telegram user identities** (`telegram_user_id`, username) | The product's core promise is anonymity before acceptance | Total loss of product trust; users are exposed to strangers they were told could not identify them |
| A2 | **Private chat contents** | Negotiations between strangers about real-world meetings | Severe personal harm; unrecoverable reputational damage |
| A3 | **Admin credentials** | Can suspend users, move currency, read chats | Full compromise of A1, A2 and A4 simultaneously |
| A4 | **Coin balances and ledger integrity** | In-app currency | Economic collapse of the incentive system; unresolvable disputes |
| A5 | **Trust Scores** | Reputation, drives ranking and eligibility | Unfair exclusion; a manipulable ranking becomes worthless |
| A6 | **Event capacity allocation** | Scarce seats | Overbooking ⇒ people travel to a meeting with no room for them |
| A7 | **Profile data** (birth year, gender, city) | PII, minimised but present | Privacy harm; combined with A1 enables targeting |
| A8 | **Availability of the bot** | The only notification channel | Product is unusable; a Telegram ToS violation causes this permanently |

---

## 2. Adversaries

| Adversary | Capability | Motivation |
|---|---|---|
| **Curious host** | Legitimate account, many events, sees many guests | De-anonymise or correlate guests across events |
| **Harasser** | Legitimate account, targets one person | Identify, contact off-platform, or follow a specific user |
| **Fraudster** | Multiple accounts, scripted | Farm referral and review coins; sell boosted placement |
| **Spammer** | Bulk accounts | Advertise via events and chat messages |
| **External attacker** | No account, network access to our endpoints | Forge auth, dump the database, escalate to admin |
| **Malicious insider** | Valid admin credentials | Read chats, manipulate balances, unmask users |
| **Compromised infrastructure** | Stolen disk, stolen backup, hosting-provider access | Bulk exfiltration of A1, A2, A7 |

---

## 3. Threats and controls

Status legend: **✅ designed** (control specified, milestone assigned) · **⏳ pending** (not yet built) ·
**⚠️ accepted risk** (no control; consciously accepted).

### Authentication and session

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T1.1 | Forged `initData` to impersonate any user | HMAC-SHA256 with key `HMAC("WebAppData", botToken)`, constant-time compare | M2 | ✅ |
| T1.2 | **Replay of a captured valid `initData`** | `auth_date` ≤ 5 min **plus** one-time `hash` nonce in Redis. The freshness window alone is not sufficient | M2 | ✅ |
| T1.3 | Trusting `initDataUnsafe` | Never read; server parses the signed blob only | M2 | ✅ |
| T1.4 | Stolen access token | 15-minute expiry; refresh rotation with reuse detection revoking the family | M2 | ✅ |
| T1.5 | Webhook forgery | Secret path + `X-Telegram-Bot-Api-Secret-Token` (constant-time) + optional CIDR allowlist | M2 | ✅ |
| T1.6 | Webhook probing to enumerate users | Handler **always** returns 200 regardless of internal outcome | M2 | ✅ |

### Anonymity (A1, A2) — the highest-priority group

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T2.1 | `forwardMessage` leaks `forward_from` | **`forwardMessage` is never used.** Always a fresh `sendMessage` | M8 | ✅ |
| T2.2 | `text_mention` entity carries a raw numeric user id | **All** message entities stripped before relay | M8 | ✅ |
| T2.3 | User types their own `@username` / phone in the anonymous stage | Pattern scan; masked («حذف شد») + logged for moderation | M8 | ✅ |
| T2.4 | Telegram id leaks through an API response | Storage separation + DTO allowlist + **automated CI leak scan across every endpoint** | M5, M15 | ✅ |
| T2.5 | Curious host correlates the same guest across events | Per-chat aliases were the stated control. **They never actually prevented this**: `GET /events/:publicId/participants` has returned every requester's display name since M6, so a host could always correlate by reading their own queue. ADR-0014 stops pretending otherwise and titles conversations «name — event». No control, and **M19 tells the user so**: `ChatsView`'s disclosure now names what is visible and says a host with several activities can tell two requests came from one person. See R8 | M8, M18, M19 | ⚠️ accepted, disclosed |
| T2.6 | Link preview exposes a profile | `link_preview_options.is_disabled = true` on every relayed message | M8 | ✅ |
| T2.7 | Telegram id appears in logs | pino redaction allowlist + a test asserting each sensitive field is redacted | M15 | ✅ |
| T2.8 | Contact revealed without the user's intent | Requires `OPEN` chat + explicit button + native confirmation + `consent` row | M8 | ✅ |
| T2.9 | **Traffic/timing correlation** — a host with two events infers a shared guest from message timing | None. Out of scope for MVP | — | ⚠️ accepted |

### Authorisation

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T3.1 | IDOR — reading another user's chat, participation, coins, reviews | Every query scoped by actor; random `public_id` in URLs; ownership asserted in the **service** layer | M6, M8 | ✅ |
| T3.2 | Non-host accepts/rejects/edits an event | Host ownership asserted in the service | M6 | ✅ |
| T3.3 | Enumeration of users or events by sequential id | UUID `public_id`; internal ids never exposed | M2+ | ✅ |
| T3.4 | Admin privilege escalation | Deny-by-default RBAC, service-layer checks, four-eyes on role changes, **RBAC matrix test** | M12 | ✅ |
| T3.5 | Insider reads chats casually | Break-glass: permission **+** open case **+** written reason, 15-min box, **per-message audit**, weekly digest to SUPER_ADMIN | M12 | ✅ |
| T3.6 | **A SUPER_ADMIN with database access bypasses every application control** | None technical. Mitigated organisationally: minimise who holds DB credentials; audit log is append-only | — | ⚠️ accepted |

### Integrity (A4, A5, A6)

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T4.1 | Overbooking via concurrent joins/accepts | `SELECT … FOR UPDATE` on the event row + `CHECK (accepted_count <= capacity)` | M6 | ✅ |
| T4.2 | Duplicate join request | `UNIQUE (event_id, user_id)` + `ON CONFLICT DO NOTHING` | M6 | ✅ |
| T4.3 | Double-granted onboarding reward under concurrency | `coin_ledger.idempotency_key` UNIQUE | M3 | ✅ |
| T4.4 | Negative balance via concurrent spends | `CHECK (balance >= 0)` + single transaction | M9 | ✅ |
| T4.5 | Ledger tampering | `BEFORE UPDATE OR DELETE` trigger raises; corrections are `REVERSAL` rows | M9 | ✅ |
| T4.6 | Referral farming with throwaway accounts | One referrer per user (UNIQUE); reward only after the referred user **attends an event**; velocity limits; `fraud_signals` reviewed by admins | M9 | ✅ |
| T4.7 | Review farming / reciprocal score-trading | Reviews only from actual participations; blind reveal (ADR-0011); `UNIQUE (participant_id, reviewer)` | M11 | ✅ |
| T4.8 | Client clock manipulation to dodge a cancellation penalty | Server clock only; the endpoint accepts **no** timestamp parameter | M10 | ✅ |
| T4.9 | Double promotion of a waitlisted user | Promotion under the same event lock; idempotent job | M7 | ✅ |
| T4.10 | **Sybil accounts** — one person, many Telegram accounts | Partial only: referral requires attendance, rate limits per account. Telegram account creation is outside our control | M9, M15 | ⚠️ partial |

### Input handling

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T5.1 | XSS in event or chat content | Vue escapes by default; **`v-html` banned repo-wide (lint-enforced)**; bot HTML templates use a unit-tested `escapeHtml()` | M4, M8 | ✅ |
| T5.2 | SQL injection | Prisma parameterises; raw SQL only via tagged `$queryRaw`; CI grep against concatenated SQL | M1+ | ✅ |
| T5.3 | SSRF via `external_link` | Stored and displayed, **never fetched server-side**; https-only; no link-preview fetching | M4 | ✅ |
| T5.4 | Malicious image upload (polyglot, embedded payload, SVG script) | Magic-byte sniffing (not the declared MIME), ≤5 MB, dimension caps, **re-encode with sharp**, **SVG rejected**, random storage key, strict CSP | M15 | ⏳ |
| T5.5 | Blacklist evasion via Persian obfuscation | Shared normalization pipeline (ADR-0012); versioned decisions; user reports as the second line | M4 | ✅ |
| T5.6 | CSRF on the admin panel | Cookie sessions with CSRF tokens, `SameSite=Lax`. The Mini App uses bearer tokens, so it is not exposed | M12 | ✅ |

### Abuse and availability

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T6.1 | Spam events / spam joins / spam messages | Redis token buckets per user + IP + endpoint class: events 5/day, joins 20/day, messages 30/min, reports 10/day | M15 | ⏳ |
| T6.2 | Report brigading to silence a legitimate host | 3 **distinct** reporters required; auto-hide is reversible; every case is human-reviewed | M12 | ✅ |
| T6.3 | Notification flooding a user | Per-chat rate limiting; dedupe keys | M13 | ✅ |
| T6.4 | Exhausting the global Telegram rate budget | Single `telegram-send` queue with a 25/s global limiter; `403` stops retrying immediately | M13 | ✅ |
| T6.5 | **Telegram bans the bot for a ToS violation** | No technical control. Requires a human review of current Bot API terms before launch. **Would be a total outage** | pre-launch | ⚠️ open |
| T6.6 | Application-level DoS | nginx connection limits, request size caps, rate limits. No CDN/WAF in MVP | M16 | ⏳ partial |
| T6.7 | **Enumerating gift codes** — a campaign code is short enough to be typed, therefore short enough to be guessed, and a hit credits coins | `GIFT_CODE_REDEEM` bucket at **10/hour per user**, the tightest in the product; refusals counted as `payetam_gift_code_redemptions_total{result="invalid"}` because a failed attempt leaves no row anywhere; global and per-user caps bound the damage of a hit. Codes should be minted long — the alphabet is the operator's choice (ADR-0015) | M18 | ✅ |
| T6.8 | Referral code guessing, to attribute somebody else's invites | Codes are 8 characters from a 31-character alphabet drawn with `randomInt` (≈8.5 × 10¹¹). Claim attempts counted by outcome; the reward requires an **attended event**, so a hit is worth nothing without a real person in a real café (T6, ADR-0007) | M9, M18 | ✅ |

### Infrastructure and data at rest

| ID | Threat | Control | Milestone | Status |
|---|---|---|---|---|
| T7.1 | Stolen database dump or backup | LUKS full-disk + **app-level AES-256-GCM on chat bodies and TOTP secrets**; backups encrypted off-box | M8, M16 | ⏳ |
| T7.2 | **Compromised application server** | **None — the server holds the key by design.** This is the explicit limitation of app-level encryption and must never be described to users as end-to-end | — | ⚠️ accepted |
| T7.3 | Secrets committed to the repository | `.env.example` holds placeholders only; `.gitignore` excludes `.env*`; secrets injected via environment; CI secret scan | M1, M16 | ⏳ |
| T7.4 | Data loss | Nightly `pg_dump` + WAL archiving, **with a rehearsed restore drill whose real duration is recorded** | M16 | ⏳ |
| T7.5 | Single VPS failure | Backups and a documented rebuild. No redundancy in MVP | M16 | ⚠️ accepted |

---

## 4. Accepted risks (explicit)

These have no control and are accepted deliberately. Each needs a named owner before launch.

| # | Risk | Rationale |
|---|---|---|
| R1 | **18+ is self-declared and unverified** | Identity verification is disproportionate for MVP and would itself require collecting far more PII. Residual risk of a minor on a platform that arranges in-person meetings is real |
| R2 | **App-level encryption does not protect a compromised app server** | Inherent to a design where moderators must be able to investigate abuse (T7.2) |
| R3 | **A SUPER_ADMIN with direct DB access bypasses application controls** | Mitigated organisationally, not technically (T3.6) |
| R4 | **Single VPS, no redundancy** | Cost-appropriate for MVP; recovery is by restore, not failover (T7.5) |
| R5 | **Telegram ToS dependency** | The entire product depends on one platform's terms; a violation is a total outage (T6.5) |
| R6 | **Sybil resistance is partial** | Telegram account creation is outside our control (T4.10) |
| R7 | **Timing correlation in anonymous chat** | Out of scope for MVP (T2.9) |
| R8 | **A host can tell that the same person asked to join two of their events** | The participant list has given a host every requester's display name since M6, so this was never prevented — the per-chat alias only made the host's *conversation list* unreadable while the correlation stayed available one screen away. ADR-0014 (M18) accepts the risk explicitly and titles conversations «name — event»; **M19 discloses it to the user** in `ChatsView` rather than accepting it silently on their behalf, and `privacy-gate.int.test.ts` pins what each side can actually read. What remains protected, and is unaffected, is everything in `telegram_account` (T2.4, invariant 7) |

---

## 5. Legal questions requiring human review

Flags for a person with local legal knowledge. **Not legal advice.**

1. Lawful basis and disclosure obligations for storing private interpersonal messages of Iranian users.
2. Platform liability for offline harm arising from meetings arranged through the service.
3. Whether self-declared 18+ is a sufficient control given R1.
4. Whether gender-based eligibility filtering carries discrimination exposure in the target market.
5. What a data-subject deletion request must actually delete, and within what period (built in M15).
6. Whether relaying user messages through a bot, and automated channel posting, comply with the **current**
   Telegram Bot API terms.
7. The mandatory escalation path for illegal content, including CSAM, before chat goes public.

---

## 6. Review triggers

Re-open this document when: a new data type is collected · a new external integration is added · media
support is enabled in chat · real-money features are introduced · an incident occurs · a new admin capability
is added · before every production launch.
