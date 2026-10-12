import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { Prisma, PrismaService } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import {
  AppError,
  ErrorCode,
  INTERACTION_SESSION_GAP_MINUTES,
  type InteractionKind,
  type InteractionOutcome,
} from '@payetam/shared';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

export interface InteractionOverview {
  windowDays: number;
  since: Date;
  /** The first interaction ever recorded, or null before there is one. */
  trackingSince: Date | null;
  totals: {
    interactions: number;
    activeUsers: number;
    sessions: number;
    stepsPerSession: number;
    newAccounts: number;
    newAccountsSilent: number;
  };
  byDay: { day: string; interactions: number; activeUsers: number }[];
  byKind: { kind: InteractionKind; interactions: number; users: number }[];
  byOutcome: { outcome: InteractionOutcome; interactions: number }[];
  byHour: { hour: number; interactions: number }[];
}

export interface InteractionLink {
  action: string;
  ref: string | null;
  title: string | null;
  taps: number;
  users: number;
  newAccounts: number;
  returningUsers: number;
}

export interface InteractionLinks {
  windowDays: number;
  since: Date;
  rows: InteractionLink[];
  omittedRows: number;
}

export interface InteractionAction {
  kind: InteractionKind;
  action: string;
  count: number;
  users: number;
  refused: number;
  gated: number;
  stale: number;
  failed: number;
  topRefusal: string | null;
  averageMs: number;
}

export interface InteractionActions {
  windowDays: number;
  since: Date;
  rows: InteractionAction[];
  omittedRows: number;
}

export interface TimelineItem {
  id: string;
  at: Date;
  kind: InteractionKind;
  action: string;
  ref: string | null;
  outcome: InteractionOutcome;
  detail: string | null;
  screen: string | null;
  wizardKind: string | null;
  wizardStep: string | null;
  durationMs: number;
}

export interface InteractionTimeline {
  items: TimelineItem[];
  /** Pass back as `before` for the next page; null on the last one. */
  nextBefore: Date | null;
}

/** Rows on one screen of the links and the actions reports. */
const MAX_ROWS = 200;

/** One page of a person's trail. */
export const TIMELINE_PAGE_SIZE = 50;

/**
 * Staff are in no total.
 *
 * At this size the operator pressing buttons after a release is a visible share
 * of all traffic, and a report that counted it would be measuring the testing.
 * An account is staff when its Telegram id is linked to an admin (ADR-0018).
 *
 * The subquery reads `telegram_account` to make that match and **selects
 * nothing from it** — the pattern `AcquisitionReportService` documents for
 * `bot_blocked`. No Telegram id reaches a result row, so none can reach a
 * response (ADR-0009, invariant 7). A row with no user passes: `NULL = …` is
 * never true, so nobody is found to exclude it.
 */
const NOT_STAFF = Prisma.sql`NOT EXISTS (
  SELECT 1
  FROM "telegram_account" staff_account
  JOIN "admin_telegram_link" staff_link
    ON staff_link."telegram_user_id" = staff_account."telegram_user_id"
  WHERE staff_account."user_id" = i."user_id"
)`;

/**
 * Something a person did, as opposed to something that happened to the bot.
 *
 * A block and an unblock are recorded so the drop-off report can ask what came
 * before them. They are not a step anybody took *in* the bot, and counting
 * them as activity would make blocking the bot look like using it.
 */
const IS_ACTIVITY = Prisma.sql`i."kind" NOT IN ('BLOCKED', 'UNBLOCKED')`;

