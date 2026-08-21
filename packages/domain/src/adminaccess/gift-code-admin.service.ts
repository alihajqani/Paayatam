import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { normalizeCode } from '../economy/referral.service';
import { isUniqueViolation } from '../identity/user.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

export interface GiftCodeSummary {
  code: string;
  coins: number;
  /** Null is unlimited — the honest representation of "no cap". */
  maxRedemptions: number | null;
  perUserLimit: number;
  redeemedCount: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
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
  note?: string | null;
}

/**
 * Managing gift and discount codes (M18, ADR-0010).
 *
 * Separate from `GiftCodeService` for a structural reason rather than a stylistic
 * one: redeeming is a *user* operation and lives in `economy`, while creating and
 * disabling are *staff* operations and need `AdminAccessService` — which imports
 * `EconomyModule`. One service doing both would make that import a cycle. This is
 * the same split `ChatUnsealService` already makes against `ChatModule`.
 *
 * Every method begins with `assertPermission` and ends with an audit row, which is
 * invariant 12 in code. The check is here rather than in a controller guard so it
 * holds for the seeds, jobs and scripts that do not exist yet (ADR-0010 rule 2).
 *
 * **The permission is `giftcode.manage`, held only by `SUPER_ADMIN`.** Minting
 * coins out of nothing is the same class of capability as `coin.adjust`, and
 * ADR-0010's reasoning about `SUPPORT` applies unchanged: the role most exposed to
 * "please just give them the coins" is the role that must not be able to.
 */
@Injectable()
export class GiftCodeAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mint a campaign code.
   *
   * The code is normalized on write — upper-cased, spaces and dashes removed — by
   * the same function referral codes use, so «summer-24» and «SUMMER24» are one
   * code rather than two. Case-insensitivity is therefore a property of the
   * column, not something every read has to remember.
   */
  async create(session: AdminSession, input: CreateGiftCodeInput): Promise<GiftCodeSummary> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const code = normalizeCode(input.code);
    // Re-validated here and not only at the contract, because this service is
    // reachable from a script that never passes through a zod pipe.
    if (code.length < 4 || code.length > 32) throw new AppError(ErrorCode.VALIDATION_FAILED);
    if (!Number.isInteger(input.coins) || input.coins <= 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED);
    }

    const startsAt = input.startsAt ?? null;
    const expiresAt = input.expiresAt ?? null;
    if (startsAt !== null && expiresAt !== null && startsAt.getTime() >= expiresAt.getTime()) {
      // Stated here as well as in the CHECK, so an operator gets the error
      // catalogue's Persian rather than a constraint name rendered as a 500.
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'expiresAt' });
    }

    let created;
    try {
      created = await this.prisma.giftCode.create({
        data: {
          code,
          coins: input.coins,
          maxRedemptions: input.maxRedemptions ?? null,
          perUserLimit: input.perUserLimit ?? 1,
          startsAt,
          expiresAt,
          note: input.note ?? null,
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
      // An allowlist, never a spread: `audit_log` is read by staff and a spread
      // would carry whatever column somebody adds next.
      after: {
        code: created.code,
        coins: created.coins,
        maxRedemptions: created.maxRedemptions,
        perUserLimit: created.perUserLimit,
        startsAt: created.startsAt?.toISOString() ?? null,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });

    return toSummary(created);
  }

  /**
   * Turn a campaign on or off.
   *
   * A switch separate from the expiry window, for the reason `channel.enabled`
   * exists: a campaign that has to stop *now* must not require back-dating a
   * timestamp — which is fiddly under pressure and leaves a lie in the record.
   */
  async setActive(
    session: AdminSession,
    rawCode: string,
    isActive: boolean,
  ): Promise<GiftCodeSummary> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const code = normalizeCode(rawCode);
    const existing = await this.prisma.giftCode.findUnique({ where: { code } });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

    const updated = await this.prisma.giftCode.update({ where: { code }, data: { isActive } });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: isActive ? 'giftcode.enabled' : 'giftcode.disabled',
      targetType: 'gift_code',
      targetId: updated.id,
      before: { isActive: existing.isActive },
      after: { isActive },
    });

    return toSummary(updated);
  }

  /**
   * Every campaign, newest first, with its redemption count.
   *
   * This is the monitoring surface: `redeemedCount` against `maxRedemptions` is
   * how an operator sees a campaign being drained, and the audit trail
   * (`targetType = 'gift_code'`) is how they see who did what to it. No audit row
   * of its own — invariant 12 is about mutations.
   */
  async list(session: AdminSession, limit = 100): Promise<GiftCodeSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.GIFT_CODE_MANAGE);

    const rows = await this.prisma.giftCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return rows.map(toSummary);
  }
}

/**
 * Field by field, never a spread (§3.6 layer 2).
 *
 * `gift_code` carries the internal id and the id of the staff account that minted
 * it. Neither belongs in a response, and a spread would hand both over the moment
 * somebody adds a column.
 */
function toSummary(row: {
  code: string;
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
    code: row.code,
    coins: row.coins,
    maxRedemptions: row.maxRedemptions,
    perUserLimit: row.perUserLimit,
    redeemedCount: row.redeemedCount,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
    note: row.note,
    createdAt: row.createdAt,
  };
}
