import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SettingsService } from '../catalog/settings.service';
import { permissionsFor } from './admin-access.service';
import { BOT_PERMISSIONS } from './admin-telegram.service';
import { shouldSendDigest, tehranHourOf } from './moderation-digest';
import { PERMISSIONS, type RoleKey } from './permissions';

/** What a moderator is told: counts, never content (plan 06). */
export interface DigestSummary {
  /** Every case the panel counts as open — the same number the dashboard shows. */
  openCount: number;
  /** Open and held by nobody: the ones waiting for somebody to pick them up. */
  unclaimedCount: number;
  oldestUnclaimedAt: Date | null;
  /** The unclaimed ones by what they are about. */
  bySubject: Record<string, number>;
}

export interface DigestDue {
  adminUserId: string;
  /**
   * Where to send it. Read from `admin_telegram_link` by the worker at delivery
   * and never put in a job payload, so Redis holds no Telegram id (invariant 7).
   */
  telegramUserId: bigint;
  summary: DigestSummary;
}

const OPEN_STATUSES = ['OPEN', 'IN_REVIEW', 'ESCALATED'] as const;

/**
 * Telling moderators the queue has work (plan 06, ADR-0018's "obvious next
 * feature").
 *
 * ── Who is told ─────────────────────────────────────────────────────────────
 *
 * An ACTIVE admin with a Telegram link **whose bot session would hold
 * `event.moderate`** — the intersection `AdminTelegramService.sessionFor`
 * computes, not merely "linked". `isLinked` is deliberately cheaper and does not
 * load roles, so it is the wrong question here: a linked analyst would be told
 * about a queue they cannot open.
 *
 * ── Why this is not a notification ──────────────────────────────────────────
 *
 * The notification pipeline is built around `user`: a recipient is a
 * `userPublicId` and the chat is resolved by `telegramTargetFor`. A moderator is
 * **not** a user — `admin_user` has no foreign key to `user`, and that
 * separation is a control rather than a gap. So the worker sends this directly
 * from its own job, reading the address here at the moment of delivery, and no
 * `notification` row, dedupe key or retention entry exists for it. The quiet
 * period is `admin_telegram_link.last_digest_at` (migration 0051).
 */
@Injectable()
export class ModerationDigestService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  /** Every moderator who should be sent the digest now, with what to tell them. */
  async due(): Promise<DigestDue[]> {
    const now = this.clock.now();

    const [openCount, unclaimed, delayMinutes, quietMinutes] = await Promise.all([
      this.prisma.moderationCase.count({ where: { status: { in: [...OPEN_STATUSES] } } }),
      this.prisma.moderationCase.findMany({
        where: { status: 'OPEN', assignedAdminId: null },
        orderBy: { createdAt: 'asc' },
        select: { subjectType: true, createdAt: true },
      }),
      this.settings.getInt('moderation.digest_delay_minutes'),
      this.settings.getInt('moderation.digest_quiet_minutes'),
    ]);
    if (unclaimed.length === 0) return [];

    const bySubject: Record<string, number> = {};
    for (const row of unclaimed) {
      bySubject[row.subjectType] = (bySubject[row.subjectType] ?? 0) + 1;
    }
    const summary: DigestSummary = {
      openCount,
      unclaimedCount: unclaimed.length,
      oldestUnclaimedAt: unclaimed[0]?.createdAt ?? null,
      bySubject,
    };

    const links = await this.prisma.adminTelegramLink.findMany({
      where: { adminUser: { status: 'ACTIVE' } },
      select: {
        telegramUserId: true,
        lastDigestAt: true,
        adminUser: { select: { id: true, roles: { select: { role: { select: { key: true } } } } } },
      },
    });

    const tehranHour = tehranHourOf(now);
    return links
      .filter((link) => {
        const roles = link.adminUser.roles.map((row) => row.role.key as RoleKey);
        return permissionsFor(roles)
          .filter((permission) => BOT_PERMISSIONS.includes(permission))
          .includes(PERMISSIONS.EVENT_MODERATE);
      })
      .filter((link) =>
        shouldSendDigest({
          unclaimedCount: summary.unclaimedCount,
          oldestUnclaimedAt: summary.oldestUnclaimedAt,
          lastDigestAt: link.lastDigestAt,
          now,
          tehranHour,
          delayMinutes,
          quietMinutes,
        }),
      )
      .map((link) => ({
        adminUserId: link.adminUser.id,
        telegramUserId: link.telegramUserId,
        summary,
      }));
  }

  /**
   * The digest went, or never can (the bot is blocked): start the quiet period.
   *
   * Written for a blocked bot too, so a moderator who blocked it is not retried
   * every quarter hour — the next attempt waits the same quiet period.
   */
  async markSent(adminUserId: string): Promise<void> {
    await this.prisma.adminTelegramLink.updateMany({
      where: { adminUserId },
      data: { lastDigestAt: this.clock.now() },
    });
  }
}
