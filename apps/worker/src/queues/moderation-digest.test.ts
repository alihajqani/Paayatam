import { describe, expect, it, vi } from 'vitest';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * Delivering the moderation digest (plan 06).
 *
 * Who is due, and when, is `ModerationDigestService`'s and has its own suite
 * against a database. What the worker owns is what happens after a send: the
 * quiet period starts when the message went **or can never go**, and does not
 * start when Telegram merely failed, so the next pass tries again.
 */

const DUE = {
  adminUserId: 'admin-1',
  telegramUserId: 573_914_882n,
  summary: {
    openCount: 2,
    unclaimedCount: 2,
    oldestUnclaimedAt: new Date(Date.now() - 60 * 60_000),
    bySubject: { EVENT: 2 },
  },
};

function build(outcome: Record<string, unknown>): {
  processors: Processors;
  send: ReturnType<typeof vi.fn>;
  markSent: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(outcome);
  const markSent = vi.fn().mockResolvedValue(undefined);
  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    {} as never, // OutboxRelayService
    {} as never, // NotificationService
    {} as never, // UserSettingsService
    { send } as never,
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    {} as never, // MessagingService
    {} as never, // ReleaseAnnouncementService
    {} as never, // InvitationService
    { counter: vi.fn(), observe: vi.fn() } as never,
    {} as never, // CoinService
    {} as never, // TelegramLoggerService
    {} as never, // ConversationService
    {} as never, // HostRewardService
    {} as never, // ComebackService
    {} as never, // AdminTelegramService
    { due: vi.fn().mockResolvedValue([DUE]), markSent } as never,
  );
  return { processors, send, markSent };
}

function run(processors: Processors): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name: JOBS.MODERATION_DIGEST });
}

describe('the moderation digest job', () => {
  it('sends to the linked Telegram account with the queue button, then starts the quiet period', async () => {
    const { processors, send, markSent } = build({ kind: 'SENT', messageId: 1 });

    await run(processors);

    expect(send).toHaveBeenCalledOnce();
    const [chatId, text, keyboard] = send.mock.calls[0] as [bigint, string, unknown];
    expect(chatId).toBe(573_914_882n);
    expect(text).toContain('۲ پرونده');
    expect(JSON.stringify(keyboard)).toContain('ad:list:x');
    expect(markSent).toHaveBeenCalledWith('admin-1');
  });

  /** Blocked is terminal: retrying every quarter hour would only burn the limiter. */
  it('starts the quiet period for a moderator who blocked the bot', async () => {
    const { processors, markSent } = build({ kind: 'BLOCKED', reason: 'blocked' });

    await run(processors);

    expect(markSent).toHaveBeenCalledWith('admin-1');
  });

  it('leaves the quiet period unstarted when Telegram only failed, so the next pass retries', async () => {
    const { processors, markSent } = build({ kind: 'RETRY', reason: 'timeout' });

    await run(processors);

    expect(markSent).not.toHaveBeenCalled();
  });
});
