import { describe, expect, it, vi } from 'vitest';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * «پایه‌تَم در … باز شد» on its schedule (plan 17).
 *
 * Which cities, the campaign and the "once" are
 * `city-launch-announcement.service.int.test.ts`'s. This is the wiring: the
 * scheduled job reaches the service, and a pass that announced a city dispatches
 * the campaign at once rather than a minute later.
 */

function build(announced: { cityNameFa: string; recipients: number }[]) {
  const cityLaunches = { announceLaunchedCities: vi.fn().mockResolvedValue(announced) };
  const messaging = { claimSendingCampaigns: vi.fn().mockResolvedValue([]) };

  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    {} as never, // OutboxRelayService
    {} as never, // NotificationService
    {} as never, // UserSettingsService
    {} as never, // TelegramClient
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    messaging as never,
    {} as never, // ReleaseAnnouncementService
    {} as never, // InvitationService
    { counter: vi.fn(), observe: vi.fn() } as never,
    {} as never, // CoinService
    { alert: vi.fn() } as never, // TelegramLoggerService
    {} as never, // ConversationService
    {} as never, // HostRewardService
    {} as never, // ComebackService
    {} as never, // AdminTelegramService
    {} as never, // ModerationDigestService
    {} as never, // AuditService
    cityLaunches as never,
    {} as never, // NoShowClaimService
    {} as never, // SeedSchedulerService
    {} as never, // AnonymizationService
  );

  return { processors, cityLaunches, messaging };
}

function scheduled(processors: Processors): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name: JOBS.CITY_LAUNCH_ANNOUNCE });
}

describe('the city launch announcement job', () => {
  it('announces, and dispatches the campaign straight away', async () => {
    const { processors, cityLaunches, messaging } = build([
      { cityNameFa: 'شیراز', recipients: 120 },
    ]);

    await scheduled(processors);

    expect(cityLaunches.announceLaunchedCities).toHaveBeenCalledOnce();
    expect(messaging.claimSendingCampaigns).toHaveBeenCalledOnce();
  });

  it('does nothing more on a pass that announced nothing', async () => {
    const { processors, cityLaunches, messaging } = build([]);

    await scheduled(processors);

    expect(cityLaunches.announceLaunchedCities).toHaveBeenCalledOnce();
    expect(messaging.claimSendingCampaigns).not.toHaveBeenCalled();
  });
});
