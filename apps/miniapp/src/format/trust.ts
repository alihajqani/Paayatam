/**
 * Reading somebody else's Trust Score (M18).
 *
 * One predicate, in one place, because the interesting case is not the number —
 * it is the **absence** of one. `trust_score` is written lazily by the first
 * movement, so a brand-new account has no row and the API sends `null`. Rendering
 * that as «۰ از ۱۰۰» would show the worst possible reputation to somebody who has
 * done nothing wrong, and the two screens that display a score are otherwise
 * unrelated — copied into both, the distinction is one refactor away from being
 * lost in one of them.
 *
 * An out-of-range value is treated as unknown rather than clamped. The contract
 * already refuses one, so the only way to see it is a client running against a
 * newer or corrupted response — and inventing a plausible number for a value the
 * product does not understand is worse than admitting it does not know.
 */
export function isKnownTrustScore(score: number | null | undefined): score is number {
  return typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100;
}
