# Bot interaction tracking and the «رفتار کاربران» report

- **Status:** Release 1 implemented on `feat/bot-interaction-tracking` (2026-10-12),
  not merged and not deployed. Release 2 is not started. Where the code and the
  design below disagree, "Release 1 as built" at the end says which won and why.
- **Scope:** one new table (`bot_interaction`, migration 0065), a capture hook in
  `BotService.dispatch`, a naming function, a writer and a report service in
  `packages/domain`, one retention rule, a new admin page and one new section on the
  user detail page.
- **Ships in two releases.** Release 1 captures everything and reports the basics.
  Release 2 adds the reports that need days of data before they say anything.

## What was asked

The operator wants to see, in the admin panel, how people use the bot: how often a link
is tapped, which buttons are pressed most, whether people move around in the bot at all,
where they go, and why they stop. It serves two decisions: which link and which outbound
message is worth repeating (marketing), and which screen or form loses people (product).

## What exists today

Verified against the tree on 2026-10-12.

| Question | Today | Where |
|---|---|---|
| How many **new accounts** did a link create | recorded | `user_acquisition`, first touch, written once in the INSERT that creates the account |
| How far those accounts got | recorded | `AcquisitionReportService`, admin page «منابع ورود» |
| How many times a link was tapped | not recorded | an existing user who taps a link leaves no row |
| Which buttons are pressed | not recorded | `audit_log` holds state transitions only |
| Which screens were sent | half recorded | every `reply()` writes a `notification` row with its `template_key`; a screen drawn by editing a message writes none |
| Where a form is abandoned | a snapshot only | `conversation_state.kind` and `.step` for open drafts, purged after 7 days |
| When somebody was last active | misleading | `telegram_account.last_seen_at` is written by `findOrCreateByTelegram`, which only `/start` calls |

The API log does not fill the gap: `dispatch` logs refusals and failures, never an
ordinary update.

## Decisions

1. **One row per Telegram update, in our own Postgres.** Rejected: a hosted or
   self-hosted analytics product. The self-hosted ones need more memory than the whole
   4 GB box PayeTam shares; the hosted ones send user behaviour to a third party; neither
   is "in the admin panel".
2. **Capture is complete in release 1, reports grow afterwards.** A report can be written
   later over data that exists. Data that was not captured cannot be recovered, so every
   column below ships in the first migration even where its report ships second.
   `[operator-confirmed: two releases, 2026-10-12]`
3. **Per-user timeline, behind `user.read`.** Aggregates need `dashboard.read`, which is
   all `ANALYST` holds (ADR-0010). One person's trail is shown on the user detail page,
   which already requires `user.read`. `[operator-confirmed: 2026-10-12]`
4. **Raw rows live 180 days.** The same window as notifications and direct messages, so
   the privacy notice states one number. `[operator-confirmed: 2026-10-12]`
5. **No message text, ever.** A typed message is recorded as "text, claimed by a form"
   or "text, claimed by nothing". The body is not stored, hashed or measured.
6. **No Telegram user id.** Rows carry the internal `user_id`. Invariant 7 and ADR-0009
   layer 1 are untouched: nothing here reads or copies `telegram_account.telegram_user_id`.
7. **Recording can never break an update.** The write happens in `dispatch`'s `finally`,
   inside its own `try/catch`. A failed insert costs one error log line.
8. **Staff are left out of aggregates.** At this size the operator testing a release is a
   visible share of all traffic. Accounts linked through `admin_telegram_link` are
   excluded from every aggregate by a subquery that selects no column of
   `telegram_account` (the pattern `AcquisitionReportService` documents for
   `bot_blocked`). Their rows are still written, and still appear on their own timeline.

## The table

