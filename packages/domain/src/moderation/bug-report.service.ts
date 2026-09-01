import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { BugReportStatus, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';

/**
 * What a user says is broken about the product (v0.6.5).
 *
 * ── Why this is not `ReportService` ─────────────────────────────────────────
 *
 * `ReportService.file` is moderation. It takes a subject — an event, a chat, a
 * person — counts distinct reporters against `moderation.report_threshold`,
 * hides the subject when enough of them agree, and opens a `ModerationCase` for
 * a human. Every one of those is wrong for a bug: there is no subject to hide,
 * three people hitting the same broken button should not trigger an auto-hide of
 * anything, and invariant 5's `UNIQUE (target, reporter)` would let somebody
 * report exactly one bug, ever.
 *
 * So: a separate table, a separate lifecycle, and no threshold machinery at all.
 * A bug report is read by a person and closed by a person.
 *
 * ── Screenshots are handles, not files ──────────────────────────────────────
 *
 * `screenshotFileIds` holds Telegram `file_id` strings. The image lives on
 * Telegram's servers and the bot can fetch it whenever a moderator asks for it.
 * Copying it into this deployment's storage would mean owning a retention
 * policy, a deletion path and a malware-scanning question for a file the
 * reporter has already published to the bot — for no benefit to anybody looking
 * at it. A `file_id` is scoped to one bot token: it is not a public URL and is
 * inert in anybody else's hands.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * A rate limit. `BUG_REPORT_FILE` is spent by the **bot**, at the point the form
 * opens, exactly as `GIFT_CODE_REDEEM` is — this service is also reachable from a
 * script, and the limiter belongs to the surface a person is typing into rather
 * than to the method a job might call in a loop.
 */

/** One report, as staff read it. */
export interface BugReportSummary {
  publicId: string;
  /** The reporter, by public id only (ADR-0009). */
  userPublicId: string;
  description: string;
  screenshotFileIds: string[];
  appVersion: string | null;
  status: BugReportStatus;
  adminNote: string | null;
  createdAt: Date;
  handledAt: Date | null;
}

const SUMMARY_SELECT = {
  publicId: true,
  description: true,
  screenshotFileIds: true,
  appVersion: true,
  status: true,
  adminNote: true,
  createdAt: true,
  handledAt: true,
  user: { select: { publicId: true } },
} as const;

type BugReportRow = Prisma.BugReportGetPayload<{ select: typeof SUMMARY_SELECT }>;

@Injectable()
export class BugReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * File one.
   *
   * The bounds are restated here and not only in the wizard, because this method
   * is reachable from a script that never passed through a step — the same
   * argument `GiftCodeAdminService.create` makes about its own validation. The
   * CHECK constraints behind them are the third line, not the first.
   */
  async file(
    userId: string,
    input: {
      description: string;
      screenshotFileIds?: readonly string[];
      /** The release the reporter was on. Recorded rather than asked for. */
      appVersion?: string | null;
    },
  ): Promise<BugReportSummary> {
    const description = input.description.trim();
    if (description.length < 10 || description.length > 2000) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'description' });
    }

    const screenshots = [...new Set(input.screenshotFileIds ?? [])];
    if (screenshots.length > 10) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'screenshotFileIds' });
    }

    const created = await this.prisma.bugReport.create({
      data: {
        userId,
        description,
        screenshotFileIds: screenshots,
        appVersion: input.appVersion ?? null,
        createdAt: this.clock.now(),
      },
      select: SUMMARY_SELECT,
    });

    /**
     * Audited as a USER action, and **without the text**.
     *
     * `audit_log` is a staff read surface and an export target; a bug report's
     * body is free text a user typed and belongs in the row a moderator opens
     * deliberately, not in a trail that gets copied around. What is recorded is
     * that a report exists, by whom, and how many screenshots came with it —
     * which is what makes "did this land?" answerable without reading anybody's
     * words.
     */
    await this.audit.record({
      actorType: 'USER',
      actorId: userId,
      action: 'bugreport.filed',
      targetType: 'bug_report',
      targetId: created.publicId,
      after: { screenshots: screenshots.length, appVersion: created.appVersion },
    });

    return toSummary(created);
  }

  /** The queue. Open first and oldest first — a queue nobody works from the bottom. */
  async list(filters: { status?: BugReportStatus; limit?: number } = {}): Promise<{
    reports: BugReportSummary[];
    total: number;
  }> {
    const where = filters.status === undefined ? {} : { status: filters.status };
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const [rows, total] = await Promise.all([
      this.prisma.bugReport.findMany({
        where,
        select: SUMMARY_SELECT,
        // Open before settled, then oldest first inside each. `status` ascends
        // through the enum in declaration order, which puts OPEN first — the
        // ordering the queue wants, from the ordering the schema already states.
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        take,
      }),
      this.prisma.bugReport.count({ where }),
    ]);

    return { reports: rows.map(toSummary), total };
  }

  /**
   * Move one along, with a note.
   *
   * `handledAt` and `handledByAdminId` are set together with any non-OPEN status
   * and cleared by a return to OPEN, because the table's CHECK says the three
   * move together — a report marked resolved by nobody at no time is not a
   * record of anything.
   */
  async setStatus(
    publicId: string,
    adminUserId: string,
    status: BugReportStatus,
    note?: string,
  ): Promise<BugReportSummary> {
    const existing = await this.prisma.bugReport.findUnique({
      where: { publicId },
      select: { id: true, status: true },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

    const now = this.clock.now();
    const settled = status !== 'OPEN';

    // Key by key rather than a spread: under `exactOptionalPropertyTypes` an
    // explicit `undefined` is a *present* key, and Prisma reads a present
    // `adminNote: undefined` as an instruction it cannot satisfy. Absent means
    // "leave the note as it is", which is what an admin who only changed the
    // status meant.
    const trimmed = note?.trim();
    const updated = await this.prisma.bugReport.update({
      where: { id: existing.id },
      data: {
        status,
        ...(trimmed !== undefined ? { adminNote: trimmed === '' ? null : trimmed } : {}),
        handledByAdminId: settled ? adminUserId : null,
        handledAt: settled ? now : null,
      },
      select: SUMMARY_SELECT,
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'bugreport.status_changed',
      targetType: 'bug_report',
      targetId: publicId,
      before: { status: existing.status },
      after: { status, note: note?.trim() ?? null },
    });

    return toSummary(updated);
  }
}

function toSummary(row: BugReportRow): BugReportSummary {
  return {
    publicId: row.publicId,
    userPublicId: row.user.publicId,
    description: row.description,
    screenshotFileIds: row.screenshotFileIds,
    appVersion: row.appVersion,
    status: row.status,
    adminNote: row.adminNote,
    createdAt: row.createdAt,
    handledAt: row.handledAt,
  };
}
