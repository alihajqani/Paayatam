# ADR-0020: Direct messages are kept 180 days, readable by the owner's staff, and blockable

- **Status:** Accepted
- **Decides:** amends the v0.8.0 position that `direct_message` has no retention clock
  (`RetentionService`), and amends ADR-0010's break-glass rule for **direct messages only** —
  the retired anonymous chat keeps `chat.read` + an unseal grant
- **Invariant owned:** none. Bound by ADR-0009 (bodies encrypted at rest; `telegram_user_id`
  never leaves `identity`) and ADR-0010 (deny by default; every staff read audited)

## Context

Direct messages replaced the anonymous chat in v0.8.0. Three things about them were decided then
by omission rather than on purpose, and the published terms now have to describe each of them:

1. **They were kept forever.** The reasoning was that a thread used to arrange a meeting must not
   lose the address halfway through. True for days, not for years — and "forever" is not
   something a privacy notice can promise to people who were never told it.
2. **Nobody could read them.** No staff surface decrypted a direct message. A report about the
   sender reached a moderator without the words that caused it, and the operator could not see
   whether the feature was being used to harass, sell or spam.
3. **The only defence was a report.** A recipient who did not want to hear from somebody again had
   to ask a moderator to act on something they could have settled themselves.

## Decision

1. **180 days, from when a message was written.** The nightly purge deletes every
   `direct_message` whose `created_at` is older than `RETENTION.DIRECT_MESSAGE_DAYS`. A surviving
   reply to a purged message has its `parent_id` cleared first — the reference is to a message
   that no longer exists, and `parent_id` is RESTRICT. 180 matches the notification window, so a
   notice never outlives the message it announced by more than a day.
2. **Staff read them in the panel, as conversations, under `direct.read`.** A new permission,
   granted to `SUPER_ADMIN` alone. A conversation is the messages between two accounts about one
   activity, oldest first. The check is in the service layer (invariant 12), and **every opened
   conversation writes `direct.thread_read` to `audit_log`** — which conversation, never its words.
   Not break-glass: no case, no grant, no time box. That is the difference from the anonymous chat,
   whose participants were promised anonymity; direct messages carry names and the terms say staff
   may read them.
3. **A recipient can block a sender.** One row in `direct_message_block` per direction. While it
   exists, `DirectMessageService` refuses a message **either way** between the two — a blocker who
   could keep writing to somebody unable to answer would be a conversation with one side gagged.
   Blocking touches direct messages only: requests, reviews and reports are unaffected. Unblocking
   deletes the row; both acts are audited.

## Consequences

- Evidence for abuse reported after 180 days is gone. Accepted, as ADR-0009 accepted 90 days for
  the chat.
- The operator can read private messages. That is now stated in the privacy notice, and the audit
  trail says who read which conversation and when.
- A blocked sender is told they cannot write, rather than having messages silently dropped. It
  reveals the block; a silent drop would leave somebody waiting on an answer that cannot come.

## Alternatives considered

- **Keep them forever.** Rejected: no bound a privacy notice can state.
- **Break-glass for direct messages too.** Rejected by the operator: moderation needs to read a
  reported thread without opening a case first, and nothing about these messages is anonymous.
- **Silent block.** Rejected, for the reason under Consequences.
