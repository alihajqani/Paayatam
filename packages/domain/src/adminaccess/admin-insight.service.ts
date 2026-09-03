import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@payetam/db';
import type {
  ActorType,
  CoinLedgerType,
  EventStatus,
  ParticipantStatus,
  ReportStatus,
  UserStatus,
} from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { sanitizeInbound } from '../privacy/sanitizer';
import { normalize } from '../moderation/persian-normalizer';
import { GIFT_CODE_FAILURE_ACTION } from '../economy/gift-code.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** One `(key, count)` row, as every roll-up on the dashboard is. */
export type Tally = Record<string, number>;

export interface AdminDashboard {
  users: { total: number; byStatus: Tally; newLast7Days: number; activeLast7Days: number };
  events: { total: number; byStatus: Tally };
  participations: { byStatus: Tally };
  chats: { byStatus: Tally };
  reports: { byStatus: Tally };
  cases: { byStatus: Tally };
  economy: {
    /** `SUM(coin_account.balance)` — what users are holding right now. */
    coinsHeld: number;
    /** `SUM(coin_ledger.amount)` where positive — everything ever granted. */
    coinsGranted: number;
    coinsSpent: number;
    ledgerLast24h: number;
  };
  referrals: { byStatus: Tally; flagged: number };
  giftCodes: {
    total: number;
    active: number;
    redemptions: number;
    coinsGranted: number;
    failedAttemptsLast24h: number;
  };
  moderationBacklog: { openCases: number; openReports: number; oldestOpenCaseAt: Date | null };
}

export interface UserSummary {
  publicId: string;
  displayName: string | null;
  status: UserStatus;
  onboardingState: string;
  trustScore: number | null;
  coinBalance: number;
  createdAt: Date;
}

export interface UserDetail extends UserSummary {
  cityNameFa: string | null;
  districtNameFa: string | null;
  birthYear: number | null;
  /**
   * The bio, with contact details **masked** — «حذف شد» in place of a phone
   * number, an `@handle`, a `t.me/` link or an email.
   *
   * The leak scan found this one: a user who types their number into their bio
   * has not consented to hand it to staff, and `user.read` is held by `SUPPORT`,
   * which is the role most exposed to social engineering. The bio reaches no
   * other user anywhere in the product, so a raw one here would be the *only*
   * place those digits are ever projected.
   *
   * Masked with the same `sanitizeInbound` the chat relay uses rather than a
   * second set of patterns, so a rule added for one is a rule that holds for both.
   */
  bio: string | null;
  /** How many fragments the masking removed, so a moderator knows it happened. */
  bioRedactions: number;
  coins: { granted: number; spent: number; entries: number };
  referrals: { made: number; qualified: number; rejected: number; receivedStatus: string | null };
  events: { hosted: number; published: number };
  participations: Tally;
  reportsAgainst: number;
  reportsFiled: number;
  giftCodeRedemptions: { count: number; coins: number };
}

export interface EventSummary {
  publicId: string;
  title: string;
  status: EventStatus;
  moderationStatus: string;
  hostPublicId: string;
  hostDisplayName: string | null;
  cityNameFa: string;
  startsAt: Date;
  capacity: number;
  acceptedCount: number;
  requestCount: number;
  reportCount: number;
  createdAt: Date;
}

export interface ReportSummary {
  publicId: string;
  targetType: string;
  targetId: string;
  reason: string;
  description: string | null;
  status: ReportStatus;
  moderationCaseId: string | null;
  reporterPublicId: string;
  createdAt: Date;
}

export interface LedgerEntrySummary {
  userPublicId: string;
  amount: number;
  balanceAfter: number;
  type: CoinLedgerType;
  reasonCode: string;
  actorType: string;
  refType: string | null;
  createdAt: Date;
}

