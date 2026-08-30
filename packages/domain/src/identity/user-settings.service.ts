import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';

/**
 * What a person has chosen to be told about (v0.6.1).
 *
 * ── Why absence is not a state ──────────────────────────────────────────────
 *
 * A user who has never opened the settings screen has no row, and `get` resolves
 * that to the defaults rather than creating one. So adding this table changed
 * nothing about what anybody receives — which is the property that lets it ship
 * to a live product without a backfill and without a day where notifications
 * behave differently for people who happened to have visited a screen.
 *
 * ── What is not switchable, and why ─────────────────────────────────────────
 *
 * Consent, policy changes, moderation outcomes, account state. Those are not
 * notifications somebody opts out of; they are the product telling a person
 * something it is obliged to tell them, and a preference that could silence them
 * would be a preference that hides a suspension from the person suspended.
 * `notificationCategory` marks them `essential` and the worker never asks.
 */
export interface UserNotificationSettings {
  notifyChat: boolean;
  notifyEvents: boolean;
  notifyCampaigns: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: UserNotificationSettings = {
  notifyChat: true,
  notifyEvents: true,
  notifyCampaigns: true,
};

@Injectable()
export class UserSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<UserNotificationSettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { notifyChat: true, notifyEvents: true, notifyCampaigns: true },
    });
    return row ?? DEFAULT_NOTIFICATION_SETTINGS;
  }

  /**
   * Apply a partial change, creating the row on first write.
   *
   * `upsert` rather than read-then-write: two taps arriving together would
   * otherwise race to insert against a UNIQUE `user_id`, and the loser would
   * throw where the user expects a toggle. The create branch spells out the
   * whole row so a first write of one field does not depend on column defaults
   * agreeing with `DEFAULT_NOTIFICATION_SETTINGS` — they do, and this is what
   * keeps them doing so.
   */
  async update(
    userId: string,
    /**
     * `| undefined` on each field rather than `Partial<…>`, for the reason
     * `UpdateProfileInput` spells its own optionals out: under
     * `exactOptionalPropertyTypes` a `Partial<T>` accepts an absent key and
     * *rejects* an explicit `undefined`, and a Zod-parsed body hands over
     * exactly the latter.
     */
    patch: {
      notifyChat?: boolean | undefined;
      notifyEvents?: boolean | undefined;
      notifyCampaigns?: boolean | undefined;
    },
  ): Promise<UserNotificationSettings> {
    /**
     * Absent keys are *omitted*, not passed as `undefined`.
     *
     * Prisma's generated input types reject an explicit `undefined` under
     * `exactOptionalPropertyTypes`, and a Zod-parsed body is full of them — so
     * the spread is rebuilt field by field rather than handed over as it
     * arrived. The same shape `entityOf` uses in `update.ts`, for the same
     * compiler reason.
     */
    const data = {
      ...(patch.notifyChat !== undefined ? { notifyChat: patch.notifyChat } : {}),
      ...(patch.notifyEvents !== undefined ? { notifyEvents: patch.notifyEvents } : {}),
      ...(patch.notifyCampaigns !== undefined ? { notifyCampaigns: patch.notifyCampaigns } : {}),
    };

    return this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_NOTIFICATION_SETTINGS, ...data },
      update: data,
      select: { notifyChat: true, notifyEvents: true, notifyCampaigns: true },
    });
  }
}
