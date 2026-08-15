import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import type { InitDataUser } from './init-data.validator';

/** The safe projection of a user. Contains nothing that could identify them on Telegram. */
export interface PublicUser {
  publicId: string;
  onboardingState: 'NEW' | 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE';
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DELETED';
  locale: string;
  timezone: string;
}

@Injectable()
export class UserService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Create-or-get, keyed on the Telegram id.
   *
   * Idempotent under concurrency: two simultaneous `/start` taps race to insert, and
   * `telegram_account.telegram_user_id` is UNIQUE, so one loses at the database and
   * re-reads instead of creating a second account. A read-then-write check would
   * have a window between the two statements; this has none.
   *
   * Also refreshes the cached Telegram profile fields, which are the only place a
   * username is stored and are never returned to a client.
   */
  async findOrCreateByTelegram(telegramUser: InitDataUser): Promise<PublicUser> {
    const now = this.clock.now();

    const existing = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId: telegramUser.telegramUserId },
      include: { user: true },
    });

    if (existing) {
      await this.prisma.telegramAccount.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          usernameCached: telegramUser.username ?? null,
          firstNameCached: telegramUser.firstName ?? null,
          languageCode: telegramUser.languageCode ?? null,
          // Seeing the user again proves the bot is not blocked.
          botBlocked: false,
        },
      });
      return this.assertUsable(toPublicUser(existing.user));
    }

    try {
      const created = await this.prisma.user.create({
        data: {
          locale: telegramUser.languageCode === 'fa' ? 'fa-IR' : 'fa-IR',
          telegramAccount: {
            create: {
              telegramUserId: telegramUser.telegramUserId,
              usernameCached: telegramUser.username ?? null,
              firstNameCached: telegramUser.firstName ?? null,
              languageCode: telegramUser.languageCode ?? null,
              firstSeenAt: now,
              lastSeenAt: now,
            },
          },
        },
      });
      return this.assertUsable(toPublicUser(created));
    } catch (error) {
      // Lost the insert race. The other request created the account; read it.
      if (isUniqueViolation(error)) {
        const raced = await this.prisma.telegramAccount.findUnique({
          where: { telegramUserId: telegramUser.telegramUserId },
          include: { user: true },
        });
        if (raced) {
          return this.assertUsable(toPublicUser(raced.user));
        }
      }
      throw error;
    }
  }

  async findByPublicId(publicId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { publicId } });
    if (!user || user.deletedAt !== null) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }
    return this.assertUsable(toPublicUser(user));
  }

  /**
   * Maps the externally-visible `public_id` to the internal primary key.
   *
   * Deliberately explicit rather than returning the internal id from `findByPublicId`:
   * it keeps the internal id out of every object that could be serialised by
   * accident, so leaking it requires calling this on purpose.
   */
  async resolveInternalId(publicId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { publicId },
      select: { id: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }
    return user.id;
  }

  /**
   * Resolves a Telegram id to a user without creating one. Used by the bot, where
   * a message from an unknown user should prompt `/start`, not silently register them.
   */
  async findByTelegramId(telegramUserId: bigint): Promise<PublicUser | null> {
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      include: { user: true },
    });
    return account ? toPublicUser(account.user) : null;
  }

  async markBotBlocked(telegramUserId: bigint, blocked: boolean): Promise<void> {
    await this.prisma.telegramAccount
      .update({ where: { telegramUserId }, data: { botBlocked: blocked } })
      .catch(() => undefined); // Unknown user: nothing to record, nothing to fail.
  }

  private assertUsable(user: PublicUser): PublicUser {
    if (user.status === 'BANNED' || user.status === 'DELETED') {
      throw new AppError(ErrorCode.USER_BANNED);
    }
    return user;
  }
}

/**
 * Narrows a database row to the safe projection.
 *
 * The parameter is typed with the literal unions rather than `string`, so Prisma's
 * generated enum values flow through without a cast — and adding a new enum member
 * to the schema becomes a compile error here rather than a silent widening.
 */
function toPublicUser(user: {
  publicId: string;
  onboardingState: PublicUser['onboardingState'];
  status: PublicUser['status'];
  locale: string;
  timezone: string;
}): PublicUser {
  return {
    publicId: user.publicId,
    onboardingState: user.onboardingState,
    status: user.status,
    locale: user.locale,
    timezone: user.timezone,
  };
}

/** Prisma reports a unique constraint violation as P2002. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
