# ADR-0017: Conversation wizards, and the state a stateless bot has to start keeping

- **Status:** Accepted (2026-08-28)
- **Supersedes:** ADR-0003 §"the Mini App is where forms live" — *in part*. See *Relationship to
  ADR-0003*, which is the whole of what changes.
- **Invariant owned:** a conversation step is reachable only by the user who owns it, and a
  redelivered update advances it exactly once.

## Context

The bot answers eight commands and every one of them is a **read**. That was a decision, recorded in
`PROJECT_MEMORY.md` §10: single-turn work belongs in the bot, anything with a form belongs in the Mini
App, because a form expressed as a conversation needs per-user state and `BotService` deliberately held
none — which is exactly what made a redelivered Telegram update idempotent.

The product owner has decided to **retire the Mini App** and move the forms into the chat. That is not
a refactor of the above; it is the reversal of it, and it costs the property the old design was built
around. This record exists to say what is being traded for what, because the next person to read
`BotService` will find state in it and should find the argument here rather than infer one.

The forms in question:

| View | Fields | Why it is hard |
|---|---|---|
| `CreateEventView` | 16 | three dependent selects (province → city → district, 1252 cities), two datetimes, conditional validation |
| `EditEventView` | same 16, prefilled | must not clear a field the user did not touch |
| `EditProfileView` | 7 | display name, city, birth year, interests, bio, invite opt-out |
| `TermsView` | 1 (accept) | **gates every write in the product** |

## The decision that is forced before any other

**`TermsView` and the profile funnel move to the bot first, and the Mini App is retired last.**

This is not a sequencing preference. `AuthGuard` turns "has not accepted the current policies" into
`POLICY_VERSION_STALE`, and `hasAcceptedCurrentPolicies()` gates event creation, joining, chat writes
and invitations. Acceptance today is `POST /onboarding/consent`, an authenticated endpoint reachable
only from the Mini App, which authenticates with `initData` (ADR-0004). Disable the Mini App before
the bot can take an acceptance and **every gated write in the product refuses, for every user** — the
same shape as the bug recorded as trap 2 in `PROJECT_MEMORY.md`, which would have bricked the v0.3.0
deploy.

The same is true of `onboardingState`: a user who cannot reach `PROFILE_COMPLETE` cannot do anything,
and the only surface that completes a profile is the one being switched off.

So the order is: framework → consent → profile → event creation → *then* retire the Mini App. Any
other order has a window in which the product does not work.

## Decision

### 1. An explicit step machine, not grammY's `conversations` plugin

The requirement as written names `@grammyjs/conversations`. It is the wrong tool **here**, for reasons
specific to this codebase rather than to the plugin:

- The plugin drives a flow by *awaiting* inside a live middleware context — `await conversation.wait()`,
  then `ctx.reply(...)`. Replying from inside the request is precisely what **invariant 11** forbids:
  every outbound Telegram call goes through the `telegram-send` queue, never inline. A reply sent from
  the API process would also bypass the global rate limiter, whose headroom is what keeps a
  notification backlog from starving somebody watching a spinner.
- `BotService` is not a grammY middleware. `apps/api` parses an update into a `ParsedUpdate`
  (`packages/telegram/src/update.ts`) and calls a Nest service; grammY exists in this repo to *send*,
  in the worker. Adopting the plugin means adopting its pipeline, in the process that must not send.
- The plugin's replay model re-executes the conversation function from the top on each update. That is
  a second idempotency story running beside the one the bot already has (a UNIQUE index on a key
  derived from `update_id`), and two of them is worse than either.

What replaces it is smaller than the plugin and fits what is already here: a row holding
`(userId, kind, step, formData, lastMessageId)`, a pure `advance(step, input) → nextStep | error`
function per wizard, and the same reply-is-a-row mechanism every command already uses. It is testable
without a grammY harness — `advance` is a pure function over a JSON object — which is what makes the
per-step unit tests the requirement asks for actually cheap to write.

**Cost, stated plainly:** we write and maintain the step machine ourselves. The plugin's branching,
back-tracking and `wait` combinators are things we will reimplement the parts of. Accepted, because
the parts we need are few and the parts we would have to fight are the ones that violate invariant 11.

### 2. State lives in Postgres, not Redis

The requirement asks for both — "persisted in Postgres so redelivered updates remain idempotent"
(Technical §1) and "in Redis so you can run multiple bot instances" (Scalability §1). These are not
compatible as stated, and the second is a solution to a problem the first does not have: Postgres is
already shared by every API instance, so state in Postgres is *already* horizontally scalable. Nothing
about multiple bot instances requires Redis.