`bot_interaction`, append-only, hand-written migration `00000000000065_bot_interaction`.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid v7 | primary key |
| `update_id` | bigint, UNIQUE | Telegram's update id. A redelivered update conflicts and is not counted twice |
| `user_id` | uuid, nullable, FK `user` ON DELETE CASCADE | null when the sender has no usable account |
| `kind` | enum `bot_interaction_kind` | `START`, `COMMAND`, `CALLBACK`, `KEYBOARD`, `TEXT`, `PHOTO`, `UNSUPPORTED`, `BLOCKED`, `UNBLOCKED` |
| `action` | text | the name of what was pressed or sent, with every id removed. See "Naming" |
| `ref` | text, nullable | the public id or campaign tag the action named |
| `created_account` | boolean | true on the `/start` that created the account |
| `message_id` | int, nullable | the message the tapped button sits on. A per-chat counter, already stored in `notification.telegram_message_id` |
| `wizard_kind` | text, nullable | the form open after this update was handled |
| `wizard_step` | text, nullable | the step now on screen, or `$summary`, `$cancelled` |
| `finished_wizard` | text, nullable | the form this update submitted (migration 0066; see "as built" 11) |
| `outcome` | enum `bot_interaction_outcome` | `OK`, `REFUSED`, `GATED`, `STALE`, `FAILED`, `NO_ACCOUNT` |
| `detail` | text, nullable | the `ErrorCode` for `REFUSED`; `terms`, `channel`, `profile` or `app_access` for `GATED` |
| `screen` | text, nullable | the template key of the last screen drawn in answer |
| `duration_ms` | int | time spent inside `route()` |
| `created_at` | timestamptz(3) | |

Indexes: `(user_id, created_at)` for timelines and sessions, `(created_at)` for windows
and the purge, `(action, created_at)` for the button and link reports.

`KEYBOARD` is a tap on the persistent reply keyboard. Telegram delivers it as ordinary
text, and `onText` already tells it apart with `menuCommandFor` and `menuGroupKeyFor`.
`EDITED_TEXT` is not recorded: the bot ignores edits and Telegram sends one for every
edit in the chat.

`action` and `wizard_step` are text, not enums, for the reason `conversation_state.step`
is: adding a button or a form step must not need a migration.

Size: about 300 bytes a row with indexes. At 50 active people a day and 20 updates each,
180 days is 180 thousand rows and roughly 55 MB. At 1,000 active people it is about 1 GB,
and that is the point at which a daily rollup table replaces most raw reads. It is not
built now.

## Capture

Every update passes through `BotService.dispatch` → `route()`. That is the one hook.

1. `dispatch` opens an **interaction context** (an `AsyncLocalStorage` store, the same
   mechanism as `packages/platform/src/logging/request-context.ts`) and seeds it with
   `describeIntent(update.intent)`: kind, action, ref, message id.
2. Handlers do not change their signatures. Six existing choke points annotate the
   context:
   - `knownUser` and `onStart` set `user_id` (and `created_account`);
   - `reply` and `repaint` set `screen`;
   - `drawWizard` sets `wizard_kind` and `wizard_step` from the `ConversationOutcome`;
   - `refuse` and `refuseToast` set `REFUSED` and the error code;
   - `onboardingGate` and `appAccessBlocked` set `GATED` and which gate;
   - the places that answer a button whose data no longer parses set `STALE`.
3. `dispatch`'s existing `catch` sets `REFUSED` (an `AppError` nobody caught closer) or
   `FAILED`. Its new `finally` writes the row with
   `createMany({ skipDuplicates: true })` and swallows its own errors.

The write is awaited, not fired and forgotten, for the reason the webhook awaits
`dispatch`: work still in flight when the process is replaced is lost with no record.

`InteractionService.record()` lives in `packages/domain` and is the only writer.
The context helper lives in `apps/api/src/telegram/`, because only the bot adapter
annotates it. A call outside a context is a no-op.

## Naming an action

`describeIntent` is a pure function in `packages/telegram`, next to the codecs it reads.

| Input | `action` | `ref` |
|---|---|---|
| `/start` with no payload | `start:direct` | |
| `/start src_<tag>` | `start:campaign` | the tag |
| `/start event_<id>`, `join_<id>`, `host_<id>` | `start:event`, `start:join`, `start:host` | the public id |
| `/start <referral code>` | `start:referral` | none (a code names a person) |
| `/start <anything else>` | `start:other` | the payload when Telegram could carry it |
| `/discover` | `cmd:discover` | |
| reply-keyboard button | `kb:<command>` or `kb:group:<key>` | |
| `ev:show:<uuid>` | `ev:show` | the uuid |
| `wz:confirm:…`, `wz:<step>:<value>` | `wz:confirm`, `wz:<step>` | |
| text a form claimed | `text:answer` | |
| text nothing claimed | `text:unclaimed` | |
| a callback family the function does not know | its prefix | |

