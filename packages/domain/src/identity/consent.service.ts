import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, PiiHasher, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';

export interface CurrentPolicy {
  id: string;
  type: 'TERMS' | 'PRIVACY' | 'COMMUNITY';
  version: number;
  contentMd: string;
  summaryFa: string | null;
  /** M22: the document's own name, and what changed. Null on pre-M22 rows. */
  titleFa: string | null;
  changeSummaryFa: string | null;
  /** `TERMS v3` — what a consent record snapshots. */
  label: string;
}

export interface ConsentContextInfo {
  ipAddress?: string;
  userAgent?: string;
  /** Correlation id, so an acceptance can be tied to the access log (M22). */
  requestId?: string;
  /** A release string. Safe client context — never a device fingerprint. */
  appVersion?: string;
}

/** What a user still owes, and what they have already agreed to (M22). */
export interface PolicyStanding {
  pending: CurrentPolicy[];
  accepted: { policy: CurrentPolicy; acceptedAt: Date }[];
}

/**
 * The two document types a user must accept before using the product.
 *
 * `COMMUNITY` is deliberately absent: it exists in the enum and can be published
 * and read, but it does not gate anything. A third mandatory document is a product
 * decision, not a consequence of somebody adding an enum member.
 */
const REQUIRED_TYPES: readonly string[] = ['TERMS', 'PRIVACY'];

/** `TERMS v3` — the exact identifier a consent record snapshots. */
export function policyLabel(type: string, version: number): string {
  return `${type} v${String(version)}`;
}

