import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { GIFT_CODE_FAILURE_ACTION } from '../economy/gift-code.service';
import { generateCode, normalizeCode } from '../economy/referral.service';
import { isUniqueViolation } from '../identity/user.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/**
 * How long a bulk-generated code is, excluding any prefix (ADR-0016).
 *
 * Twelve characters over the 31-character alphabet is ≈ 7.7 × 10¹⁷ codes. Against
 * the 10-an-hour redemption bucket, a sweep of even a millionth of that space
 * outlives every campaign anybody will run. Eight — the referral length — is
 * fine for a code that records a relationship and is not fine for one that pays.
 */
export const GIFT_CODE_DEFAULT_LENGTH = 12;
export const GIFT_CODE_MIN_LENGTH = 6;
export const GIFT_CODE_MAX_LENGTH = 24;

/**
 * How many times a batch re-draws the codes that collided before giving up.
 *
 * At the default length a collision is astronomically unlikely; at the minimum
 * length with a shared prefix and a thousand codes it is merely unlikely, which
 * is exactly the case a retry loop exists for. Five rounds of "generate what is
 * still missing" converges or the input was wrong.
 */
const BATCH_ATTEMPTS = 5;

/**
 * What an operator may put in front of a batch's random half.
 *
 * Uppercase letters and the digits 2–9. Deliberately wider than `CODE_ALPHABET`
 * on the letters and exactly as narrow on the digits — see the note at the call
 * site: a word disambiguates its own glyphs, and a bare `0` or `1` does not.
 */
const GIFT_CODE_PREFIX_PATTERN = /^[A-Z2-9]*$/;

/** A campaign's derived state, which no column stores because three of them do. */
export type GiftCodeState = 'SCHEDULED' | 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'EXHAUSTED';

export interface GiftCodeSummary {
  /** The handle every URL and every response uses. Never the code itself. */
  publicId: string;
  /**
   * `NOWR••••4F2Z` — enough to recognise a code somebody quoted at you, never
   * enough to redeem one.
   *
   * The full code is returned **once**, by the call that created it. A list that
   * echoed live codes would turn a stolen admin session into free coins without
   * the attacker having to do anything but read (ADR-0016).
   */
  codeMasked: string;
  campaign: string | null;
  batchId: string | null;
  coins: number;
  /** Null is unlimited — the honest representation of "no cap". */
  maxRedemptions: number | null;
  perUserLimit: number;
  redeemedCount: number;
  /** Null when uncapped. Never negative. */
  remainingRedemptions: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  /** What the three columns and the clock add up to, computed once, server-side. */
  state: GiftCodeState;
  note: string | null;
  createdAt: Date;
}

export interface CreateGiftCodeInput {
  code: string;
  coins: number;
  maxRedemptions?: number | null;
  perUserLimit?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  campaign?: string | null;
  note?: string | null;
}

export interface BulkCreateGiftCodesInput {
  count: number;
  coins: number;
  /** Prepended verbatim to every code, normalized with it. «NOWRUZ-» → `NOWRUZ`. */
  prefix?: string | null;
  /** Random characters after the prefix. */
  length?: number;
  maxRedemptions?: number | null;
  perUserLimit?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  isActive?: boolean;
  campaign?: string | null;
  note?: string | null;
}

export interface GiftCodeBatch {
  batchId: string;
  campaign: string | null;
  /**
   * Every code, in plaintext, and **the only time they are ever returned**.
   *
   * They are not recoverable afterwards by any endpoint, which is the property
   * that makes bulk minting safe to expose at all: what the panel does not keep,
   * a stolen session cannot read.
   */
  codes: string[];
  summaries: GiftCodeSummary[];
}

/** One created code, with its plaintext — returned once, by `create` alone. */
export interface CreatedGiftCode {
  code: string;
  summary: GiftCodeSummary;
}

export interface GiftCodeListFilters {
  campaign?: string;
  batchId?: string;
  isActive?: boolean;
  /**
   * An **exact** code, normalized before lookup.
   *
   * Exact rather than a prefix match, and that is the whole design: an operator
   * holding a code a user quoted can find it, and an operator holding nothing
   * cannot enumerate. A `LIKE 'NOW%'` search would hand back the campaign.
   */
  code?: string;
  limit?: number;
  offset?: number;
}

