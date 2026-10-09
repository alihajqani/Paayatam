# ADR-0021: Showing a counterpart's age, never their birth year

- **Status:** Accepted (2026-10-09)
- **Decides:** amends ADR-0014 ("what may one party to a transaction see about the other?") by adding
  an age to what each side reads. ADR-0009's minimisation (D4) is untouched: `birth_year` is still the
  only thing stored, and it still reaches no screen.
- **Invariant owned:** none new.

## Context

The operator asked that wherever the bot names the other side of an activity, it say how old they are:

1. A guest opening an activity's page reads the host's name and Trust Score, and nothing about whether
   this is somebody their own age.
2. A host deciding on a join request, or reading their guest list, has a name, a medal and a Trust Score.
   Activities often carry an age range the host chose, and the host could not see where a requester
   fell in it.

ADR-0014 settled that a name and a reputation number are fair to show between the two parties to a
participation, on the test **"does showing it here disclose anything this viewer cannot already
obtain?"** An age does not pass that test as cleanly: nothing showed it before. So it is a decision,
recorded here, not a formality.

## Decision

**The age, in whole years, beside the name, in exactly three places:**

- the activity's page in the bot (`formatEventDetail`): the host;
- the host's guest list (`formatParticipants`): each requester;
- the join-request notice and the waiting-list promotion notice (`requesterLine`): the requester.

It is computed by `ageFromBirthYear`, the age gate's own arithmetic with the server clock and
`APP_TIMEZONE` (ADR-0008), so the number a host reads is the one an age range was checked against.
That means "the age reached this year", which can be one more than today's: the cost of storing a
year rather than a date, accepted in ADR-0009.

**The birth year itself never leaves the domain.** It is turned into an age where it is read and is
not put in a payload, a projection or a wire view:

- The search projection (`SELECT_COLUMNS`) is **not** widened. `DiscoveryService.findPublished` reads
  the one host's year in a separate query and returns `hostAge`, so search results and the
  Mini App's `discoveredEventView` carry no year and no age.
- `ParticipantSummary` gains `age`, and `toParticipantSummaryView` still maps field by field, so
  `GET /events/:publicId/participants` is unchanged.
- The `participation.requested` and `waitlist.promoted` payloads carry `participantAge`, never
  `birthYear`. A payload queued before this change has no age and renders without one.

A missing year (an anonymised profile) renders as nothing, never as a guess or «۰».

## Consequences

**Positive**
- A host decides on a request knowing roughly who it is; a guest sees whether a host is in their
  bracket before paying to ask.
- The allowlists stay honest: `cross-event-correlation.int.test.ts` admits `age` with its reasoning,
  and `discovery.service.int.test.ts`'s projection list still has no year.

**Negative**
- An age is personal data the counterparty did not see before. Combined with a display name it
  narrows who somebody is. It is accepted because both parties are deciding whether to meet in person,
  and age is among the first things anybody asks at that point.
- It is self-declared and unverified (ADR-0009), and now shown, so a false year is now visible to
  others as well as used by the gate.

## Alternatives considered

- **An age band («۲۵ تا ۳۰»).** ADR-0009 names a band as what a birth year is "sufficient to compute".
  Rejected for the bot: the operator asked for the age, and a band next to an age range the host set
  makes the host do arithmetic to answer "is this person in my range?".
- **The birth year in the search projection.** Rejected: one page's need would put the year on every
  listing the product draws, protected only by the wire view's field-by-field mapping. A leak one
  layer stops is one layer from being a leak.
- **Showing it on the Mini App too.** Out of scope: the Mini App is being retired, and its views
  were deliberately left unchanged.