export interface AuditEntrySummary {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  createdAt: Date;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

/**
 * Everything the admin panel **reads** (M19, ADR-0010, ADR-0016).
 *
 * Split from `AdminOperationsService` because that file is where invariant 12
 * lives — *"every mutating admin action is authorised in the service layer and
 * writes `audit_log`"* — and mixing thirty read methods into it would bury the
 * pairing that makes the invariant checkable by reading. Nothing here writes, and
 * nothing here writes an audit row, which is the correct reading of invariant 12
 * rather than an omission.
 *
 * Three rules hold across every method:
 *
 *  1. **Every read asserts a permission.** `ANALYST` holds `dashboard.read` and
 *     nothing else, so the dashboard answers and every other method here refuses
 *     — which is ADR-0010's "read-only aggregates means aggregates, not a licence
 *     to read every user record", enforced rather than described.
 *  2. **Every list is bounded and reports its total.** An admin list with no
 *     `LIMIT` is the query that takes production down at the worst moment, and
 *     one with no total makes "is that all of them?" unanswerable.
 *  3. **Nothing can reach `telegram_account`.** Not by `include`, not by a
 *     relation, not by a spread — every projection here is an explicit `select`,
 *     and the leak scan walks the endpoints that expose them (invariant 7).
 */
@Injectable()
export class AdminInsightService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
  ) {}

  /**
   * The dashboard, as one round of parallel aggregates.
   *
   * Every roll-up is a `groupBy` or a `count` rather than a fetch-and-tally: the
   * screen that opens on every shift must not be the screen that reads the
   * `event` table into memory. Nothing here is per-row, so the cost is flat in
   * the number of *statuses* rather than in the number of rows.
   *
   * `dashboard.read` is the least a staff account can hold, which makes this the
   * one method here that `ANALYST` can call.
   */
  async dashboard(session: AdminSession): Promise<AdminDashboard> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const now = this.clock.now();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);

    const [
      usersByStatus,
      newUsers,
      activeUsers,
      eventsByStatus,
      participationsByStatus,
      chatsByStatus,
      reportsByStatus,
      casesByStatus,
      coinsHeld,
      granted,
      spent,
      ledgerLast24h,
      referralsByStatus,
      flaggedReferrals,
      giftCodes,
      activeGiftCodes,
      redemptions,
      giftCodeFailures,
      oldestOpenCase,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      // "Active" is a user who did something, not one who exists: a login count
      // would make a dormant install look healthy.
      this.prisma.user.count({
        where: {
          OR: [
            { participations: { some: { requestedAt: { gte: weekAgo } } } },
            { hostedEvents: { some: { createdAt: { gte: weekAgo } } } },
            { chatMemberships: { some: { lastReadAt: { gte: weekAgo } } } },
          ],
        },
      }),
      this.prisma.event.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.eventParticipant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.anonymousChat.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.moderationCase.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.coinAccount.aggregate({ _sum: { balance: true } }),
      this.prisma.coinLedger.aggregate({
        where: { amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.coinLedger.aggregate({
        where: { amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.coinLedger.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.referral.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.referral.count({ where: { fraudSignals: { not: Prisma.DbNull } } }),
      this.prisma.giftCode.count(),
      this.prisma.giftCode.count({ where: { isActive: true } }),
      this.prisma.giftCodeRedemption.aggregate({ _count: { _all: true }, _sum: { coins: true } }),
      this.prisma.auditLog.count({
        where: { action: GIFT_CODE_FAILURE_ACTION, createdAt: { gte: dayAgo } },
      }),
      this.prisma.moderationCase.findFirst({
        where: { status: { in: ['OPEN', 'IN_REVIEW', 'ESCALATED'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const openCases = casesByStatus
      .filter((row) => ['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(row.status))
      .reduce((sum, row) => sum + row._count._all, 0);

    return {
      users: {
        total: usersByStatus.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: tally(usersByStatus, 'status'),
        newLast7Days: newUsers,
        activeLast7Days: activeUsers,
      },
      events: {
        total: eventsByStatus.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: tally(eventsByStatus, 'status'),
      },
      participations: { byStatus: tally(participationsByStatus, 'status') },
      chats: { byStatus: tally(chatsByStatus, 'status') },
      reports: { byStatus: tally(reportsByStatus, 'status') },
      cases: { byStatus: tally(casesByStatus, 'status') },
      economy: {
        coinsHeld: coinsHeld._sum.balance ?? 0,
        coinsGranted: granted._sum.amount ?? 0,
        // Stored signed; reported as a magnitude, because "spent 400" reads and
        // "spent −400" does not.
        coinsSpent: Math.abs(spent._sum.amount ?? 0),
        ledgerLast24h,
      },
      referrals: { byStatus: tally(referralsByStatus, 'status'), flagged: flaggedReferrals },
      giftCodes: {
        total: giftCodes,
        active: activeGiftCodes,
        redemptions: redemptions._count._all,
        coinsGranted: redemptions._sum.coins ?? 0,
        failedAttemptsLast24h: giftCodeFailures,
      },
      moderationBacklog: {
        openCases,
        openReports: reportsByStatus.find((row) => row.status === 'OPEN')?._count._all ?? 0,
        oldestOpenCaseAt: oldestOpenCase?.createdAt ?? null,
      },
    };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  /**
   * Find a user.
   *
   * The search runs over `display_name` **normalized through the ADR-0012
   * pipeline**, because a moderator typing «علي» must find «علی» — the same
   * ي/ك and half-space folding discovery uses. Matching the raw column would
   * make the admin surface the one place in the product where Persian search
   * does not work.
   *
   * A `publicId` is matched exactly, so pasting one from a report finds the
   * account rather than searching for it.
   */
  async listUsers(
    session: AdminSession,
    filters: { query?: string; status?: UserStatus; limit?: number; offset?: number } = {},
  ): Promise<Page<UserSummary>> {
    this.access.assertPermission(session, PERMISSIONS.USER_READ);

    const query = filters.query?.trim();
    const where: Prisma.UserWhereInput = {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(query !== undefined && query !== ''
        ? {
            OR: [
              { publicId: query },
              { profile: { displayName: { contains: query, mode: 'insensitive' } } },
              { profile: { displayName: { contains: normalize(query), mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: bounded(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
        select: USER_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { rows: rows.map(toUserSummary), total };
  }

  /**
   * One user, from every angle a support conversation needs.
   *
   * Eleven aggregates in parallel rather than eleven round trips, and none of
   * them fetches rows to count them. The Telegram account is **not** among them:
   * a support agent needs to know what somebody did, not which Telegram account
   * did it, and the one time an identity is genuinely needed the answer is
   * break-glass with a case and a reason (T14).
   */
  async getUser(session: AdminSession, publicId: string): Promise<UserDetail> {
    this.access.assertPermission(session, PERMISSIONS.USER_READ);

    const user = await this.prisma.user.findUnique({
      where: { publicId },
      select: {
        ...USER_SELECT,
        id: true,
        profile: {
          select: {
            displayName: true,
            birthYear: true,
            bio: true,
            city: { select: { nameFa: true } },
            district: { select: { nameFa: true } },
          },
        },
      },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    const [
      granted,
      spent,
      entries,
      referralsMade,
      referralsQualified,
      referralsRejected,
      received,
      hosted,
      published,
      participations,
      reportsAgainst,
      reportsFiled,
      giftCodes,
    ] = await Promise.all([
      this.prisma.coinLedger.aggregate({
        where: { userId: user.id, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.coinLedger.aggregate({
        where: { userId: user.id, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.coinLedger.count({ where: { userId: user.id } }),
      this.prisma.referral.count({ where: { referrerUserId: user.id } }),
      this.prisma.referral.count({ where: { referrerUserId: user.id, status: 'QUALIFIED' } }),
      this.prisma.referral.count({ where: { referrerUserId: user.id, status: 'REJECTED' } }),
      this.prisma.referral.findUnique({
        where: { referredUserId: user.id },
        select: { status: true },
      }),
      this.prisma.event.count({ where: { hostUserId: user.id } }),
      this.prisma.event.count({ where: { hostUserId: user.id, status: 'PUBLISHED' } }),
      this.prisma.eventParticipant.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { _all: true },
      }),
      this.prisma.report.count({ where: { targetType: 'USER', targetId: user.id } }),
      this.prisma.report.count({ where: { reporterUserId: user.id } }),
      this.prisma.giftCodeRedemption.aggregate({
        where: { userId: user.id },
        _count: { _all: true },
        _sum: { coins: true },
      }),
    ]);

    const bio =
      user.profile?.bio == null
        ? null
        : sanitizeInbound({ text: user.profile.bio }, { maskContactDetails: true });

    return {
      ...toUserSummary(user),
      cityNameFa: user.profile?.city.nameFa ?? null,
      districtNameFa: user.profile?.district?.nameFa ?? null,
      birthYear: user.profile?.birthYear ?? null,
      bio: bio?.text ?? null,
      bioRedactions: bio?.redactions.length ?? 0,
      coins: {
        granted: granted._sum.amount ?? 0,
        spent: Math.abs(spent._sum.amount ?? 0),
        entries,
      },
      referrals: {
        made: referralsMade,
        qualified: referralsQualified,
        rejected: referralsRejected,
        receivedStatus: received?.status ?? null,
      },
      events: { hosted, published },
      participations: tally(participations, 'status'),
      reportsAgainst,
      reportsFiled,
      giftCodeRedemptions: {
        count: giftCodes._count._all,
        coins: giftCodes._sum.coins ?? 0,
      },
    };
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  async listEvents(
    session: AdminSession,
    filters: {
      query?: string;
      status?: EventStatus;
      hostPublicId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Page<EventSummary>> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);

    const query = filters.query?.trim();
    const where: Prisma.EventWhereInput = {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.hostPublicId !== undefined ? { host: { publicId: filters.hostPublicId } } : {}),
      // Against the *normalized* column, which is what the ADR-0012 pipeline
      // wrote and what discovery searches. Matching `title` would make the
      // moderation queue the one search in the product that fails on «ي».
      ...(query !== undefined && query !== ''
        ? { titleNormalized: { contains: normalize(query) } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: bounded(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
        select: EVENT_SELECT,
      }),
      this.prisma.event.count({ where }),
    ]);

    const reportCounts = await this.reportsFor(
      'EVENT',
      rows.map((row) => row.id),
    );

    return {
      rows: rows.map((row) => toEventSummary(row, reportCounts.get(row.id) ?? 0)),
      total,
    };
  }

  async getEvent(session: AdminSession, publicId: string): Promise<EventSummary> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);

    const row = await this.prisma.event.findUnique({
      where: { publicId },
      select: EVENT_SELECT,
    });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);

    const reports = await this.reportsFor('EVENT', [row.id]);
    return toEventSummary(row, reports.get(row.id) ?? 0);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /**
   * The report queue.
   *
   * `report.review` rather than `event.moderate`, because `SUPPORT` holds the
   * first and not the second: reading what people complained about is the job,
   * and hiding an event is a different one.
   *
   * The reporter is a `public_id`. §7's rule that a decision never reveals the
   * reporter to the reported is upstream of this — nothing here reaches a
   * response a reported user can see — but the identity is still projected as
   * narrowly as it can be.
   */
  async listReports(
    session: AdminSession,
    filters: {
      status?: ReportStatus;
      targetType?: 'EVENT' | 'USER' | 'MESSAGE' | 'REVIEW';
      targetId?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Page<ReportSummary>> {
    this.access.assertPermission(session, PERMISSIONS.REPORT_REVIEW);

    const createdAt =
      filters.from === undefined && filters.to === undefined
        ? undefined
        : {
            ...(filters.from !== undefined ? { gte: filters.from } : {}),
            ...(filters.to !== undefined ? { lte: filters.to } : {}),
          };

    const where: Prisma.ReportWhereInput = {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.targetType !== undefined ? { targetType: filters.targetType } : {}),
      ...(filters.targetId !== undefined ? { targetId: filters.targetId } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        // Oldest first: a queue nobody works from the bottom.
        orderBy: { createdAt: 'asc' },
        take: bounded(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
        select: {
          publicId: true,
          targetType: true,
          targetId: true,
          reason: true,
          description: true,
          status: true,
          moderationCaseId: true,
          createdAt: true,
          reporter: { select: { publicId: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        publicId: row.publicId,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        description: row.description,
        status: row.status,
        moderationCaseId: row.moderationCaseId,
        reporterPublicId: row.reporter.publicId,
        createdAt: row.createdAt,
      })),
      total,
    };
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────

  /**
   * The coin ledger, searchable (ADR-0007).
   *
   * This is what makes "where did my coins go?" answerable by somebody other than
   * the person asking. `ledger.read` — held by `SUPPORT`, which deliberately does
   * **not** hold `coin.adjust`: reading the ledger is how a support conversation
   * is resolved, and moving a balance is not a support action.
   *
   * Immutable by construction rather than by permission: `coin_ledger` carries a
   * `BEFORE UPDATE OR DELETE` trigger, so there is no writing path to expose.
   */
  async searchLedger(
    session: AdminSession,
    filters: {
      userPublicId?: string;
      type?: CoinLedgerType;
      reasonCode?: string;
      refType?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Page<LedgerEntrySummary> & { net: number }> {
    this.access.assertPermission(session, PERMISSIONS.LEDGER_READ);

    const user =
      filters.userPublicId === undefined
        ? undefined
        : await this.prisma.user.findUnique({
            where: { publicId: filters.userPublicId },
            select: { id: true },
          });
    if (filters.userPublicId !== undefined && user == null) {
      return { rows: [], total: 0, net: 0 };
    }

    const createdAt =
      filters.from === undefined && filters.to === undefined
        ? undefined
        : {
            ...(filters.from !== undefined ? { gte: filters.from } : {}),
            ...(filters.to !== undefined ? { lte: filters.to } : {}),
          };

    const where: Prisma.CoinLedgerWhereInput = {
      ...(user != null ? { userId: user.id } : {}),
      ...(filters.type !== undefined ? { type: filters.type } : {}),
      ...(filters.reasonCode !== undefined ? { reasonCode: filters.reasonCode } : {}),
      ...(filters.refType !== undefined ? { refType: filters.refType } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };

    const [rows, total, net] = await Promise.all([
      this.prisma.coinLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: bounded(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
        select: {
          amount: true,
          balanceAfter: true,
          type: true,
          reasonCode: true,
          actorType: true,
          refType: true,
          createdAt: true,
          user: { select: { publicId: true } },
        },
      }),
      this.prisma.coinLedger.count({ where }),
      this.prisma.coinLedger.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
      rows: rows.map((row) => ({
        userPublicId: row.user.publicId,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        type: row.type,
        reasonCode: row.reasonCode,
        actorType: row.actorType,
        refType: row.refType,
        createdAt: row.createdAt,
      })),
      total,
      // Over the whole filter, not the page: "what did this campaign cost us?"
      // is a question about every matching row.
      net: net._sum.amount ?? 0,
    };
  }

  /**
   * Reconciliation, as a question anybody with `ledger.read` can ask.
   *
   * ADR-0007's invariant is `coin_account.balance = SUM(coin_ledger.amount)` per
   * user, and `reconciliation.int.test.ts` asserts it on every commit — against a
   * database a test built. This asks it of the **real** one, which is the version
   * that matters at three in the morning.
   *
   * One statement, grouped, with the accounts that disagree returned rather than
   * a boolean: "reconciliation failed" is not something anybody can act on.
   */
  async reconcile(session: AdminSession): Promise<{
    accounts: number;
    drifted: Array<{ userPublicId: string; balance: number; ledger: number }>;
  }> {
    this.access.assertPermission(session, PERMISSIONS.LEDGER_READ);

    const [accounts, drifted] = await Promise.all([
      this.prisma.coinAccount.count(),
      this.prisma.$queryRaw<Array<{ public_id: string; balance: number; ledger: bigint | null }>>`
        SELECT u."public_id", a."balance", COALESCE(SUM(l."amount"), 0) AS ledger
        FROM "coin_account" a
        JOIN "user" u ON u."id" = a."user_id"
        LEFT JOIN "coin_ledger" l ON l."user_id" = a."user_id"
        GROUP BY u."public_id", a."balance"
        HAVING a."balance" <> COALESCE(SUM(l."amount"), 0)
        LIMIT 100
      `,
    ]);

    return {
      accounts,
      drifted: drifted.map((row) => ({
        userPublicId: row.public_id,
        balance: row.balance,
        ledger: Number(row.ledger ?? 0n),
      })),
    };
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  /**
   * The audit trail, filterable and paginated.
   *
   * `AdminOperationsService.listAuditLog` is kept as it was — four fields, no
   * paging — because the RBAC matrix and the leak scan both address it and
   * changing its shape would be changing a tested contract for no reason. This is
   * the panel's viewer: the same rows, the same permission, with the filters and
   * the payloads a person reading an incident actually needs.
   *
   * `before` and `after` are projected as stored. They are an allowlist at every
   * call site by rule (`AuditService`'s contract), which is what makes showing
   * them safe — and it is why nothing in this milestone ever put a gift code or a
   * Telegram id into one.
   */
  async listAudit(
    session: AdminSession,
    filters: {
      actorId?: string;
      actorType?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Page<AuditEntrySummary>> {
    this.access.assertPermission(session, PERMISSIONS.AUDIT_READ);

    const createdAt =
      filters.from === undefined && filters.to === undefined
        ? undefined
        : {
            ...(filters.from !== undefined ? { gte: filters.from } : {}),
            ...(filters.to !== undefined ? { lte: filters.to } : {}),
          };

    const where: Prisma.AuditLogWhereInput = {
      ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
      ...(filters.actorType !== undefined ? { actorType: filters.actorType as ActorType } : {}),
      // A prefix, so `giftcode.` finds every gift-code action without an
      // operator having to know the six names.
      ...(filters.action !== undefined ? { action: { startsWith: filters.action } } : {}),
      ...(filters.targetType !== undefined ? { targetType: filters.targetType } : {}),
      ...(filters.targetId !== undefined ? { targetId: filters.targetId } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: bounded(filters.limit),
        skip: Math.max(filters.offset ?? 0, 0),
        select: {
          id: true,
          actorType: true,
          actorId: true,
          action: true,
          targetType: true,
          targetId: true,
          before: true,
          after: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * How many open reports each of these subjects has.
   *
   * One grouped query for a whole page, which is the difference between a
   * moderation list and an N+1 that gets slower as the queue gets longer.
   */
  private async reportsFor(
    targetType: 'EVENT' | 'USER' | 'MESSAGE' | 'REVIEW',
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.report.groupBy({
      by: ['targetId'],
      where: { targetType, targetId: { in: ids }, status: 'OPEN' },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.targetId, row._count._all]));
  }
}

/** `[{ status, _count }]` → `{ status: count }`, with no zero rows invented. */
function tally<K extends string>(
  rows: Array<Record<K, string> & { _count: { _all: number } }>,
  key: K,
): Tally {
  return Object.fromEntries(rows.map((row) => [row[key], row._count._all]));
}

/** Every admin list is bounded, whatever the caller asked for (§4). */
function bounded(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

/**
 * The user projection, field by field (§3.6 layer 2).
 *
 * `user` has a `telegramAccount` relation one `include` away, and this is the
 * surface where reaching for it would feel most reasonable — a support agent
 * asking "who is this?". It is not here, and the answer to that question is
 * break-glass with a case and a written reason (T14).
 */
const USER_SELECT = {
  publicId: true,
  status: true,
  onboardingState: true,
  createdAt: true,
  profile: { select: { displayName: true } },
  trustScore: { select: { score: true } },
  coinAccount: { select: { balance: true } },
} as const;

function toUserSummary(row: {
  publicId: string;
  status: UserStatus;
  onboardingState: string;
  createdAt: Date;
  profile: { displayName: string } | null;
  trustScore: { score: number } | null;
  coinAccount: { balance: number } | null;
}): UserSummary {
  return {
    publicId: row.publicId,
    displayName: row.profile?.displayName ?? null,
    status: row.status,
    onboardingState: row.onboardingState,
    // **Null is not zero** (ADR-0014). `trust_score` is written lazily by the
    // first movement, so an account that has done nothing has no row, and 0 is
    // the worst possible reputation shown to somebody who has earned none of it.
    trustScore: row.trustScore?.score ?? null,
    // A balance, on the other hand, *is* zero when there is no account: an
    // account is created by the first movement and no movement means no coins.
    coinBalance: row.coinAccount?.balance ?? 0,
    createdAt: row.createdAt,
  };
}

const EVENT_SELECT = {
  id: true,
  publicId: true,
  title: true,
  status: true,
  moderationStatus: true,
  startsAt: true,
  capacity: true,
  acceptedCount: true,
  requestCount: true,
  createdAt: true,
  host: { select: { publicId: true, profile: { select: { displayName: true } } } },
  city: { select: { nameFa: true } },
} as const;

function toEventSummary(
  row: {
    publicId: string;
    title: string;
    status: EventStatus;
    moderationStatus: string;
    startsAt: Date;
    capacity: number;
    acceptedCount: number;
    requestCount: number;
    createdAt: Date;
    host: { publicId: string; profile: { displayName: string } | null };
    city: { nameFa: string };
  },
  reportCount: number,
): EventSummary {
  return {
    publicId: row.publicId,
    title: row.title,
    status: row.status,
    moderationStatus: row.moderationStatus,
    hostPublicId: row.host.publicId,
    hostDisplayName: row.host.profile?.displayName ?? null,
    cityNameFa: row.city.nameFa,
    startsAt: row.startsAt,
    capacity: row.capacity,
    acceptedCount: row.acceptedCount,
    requestCount: row.requestCount,
    reportCount,
    createdAt: row.createdAt,
  };
}

/** Re-exported for the controller's mapper, which narrows this again. */
export type { ParticipantStatus };
