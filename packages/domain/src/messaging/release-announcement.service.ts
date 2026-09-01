import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import { ENV } from '@payetam/platform';
import { resolveVersion } from '@payetam/shared';
import { SettingsService } from '../catalog/settings.service';
import { MessagingService } from './messaging.service';

/**
 * "The bot has been updated — press /start again."
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A deploy replaces the process, and the user on the other side has no way to
 * know. What they have is a persistent reply keyboard whose labels may have
 * moved, a wizard whose step keys may have changed, and inline buttons in
 * messages from before the deploy whose `callback_data` this build may no longer
 * parse — all of which produce «این دکمه دیگر کار نمی‌کند» from a bot that looks
 * broken rather than updated. Telling everybody once, and telling them the one
 * action that fixes all of it, turns a confusing half-hour into a sentence.
 *
 * ── How "once" is guaranteed ────────────────────────────────────────────────
 *
 * By `message_campaign.idempotency_key`, and by nothing else. The key is
 * `release-announce:<version>`, the column is UNIQUE, and that single constraint
 * covers every case that matters: a worker that restarts three times in a
 * deploy, two replicas booting together, a crash between creating the campaign
 * and confirming it, and a rollback-then-roll-forward to a version already
 * announced. No new table, no "last announced" row to get out of step with what
 * was actually sent.
 *
 * That last case is worth stating plainly: **rolling back and forward again
 * announces nothing**, because the version is the same string it was. That is
 * the correct behaviour — the users were already told about this release.
 *
 * ── Why the worker and not the API ──────────────────────────────────────────
 *
 * The worker is what sends. Putting it here means the campaign is created by the
 * process that will drain it, so there is no window in which a queued broadcast
 * exists with nothing running to deliver it. It also keeps a boot-time write out
 * of the API, which has to become healthy quickly.
 */
@Injectable()
export class ReleaseAnnouncementService {
  private readonly logger = new Logger(ReleaseAnnouncementService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Announce this release, if it has not been announced.
   *
   * Returns what happened rather than nothing, so the caller can log one line
   * and a test can assert on it without reading the database.
   *
   * **Every failure is swallowed by the caller, not here.** This throws what it
   * throws; `ProcessorsService` decides that a failed announcement must not stop
   * the worker from booting, because a bot that does not start is a much worse
   * outcome than a release nobody was told about.
   */
  async announceCurrentRelease(): Promise<
    { sent: true; version: string; recipients: number } | { sent: false; reason: string }
  > {
    if ((await this.settings.getInt('release.announce_enabled')) === 0) {
      return { sent: false, reason: 'disabled' };
    }

    const version = resolveVersion(this.env.PAYETAM_VERSION);
    const idempotencyKey = releaseAnnouncementKey(version);

    /**
     * Asked before creating, rather than relying on the create returning the
     * existing row.
     *
     * `createCampaign` does return it on a key collision — that is what an
     * idempotency key is for — but it *materialises the recipient set first*,
     * which on a re-boot would be a full scan of the user table to produce rows
     * `skipDuplicates` then throws away. One indexed lookup instead.
     */
    const existing = await this.prisma.messageCampaign.findUnique({
      where: { idempotencyKey },
      select: { publicId: true },
    });
    if (existing !== null) return { sent: false, reason: 'already announced' };

    const campaign = await this.messaging.createCampaign({
      kind: 'BROADCAST',
      bodyText: announcementText(version),
      parseMode: 'HTML',
      // Suspended accounts included, deliberately: `whereFor`'s default is
      // ACTIVE + SUSPENDED, a suspended user can still read, and the buttons
      // under their fingers changed too.
      audience: { everyone: true },
      idempotencyKey,
      actor: { type: 'SYSTEM' },
    });

    /**
     * Confirmed immediately, which is the one place this differs from every
     * other broadcast in the product.
     *
     * `MessagingService` makes an operator preview a campaign and type the
     * recipient count back before anything sends, and that gate exists because a
     * broadcast is composed by a person who may have got the audience wrong.
     * Neither half applies here: the audience is "everyone" by construction and
     * the text is not authored per send, so there is nothing for a human to
     * check that the code has not already fixed. The control that replaces it is
     * `release.announce_enabled`, which is a switch an operator can throw before
     * the deploy rather than a dialog they have to be awake for during it.
     *
     * `confirmedByAdminId` is null, because no admin confirmed it.
     */
    await this.messaging.confirm(campaign.publicId, null);

    this.logger.log(
      `Announced release ${version} to ${String(campaign.estimatedRecipients)} recipients`,
    );
    return { sent: true, version, recipients: campaign.estimatedRecipients };
  }
}

/** `release-announce:v0.6.5`. The UNIQUE that makes "once per release" true. */
export function releaseAnnouncementKey(version: string): string {
  return `release-announce:${version}`;
}

/**
 * What everybody reads after a deploy.
 *
 * Short, and its entire job is the last line. It does not list what changed:
 * a changelog in a broadcast is a message people stop opening, and the thing
 * being asked for — press /start — is the same whatever shipped.
 *
 * `/start` rather than a button, on purpose. A button is `callback_data`, and
 * `callback_data` from a build somebody's client has cached is exactly the class
 * of thing this message exists to get people out of. A slash command is text and
 * cannot go stale.
 */
export function announcementText(version: string): string {
  return (
    `<b>پایه‌تَم به‌روزرسانی شد</b> 🎉\n\n` +
    `نسخهٔ تازه (<code>${version}</code>) منتشر شد.\n\n` +
    `لطفاً یک بار <b>/start</b> را بزنید تا ربات از نو باز شود. ` +
    `دکمه‌های پیام‌های قدیمی ممکن است دیگر کار نکنند.`
  );
}
