import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_BOT_USERNAME, type Env } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import type { AcquisitionFunnel, AcquisitionSource } from '@payetam/shared';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** One source, or one campaign tag, and how far its people got. */
export interface AcquisitionReportRow extends AcquisitionFunnel {
  /** Null is an account created before attribution was recorded. */
  source: AcquisitionSource | null;
  ref: string | null;
}

export interface AcquisitionReport {
  windowDays: number | null;
  since: Date | null;
  trackingSince: Date | null;
  totals: AcquisitionFunnel;
  rows: AcquisitionReportRow[];
  /** Rows past the cap, which the totals still include. */
  omittedRows: number;
  botUsername: string;
}

/**
 * Rows on one screen. The sources reported whole are five; the rest are campaign
 * tags and unrecognised payloads, and a list longer than this is a list nobody
 * reads — the totals still count every row that is left off.
 */
const MAX_ROWS = 100;

interface FunnelRow {
  source: AcquisitionSource | null;
  ref: string | null;
  users: bigint;
  terms_accepted: bigint;
  profile_complete: bigint;
  requested: bigint;
  attended: bigint;
  hosted: bigint;
  bot_blocked: bigint;
}

/**
 * Where users come from, and which of those places brings people who stay.
 *
 * ── Why the funnel and not just a count ─────────────────────────────────────
 *
 * The question an operator brings here is "which ad should I keep paying for",
 * and sign-ups alone answer it wrongly: an ad in an anonymous-chat bot can bring
 * a hundred taps that each block the bot inside a minute. So every row carries
 * the same people counted again at each step that matters — accepted the terms,
 * finished a profile (without which nobody can join anything), asked to join,
 * attended, hosted — and the one that means "this was not for me": blocked.
 *
 * ── Every account, attributed or not ────────────────────────────────────────
 *
 * The scan starts from `user` and LEFT JOINs the attribution, so the accounts
 * that predate it are a row of their own rather than missing from the totals. A
 * report whose total disagreed with the dashboard's user count would be a report
 * nobody trusted about anything else.
 *
 * ── `telegram_account`, and only `bot_blocked`, and only counted ────────────
 *
 * The table is kept apart so nothing reaches the Telegram id by accident
 * (ADR-0009). This reads one boolean from it, inside a `COUNT … FILTER`, and
 * nothing it selects is a column of that table.
 *
 * `dashboard.read`: every number is an aggregate, which is what ADR-0010 gives
 * `ANALYST`. Campaign tags and event ids name links, not people. Nothing here
 * writes.
 */
@Injectable()
export class AcquisitionReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    /** For `TELEGRAM_BOT_USERNAME` alone, which the link builder needs. */
    @Inject(ENV) private readonly env: Env,
  ) {}

  async report(session: AdminSession, windowDays?: number): Promise<AcquisitionReport> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since =
      windowDays === undefined
        ? null
        : new Date(this.clock.now().getTime() - windowDays * 86_400_000);

    const [grouped, tracking] = await Promise.all([
      /**
       * One pass over `user`, grouped by source and — only for the two sources
       * whose `ref` is worth a row of its own — by `ref`. A row per referral code
       * or per event would be a list of people and events, which is what the
       * referrals and events screens are for.
       *
       * Epoch rather than a conditional WHERE for "all time", so the statement is
       * one tagged template with nothing built at runtime (the CI grep for
       * `$queryRawUnsafe` exists because a built string reads like injection).
       */
      this.prisma.$queryRaw<FunnelRow[]>`
        SELECT a."source"::text AS source,
               CASE WHEN a."source" IN ('CAMPAIGN', 'OTHER') THEN a."ref" END AS ref,
               COUNT(*) AS users,
               COUNT(*) FILTER (
                 WHERE u."onboarding_state" IN ('TERMS_ACCEPTED', 'PROFILE_COMPLETE')
               ) AS terms_accepted,
               COUNT(*) FILTER (WHERE u."onboarding_state" = 'PROFILE_COMPLETE') AS profile_complete,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "event_participant" ep WHERE ep."user_id" = u."id"
               )) AS requested,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "event_participant" ep
                 WHERE ep."user_id" = u."id" AND ep."status" = 'COMPLETED'
               )) AS attended,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "event" e
                 WHERE e."host_user_id" = u."id" AND e."is_seeded" = false
               )) AS hosted,
               COUNT(*) FILTER (WHERE t."bot_blocked") AS bot_blocked
        FROM "user" u
        LEFT JOIN "user_acquisition" a ON a."user_id" = u."id"
        LEFT JOIN "telegram_account" t ON t."user_id" = u."id"
        WHERE u."is_seed" = false
          AND u."created_at" >= ${since ?? new Date(0)}
        GROUP BY 1, 2
      `,
      this.prisma.userAcquisition.aggregate({ _min: { createdAt: true } }),
    ]);

    const rows = grouped
      .map((row) => ({
        source: row.source,
        ref: row.ref,
        users: Number(row.users),
        termsAccepted: Number(row.terms_accepted),
        profileComplete: Number(row.profile_complete),
        requested: Number(row.requested),
        attended: Number(row.attended),
        hosted: Number(row.hosted),
        botBlocked: Number(row.bot_blocked),
      }))
      // Largest first, then the one that kept the most people: two ads that
      // brought the same number are not equal if one of them kept nobody. The
      // rest is only so a reload does not reshuffle a tie.
      .sort(
        (a, b) =>
          b.users - a.users ||
          b.profileComplete - a.profileComplete ||
          (a.source ?? '').localeCompare(b.source ?? '') ||
          (a.ref ?? '').localeCompare(b.ref ?? ''),
      );

    return {
      windowDays: windowDays ?? null,
      since,
      trackingSince: tracking._min.createdAt,
      totals: sumFunnels(rows),
      rows: rows.slice(0, MAX_ROWS),
      omittedRows: Math.max(0, rows.length - MAX_ROWS),
      botUsername: this.env.TELEGRAM_BOT_USERNAME ?? DEFAULT_BOT_USERNAME,
    };
  }
}

function sumFunnels(rows: AcquisitionFunnel[]): AcquisitionFunnel {
  const total: AcquisitionFunnel = {
    users: 0,
    termsAccepted: 0,
    profileComplete: 0,
    requested: 0,
    attended: 0,
    hosted: 0,
    botBlocked: 0,
  };
  for (const row of rows) {
    total.users += row.users;
    total.termsAccepted += row.termsAccepted;
    total.profileComplete += row.profileComplete;
    total.requested += row.requested;
    total.attended += row.attended;
    total.hosted += row.hosted;
    total.botBlocked += row.botBlocked;
  }
  return total;
}
