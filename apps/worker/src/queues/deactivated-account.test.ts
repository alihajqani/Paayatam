import { describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '@payetam/telegram';
import { Processors } from './processors.service';

/**
 * A deleted Telegram account is the one deletion the product honours.
 *
 * There is no «delete my account» in the bot, by decision: the terms say an
 * account's personal data goes when its Telegram account does. Telegram tells us
 * so only by refusing a send — 403 «Forbidden: user is deactivated» — which
 * shares its status with a blocked bot and differs only in its description. So
 * this pins both halves: the deactivation anonymises, and a plain block does not,
 * because somebody who blocked the bot can come back with /start.
 */
function buildProcessors(reason: string): {
  processors: Processors;
  anonymize: ReturnType<typeof vi.fn>;
  markUndeliverable: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ kind: 'BLOCKED', reason });
  const anonymize = vi.fn().mockResolvedValue({ userId: 'u-1' });
  const markUndeliverable = vi.fn().mockResolvedValue(undefined);

  const notifications = {
    load: vi.fn().mockResolvedValue({
      id: 'n-1',
      userId: 'u-1',
      templateKey: TEMPLATES.BOT_NOTICE,
      payload: { text: 'x' },
      telegramUserId: 573_914_882n,
      botBlocked: false,
    }),
    markSuppressed: vi.fn().mockResolvedValue(undefined),
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markUndeliverable,
  };
  const userSettings = {
    get: vi.fn().mockResolvedValue({ notifyChat: true, notifyEvents: true, notifyCampaigns: true }),
  };
  const adminTelegram = { isLinked: vi.fn().mockResolvedValue(false) };

  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    {} as never, // OutboxRelayService
    notifications as never,
    userSettings as never,
    { send, botUsername: 'paayatambot' } as never,
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    {} as never, // MessagingService
    {} as never, // ReleaseAnnouncementService
    {} as never, // InvitationService
    {} as never, // MetricsRegistry
    {} as never, // CoinService
    {} as never, // TelegramLoggerService
    {} as never, // ConversationService
    {} as never, // HostRewardService
    {} as never, // ComebackService
    adminTelegram as never,
    {} as never, // ModerationDigestService
    {} as never, // AuditService
    {} as never, // CityLaunchAnnouncementService
    {} as never, // NoShowClaimService
    {} as never, // SeedSchedulerService
    { anonymize } as never, // AnonymizationService
  );

  return { processors, anonymize, markUndeliverable };
}

async function runSend(processors: Processors): Promise<void> {
  const onSend = (processors as unknown as { onSend: (job: unknown) => Promise<void> }).onSend.bind(
    processors,
  );
  await onSend({ data: { notificationId: 'n-1' } });
}

describe('a send to a deleted Telegram account', () => {
  it('anonymises the account', async () => {
    const { processors, anonymize, markUndeliverable } = buildProcessors(
      'Forbidden: user is deactivated',
    );

    await runSend(processors);

    expect(markUndeliverable).toHaveBeenCalledWith('n-1', 'u-1');
    expect(anonymize).toHaveBeenCalledWith('u-1');
  });

  it('leaves an account alone when the bot was only blocked', async () => {
    const { processors, anonymize, markUndeliverable } = buildProcessors(
      'Forbidden: bot was blocked by the user',
    );

    await runSend(processors);

    expect(markUndeliverable).toHaveBeenCalled();
    expect(anonymize).not.toHaveBeenCalled();
  });

  /** The send is already settled; a failure here must not turn it into a retry. */
  it('does not throw when the anonymisation fails', async () => {
    const { processors, anonymize } = buildProcessors('Forbidden: user is deactivated');
    anonymize.mockRejectedValueOnce(new Error('database away'));

    await expect(runSend(processors)).resolves.toBeUndefined();
  });
});
