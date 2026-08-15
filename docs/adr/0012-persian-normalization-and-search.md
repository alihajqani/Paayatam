# ADR-0012: Persian text normalization, moderation and search

- **Status:** Accepted (2026-08-15)
- **Decides:** Blacklist matching strategy, search strategy
- **Invariant owned:** normalization is one shared pipeline, used identically by moderation and search

## Context

Persian text has properties that defeat naive string matching, and every one of them is a way to smuggle a
blacklisted term past a filter:

| Problem | Example |
|---|---|
| Arabic vs Persian letters | `ي` (U+064A) vs `ی` (U+06CC); `ك` (U+0643) vs `ک` (U+06A9) — visually near-identical, different code points |
| ZWNJ / half-space | `می‌روم` vs `می روم` vs `میروم` — three encodings of one word |
| Diacritics (اعراب) | `سَلام` vs `سلام` |
| Arabic-Indic digits | `۱۲۳` vs `١٢٣` vs `123` — three digit systems |
| Character repetition | `سسسلام` reads as `سلام` to a human, not to `LIKE` |
| Homoglyphs | Latin `o` inside a Persian word |
| Zero-width characters | ZWJ/ZWNJ/RLM inserted between letters of a banned word |

The same pipeline is needed twice, for opposite purposes: **moderation** must catch a term however it is
obfuscated, and **search** must match a user's query however they typed it. If the two pipelines differ, one
of them is wrong.

## Decision

**A single normalization module, `packages/domain/moderation/persian-normalizer.ts`, composed of small pure
functions, each independently unit-tested with its own table, used by both moderation and search.**

### Pipeline (ordered)

1. Unicode NFC normalization.
2. Arabic → Persian letter folding: `ي`→`ی`, `ك`→`ک`, `ة`→`ه`, `أإآ`→`ا`.
3. Diacritic removal (fatha, kasra, damma, shadda, sukun, tanwin).
4. Zero-width character handling: ZWNJ folded to a space for tokenization, ZWJ/RLM/LRM stripped entirely.
5. Digit unification: Arabic-Indic (`۰-۹`) and Eastern Arabic (`٠-٩`) → Latin.
6. Punctuation unification: `؟`→`?`, `،`→`,`, Persian quotes → ASCII.
7. Whitespace collapse and trim.
8. Repetition collapse: 3+ identical consecutive letters → 1.
9. Homoglyph mapping: confusable Latin/Cyrillic characters → their Persian equivalents.

Each step is a separate exported function. The composed `normalize()` is what callers use, but each rule is
testable and fixable in isolation.

### Moderation

- `blacklist_term` stores **`term_normalized`**; incoming text is normalized before matching.
- Three pattern types: `EXACT`, `SUBSTRING`, `REGEX`.
- Two severities: **`BLOCK`** (never publishes, straight to `PENDING_MODERATION`) and **`FLAG`** (publishes,
  but opens a moderation case for review).
- **`FLAG` is the default for ambiguous terms.** A false positive that blocks a legitimate host is a worse
  product outcome than a flagged item sitting briefly in a queue — this is the single most important tuning
  decision in the module.
- `blacklist_version` is incremented on any change, and **every `moderation_case` stores the version that
  judged it**, so a decision can always be explained against the rules in force at the time.
- Changing the blacklist enqueues a re-scan of recent content on the `moderation` queue.
- `moderation_case.false_positive` is recorded by moderators, giving a measurable false-positive rate rather
  than an impression.

### Search

- Postgres FTS: a `search_vector` `tsvector` column populated by trigger from **normalized** title and
  description, GIN-indexed.
- `pg_trgm` GIN index on the normalized title for fuzzy/typo matching.
- Queries pass through the **same** `normalize()` before hitting either index.
- The `simple` text search configuration is used rather than a stemmer: Postgres has no Persian stemmer, and
  `simple` plus trigram matching outperforms an incorrect stemmer.
- Ranking combines FTS rank with the configured business weights (time-proximity, popularity, recency, boost,
  trust capped at 10%, interest match) — see `docs/implementation-plan.md` §11.

## Consequences

**Positive**
- Obfuscation via letter variants, half-spaces, diacritics, digits or repetition is defeated before matching.
- Search and moderation cannot drift apart, because they share one function.
- Per-rule tests mean a normalization bug is localised to one small pure function.
- No search infrastructure to operate; the FTS + trigram approach handles six figures of events comfortably.

**Negative**
- Normalization is lossy. `سلام` and `سسسلام` become identical, so a legitimate word could in principle
  collide with a banned one. The `FLAG`-by-default policy is what keeps that from blocking real users.
- Aggressive rules risk false positives; the false-positive rate must be **watched**, not assumed. Tracked
  explicitly via `moderation_case.false_positive`.
- No stemming means `کتاب` does not match `کتاب‌ها`. Trigram matching covers most of this in practice;
  revisit if search quality complaints appear.
- Determined adversaries will always find new obfuscations. Automated moderation is a filter, not a
  guarantee — user reports (M12) are the necessary second line.

## Alternatives considered

- **Meilisearch / Elasticsearch.** Better relevance and typo tolerance out of the box. Rejected for MVP: a
  second datastore to operate, sync and back up, for a corpus that will be in the low thousands. An
  `ISearchProvider` interface keeps the swap cheap, gated behind a feature flag.
- **Postgres `arabic` text search configuration.** Rejected: it stems Arabic, not Persian, and produces wrong
  stems for Persian morphology.
- **A third-party moderation API.** Rejected: sanctions and availability risk from Iran, per-request cost,
  latency on the event-creation path, and sending user content to a third party contradicts the privacy
  posture in ADR-0009.
- **Duplicating normalization in the search layer.** Rejected: two implementations means two behaviours, and
  the moderation one would eventually be the weaker.
