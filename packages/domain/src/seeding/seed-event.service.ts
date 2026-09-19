import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { EventService } from '../events/event.service';
import { ParticipationService } from '../participation/participation.service';
import { pickSeedContent } from './seed-content';
import { upcomingEventsWhere } from './seed-floor';
import { SeedIdentityService } from './seed-identity.service';
import { pickSeedCategory, pickSeedSlot } from './seed-variety';

/**
 * Creates and fills marketing seed events (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md and
 * 2026-09-19-seed-event-floor-and-purge-design.md).
 *
 * `createSeedEvent` goes through the real `EventService.create` as the
 * configured host — the same coin charge for creation and, since this content
 * always scans CLEAN and resolves PUBLISHED, the same automatic channel-post
 * charge. There is no second, cheaper path: the whole point is that a seed event
 * behaves exactly like a real one from here on. The one thing it is exempt from
 * is the per-host quota, so a city's floor is not capped by what one account may
 * hold.
 *
 * What differs from event to event — category, topic, day, hour, duration — is
 * decided against the city's *current* upcoming events, so each new one looks
 * unlike its neighbours (`seed-variety.ts`, `seed-content.ts`).
 */
@Injectable()
export class SeedEventService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly events: EventService,
    private readonly participation: ParticipationService,
    private readonly identities: SeedIdentityService,
  ) {}

  async createSeedEvent(cityId: string): Promise<{ eventPublicId: string }> {
    const now = this.clock.now();
    const config = await this.prisma.citySeedConfig.findUniqueOrThrow({ where: { cityId } });

    const [city, upcoming, categories] = await Promise.all([
      this.prisma.city.findUniqueOrThrow({ where: { id: cityId }, select: { nameFa: true } }),
      this.prisma.event.findMany({
        where: upcomingEventsWhere(now, cityId),
        select: { title: true, startsAt: true, categoryId: true },
      }),
      // Eligible means what `EventService.resolveCategory` will accept: active,
      // not the catch-all («سایر» has no topic worth inventing), and offered in
      // this city — a category with no `city_category` rows is offered
      // everywhere (migration 0020).
      this.prisma.category.findMany({
        where: {
          isActive: true,
          allowsCustomLabel: false,
          slug: { not: 'other' },
          OR: [{ cities: { none: {} } }, { cities: { some: { cityId } } }],
        },
        select: { id: true, slug: true, nameFa: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    if (categories.length === 0) {
      throw new Error(`No seedable category is offered in city ${cityId}`);
    }

    const usedCounts = new Map<string, number>();
    for (const event of upcoming) {
      usedCounts.set(event.categoryId, (usedCounts.get(event.categoryId) ?? 0) + 1);
    }

    const category = pickSeedCategory({
      candidates: categories,
      usedCounts,
      random: Math.random,
    });
    const content = pickSeedContent({
      categorySlug: category.slug,
      categoryNameFa: category.nameFa,
      cityNameFa: city.nameFa,
      takenTitles: new Set(upcoming.map((event) => event.title)),
      random: Math.random,
    });
    const slot = pickSeedSlot({
      now,
      timeZone: this.env.APP_TIMEZONE,
      takenStarts: upcoming.map((event) => event.startsAt),
      parts: content.parts,
      random: Math.random,
    });

    const created = await this.events.create(
      config.hostUserId,
      {
        title: content.title,
        description: content.description,
        categoryId: category.id,
        cityId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        capacity: config.eventCapacity,
        costType: 'FREE',
      },
      // Marks the row `isSeeded` in the same transaction that creates it. It used
      // to be a second UPDATE afterwards, and a crash between the two would have
      // left a fake event nothing knew to fill or clean up.
      { seeded: true },
    );

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
    try {
      await this.participation.seatSeedParticipant(eventPublicId, userId);
    } catch (error) {
      // The seat was refused after the identity was made — the event filled
      // under us, or was cancelled. An identity with no seat would sit in the
      // user table forever and count as a person, so it goes now.
      await this.identities.discard(userId);
      throw error;
    }

    return { done: event.acceptedCount + 1 >= event.capacity };
  }
}
