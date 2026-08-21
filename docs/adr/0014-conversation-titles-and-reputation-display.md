# ADR-0014: Naming a conversation, and showing a Trust Score to the other party

- **Status:** Accepted (2026-08-20)
- **Amends:** ADR-0009 layer 3 (per-chat aliases) — see *Relationship to ADR-0009*
- **Invariant owned:** none new. Invariant 7 is untouched and remains ADR-0009's.

## Context

Three requests arrived together, and they are one decision because they all ask the same question:
**what may one party to a transaction see about the other?**

1. A guest looking at an event page cannot tell whether the host is somebody the platform trusts.
2. A host deciding on a join request has a name and a timestamp and nothing else to decide on.
3. A conversation in the Mini App and in the bot's DM is headed «میهمان ۱» and nothing more. A host
   running four events therefore has four conversations, several of which are with somebody called
   «میهمان ۱», and no way to tell which is which. This is not a cosmetic complaint: the bot's DM
   carries *every* conversation a person is in, so the header is the only thing distinguishing them.

The third is where the tension is. ADR-0009 layer 3 assigns aliases **per chat** rather than per user,
specifically so "a host who runs many events cannot correlate a guest across them", and it explicitly
rejects stable per-user aliases for that reason.

## The privacy question, stated honestly

The relevant question is not "is a display name identity?" — it is **"does showing it here disclose
anything this viewer cannot already obtain?"** For the two parties to a participation, it does not:

- A host already reads every requester's `display_name` in `GET /events/:publicId/participants`. That
  endpoint has returned it since M6.
- A guest already reads the host's `display_name` on the event page. `discoveredEventView.host` has
  carried it since M5.
- Alias index is assigned from chat-creation order within an event, and chats are created at request
  time. The participant list is ordered by `requested_at`. A host who wanted to correlate «میهمان ۲»
  with a name could already do so by counting down their own queue.

So cross-event correlation by a host was **already available** through the participant list, in a form
that is strictly easier than reasoning about alias numbers. Layer 3 was not, in practice, preventing
what its rationale describes; it was making the conversation list unusable while not preventing it.

What ADR-0009 *does* protect, and what this decision leaves entirely alone, is everything in
`telegram_account` — the numeric id, the `@username`, the phone number a user might type. That is
invariant 7, that is what the five layers exist for, and none of it is reachable from anything below.

## Decision

### 1. A conversation is titled «who — which event»

`ChatSummary` gains `counterpartName`, and every surface that titles a conversation renders it beside
`eventTitle`:

- the Mini App's chat list (`ChatsView`);
- the relayed message header in the bot, for a message, an edit **and** a deletion.

`counterpartName` is the counterpart's `user_profile.display_name`, **falling back to their per-chat
alias** — never to an invented string. A profile can be absent because M15's anonymisation cleared it
or because the account never finished onboarding, and «میهمان ۱ — سفر شمال» remains a usable title
where «کاربر» would be a name the product made up.

`counterpartAlias` is **kept beside it**, not replaced. It is still what the evidentiary record
attributes a message to, still what a moderator reads in an unsealed conversation, and still the
fallback.

**No migration was required.** `anonymous_chat.event_id` has existed since M8 and every chat has always
been created from a participation, which is itself scoped to an event. The relationship this needed was
already in the schema; what was missing was that nothing carried it to the surface. Existing chats,
messages and notifications therefore work unchanged, and the relay renders whichever halves of the
header an older queued payload happens to carry.

### 2. A Trust Score is visible to the counterparty, as a number and never as a ledger

- `discoveredEventView.host.trustScore` — the host, on the event page.
- `participantSummaryView.trustScore` — each requester, in the host's queue.

Both are `number | null`, 0–100. **Null is not zero.** `trust_score` is written lazily by the first
movement, so a brand-new account genuinely has no row, and rendering that as 0 would show the worst
possible reputation to somebody who has done nothing wrong. Ranking resolves the same absence to
`trust.initial_score` because a sort has to produce a number; a *screen* does not have to, and says
«تازه‌وارد» instead.

Neither carries `trust_score_ledger`. The number answers "should I trust this person"; the ledger is a
record of specific incidents, and it stays with the person they happened to (`GET /me/trust`).

The host's score is shown to any authenticated viewer, which is the same audience that already sees
their display name — and the score is *already* a public fact about a host in the sense that it moves
their position in discovery (ADR-0007, plan §12).

## Relationship to ADR-0009

ADR-0009 stays Accepted and its five layers stay in force. This record amends **one clause of layer 3**:
the alias is still assigned per chat and is still what a message is attributed to, but a conversation is
now *titled* by the counterpart's name where one exists.

The alternative that ADR-0009 rejected — **stable per-user aliases** — is still rejected, and this is
not that. A stable alias would have been a pseudonym the platform assigned and maintained across
contexts, correlatable by anyone who ever saw it. A display name is a name the user chose to publish,
which both parties to a participation already read elsewhere.

## Consequences

**Positive**
- A host with several running events can tell their conversations apart, which is the difference
  between a usable inbox and an unusable one.
- The bot's DM — where every conversation lands in one Telegram thread — becomes readable at all.
- A host deciding on a stranger has the reputation signal the plan already computes, at the moment §11
  intends it to matter.
- Nothing new is disclosed to anyone; the change is which screen shows what.

**Negative**
- **Layer 3's stated protection is now weaker than it reads.** It was already weaker than it read, and
  this makes the gap explicit rather than closing it. A host who wants to know whether the same person
  has asked to join two of their events can now see it at a glance instead of by counting. Recorded
  here rather than left implicit, and it belongs in the threat model's accepted risks.
- Anyone who assumed "anonymous chat" meant the host never learns their name was already wrong from M6
  onward. The Mini App copy on `ChatsView` says identities are hidden «تا زمانی که خودشان نخواهند»,
  which is true of contact details and was never true of display names. **The copy should be corrected**
  — tracked as a follow-up, because it is a user-facing promise and not a code change.
- Two more fields on two more responses for the leak scan to walk. Both are covered.

## Alternatives considered

- **Show the name only after contact sharing.** Seriously considered, and it is the conservative
  reading. Rejected because it fixes nothing: the conversation that most needs a title is the one
  *before* acceptance, which is the whole product, and contact sharing happens after. It would also
  have been a rule with no privacy benefit, since the host reads the same name in their queue either
  way.
- **Title the conversation by event alone.** This is what the Mini App did. It is exactly ambiguous in
  the case that matters — two guests, one event — and does nothing at all for the bot's DM, where every
  conversation shares one thread.
- **Number the conversations globally per host** («گفت‌وگوی ۳»). Distinguishable, and meaningless: it
  tells the host nothing about who or what, and it is a stable per-user-ish pseudonym of the kind
  ADR-0009 rejected.
- **Show the full trust ledger to a counterparty.** Rejected outright. The number is a summary; the
  ledger is a list of things that happened to a person, including moderation decisions, and it is not
  the counterparty's business.
- **Coalesce a missing Trust Score to the neutral 50 for display**, matching the ranking formula.
  Rejected: it shows a number the user never earned, and «۵۰ از ۱۰۰» reads as a judgement where
  «تازه‌وارد» reads as the absence of one.
