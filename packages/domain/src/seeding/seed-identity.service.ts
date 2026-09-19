import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Gender } from '@payetam/db';

const FIRST_NAMES: Record<Gender, readonly string[]> = {
  MALE: ['علی', 'حسین', 'محمد', 'امیر', 'رضا', 'سامان', 'بهزاد', 'کیان'],
  FEMALE: ['سارا', 'نگین', 'مریم', 'الهام', 'پریسا', 'رها', 'یاسمن', 'ترانه'],
  PREFER_NOT_SAY: ['نیک', 'آرمان', 'شایان', 'رهام'],
};

const LAST_INITIALS = ['ر.', 'م.', 'ک.', 'ص.', 'ن.', 'ب.', 'ت.', 'ح.'];

const GENDERS: readonly Gender[] = ['MALE', 'FEMALE', 'PREFER_NOT_SAY'];

/**
 * Creates the throwaway synthetic participants marketing seed events fill
 * their capacity with (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
 *
 * Never reused across events — row growth is immaterial for a feature with a
 * finite useful life, and freshness avoids any bookkeeping about which
 * identity is "busy" on which event.
 */
@Injectable()
export class SeedIdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createSeedParticipant(cityId: string): Promise<{ userId: string }> {
    const gender = pick(GENDERS);
    const firstName = pick(FIRST_NAMES[gender]);
    const lastInitial = pick(LAST_INITIALS);
    // Gregorian, per `user_profile_birth_year_plausible` (migration 0003) — a
    // Jalali year here would fail that CHECK, exactly the mistake it exists
    // to catch. ~20-35 y/o as of the mid-2020s.
    const birthYear = 1990 + Math.floor(Math.random() * 15);

    const user = await this.prisma.user.create({
      data: {
        isSeed: true,
        onboardingState: 'PROFILE_COMPLETE',
        profile: {
          create: {
            displayName: `${firstName} ${lastInitial}`,
            gender,
            birthYear,
            cityId,
          },
        },
      },
      select: { id: true },
    });

    return { userId: user.id };
  }

  /**
   * Removes an identity that never got a seat — the seat failed after the
   * identity was made. A no-op for anyone who is not a seed identity and for
   * anyone who does hold a participation, so it cannot remove a real account or
   * a seat's occupant whatever id it is handed.
   */
  async discard(userId: string): Promise<void> {
    await this.prisma.user.deleteMany({
      where: { id: userId, isSeed: true, participations: { none: {} } },
    });
  }
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}
