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
}

export interface ConsentContextInfo {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class ConsentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly pii: PiiHasher,
  ) {}

  async currentPolicies(): Promise<CurrentPolicy[]> {
    const versions = await this.prisma.policyVersion.findMany({
      where: { isCurrent: true },
      orderBy: { type: 'asc' },
    });

    return versions.map((v) => ({
      id: v.id,
      type: v.type,
      version: v.version,
      contentMd: v.contentMd,
      summaryFa: v.summaryFa,
    }));
  }

  /**
   * Records acceptance of the supplied policy versions and advances onboarding.
   *
   * Idempotent by construction: `UNIQUE(user_id, policy_version_id, context)` means a
   * duplicate INSERT loses at the database, so ten concurrent submissions produce one
   * row each and no error. Nothing here reads-then-writes.
   *
   * Rejects stale versions rather than accepting them silently — consenting to a
   * superseded document is not consent to the current one.
   */
  async acceptPolicies(
    userId: string,
    policyVersionIds: string[],
    context: ConsentContextInfo = {},
  ): Promise<void> {
    const required = await this.prisma.policyVersion.findMany({
      where: { isCurrent: true, type: { in: ['TERMS', 'PRIVACY'] } },
    });

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
        data: [...requiredIds].map((policyVersionId) => ({
          userId,
          policyVersionId,
          context: 'ONBOARDING' as const,
          acceptedAt,
          ipHash,
          userAgentHash,
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

  async hasAcceptedCurrentPolicies(userId: string): Promise<boolean> {
    const required = await this.prisma.policyVersion.findMany({
      where: { isCurrent: true, type: { in: ['TERMS', 'PRIVACY'] } },
      select: { id: true },
    });
    if (required.length === 0) return false;

    const accepted = await this.prisma.consent.count({
      where: { userId, policyVersionId: { in: required.map((p) => p.id) } },
    });

    return accepted === required.length;
  }
}
