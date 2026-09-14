import { describe, expect, it, vi } from 'vitest';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * «همه آمدند؟» on its schedule (plan 15).
 *
 * Who is asked, and the payload, are `lifecycle.int.test.ts`'s. This is the
 * wiring: the scheduled job reaches `promptAttendance`, and a pass that asked
 * somebody drains the outbox at once instead of leaving the question to the
 * five-minute backstop.
 */

function build(prompted: number) {
  const lifecycle = { promptAttendance: vi.fn().mockResolvedValue(prompted) };
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
  );

  return { processors, lifecycle, relay };
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
});
