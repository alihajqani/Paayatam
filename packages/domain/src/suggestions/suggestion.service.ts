import { Inject, Injectable } from '@nestjs/common';
import type { CostType } from '@payetam/shared';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { isoDay } from '@payetam/telegram';
import { ACTIVE_EVENT_STATUSES } from '../events/state-machine';

/** A suggestion as the bot's card shows it. Public id only (invariant 7). */
export interface SuggestionCard {
  publicId: string;
  title: string;
  description: string;
  venueLabel: string;
  startsAt: Date;
  durationHours: number;
  costType: CostType;
  costAmount: number | null;
  externalLink: string | null;
  cityNameFa: string;
  categoryNameFa: string;
}

/**
 * What a tap on `?start=host_<publicId>` should open.
 *
 * - `gone` — closed, started, or never existed.
 * - `own` — the reader already hosts an event from it; show them that.
 * - `join` — somebody else hosts a live event from it with a free seat; send the
 *   reader there, with the option to make their own.
 * - `host` — offer «میزبانش می‌شوم».
 */
export type SuggestionLink =
  | { kind: 'gone' }
  | { kind: 'own'; eventPublicId: string }
  | { kind: 'join'; eventPublicId: string; suggestion: SuggestionCard }
  | { kind: 'host'; suggestion: SuggestionCard };

/**
 * The bot's side of event suggestions (migration 0064).
 *
 * ── «اولی میزبان، بقیه همراه» ───────────────────────────────────────────────
 *
 * A screening tapped by two readers should become one event with two people,
 * not two events with one each: in a city with fifty users, splitting them is
 * what keeps every event empty. So a tap first looks for a live event already
 * made from the suggestion and sends the reader there. Only when there is none
 * with a free seat is hosting offered — and even beside the existing event the
 * bot offers «خودم یکی جدا می‌سازم», because "go with a stranger" is a choice,
 * not a rule.
 *
 * Decided here rather than in the bot because it is a rule about the product,
 * and a rule enforced on one surface protects one surface.
 */
@Injectable()
export class SuggestionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolveLink(publicId: string, userId: string): Promise<SuggestionLink> {
    const row = await this.findOpen(publicId);
    if (row === null) return { kind: 'gone' };

    const now = this.clock.now();
    const live = {
      suggestionId: row.id,
      deletedAt: null,
      startsAt: { gt: now },
    } as const;

    const own = await this.prisma.event.findFirst({
      where: { ...live, hostUserId: userId, status: { in: [...ACTIVE_EVENT_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { publicId: true },
    });
    if (own !== null) return { kind: 'own', eventPublicId: own.publicId };

    // A free seat is `accepted_count < capacity`, a comparison between two
    // columns that Prisma's `where` cannot state — so the candidates are read
    // and filtered here. They are the events of one suggestion: a handful.
    const others = await this.prisma.event.findMany({
      where: { ...live, status: 'PUBLISHED', hostUserId: { not: userId } },
      orderBy: { createdAt: 'asc' },
      select: { publicId: true, capacity: true, acceptedCount: true },
    });
    const open = others.find((event) => event.acceptedCount < event.capacity);

    const suggestion = toCard(row);
    return open === undefined
      ? { kind: 'host', suggestion }
      : { kind: 'join', eventPublicId: open.publicId, suggestion };
  }

  /**
   * The event wizard's form, every core question answered — or null when the
   * suggestion is gone.
   *
   * Day, hour and minute are Tehran's wall clock, because that is what the
   * wizard's calendar and hour buttons mean (ADR-0008). The minute rides in
   * `startMinute`, which the wizard drops the moment the host picks an hour of
   * their own.
   */
  async wizardForm(publicId: string): Promise<Record<string, unknown> | null> {
    const row = await this.findOpen(publicId);
    if (row === null) return null;

    const { hour, minute } = tehranHourMinute(row.startsAt);
    return {
      title: row.title,
      description: row.description,
      categoryId: row.categoryId,
      ...(row.city.provinceId !== null ? { provinceId: row.city.provinceId } : {}),
      cityId: row.cityId,
      districtLabel: row.venueLabel,
      day: isoDay(row.startsAt),
      hour,
      startMinute: minute,
      durationHours: row.durationHours,
      capacity: row.capacity,
      costType: row.costType,
      ...(row.costAmount !== null ? { costAmount: row.costAmount } : {}),
      ...(row.externalLink !== null ? { externalLink: row.externalLink } : {}),
      suggestionId: row.id,
    };
  }

  /** Open means not closed and not yet started. */
  private async findOpen(publicId: string) {
    if (!PUBLIC_ID.test(publicId)) return null;
    return this.prisma.eventSuggestion.findFirst({
      where: { publicId, closedAt: null, startsAt: { gt: this.clock.now() } },
      include: {
        city: { select: { nameFa: true, provinceId: true } },
        category: { select: { nameFa: true } },
      },
    });
  }
}

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toCard(row: {
  publicId: string;
  title: string;
  description: string;
  venueLabel: string;
  startsAt: Date;
  durationHours: number;
  costType: CostType;
  costAmount: number | null;
  externalLink: string | null;
  city: { nameFa: string };
  category: { nameFa: string };
}): SuggestionCard {
  return {
    publicId: row.publicId,
    title: row.title,
    description: row.description,
    venueLabel: row.venueLabel,
    startsAt: row.startsAt,
    durationHours: row.durationHours,
    costType: row.costType,
    costAmount: row.costAmount,
    externalLink: row.externalLink,
    cityNameFa: row.city.nameFa,
    categoryNameFa: row.category.nameFa,
  };
}

/** The hour and minute an instant reads as in Tehran. */
function tehranHourMinute(instant: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: 'hour' | 'minute'): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return { hour: read('hour'), minute: read('minute') };
}
