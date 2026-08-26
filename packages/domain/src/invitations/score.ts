/**
 * Who is most likely to come, scored (M22 phase 11).
 *
 * A **plain weighted sum of facts the product already holds**, and every one of
 * the choices below is about staying honest rather than about being clever.
 *
 * ── What it deliberately is not ──────────────────────────────────────────────
 *
 * It is not a model, it makes no probability claim, and its output is not a
 * percentage. Calling a number "probability of participation" would be asserting
 * something the data cannot support — nobody has measured whether these terms
 * predict turnout, and the honest name for the output is a *rank*.
 *
 * It infers nothing. Gender, age and birth year are available on every profile
 * and are absent from this file on purpose: inferring who is "likely" to attend
 * from a protected attribute is discrimination whether or not it correlates, and
 * §12's "no unfair discrimination" applies to an invitation exactly as it applies
 * to ranking.
 *
 * ── Why it is a pure function over plain data ────────────────────────────────
 *
 * So it can be tested with no database, so the breakdown it returns can be stored
 * verbatim beside the invitation, and so "why was this person chosen?" is answered
 * by reading a row rather than by re-running a query against data that has since
 * moved. That last property is what makes the selection auditable.
 */

/** The tunable half, read from `app_setting` by the caller. */
export interface InviteWeights {
  sameCity: number;
  interestMatch: number;
  categoryHistory: number;
  recentActivity: number;
  trust: number;
  recentInvitePenalty: number;
}

/** Everything the score looks at, and nothing else. */
export interface InviteCandidate {
  userId: string;
  /** Null for a profile with no city, which cannot happen today. */
  cityId: string | null;
  /** Category ids this user has declared an interest in. */
  interestCategoryIds: readonly string[];
  /** How many events of the event's own category they have attended. */
  categoryAttendances: number;
  /** True when they have taken part in anything inside the activity window. */
  recentlyActive: boolean;
  /** 0–100, or null for an account that has never been judged (ADR-0014). */
  trustScore: number | null;
  /** True when they were invited to anything inside the cooldown window. */
  invitedRecently: boolean;
}

export interface InviteTarget {
  cityId: string;
  categoryId: string;
}

/**
 * Which terms fired and what each contributed.
 *
 * Stored as `event_invitation.score_breakdown`, which is what makes the choice
 * explainable months later. It holds **numbers only** — no city name, no interest,
 * nothing that describes the person. A breakdown that named the reasons in prose
 * would be a profile of the recipient sitting in a column an operator can export.
 */
export interface ScoreBreakdown {
  sameCity: number;
  interestMatch: number;
  categoryHistory: number;
  recentActivity: number;
  trust: number;
  recentInvitePenalty: number;
  total: number;
}

/**
 * Attendances past which the history term stops growing.
 *
 * Three, because the term is meant to separate "has done this before" from "has
 * not". Letting it scale without a ceiling would make one very frequent attendee
 * outrank every plausible newcomer on that term alone, which is how a
 * recommendation loop ends up inviting the same six people to everything.
 */
export const CATEGORY_HISTORY_CAP = 3;

export function scoreCandidate(
  candidate: InviteCandidate,
  target: InviteTarget,
  weights: InviteWeights,
): ScoreBreakdown {
  const sameCity = candidate.cityId === target.cityId ? weights.sameCity : 0;

  const interestMatch = candidate.interestCategoryIds.includes(target.categoryId)
    ? weights.interestMatch
    : 0;

  // Capped and rounded down, so the term is an integer and the total is one too —
  // which keeps the stored breakdown readable and the ordering exact.
  const historyRatio =
    Math.min(candidate.categoryAttendances, CATEGORY_HISTORY_CAP) / CATEGORY_HISTORY_CAP;
  const categoryHistory = Math.floor(weights.categoryHistory * historyRatio);

  const recentActivity = candidate.recentlyActive ? weights.recentActivity : 0;

  /**
   * Trust, scaled — and **only ever additive**.
   *
   * An account with no score contributes zero rather than being penalised: it has
   * never been judged, and ADR-0014's rule that a missing score is not a bad score
   * matters more here than anywhere, because the people it would push down are new
   * users who have done nothing wrong.
   */
  const trust =
    candidate.trustScore === null
      ? 0
      : Math.floor((weights.trust * Math.max(candidate.trustScore, 0)) / 100);

  const recentInvitePenalty = candidate.invitedRecently ? -weights.recentInvitePenalty : 0;

  return {
    sameCity,
    interestMatch,
    categoryHistory,
    recentActivity,
    trust,
    recentInvitePenalty,
    total:
      sameCity + interestMatch + categoryHistory + recentActivity + trust + recentInvitePenalty,
  };
}

export interface ScoredCandidate {
  userId: string;
  score: number;
  breakdown: ScoreBreakdown;
}

/**
 * Rank, then cut.
 *
 * **Ties break on `userId`, ascending**, and that is the whole reason this is a
 * function rather than a `.sort()` at the call site: `userId` is a UUIDv7, so the
 * tie-break is "whoever joined first", it is total, and it is stable across runs.
 * A comparison that left ties to the input order would make the same event pick a
 * different twenty on a second preview, which is exactly the thing an operator
 * confirming a charge should not see.
 */
export function rankCandidates(
  candidates: readonly InviteCandidate[],
  target: InviteTarget,
  weights: InviteWeights,
  limit: number,
): ScoredCandidate[] {
  return candidates
    .map((candidate) => {
      const breakdown = scoreCandidate(candidate, target, weights);
      return { userId: candidate.userId, score: breakdown.total, breakdown };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.userId.localeCompare(b.userId)))
    .slice(0, Math.max(limit, 0));
}