Postgres wins on the properties that matter here:

- **Idempotency by the same mechanism as everything else.** A UNIQUE index does the deduping; the bot
  already relies on one keyed off `update_id`.
- **Transactional consistency with the thing being built.** The final step creates an `event` row and
  clears the draft. In Postgres that is one transaction. Across Redis and Postgres it is two writes
  with a window between them, and the window is "the event exists and the draft that made it also
  still does".
- **It survives a Redis flush.** A half-completed 16-field form is the user's typing. Losing it to a
  cache eviction is a product that wasted their time.

Redis keeps the job it is good at: **caching the province and city lists** (Performance §2), which are
read on every keyboard render, change rarely, and cost nothing if lost.

### 3. Retention: seven days, and the requirement that contradicts it

Three retention rules were given: delete after 24 hours (Privacy §2), resume after 24 hours (Recovery
§1), delete after 7 days (Recovery §2). The first two cannot both hold — a state deleted at 24 hours
is not resumable at 24 hours.

**Seven days**, with the draft cleared immediately on completion or abandonment. The resume
requirement is explicit and a user who starts an event on Friday and finishes it on Monday is a normal
user, not an edge case.

This does not weaken ADR-0009. A draft holds what the user typed into a form about a public event —
a title, a city id, a date, a price. It holds no `telegram_user_id`, no phone number, and no message
body; the anonymity boundary is untouched. `formData` is nonetheless stored encrypted at rest under
the existing `CHAT_ENCRYPTION_KEY`, because a free-text description is the user's words and the cost
of encrypting it is one column type.

### 4. Editing the message, not sending another

The UX requirement — each selection edits the previous message rather than appending — is what makes a
wizard feel like a screen instead of a transcript. It is also a **new outbound Telegram call**, so it
goes through the queue like every other one: a new job kind beside `SEND_NOTIFICATION`, and a new
`editMessageText` method on the worker's client, which today has only `sendMessage` and
`answerCallbackQuery`.

`lastMessageId` on the state row is what makes the edit addressable. When the edit fails — the user
deleted the message, or Telegram refuses `message is not modified` — the fallback is to send a fresh
one and record its id. A wizard that dead-ends because a message was deleted is worse than a wizard
that occasionally posts twice.

### 5. Authorisation is the row, not the button

`callback_data` is untrusted input and carries no authority; this is already `callback-data.ts`'s
position and it does not change. A wizard callback names a step and a value, never a draft id — the
draft is looked up by `userId`, which comes from the authenticated Telegram sender, so there is no id
for a tamperer to swap. The threat "can user A advance user B's wizard?" is answered by there being
nothing in the button that names B.

## Relationship to ADR-0003

ADR-0003 froze two things: Vue 3 for the frontends, and the Telegram Native Design System for their
appearance. **Both stand for `apps/admin`**, which is not affected by any of this and remains the
surface where provinces, cities and activity tags are managed.

What this record supersedes is narrower than "ADR-0003": it is the consequence people draw from it,
that a form belongs in a Vue view because that is where forms live. For the *user-facing* flows named
above, the form now lives in the chat. `apps/miniapp` is retired only once the bot covers consent,
profile completion and event creation — see *the decision that is forced before any other*.

## Consequences

**What is lost.** The bot is no longer stateless, and "there is nowhere for a half-typed event to
live" stops being true. Idempotency is now a property of the dedupe index and the step machine rather
than of the architecture having no memory. That is a real reduction in how easy the bot is to reason
about, and it is the price of the decision.

**What is gained.** A user creates an event without leaving Telegram; the product stops depending on a
WebView that is slow on weak connections and awkward on desktop clients; there is one surface to
learn.

**What must be watched.** Drop-off per step, and any conversation sitting in one step for more than
ten minutes — the requirement asks for both, and they are the same signal read two ways: a step people
abandon is a step that is asking the wrong question.

## Rejected

- **`@grammyjs/conversations`** — §1.
- **Redis as the store of record** — §2. It remains the cache.
- **`force_reply` for every field instead of inline keyboards.** Fewer buttons to build, but it turns
  a bounded choice (one of 31 provinces) into free text that has to be parsed, matched against 1252
  city names, and rejected in Persian when it does not match. Inline keyboards make the invalid state
  unrepresentable, which is worth more than the code they cost.
- **Keeping the Mini App for event creation only.** Coherent, and it is what `PROJECT_MEMORY.md` §10
  argued for. Rejected by the product owner, whose call it is; recorded here so the argument is not
  lost if the decision is revisited.