export interface GiftCodePage {
  codes: GiftCodeSummary[];
  total: number;
}

export interface GiftCodeAnalytics {
  summary: GiftCodeSummary;
  /** Redemptions that produced a ledger row. The financial number. */
  successfulRedemptions: number;
  /** Distinct people. Equal to `successfulRedemptions` while the cap is 1. */
  uniqueUsers: number;
  /** Summed from `gift_code_redemption.coins`, the immutable snapshot. */
  coinsGranted: number;
  /** Refused attempts, from `audit_log`. Zero is "none", never "unknown". */
  failedAttempts: number;
  /** Refusals by reason code — `invalid`, `expired`, `already_redeemed`, … */
  failuresByReason: Record<string, number>;
  firstRedeemedAt: Date | null;
  lastRedeemedAt: Date | null;
  /** One row per UTC day that saw a redemption, oldest first. */
  trend: Array<{ day: string; redemptions: number; coins: number }>;
}

export interface CampaignSummary {
  campaign: string;
  codes: number;
  activeCodes: number;
  redemptions: number;
  coinsGranted: number;
  uniqueUsers: number;
  firstRedeemedAt: Date | null;
  lastRedeemedAt: Date | null;
}

/** One redemption as the panel lists it. A user's public id, never their name. */
export interface GiftCodeRedemptionRow {
  userPublicId: string;
  seq: number;
  /** What was granted **at the time**, from the redemption row (ADR-0016). */
  coins: number;
  createdAt: Date;
}

/**
 * Managing gift and discount codes (M18, extended in M19; ADR-0010, ADR-0015,
 * ADR-0016).
 *
 * Separate from `GiftCodeService` for a structural reason rather than a stylistic
 * one: redeeming is a *user* operation and lives in `economy`, while creating and
 * disabling are *staff* operations and need `AdminAccessService` — which imports
 * `EconomyModule`. One service doing both would make that import a cycle. This is
 * the same split `ChatUnsealService` already makes against `ChatModule`.
 *
 * Every mutating method begins with `assertPermission` and ends with an audit row,
 * which is invariant 12 in code. The check is here rather than in a controller
 * guard so it holds for the seeds, jobs and scripts that do not exist yet
 * (ADR-0010 rule 2).
 *
 * **The permission is `giftcode.manage`, held only by `SUPER_ADMIN`.** Minting
 * coins out of nothing is the same class of capability as `coin.adjust`, and
 * ADR-0010's reasoning about `SUPPORT` applies unchanged: the role most exposed to
 * "please just give them the coins" is the role that must not be able to.
 *
 * **Three rules M19 added, and all three are about the code being a secret:**
 *
 *  1. **A code is addressed by `public_id`, never by itself.** A code in a URL
 *     path is a code in an access log, a proxy log and a browser history —
 *     ADR-0015 said "never log raw gift codes" and then routed on one.
 *  2. **Reads mask the code.** The plaintext is returned exactly once, by the call
 *     that created it. A stolen admin session can therefore see how a campaign is
 *     doing and cannot spend it.
 *  3. **Nothing here mutates a redemption or a ledger row.** Retuning `coins`
 *     changes what the *next* redemption grants; `gift_code_redemption.coins`
 *     snapshots what an old one did, and the ledger is append-only besides.
 */