The rule for callbacks is the same for all 22 prefixes (the 21 in `callback-data.ts`
and the wizard's `wz`): keep the prefix and the verb, drop every uuid and number, and
put the first uuid in `ref`. An unknown family still
counts under its prefix, so a new button is never lost, only unnamed.

Persian labels for the admin page (`ev:show` → «دیدن جزئیات برنامه») live in
`packages/shared`. An action without a label is shown by its key.

## Reports

All reads are `$queryRaw` tagged templates in `InteractionReportService`
(`packages/domain/src/adminaccess/`), authorised in the service with
`assertPermission`, with zod contracts in `packages/shared`. Windows are 7, 30, 90 and
180 days. A **session** is derived at read time: a person's consecutive interactions
with no gap longer than 30 minutes.

The admin panel has no chart library and gains none. Like the existing pages, the new
one is tables and CSS bars.

### Release 1

New page `/interactions`, «رفتار کاربران», group `overview`, `dashboard.read`.

- **نمای کلی.** Active people per day; interactions, sessions and steps per session;
  the share of new accounts that did nothing after `/start`; breakdown by kind; hour of
  day in Tehran time.
- **لینک‌ها.** Per link (`start:*` and `ref`): taps, distinct people, accounts created,
  returning people. Event links show the event's title.
- **دکمه‌ها و دستورها.** Per action: count, distinct people, how often it was refused,
  and the commonest refusal code.

On `UserDetailView`, a section «مسیر در ربات»: that person's interactions, newest first,
paginated, `user.read`.

### Release 2

Three more tabs on the same page. No schema change.

- **قیف‌ها.** Onboarding: account created → terms → channel → profile → first discovery
  → first event detail → first join request, split by acquisition source. Each form:
  runs started, people reaching each step, submitted, cancelled, abandoned.
- **نقطه‌های ریزش.** The last screen of people who did not come back; refusal codes by
  the action that produced them; stale-button taps; `text:unclaimed` counts; the last
  screen before `BLOCKED` and how long after `/start` it happened.
- **بازگشت.** Return after 1, 7 and 30 days by acquisition source. Per outbound
  notification template: how many were sent, and how many were followed by a tap on that
  message (`bot_interaction.message_id` = `notification.telegram_message_id`, same user).

## Privacy and retention

- `RETENTION.INTERACTION_DAYS = 180`, purged by `created_at` in `RetentionService.purge()`
  and counted in its log line.
- Retention windows in this repository are commitments made in the privacy notice
  (`retention.service.ts` says so). The notice therefore needs one sentence: the bot
  records which buttons and commands are used, never message text, for 180 days.
- A new row is not personal data beyond what `notification` and `audit_log` already
  hold: an internal id, an action name, a time.
- Deleting a user cascades to their rows.

## What cannot be measured

Telegram does not tell a bot about: somebody who opens a `t.me` link and never presses
Start; a tap on a URL button (channel join links, the share sheet); whether a message
was read. No code changes that. Nothing before the release is backfilled.

## Invariants and repository rules this touches

- New endpoints are added to `apps/api/src/response-leak.int.test.ts`.
- Authorisation is in the service, not only the guard (invariant 12).
- The migration is additive and hand-written; `schema.prisma` matches; the enums and the
  UNIQUE index go on CI's hand-written allowlist if the `integration` job requires it.
- The new providers are wired where they are declared; both `app.module.test.ts` graphs
  must still resolve.

## Testing

- **Unit, `describeIntent`.** Every encoder's output is fed in. No `action` it returns
  contains a uuid or a run of digits, and every known family has a name.
- **Integration, webhook.** One update writes one row. The same `update_id` again writes
  none. A refused join records `REFUSED` and its code. A typed message is recorded and
  its text is in no column. A recorder that throws does not stop the reply.
- **Integration, reports.** Seeded rows produce the expected counts; staff are excluded;
  `ANALYST` can read aggregates and cannot read a timeline.
- **Admin.** A jsdom test for the new view, in the shape of `AcquisitionView.test.ts`.

## Release 1 as built

What the implementation changed, found, or decided that the design above did not say.

1. **`describeIntent` lives in `packages/domain/src/interaction/`**, not in
   `packages/telegram`. Naming a `/start` payload needs `isReferralCodeShape`, which is
   the domain's rule and the one `acquisitionFor` already asks, and `packages/telegram`
   depends on neither app nor domain.
2. **"No message text" is a database rule, not only the writer's.** Every text column has
   a CHECK constraining it to the alphabet a name is written in (`action`
   `^[a-z0-9_:]{1,64}$`, and one each for `ref`, `detail`, `screen` and the two wizard
   columns). A typed sentence fails the constraint and the row is not written. The five
   constraints and the UNIQUE index are on CI's hand-written allowlist.
3. **A command nobody published is `cmd:unknown`.** What follows a slash is something a
   person typed. `/event_<code>` and `/myevent_<code>` are one action each.
4. **An unknown callback family is `<prefix>:<verb>`**, not the bare prefix, when it has
   the usual `prefix:verb:id` shape. Five families whose second segment is data rather
   than a verb (`dc`, `mv`, `wl`, `ts`, `gn`) are counted under the prefix alone; `gn` so
   that which gender somebody chose is never part of an action name.
5. **A wizard button never sets `ref`**, even when its value is a uuid: there the uuid is
   a city or a category, an answer to a form question, not a target.
6. **`UserService.arriveByTelegram`** returns `{ user, created }`, and
   `findOrCreateByTelegram` delegates to it. That is how `/start` learns it created the
   account without a flag riding on a `PublicUser` that sign-in hands to a mapper.
7. **`repaint` takes the screen it redraws as a required argument.** An edit writes no
   `notification` row, so nothing else says what was drawn. Fifteen call sites name the
   template the same screen is sent with.
8. **`GATED` is recorded inside `resumeOnboarding`, when its lead is `gate`.** That covers
   the two gates and also an event link followed by somebody who still owes a sign-up
   step, which is the same thing from the person's side. `app_access` is recorded at the
   two places the router refuses for it.
9. **A block resolves the sender**, so the row is recorded against a person. Two extra
   indexed reads on a rare update.
10. **A cancelled form has no `wizard_kind`.** `ConversationService` has cleared the draft
    by the time the outcome is known. A reader takes the kind from the row before.
11. **A submitted form is recorded in `finished_wizard`, not as a `$submitted` step**
    (migration 0066, found while building release 2). `wizard_kind` and `wizard_step` are
    the form and step *left on screen*, and one update can submit a form and open the
    next: «می‌پذیرم» writes the acceptance and draws the profile form's first question.
    With a `$submitted` mark the second form overwrote the first, so the terms read as a
    form everybody starts and nobody finishes. Now the position is cleared on submit and
    `finished_wizard` names what was sent; `outcome` says whether it was accepted. Four
    forms (`ACCEPT_POLICIES`, `REDEEM_CODE`, `DIRECT_MESSAGE`, `NO_SHOW_CLAIM`) are
    submitted by reaching their summary, because they have no summary screen.
12. **The timeline is not windowed and not audited.** It mirrors `GET users/:publicId`,
    which asserts `user.read` and writes no audit row. Staff are excluded from totals
    only; their own trail is readable.
13. **`KEYBOARD` taps are named by the command they run** (`kb:discover`), and labels for
    a command are shared by its three routes (`cmd:`, `kb:`, `mn:c:`).
14. **Steps are shown by key** on the admin pages (`قدم title`). The questions live in the
    wizard definitions in `@payetam/domain`, which the panel does not depend on.
15. **`start:other` keeps the payload, exactly as `user_acquisition` does.** It is what
    makes an ad link built without the `src_` prefix show up under its own name. The cost
    is the same in both tables and is accepted in both: somebody who types
    `/start <digits>` by hand has those digits stored as a `ref`. The difference here is
    that it can happen on any `/start`, not only the first.

Tests added: `describe-intent.test.ts` (43), `interaction.service.int.test.ts` (11),
`interaction-tracking.int.test.ts` (17, through the real webhook),
`interaction-report.int.test.ts` (17), two cases in `retention.int.test.ts`, five
routes in `response-leak.int.test.ts`, `interaction.test.ts` in shared (9),
`InteractionsView.test.ts` (13), `InteractionTrail.test.ts` (8), one case in
`router.test.ts`.

## Open questions for the operator

1. **The privacy notice — answered, and it needs a decision.** Publishing a new current
   version of a required document **does** send every existing user back through the
   consent gate: `ConsentService.hasAcceptedCurrentPolicies` exists to catch "accepted
   version *n* when *n+1* is current". So the sentence about interaction records should
   ride along with the next revision of the privacy notice rather than force a
   re-acceptance of its own. Until then the notice does not mention this table. When to
   publish is the operator's call.
2. **Staff exclusion.** Excluded by default (decision 8). Say so if the operator's own
   taps should count.
3. **Not yet applied anywhere but the test database.** Migration 0065 has been applied to
   `payetam_test` only. The development database gets it on the next `pnpm db:migrate`,
   production on the next deploy.
