import { describe, expect, it, vi } from 'vitest';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * «همه آمدند؟» on its schedule (plan 15) — and, on the same pass, the one-off
 * dispute offer to the no-shows recorded before a dispute existed (plan 08).
 *
 * Who is asked, and the payload, are `lifecycle.int.test.ts`'s and
 * `no-show-claim.service.int.test.ts`'s. This is the wiring: the scheduled job
 * reaches both, and a pass that sent anything drains the outbox at once instead
 * of leaving it to the five-minute backstop.
 */

function build(prompted: number, offered = 0) {
  const lifecycle = { promptAttendance: vi.fn().mockResolvedValue(prompted) };
  const noShowClaims = { offerPastDisputes: vi.fn().mockResolvedValue(offered) };
  const relay = { drain: vi.fn().mockResolvedValue({ processed: 0, created: 0, queued: [] }) };

  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    relay as never,
    {} as never, // NotificationService
    {} as never, // UserSettingsService
    {} as never, // TelegramClient
    {} as never, // ParticipationService
    lifecycle as never,
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    {} as never, // MessagingService
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
    {} as never, // CityLaunchAnnouncementService
    noShowClaims as never,
  );

  return { processors, lifecycle, noShowClaims, relay };
}

function scheduled(processors: Processors): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name: JOBS.ATTENDANCE_PROMPT });
}

describe('the attendance prompt job', () => {
  it('asks, and hands the questions to the relay straight away', async () => {
    const { processors, lifecycle, relay } = build(2);

    await scheduled(processors);

    expect(lifecycle.promptAttendance).toHaveBeenCalledOnce();
    expect(relay.drain).toHaveBeenCalledOnce();
  });

  it('does nothing more on a pass that asked nobody', async () => {
    const { processors, lifecycle, relay } = build(0);

    await scheduled(processors);

    expect(lifecycle.promptAttendance).toHaveBeenCalledOnce();
    expect(relay.drain).not.toHaveBeenCalled();
  });

  it('offers the earlier no-shows their dispute, and drains when it did', async () => {
    const { processors, noShowClaims, relay } = build(0, 3);

    await scheduled(processors);

    expect(noShowClaims.offerPastDisputes).toHaveBeenCalledOnce();
    expect(relay.drain).toHaveBeenCalledOnce();
  });
});