/**
 * What people do in the bot (migration 0065) — the «رفتار کاربران» page.
 *
 * ── What these answer that nothing else did ─────────────────────────────────
 *
 * `AcquisitionReportService` says which link created an account and how far
 * that account got. It cannot say how often a link is followed by people who
 * already have one, which buttons are pressed, whether anybody goes past the
 * welcome, or what refused them. Those are these four reads.
 *
 * ── Aggregates and one person's trail are different permissions ─────────────
 *
 * `overview`, `links` and `actions` are counts: `dashboard.read`, which is all
 * ADR-0010 gives `ANALYST`. `timeline` is a list about a person and needs
 * `user.read`, the permission the rest of that person's file needs. The check
 * is here and not only on the route, because a rule in a guard protects one
 * surface (invariant 12).
 *
 * ── Every statement is one tagged template ──────────────────────────────────
 *
 * Nothing is built at runtime; the two shared conditions above are `Prisma.sql`
 * fragments, which are parameterised like the templates they are placed in. CI
 * fails the build on `$queryRawUnsafe` because a built string reads like
 * injection, and nothing here needs one.
 *
 * Nothing here writes.
 */
@Injectable()
export class InteractionReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    /** For `APP_TIMEZONE` alone: a day and an hour are the product's, not UTC's. */
    @Inject(ENV) private readonly env: Env,
  ) {}

  async overview(session: AdminSession, windowDays: number): Promise<InteractionOverview> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const timezone = this.env.APP_TIMEZONE;

    const [totals, accounts, byDay, byKind, byOutcome, byHour, tracking] = await Promise.all([
      /**
       * A visit is a run of one person's interactions with no gap longer than
       * thirty minutes, so a visit *starts* at a row whose predecessor is
       * missing or older than that. `LAG` over the person's own rows finds the
       * predecessor; the count of starts is the count of visits.
       *
       * Rows with no user share one partition and are left out of the visits —
       * a tap from somebody the bot does not know belongs to nobody's visit.
       */
      this.prisma.$queryRaw<
        { interactions: bigint; active_users: bigint; attributed: bigint; sessions: bigint }[]
      >`
        WITH steps AS (
          SELECT i."user_id",
                 i."created_at",
                 LAG(i."created_at") OVER (
                   PARTITION BY i."user_id" ORDER BY i."created_at"
                 ) AS previous_at
          FROM "bot_interaction" i
          WHERE i."created_at" >= ${since} AND ${IS_ACTIVITY} AND ${NOT_STAFF}
        )
        SELECT COUNT(*) AS interactions,
               COUNT(DISTINCT "user_id") AS active_users,
               COUNT(*) FILTER (WHERE "user_id" IS NOT NULL) AS attributed,
               COUNT(*) FILTER (
                 WHERE "user_id" IS NOT NULL
                   AND ("previous_at" IS NULL
                        OR "created_at" - "previous_at"
                           > make_interval(mins => ${INTERACTION_SESSION_GAP_MINUTES}))
               ) AS sessions
        FROM steps
      `,
      /**
       * Accounts a `/start` created in the window, and how many of them never
       * did anything else. "Anything else" is read over all time, not over the
       * window: somebody who arrived on its last day and pressed a button the
       * next morning did come back, and a shorter window must not un-say that.
       */
      this.prisma.$queryRaw<{ new_accounts: bigint; silent: bigint }[]>`
        SELECT COUNT(*) AS new_accounts,
               COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM "bot_interaction" later
                 WHERE later."user_id" = i."user_id"
                   AND later."kind" NOT IN ('START', 'BLOCKED', 'UNBLOCKED')
               )) AS silent
        FROM "bot_interaction" i
        WHERE i."created_account" AND i."created_at" >= ${since} AND ${NOT_STAFF}
      `,
      this.prisma.$queryRaw<{ day: string; interactions: bigint; active_users: bigint }[]>`
        SELECT to_char(i."created_at" AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
               COUNT(*) AS interactions,
               COUNT(DISTINCT i."user_id") AS active_users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND ${IS_ACTIVITY} AND ${NOT_STAFF}
        GROUP BY 1
        ORDER BY 1
      `,
      // Every kind, blocks included: this is the one place they are shown.
      this.prisma.$queryRaw<{ kind: InteractionKind; interactions: bigint; users: bigint }[]>`
        SELECT i."kind"::text AS kind,
               COUNT(*) AS interactions,
               COUNT(DISTINCT i."user_id") AS users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND ${NOT_STAFF}
        GROUP BY 1
        ORDER BY 2 DESC, 1
      `,
      this.prisma.$queryRaw<{ outcome: InteractionOutcome; interactions: bigint }[]>`
        SELECT i."outcome"::text AS outcome, COUNT(*) AS interactions
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND ${IS_ACTIVITY} AND ${NOT_STAFF}
        GROUP BY 1
        ORDER BY 2 DESC, 1
      `,
      this.prisma.$queryRaw<{ hour: number; interactions: bigint }[]>`
        SELECT EXTRACT(HOUR FROM i."created_at" AT TIME ZONE ${timezone})::int AS hour,
               COUNT(*) AS interactions
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND ${IS_ACTIVITY} AND ${NOT_STAFF}
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.botInteraction.aggregate({ _min: { createdAt: true } }),
    ]);

    const sessions = Number(totals[0]?.sessions ?? 0);
    const attributed = Number(totals[0]?.attributed ?? 0);

    return {
      windowDays,
      since,
      trackingSince: tracking._min.createdAt,
      totals: {
        interactions: Number(totals[0]?.interactions ?? 0),
        activeUsers: Number(totals[0]?.active_users ?? 0),
        sessions,
        stepsPerSession: sessions === 0 ? 0 : Math.round((attributed / sessions) * 10) / 10,
        newAccounts: Number(accounts[0]?.new_accounts ?? 0),
        newAccountsSilent: Number(accounts[0]?.silent ?? 0),
      },
      byDay: byDay.map((row) => ({
        day: row.day,
        interactions: Number(row.interactions),
        activeUsers: Number(row.active_users),
      })),
      byKind: byKind.map((row) => ({
        kind: row.kind,
        interactions: Number(row.interactions),
        users: Number(row.users),
      })),
      byOutcome: byOutcome.map((row) => ({
        outcome: row.outcome,
        interactions: Number(row.interactions),
      })),
      byHour: byHour.map((row) => ({ hour: row.hour, interactions: Number(row.interactions) })),
    };
  }

  /**
   * Every link, and every time it was followed.
   *
   * `taps` is every `/start` the link produced; `user_acquisition` holds only
   * the one that created an account. `returningUsers` are the people who
   * followed it with an account they already had — the members reading a
   * channel post, whom acquisition cannot see at all.
   *
   * The two joins give a title to the links that name an event or a suggestion.
   * They are on `public_id`, which is what the link carried, and a link whose
   * target has since gone simply has no title.
   */
  async links(session: AdminSession, windowDays: number): Promise<InteractionLinks> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const grouped = await this.prisma.$queryRaw<
      {
        action: string;
        ref: string | null;
        title: string | null;
        taps: bigint;
        users: bigint;
        new_accounts: bigint;
        returning_users: bigint;
      }[]
    >`
      SELECT i."action" AS action,
             i."ref" AS ref,
             COALESCE(e."title", s."title") AS title,
             COUNT(*) AS taps,
             COUNT(DISTINCT i."user_id") AS users,
             COUNT(*) FILTER (WHERE i."created_account") AS new_accounts,
             COUNT(DISTINCT i."user_id") FILTER (WHERE NOT i."created_account") AS returning_users
      FROM "bot_interaction" i
      LEFT JOIN "event" e
        ON i."action" IN ('start:event', 'start:join') AND e."public_id" = i."ref"
      LEFT JOIN "event_suggestion" s
        ON i."action" = 'start:host' AND s."public_id" = i."ref"
      WHERE i."kind" = 'START' AND i."created_at" >= ${since} AND ${NOT_STAFF}
      GROUP BY 1, 2, 3
      ORDER BY 4 DESC, 1, 2
    `;

    return {
      windowDays,
      since,
      rows: grouped.slice(0, MAX_ROWS).map((row) => ({
        action: row.action,
        ref: row.ref,
        title: row.title,
        taps: Number(row.taps),
        users: Number(row.users),
        newAccounts: Number(row.new_accounts),
        returningUsers: Number(row.returning_users),
      })),
      omittedRows: Math.max(0, grouped.length - MAX_ROWS),
    };
  }

  /**
   * What was pressed, most pressed first, with how each one was answered.
   *
   * `topRefusal` is the commonest error code among an action's refusals — the
   * one sentence a person pressing it is most likely to have been shown. It is
   * what turns "this button is refused a third of the time" into something an
   * operator can act on.
   */
  async actions(session: AdminSession, windowDays: number): Promise<InteractionActions> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const grouped = await this.prisma.$queryRaw<
      {
        kind: InteractionKind;
        action: string;
        count: bigint;
        users: bigint;
        refused: bigint;
        gated: bigint;
        stale: bigint;
        failed: bigint;
        top_refusal: string | null;
        average_ms: number | null;
      }[]
    >`
      SELECT i."kind"::text AS kind,
             i."action" AS action,
             COUNT(*) AS count,
             COUNT(DISTINCT i."user_id") AS users,
             COUNT(*) FILTER (WHERE i."outcome" = 'REFUSED') AS refused,
             COUNT(*) FILTER (WHERE i."outcome" = 'GATED') AS gated,
             COUNT(*) FILTER (WHERE i."outcome" = 'STALE') AS stale,
             COUNT(*) FILTER (WHERE i."outcome" = 'FAILED') AS failed,
             MODE() WITHIN GROUP (ORDER BY i."detail")
               FILTER (WHERE i."outcome" = 'REFUSED') AS top_refusal,
             ROUND(AVG(i."duration_ms"))::int AS average_ms
      FROM "bot_interaction" i
      WHERE i."created_at" >= ${since} AND ${IS_ACTIVITY} AND ${NOT_STAFF}
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2
    `;

    return {
      windowDays,
      since,
      rows: grouped.slice(0, MAX_ROWS).map((row) => ({
        kind: row.kind,
        action: row.action,
        count: Number(row.count),
        users: Number(row.users),
        refused: Number(row.refused),
        gated: Number(row.gated),
        stale: Number(row.stale),
        failed: Number(row.failed),
        topRefusal: row.top_refusal,
        averageMs: row.average_ms ?? 0,
      })),
      omittedRows: Math.max(0, grouped.length - MAX_ROWS),
    };
  }

  /**
   * One person's trail, newest first.
   *
   * Not windowed: everything the retention purge has left is shown, because
   * the question here is "what happened to this person", and the answer is
   * often older than a month. Staff are not filtered either — the exclusion is
   * a rule about totals, and a moderator's own trail is theirs to read.
   *
   * Paged by time. Two rows of one person in the same millisecond would let a
   * page boundary skip one, and Telegram delivers a chat's updates in sequence,
   * so that is not a case this spends a second cursor column on.
   */
  async timeline(
    session: AdminSession,
    userPublicId: string,
    before?: Date,
  ): Promise<InteractionTimeline> {
    this.access.assertPermission(session, PERMISSIONS.USER_READ);

    const user = await this.prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    const rows = await this.prisma.botInteraction.findMany({
      where: { userId: user.id, ...(before !== undefined ? { createdAt: { lt: before } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_PAGE_SIZE + 1,
      // An allowlist: `user_id`, `update_id` and `message_id` describe the
      // delivery, not what the person did, and have no business in a response.
      select: {
        id: true,
        createdAt: true,
        kind: true,
        action: true,
        ref: true,
        outcome: true,
        detail: true,
        screen: true,
        wizardKind: true,
        wizardStep: true,
        durationMs: true,
      },
    });

    const page = rows.slice(0, TIMELINE_PAGE_SIZE);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        at: row.createdAt,
        kind: row.kind,
        action: row.action,
        ref: row.ref,
        outcome: row.outcome,
        detail: row.detail,
        screen: row.screen,
        wizardKind: row.wizardKind,
        wizardStep: row.wizardStep,
        durationMs: row.durationMs,
      })),
      nextBefore: rows.length > TIMELINE_PAGE_SIZE && last !== undefined ? last.createdAt : null,
    };
  }

  private since(windowDays: number): Date {
    return new Date(this.clock.now().getTime() - windowDays * 86_400_000);
  }
}