@Injectable()
export class ConsentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly pii: PiiHasher,
  ) {}

  /**
   * Every currently published document, of every type.
   *
   * Filtered on `is_current`, which migration 0002's partial unique index makes
   * "at most one per type" and migration 0021's CHECK makes "and it is published".
   * A draft therefore cannot appear here however it was written.
   *
   * ── Deliberately not cached ──────────────────────────────────────────────────
   *
   * A thirty-second in-memory cache was the obvious optimisation and was removed
   * before it shipped, because of what it does in the seconds after a publish: a
   * replica still holding the old set computes `requiredPolicies()` from it, and a
   * user who has just been shown the *new* document and pressed «می‌پذیرم» submits
   * ids that do not match — so the acceptance is refused as
   * `POLICY_VERSION_STALE`. The gate would refuse the very act that clears it, for
   * up to half a minute, on exactly the release where everybody is being asked at
   * once.
   *
   * The saving it bought was one indexed read of a table with a handful of rows,
   * against the `(type, is_current)` index from migration 0002. That is not a
   * cost worth a correctness cliff, and a per-process cache cannot be invalidated
   * from the process that published.
   */
  async currentPolicies(): Promise<CurrentPolicy[]> {
    const versions = await this.prisma.policyVersion.findMany({
      where: { isCurrent: true },
      orderBy: { type: 'asc' },
      select: {
        id: true,
        type: true,
        version: true,
        contentMd: true,
        summaryFa: true,
        titleFa: true,
        changeSummaryFa: true,
      },
    });

    return versions.map(toCurrentPolicy);
  }

  /**
   * The required subset — what actually gates the product, and the **only** set
   * `acceptPolicies` will take.
   *
   * Public, because the callers that build an acceptance have to submit exactly
   * this set. `currentPolicies()` is wider by design — it includes `COMMUNITY`,
   * which is publishable and gates nothing — and a caller that submitted the wide
   * set was refused with `POLICY_VERSION_STALE` by the loop below. The bot did
   * exactly that, so the day an operator published a community guideline, the
   * consent gate would have become unclearable for **every** user at once: the
   * screen that exists to accept the terms would refuse the acceptance.
   */
  async requiredPolicies(): Promise<CurrentPolicy[]> {
    const current = await this.currentPolicies();
    return current.filter((policy) => REQUIRED_TYPES.includes(policy.type));
  }

  /**
   * Records acceptance of the supplied policy versions and advances onboarding.
   *
   * Idempotent by construction: `UNIQUE(user_id, policy_version_id, context)` means
   * a duplicate INSERT loses at the database, so ten concurrent submissions produce
   * one row each and no error. Nothing here reads-then-writes.
   *
   * Rejects stale versions rather than accepting them silently — consenting to a
   * superseded document is not consent to the current one.
   *
   * ── Which context is written (M22) ──────────────────────────────────────────
   *
   * `ONBOARDING` for a user who has never accepted anything, `REACCEPT` for one
   * agreeing to a version published after they joined. The distinction matters
   * legally and is why `context` is part of the unique key rather than a label:
   * the same person can accept the same document under two different
   * circumstances, and both rows are evidence.
   */
  async acceptPolicies(
    userId: string,
    policyVersionIds: string[],
    context: ConsentContextInfo = {},
  ): Promise<void> {
    const required = await this.requiredPolicies();

    if (required.length === 0) {
      // No published policy means nothing can be accepted. Better a loud failure
      // than silently marking users as having agreed to nothing.
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }

    const requiredIds = new Set(required.map((p) => p.id));
    const submitted = new Set(policyVersionIds);

    for (const id of requiredIds) {
      if (!submitted.has(id)) {
        throw new AppError(ErrorCode.POLICY_VERSION_STALE);
      }
    }
    for (const id of submitted) {
      if (!requiredIds.has(id)) {
        throw new AppError(ErrorCode.POLICY_VERSION_STALE);
      }
    }

    const acceptedAt = this.clock.now();
    const ipHash = this.pii.hash(context.ipAddress);
    const userAgentHash = this.pii.hash(context.userAgent);

    /**
     * What this call actually has to write, and under which context.
     *
     * Two reads, and both are load-bearing.
     *
     * **Versions already accepted are skipped**, whatever context they were
     * accepted under. `UNIQUE (user, version, context)` alone does not make a
     * repeat call a no-op: the second call would classify itself as `REACCEPT`,
     * miss the `ONBOARDING` rows on the same versions, and write a second set. The
     * unique index is what makes two *concurrent* identical calls safe; this is
     * what makes two *sequential* ones safe.
     *
     * **The context is per user, not per version.** Somebody who has accepted
     * nothing is onboarding; somebody agreeing to a version published after they
     * joined is re-accepting. The distinction matters legally, which is why it is
     * part of the unique key rather than a label.
     */
    const [priorAcceptances, alreadyAccepted] = await Promise.all([
      this.prisma.consent.count({ where: { userId } }),
      this.prisma.consent.findMany({
        where: { userId, policyVersionId: { in: required.map((policy) => policy.id) } },
        select: { policyVersionId: true },
      }),
    ]);

    const done = new Set(alreadyAccepted.map((row) => row.policyVersionId));
    const outstanding = required.filter((policy) => !done.has(policy.id));
    const consentContext = priorAcceptances === 0 ? 'ONBOARDING' : 'REACCEPT';

    if (outstanding.length === 0) {
      // Everything current is already agreed to. Still nudge the onboarding state,
      // because a user whose acceptance predates a crash may not have got it.
      await this.prisma.user.updateMany({
        where: { id: userId, onboardingState: 'NEW' },
        data: { onboardingState: 'TERMS_ACCEPTED' },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // `createMany` + `skipDuplicates` compiles to a single INSERT ... ON CONFLICT
      // DO NOTHING.
      //
      // This is not a style preference. Inserting row-by-row and catching the unique
      // violation does NOT work inside a transaction: Postgres aborts the entire
      // transaction on the first failed statement, so every subsequent statement
      // fails with 25P02 regardless of the catch. Under concurrency that also meant
      // ten requests blocking on each other's uncommitted rows until they timed out.
      // One statement has neither problem.
      await tx.consent.createMany({
        data: outstanding.map((policy) => ({
          userId,
          policyVersionId: policy.id,
          context: consentContext,
          acceptedAt,
          ipHash,
          userAgentHash,
          // Snapshotted, so the record survives the version being archived (M22).
          policyVersionLabel: policy.label,
          requestId: context.requestId ?? null,
          appVersion: context.appVersion ?? null,
        })),
        skipDuplicates: true,
      });

      // Conditional on the current state, so a concurrent duplicate is a no-op
      // rather than an overwrite.
      await tx.user.updateMany({
        where: { id: userId, onboardingState: 'NEW' },
        data: { onboardingState: 'TERMS_ACCEPTED' },
      });
    });
  }

  /**
   * Whether this user owes a re-acceptance (M22 phase 8).
   *
   * ── The empty case, and why it is `true` ─────────────────────────────────
   *
   * **No required document published means there is nothing to accept**, so the
   * gate must not block. This returned `false` and it was a product-stopping
   * bug: `AuthGuard` turns `false` into `POLICY_VERSION_STALE`, so on a
   * deployment with no published TERMS or PRIVACY version — a fresh install, or
   * a release where the legal text is still in draft — **every gated write was
   * refused for every user**, and the message told them to go and re-read a
   * document that did not exist.
   *
   * It also disagreed with `standingFor()` twenty lines below, which correctly
   * answers "you owe nothing" for the same state. The client was told it was
   * clear and the server refused anyway, which is precisely the divergence the
   * comment on `standingFor` says must not happen.
   *
   * This is not a hole. "Has never accepted anything" is a different question
   * and is already answered earlier in the guard by `onboardingState === 'NEW'`
   * → `TERMS_NOT_ACCEPTED`. This method exists only to catch somebody who
   * accepted version *n* when version *n+1* is current — and with no current
   * version there is no such person.
   */
  async hasAcceptedCurrentPolicies(userId: string): Promise<boolean> {
    const required = await this.requiredPolicies();
    if (required.length === 0) return true;

    /**
     * ── Distinct versions, not rows ─────────────────────────────────────────
     *
     * This counted `consent` **rows** and compared the total with the number of
     * required documents, and the two are not the same number. `consent` is
     * UNIQUE on `(user_id, policy_version_id, context)` — the context is part of
     * the key precisely so one person can accept one document under more than
     * one circumstance — and `ChatService.recordConsent` writes exactly such a
     * row: a `CONTACT_SHARE` acceptance against the **current PRIVACY version**,
     * the moment somebody agrees to exchange contact details.
     *
     * So a user with two required documents and three rows was measured as
     * `3 === 2` → false, and the gate closed on them permanently. Every write
     * they attempted opened the terms screen; accepting again changed nothing,
     * because `acceptPolicies` correctly finds nothing outstanding and returns.
     * The one action that caused it — sharing contact details — is the action
     * this product spends its whole safety model getting people to.
     *
     * Counting distinct `policy_version_id` asks the question the gate actually
     * means: *is there a required document this user has never agreed to?*
     */
    const accepted = await this.prisma.consent.findMany({
      where: { userId, policyVersionId: { in: required.map((p) => p.id) } },
      select: { policyVersionId: true },
      distinct: ['policyVersionId'],
    });

    return accepted.length === required.length;
  }

  /**
   * What this user still owes, and what they have already agreed to (M22).
   *
   * `pending` covers **every** current document, not only the required two: a
   * published community guideline should be shown to somebody who has not seen it,
   * even though refusing it does not lock them out. The *gate* reads
   * `hasAcceptedCurrentPolicies`, which is the required subset — so the screen can
   * be more informative than the enforcement without the two disagreeing.
   */
  async standingFor(userId: string): Promise<PolicyStanding> {
    const current = await this.currentPolicies();
    if (current.length === 0) return { pending: [], accepted: [] };

    const rows = await this.prisma.consent.findMany({
      where: { userId, policyVersionId: { in: current.map((policy) => policy.id) } },
      select: { policyVersionId: true, acceptedAt: true },
      orderBy: { acceptedAt: 'asc' },
    });

    // Earliest acceptance per version: a REACCEPT row for the same version would
    // otherwise make "when did you agree to this?" answer with the later of two
    // dates, and the first one is the one that matters.
    const acceptedAt = new Map<string, Date>();
    for (const row of rows) {
      if (!acceptedAt.has(row.policyVersionId)) acceptedAt.set(row.policyVersionId, row.acceptedAt);
    }

    const accepted: { policy: CurrentPolicy; acceptedAt: Date }[] = [];
    for (const policy of current) {
      const when = acceptedAt.get(policy.id);
      if (when !== undefined) accepted.push({ policy, acceptedAt: when });
    }

    return {
      pending: current.filter((policy) => !acceptedAt.has(policy.id)),
      accepted,
    };
  }
}

/** The wire-ish shape, from a row. An allowlist, never a spread (§3.6 layer 2). */
function toCurrentPolicy(row: {
  id: string;
  type: 'TERMS' | 'PRIVACY' | 'COMMUNITY';
  version: number;
  contentMd: string;
  summaryFa: string | null;
  titleFa: string | null;
  changeSummaryFa: string | null;
}): CurrentPolicy {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    contentMd: row.contentMd,
    summaryFa: row.summaryFa,
    titleFa: row.titleFa,
    changeSummaryFa: row.changeSummaryFa,
    label: policyLabel(row.type, row.version),
  };
}