@Injectable()
export class GiftCodeAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mint one campaign code the operator chose themselves.
   *
   * The code is normalized on write — upper-cased, spaces and dashes removed — by
   * the same function referral codes use, so «summer-24» and «SUMMER24» are one
   * code rather than two. Case-insensitivity is therefore a property of the
   * column, not something every read has to remember.
   *
   * Returns the plaintext, which is safe precisely because the operator typed it:
   * they already have it. Bulk codes are different and `createBatch` says so.
   */
  async create(session: AdminSession, input: CreateGiftCodeInput): Promise<CreatedGiftCode> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const code = normalizeCode(input.code);
    // Re-validated here and not only at the contract, because this service is
    // reachable from a script that never passes through a zod pipe.
    if (code.length < 4 || code.length > 32) throw new AppError(ErrorCode.VALIDATION_FAILED);
    if (!Number.isInteger(input.coins) || input.coins <= 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED);
    }

    const perUserLimit = await this.checkedPerUserLimit(input.perUserLimit ?? 1);
    const { startsAt, expiresAt } = checkedWindow(input.startsAt ?? null, input.expiresAt ?? null);
    const campaign = trimmedOrNull(input.campaign);

    let created;
    try {
      created = await this.prisma.giftCode.create({
        data: {
          code,
          coins: input.coins,
          maxRedemptions: input.maxRedemptions ?? null,
          perUserLimit,
          startsAt,
          expiresAt,
          campaign,
          note: trimmedOrNull(input.note),
          createdByAdminId: session.adminUserId,
          createdAt: this.clock.now(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.GIFT_CODE_DUPLICATE);
      throw error;
    }

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'giftcode.created',
      targetType: 'gift_code',
      targetId: created.id,
      // An allowlist, never a spread — and **never the code**. `audit_log` is a
      // read surface for staff and an export target; a live code in it is a live
      // code in every place the trail is ever copied to (ADR-0016).
      after: {
        publicId: created.publicId,
        coins: created.coins,
        maxRedemptions: created.maxRedemptions,
        perUserLimit: created.perUserLimit,
        campaign: created.campaign,
        startsAt: created.startsAt?.toISOString() ?? null,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });

    return { code: created.code, summary: this.toSummary(created) };
  }

  /**
   * Mint N single-use codes for one campaign, in one transaction (M19).
   *
   * **The codes are generated here, on the server, with `randomInt`.** Not in the
   * browser, where the entropy source is a page nobody controls and the codes
   * would cross the network twice; not from a sequence, which is enumerable by
   * construction; and not from `Math.random`, which is seeded per process, so two
   * API replicas minting at once would produce the same batch.
   *
   * Collisions are handled by **re-drawing what is missing** rather than by
   * failing: every attempt inserts with `skipDuplicates`, counts what landed, and
   * generates replacements for the shortfall. The unique index is what decides,
   * so a code minted by a concurrent request between the draw and the insert
   * costs one retry rather than a duplicate.
   *
   * The whole batch is one transaction: a request that fails leaves no codes at
   * all, rather than an operator holding a list where some are real (the rollback
   * requirement, and the reason `count` is capped at
   * `giftcode.max_batch_size`).
   */
  async createBatch(
    session: AdminSession,
    input: BulkCreateGiftCodesInput,
  ): Promise<GiftCodeBatch> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const maxBatch = await this.settings.getInt('giftcode.max_batch_size');
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > maxBatch) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'count', max: maxBatch });
    }
    if (!Number.isInteger(input.coins) || input.coins <= 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'coins' });
    }

    const length = input.length ?? GIFT_CODE_DEFAULT_LENGTH;
    if (
      !Number.isInteger(length) ||
      length < GIFT_CODE_MIN_LENGTH ||
      length > GIFT_CODE_MAX_LENGTH
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'length' });
    }

    const prefix = normalizeCode(input.prefix ?? '');
    if (prefix.length + length > 32) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'prefix' });
    }
    /**
     * The prefix is a **word**, and it is allowed to be one.
     *
     * The random half is drawn from `CODE_ALPHABET`, which excludes `0/O` and
     * `1/I/L` because a random string gives a reader no way to resolve an
     * ambiguous glyph. A prefix does: «NOWRUZ» read as «N0WRUZ» is corrected by
     * anybody who has seen the word, and refusing it would make the feature
     * useless for exactly the campaigns it exists for.
     *
     * What is still refused is the **digits** `0` and `1`, which have no word to
     * disambiguate them and are the half of the confusion that actually bites —
     * `NOWRUZ1405` reads as `NOWRUZI4O5` to somebody typing it off a poster.
     */
    if (!GIFT_CODE_PREFIX_PATTERN.test(prefix)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'prefix' });
    }

    const perUserLimit = await this.checkedPerUserLimit(input.perUserLimit ?? 1);
    const { startsAt, expiresAt } = checkedWindow(input.startsAt ?? null, input.expiresAt ?? null);
    const campaign = trimmedOrNull(input.campaign);
    const note = trimmedOrNull(input.note);
    const isActive = input.isActive ?? true;
    const now = this.clock.now();
    const batchId = randomUUID();

    const rows = await this.prisma.$transaction(async (tx) => {
      let created = 0;

      for (let attempt = 0; attempt < BATCH_ATTEMPTS && created < input.count; attempt += 1) {
        const missing = input.count - created;
        // A Set, because two draws colliding *within* one attempt would be
        // silently skipped by `skipDuplicates` and look like a database
        // collision — the retry would then converge more slowly for no reason.
        const candidates = new Set<string>();
        while (candidates.size < missing) candidates.add(prefix + generateCode(length));

        const result = await tx.giftCode.createMany({
          data: [...candidates].map((code) => ({
            code,
            coins: input.coins,
            maxRedemptions: input.maxRedemptions ?? null,
            perUserLimit,
            startsAt,
            expiresAt,
            isActive,
            campaign,
            batchId,
            note,
            createdByAdminId: session.adminUserId,
            createdAt: now,
          })),
          // The unique index decides, not a read this code performed a moment
          // earlier — the same argument ADR-0006 makes about capacity.
          skipDuplicates: true,
        });
        created += result.count;
      }

      if (created < input.count) {
        // Five rounds that could not place the codes means the keyspace is too
        // small for the request, not that the database is busy. Throwing rolls
        // the whole batch back, which is the only honest outcome: an operator
        // must not be handed 970 codes and told they asked for 1000.
        throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'length', reason: 'collisions' });
      }

      return tx.giftCode.findMany({ where: { batchId }, orderBy: { code: 'asc' } });
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'giftcode.batch_created',
      targetType: 'gift_code_batch',
      targetId: batchId,
      // Counts and configuration. Not one code, not even a masked one: a batch's
      // whole value to an attacker is the list.
      after: {
        count: rows.length,
        coins: input.coins,
        campaign,
        prefix: prefix === '' ? null : prefix,
        length,
        perUserLimit,
        maxRedemptions: input.maxRedemptions ?? null,
        isActive,
        startsAt: startsAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });

    return {
      batchId,
      campaign,
      codes: rows.map((row) => row.code),
      summaries: rows.map((row) => this.toSummary(row)),
    };
  }

  /**
   * Turn a campaign on or off.
   *
   * A switch separate from the expiry window, for the reason `channel.enabled`
   * exists: a campaign that has to stop *now* must not require back-dating a
   * timestamp — which is fiddly under pressure and leaves a lie in the record.
   *
   * Disabling takes effect at the **next redemption**, because `is_active` is read
   * under the row lock that spends the code and nowhere else. A client holding a
   * page loaded five minutes ago cannot redeem a code disabled since: there is no
   * cached verdict anywhere in the path.
   */
  async setActive(
    session: AdminSession,
    publicId: string,
    isActive: boolean,
  ): Promise<GiftCodeSummary> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const existing = await this.prisma.giftCode.findUnique({ where: { publicId } });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

    const updated = await this.prisma.giftCode.update({ where: { publicId }, data: { isActive } });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: isActive ? 'giftcode.enabled' : 'giftcode.disabled',
      targetType: 'gift_code',
      targetId: updated.id,
      before: { isActive: existing.isActive },
      after: { isActive },
    });

    return this.toSummary(updated);
  }

  /**
   * Retune a campaign's **future** behaviour (M19).
   *
   * What this can change is what the next redemption does. What it cannot touch,
   * and what nothing in the product can touch, is what a past redemption did:
   * `gift_code_redemption.coins` is the snapshot taken at the moment of the grant
   * and `coin_ledger` is append-only under a trigger. Raising `coins` from 50 to
   * 80 therefore leaves every existing redemption reading 50, which is correct and
   * is the reason the panel says so out loud (ADR-0016).
   *
   * `maxRedemptions` is refused below the count already taken, rather than
   * clamped: `CHECK (redeemed_count <= max_redemptions)` would refuse it anyway,
   * and a constraint violation rendered as a 500 is a worse answer than a
   * sentence.
   */
  async update(
    session: AdminSession,
    publicId: string,
    patch: {
      coins?: number;
      maxRedemptions?: number | null;
      perUserLimit?: number;
      startsAt?: Date | null;
      expiresAt?: Date | null;
      isActive?: boolean;
      campaign?: string | null;
      note?: string | null;
    },
  ): Promise<GiftCodeSummary> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const existing = await this.prisma.giftCode.findUnique({ where: { publicId } });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

    if (patch.coins !== undefined && (!Number.isInteger(patch.coins) || patch.coins <= 0)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'coins' });
    }
    if (
      patch.maxRedemptions !== undefined &&
      patch.maxRedemptions !== null &&
      patch.maxRedemptions < existing.redeemedCount
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'maxRedemptions' });
    }

    const perUserLimit =
      patch.perUserLimit === undefined
        ? undefined
        : await this.checkedPerUserLimit(patch.perUserLimit);

    const { startsAt, expiresAt } = checkedWindow(
      patch.startsAt === undefined ? existing.startsAt : patch.startsAt,
      patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
    );

    const updated = await this.prisma.giftCode.update({
      where: { publicId },
      data: {
        ...(patch.coins !== undefined ? { coins: patch.coins } : {}),
        ...(patch.maxRedemptions !== undefined ? { maxRedemptions: patch.maxRedemptions } : {}),
        ...(perUserLimit !== undefined ? { perUserLimit } : {}),
        ...(patch.startsAt !== undefined ? { startsAt } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.campaign !== undefined ? { campaign: trimmedOrNull(patch.campaign) } : {}),
        ...(patch.note !== undefined ? { note: trimmedOrNull(patch.note) } : {}),
      },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'giftcode.updated',
      targetType: 'gift_code',
      targetId: updated.id,
      before: {
        coins: existing.coins,
        maxRedemptions: existing.maxRedemptions,
        perUserLimit: existing.perUserLimit,
        isActive: existing.isActive,
        campaign: existing.campaign,
        startsAt: existing.startsAt?.toISOString() ?? null,
        expiresAt: existing.expiresAt?.toISOString() ?? null,
      },
      after: {
        coins: updated.coins,
        maxRedemptions: updated.maxRedemptions,
        perUserLimit: updated.perUserLimit,
        isActive: updated.isActive,
        campaign: updated.campaign,
        startsAt: updated.startsAt?.toISOString() ?? null,
        expiresAt: updated.expiresAt?.toISOString() ?? null,
      },
    });

    return this.toSummary(updated);
  }

  /**
   * The campaign list, newest first, paginated and filterable.
   *
   * `total` comes back with the page because an operator draining a campaign
   * needs to know how much they are not looking at, and a `LIMIT` with no count
   * makes "is that all of them?" unanswerable. Two queries in one round trip
   * rather than a window function: the count is over an indexed predicate and
   * this table is small by construction.
   *
   * No audit row — invariant 12 is about mutations.
   */
  async list(session: AdminSession, filters: GiftCodeListFilters = {}): Promise<GiftCodePage> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const where: Prisma.GiftCodeWhereInput = {
      ...(filters.campaign !== undefined ? { campaign: filters.campaign } : {}),
      ...(filters.batchId !== undefined ? { batchId: filters.batchId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.code !== undefined ? { code: normalizeCode(filters.code) } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.giftCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: boundedLimit(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
      }),
      this.prisma.giftCode.count({ where }),
    ]);

    return { codes: rows.map((row) => this.toSummary(row)), total };
  }

  /**
   * Everything a person can ask about one campaign (M19).
   *
   * **The durable rows are the source of truth, and the metric is not.**
   * `payetam_gift_code_redemptions_total` is a counter on one process that resets
   * on deploy; it is the right thing for an alert on a burst of refusals and the
   * wrong thing for "how much did this campaign cost us?". Successful redemptions
   * are counted from `gift_code_redemption`, coins are summed from its immutable
   * `coins` snapshot, and refusals come from `audit_log` — where the redemption
   * path writes one row per refused attempt precisely so this question has an
   * answer that survives a restart.
   *
   * Five aggregates, five queries, no N+1: every one of them is a single grouped
   * scan over an index added in migration 0018.
   */
  async analytics(
    session: AdminSession,
    publicId: string,
    window: { from?: Date; to?: Date } = {},
  ): Promise<GiftCodeAnalytics> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const row = await this.prisma.giftCode.findUnique({ where: { publicId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);

    const createdAt = dateRange(window);
    const { from, to } = windowBounds(window);
    const redemptionWhere: Prisma.GiftCodeRedemptionWhereInput = {
      giftCodeId: row.id,
      ...(createdAt !== undefined ? { createdAt } : {}),
    };

    const [totals, distinct, bounds, trend, failures] = await Promise.all([
      this.prisma.giftCodeRedemption.aggregate({
        where: redemptionWhere,
        _count: { _all: true },
        _sum: { coins: true },
      }),
      this.prisma.giftCodeRedemption.groupBy({
        by: ['userId'],
        where: redemptionWhere,
      }),
      this.prisma.giftCodeRedemption.aggregate({
        where: redemptionWhere,
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
      this.prisma.$queryRaw<Array<{ day: Date; redemptions: bigint; coins: bigint | null }>>`
        SELECT date_trunc('day', "created_at") AS day,
               COUNT(*)      AS redemptions,
               SUM("coins")  AS coins
        FROM "gift_code_redemption"
        WHERE "gift_code_id" = ${row.id}
          AND "created_at" BETWEEN ${from} AND ${to}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      /**
       * Refusals, grouped by the reason code the redemption path recorded.
       *
       * Raw SQL because the grouping key is inside a `jsonb` column and Prisma's
       * `groupBy` cannot reach it. A tagged template with one interpolated
       * parameter, never a concatenation — the CI grep that hunts for built SQL
       * exists because "it was only a constant" is what the next copy of this
       * will also believe.
       */
      this.prisma.$queryRaw<Array<{ reason: string | null; attempts: bigint }>>`
        SELECT "after" ->> 'reason' AS reason, COUNT(*) AS attempts
        FROM "audit_log"
        WHERE "action" = ${GIFT_CODE_FAILURE_ACTION}
          AND "target_type" = 'gift_code'
          AND "target_id" = ${row.id}
          AND "created_at" BETWEEN ${from} AND ${to}
        GROUP BY 1
      `,
    ]);

    const failuresByReason: Record<string, number> = {};
    let failedAttempts = 0;
    for (const entry of failures) {
      const attempts = Number(entry.attempts);
      failedAttempts += attempts;
      failuresByReason[entry.reason ?? 'unknown'] = attempts;
    }

    return {
      summary: this.toSummary(row),
      successfulRedemptions: totals._count._all,
      uniqueUsers: distinct.length,
      coinsGranted: totals._sum.coins ?? 0,
      failedAttempts,
      failuresByReason,
      firstRedeemedAt: bounds._min.createdAt,
      lastRedeemedAt: bounds._max.createdAt,
      trend: trend.map((bucket) => ({
        day: bucket.day.toISOString().slice(0, 10),
        redemptions: Number(bucket.redemptions),
        coins: Number(bucket.coins ?? 0n),
      })),
    };
  }

  /**
   * Every campaign, rolled up (M19).
   *
   * One grouped query rather than "list the codes, then ask each one" — the N+1
   * that a per-code analytics endpoint invites the moment somebody builds a
   * campaign screen out of it. Codes with no campaign label are excluded rather
   * than bucketed under «بدون کمپین»: a one-off support gesture is not a campaign,
   * and averaging it in makes the numbers describe nothing.
   */
  async campaigns(
    session: AdminSession,
    window: { from?: Date; to?: Date } = {},
  ): Promise<CampaignSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);
    const { from, to } = windowBounds(window);

    return (
      await this.prisma.$queryRaw<
        Array<{
          campaign: string;
          codes: bigint;
          active_codes: bigint;
          redemptions: bigint;
          coins_granted: bigint | null;
          unique_users: bigint;
          first_redeemed_at: Date | null;
          last_redeemed_at: Date | null;
        }>
      >`
        SELECT g."campaign"                                   AS campaign,
               COUNT(DISTINCT g."id")                         AS codes,
               COUNT(DISTINCT g."id") FILTER (WHERE g."is_active") AS active_codes,
               COUNT(r."id")                                  AS redemptions,
               COALESCE(SUM(r."coins"), 0)                    AS coins_granted,
               COUNT(DISTINCT r."user_id")                    AS unique_users,
               MIN(r."created_at")                            AS first_redeemed_at,
               MAX(r."created_at")                            AS last_redeemed_at
        FROM "gift_code" g
        LEFT JOIN "gift_code_redemption" r
               ON r."gift_code_id" = g."id"
              AND r."created_at" BETWEEN ${from} AND ${to}
        WHERE g."campaign" IS NOT NULL
        GROUP BY g."campaign"
        ORDER BY MAX(g."created_at") DESC
        LIMIT 200
      `
    ).map((row) => ({
      campaign: row.campaign,
      codes: Number(row.codes),
      activeCodes: Number(row.active_codes),
      redemptions: Number(row.redemptions),
      coinsGranted: Number(row.coins_granted ?? 0n),
      uniqueUsers: Number(row.unique_users),
      firstRedeemedAt: row.first_redeemed_at,
      lastRedeemedAt: row.last_redeemed_at,
    }));
  }

  /**
   * Who redeemed one code, and what they were actually granted.
   *
   * `coins` is read from the redemption row rather than from the code, which is
   * the whole point of the snapshot: a campaign retuned from 50 to 80 shows 50
   * against the redemptions that happened at 50, and the panel can prove that
   * changing configuration did not rewrite history (ADR-0016).
   *
   * A user is a `public_id` and nothing else. Not a display name, not a Telegram
   * anything — a list of who took a promotion is not a reason to project profiles.
   */
  async redemptions(
    session: AdminSession,
    publicId: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<{ redemptions: GiftCodeRedemptionRow[]; total: number }> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const code = await this.prisma.giftCode.findUnique({
      where: { publicId },
      select: { id: true },
    });
    if (!code) throw new AppError(ErrorCode.NOT_FOUND);

    const where = { giftCodeId: code.id };
    const [rows, total] = await Promise.all([
      this.prisma.giftCodeRedemption.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: boundedLimit(page.limit),
        skip: Math.max(page.offset ?? 0, 0),
        select: {
          seq: true,
          coins: true,
          createdAt: true,
          user: { select: { publicId: true } },
        },
      }),
      this.prisma.giftCodeRedemption.count({ where }),
    ]);

    return {
      redemptions: rows.map((row) => ({
        userPublicId: row.user.publicId,
        seq: row.seq,
        coins: row.coins,
        createdAt: row.createdAt,
      })),
      total,
    };
  }

  /**
   * The per-user cap, refused above the platform limit (ADR-0016).
   *
   * A setting rather than a constant so raising it is a recorded decision, and
   * checked **here** rather than only in the zod contract because a seed script
   * never passes through a pipe. Existing rows above the limit are untouched:
   * this governs what may be created, not what was.
   */
  private async checkedPerUserLimit(requested: number): Promise<number> {
    const max = await this.settings.getInt('giftcode.max_per_user_limit');
    if (!Number.isInteger(requested) || requested < 1 || requested > max) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'perUserLimit', max });
    }
    return requested;
  }

  /**
   * Field by field, never a spread (§3.6 layer 2).
   *
   * `gift_code` carries the internal id, the staff account that minted it — and
   * **the code**, which from M19 is the field this mapper exists to keep out of a
   * response. A spread would hand over all three the moment somebody adds a
   * column.
   */
  private toSummary(row: {
    publicId: string;
    code: string;
    campaign: string | null;
    batchId: string | null;
    coins: number;
    maxRedemptions: number | null;
    perUserLimit: number;
    redeemedCount: number;
    startsAt: Date | null;
    expiresAt: Date | null;
    isActive: boolean;
    note: string | null;
    createdAt: Date;
  }): GiftCodeSummary {
    return {
      publicId: row.publicId,
      codeMasked: maskCode(row.code),
      campaign: row.campaign,
      batchId: row.batchId,
      coins: row.coins,
      maxRedemptions: row.maxRedemptions,
      perUserLimit: row.perUserLimit,
      redeemedCount: row.redeemedCount,
      remainingRedemptions:
        row.maxRedemptions === null ? null : Math.max(row.maxRedemptions - row.redeemedCount, 0),
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      isActive: row.isActive,
      state: giftCodeState(row, this.clock.now()),
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}

/**
 * `NOWR••••4F2Z` — recognisable, not redeemable.
 *
 * Four leading and four trailing characters of a twelve-character code leave
 * 31⁴ ≈ 923 000 possibilities against a bucket of ten attempts an hour, which is
 * eleven years of guessing for one code. Short codes reveal less rather than
 * more: below ten characters only the first two survive, because a four-character
 * code masked to "first four" is not masked at all.
 */
export function maskCode(code: string): string {
  if (code.length < 6) return '•'.repeat(code.length);
  const head = code.length >= 10 ? 4 : 2;
  const tail = code.length >= 10 ? 4 : 1;
  return `${code.slice(0, head)}${'•'.repeat(code.length - head - tail)}${code.slice(-tail)}`;
}

/**
 * What the three columns and the clock add up to.
 *
 * Computed on the server and sent as a word, rather than sent as three booleans
 * and a timestamp for each client to combine. A panel that decided "expired"
 * itself would be comparing an ISO string against the *browser's* clock, and
 * invariant 9 says no surface in this product does that.
 *
 * The order is the order a redemption checks them in, so the badge on the screen
 * and the refusal a user would get are the same fact.
 */
export function giftCodeState(
  row: {
    isActive: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    maxRedemptions: number | null;
    redeemedCount: number;
  },
  now: Date,
): GiftCodeState {
  if (!row.isActive) return 'DISABLED';
  if (row.startsAt !== null && row.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.maxRedemptions !== null && row.redeemedCount >= row.maxRedemptions) return 'EXHAUSTED';
  return 'ACTIVE';
}

/** Stated here as well as in the CHECK, so an operator gets a sentence. */
function checkedWindow(
  startsAt: Date | null,
  expiresAt: Date | null,
): { startsAt: Date | null; expiresAt: Date | null } {
  if (startsAt !== null && expiresAt !== null && startsAt.getTime() >= expiresAt.getTime()) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'expiresAt' });
  }
  return { startsAt, expiresAt };
}

/** `''` and `'   '` are not a campaign name; they are a field somebody skipped. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Every admin list is bounded, whatever the caller asked for (§4). */
function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

function dateRange(window: { from?: Date; to?: Date }): { gte?: Date; lte?: Date } | undefined {
  if (window.from === undefined && window.to === undefined) return undefined;
  return {
    ...(window.from !== undefined ? { gte: window.from } : {}),
    ...(window.to !== undefined ? { lte: window.to } : {}),
  };
}

/**
 * The same window as `dateRange`, as two real dates rather than an optional pair.
 *
 * Raw SQL cannot express "this bound is absent" without either a `CASE` per bound
 * or four parameters that are each compared twice — both of which read as
 * cleverness and neither of which is faster than a `BETWEEN` over sentinels. No
 * redemption predates the epoch and none will be recorded in the hundredth
 * century, so the sentinels are unreachable rather than merely improbable.
 */
function windowBounds(window: { from?: Date; to?: Date }): { from: Date; to: Date } {
  return {
    from: window.from ?? new Date('1970-01-01T00:00:00.000Z'),
    to: window.to ?? new Date('9999-12-31T23:59:59.999Z'),
  };
}
