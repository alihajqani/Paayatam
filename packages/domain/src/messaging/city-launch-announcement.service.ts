import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { cityLaunchAnnouncement } from '@payetam/telegram';
import { AuditService } from '../audit/audit.service';
import { MessagingService } from './messaging.service';

export interface CityLaunchAnnounced {
  cityNameFa: string;
  recipients: number;
}

/**
 * «پایه‌تَم در … باز شد» — the message a closed city's queue has promised since
 * v0.10.0, sent once when an operator first opens it (plan 17).
 *
 * ── Why the worker and not the panel request ────────────────────────────────
 *
 * The same reasons `ReleaseAnnouncementService` gives. The worker drains the
 * campaign, so it creates it; and a campaign materialises its recipients, which
 * is work an admin request should not wait on. The panel only stamps
 * `city.launched_at`; this finds the cities stamped and not yet announced.
 *
 * ── How "once" is guaranteed ────────────────────────────────────────────────
 *
 * Twice over. `launched_at` is written by the first opening only, so reopening a
 * closed city queues nothing. And the campaign's `idempotency_key` is
 * `city-launch:<city id>`, so a pass that crashed between creating the campaign
 * and writing `launch_announced_at` finds the same campaign the next time and
 * finishes the claim instead of sending a second one.
 *
 * ── Why it is confirmed without a second human ──────────────────────────────
 *
 * `MessagingService` makes an operator preview a campaign and confirm it, because
 * a composed broadcast can have the wrong audience. This one's audience is fixed
 * — the profiles that name the city — and its text is not typed per send. The
 * human decision is the opening itself, and the panel shows the recipient count
 * in the confirmation before the operator makes it.
 */
@Injectable()
export class CityLaunchAnnouncementService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
  ) {}

  async announceLaunchedCities(): Promise<CityLaunchAnnounced[]> {
    const due = await this.prisma.city.findMany({
      where: {
        // Closed again before this ran: «باز شد» would be false. It stays due
        // and is announced if the city reopens.
        isLaunched: true,
        launchedAt: { not: null },
        launchAnnouncedAt: null,
      },
      select: { id: true, nameFa: true },
      orderBy: { launchedAt: 'asc' },
      take: 20,
    });

    const announced: CityLaunchAnnounced[] = [];
    for (const city of due) {
      announced.push(await this.announce(city));
    }
    return announced;
  }

  private async announce(city: { id: string; nameFa: string }): Promise<CityLaunchAnnounced> {
    const idempotencyKey = cityLaunchKey(city.id);

    /**
     * Looked up before creating, as the release announcement does: `createCampaign`
     * returns the existing row on a key collision, but only after materialising
     * the recipients a second time.
     */
    const existing = await this.prisma.messageCampaign.findUnique({
      where: { idempotencyKey },
      select: { publicId: true, status: true, estimatedRecipients: true },
    });

    let recipients: number;
    if (existing === null) {
      const campaign = await this.messaging.createCampaign({
        kind: 'BROADCAST',
        bodyText: cityLaunchAnnouncement(city.nameFa),
        parseMode: 'HTML',
        // Everybody who named the city and finished a profile — the queue the
        // closed-city screen counted them into.
        audience: { cityIds: [city.id], profileComplete: true },
        idempotencyKey,
        actor: { type: 'SYSTEM' },
      });
      await this.messaging.confirm(campaign.publicId, null);
      recipients = campaign.estimatedRecipients;
    } else {
      if (existing.status === 'DRAFT') await this.messaging.confirm(existing.publicId, null);
      recipients = existing.estimatedRecipients;
    }

    const now = this.clock.now();
    const claimed = await this.prisma.city.updateMany({
      where: { id: city.id, launchAnnouncedAt: null },
      data: { launchAnnouncedAt: now },
    });

    if (claimed.count === 1) {
      await this.audit.record({
        actorType: 'SYSTEM',
        action: 'city.launch_announced',
        targetType: 'city',
        targetId: city.id,
        // The count, never the recipients. Who opened the city is on the
        // `catalog.city.updated` row this follows.
        after: { recipients },
      });
    }

    return { cityNameFa: city.nameFa, recipients };
  }
}

/** `city-launch:<city id>` — the UNIQUE that makes "once per city" true. */
export function cityLaunchKey(cityId: string): string {
  return `city-launch:${cityId}`;
}
