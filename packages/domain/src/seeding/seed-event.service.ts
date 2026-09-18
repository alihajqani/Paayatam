import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { EventService } from '../events/event.service';
import { ParticipationService } from '../participation/participation.service';
import { pickSeedContent } from './seed-content';
import { SeedIdentityService } from './seed-identity.service';

// A 2-hour activity, consistent with the content bank's tone.
const EVENT_DURATION_MS = 2 * 60 * 60 * 1000;
// Starts 3 hours after creation — enough time to actually fill.
const STARTS_IN_MS = 3 * 60 * 60 * 1000;

/**
 * Creates and fills marketing seed events (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
 *
 * `createSeedEvent` goes through the real `EventService.create` as the
 * configured host — same quota (5/day, 3 concurrent per host), same coin
 * charge for creation and, since this content always scans CLEAN and
 * resolves PUBLISHED, the same automatic channel-post charge. There is no
 * second, cheaper path: the whole point is that a seed event behaves exactly
 * like a real one from here on.
 */
@Injectable()
export class SeedEventService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventService,
    private readonly participation: ParticipationService,
    private readonly identities: SeedIdentityService,
  ) {}

  async createSeedEvent(cityId: string): Promise<{ eventPublicId: string }> {
    const config = await this.prisma.citySeedConfig.findUniqueOrThrow({ where: { cityId } });
    const [city, category] = await Promise.all([
      this.prisma.city.findUniqueOrThrow({ where: { id: cityId }, select: { nameFa: true } }),
      this.prisma.category.findFirstOrThrow({
        where: { isActive: true, allowsCustomLabel: false },
        select: { id: true, nameFa: true },
      }),
    ]);

    const content = pickSeedContent({
      categoryNameFa: category.nameFa,
      cityNameFa: city.nameFa,
      random: Math.random,
    });

    const now = this.clock.now();
    const created = await this.events.create(config.hostUserId, {
      title: content.title,
      description: content.description,
      categoryId: category.id,
      cityId,
      startsAt: new Date(now.getTime() + STARTS_IN_MS),
      endsAt: new Date(now.getTime() + STARTS_IN_MS + EVENT_DURATION_MS),
      capacity: config.eventCapacity,
      costType: 'FREE',
    });

    await this.prisma.event.update({
      where: { publicId: created.publicId },
      data: { isSeeded: true },
    });

    return { eventPublicId: created.publicId };
  }

  /** Adds one synthetic seat. A no-op, reporting `done: true`, once full. */
  async fillStep(eventPublicId: string): Promise<{ done: boolean }> {
    const event = await this.prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true, cityId: true, acceptedCount: true, capacity: true },
    });

    if (event.acceptedCount >= event.capacity) {
      return { done: true };
    }

    const { userId } = await this.identities.createSeedParticipant(event.cityId);
    await this.participation.seatSeedParticipant(eventPublicId, userId);

    return { done: event.acceptedCount + 1 >= event.capacity };
  }
}
