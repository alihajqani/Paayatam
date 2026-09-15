import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_POST_UNDELETABLE_ACTION } from '@payetam/domain';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * The channel sweep's two corrections (plan 14, items 2 and 3).
 *
 * The client's classification and the domain's queries each have their own
 * suite. This one is the wiring between them — what the sweep *does* with each
 * answer — because a correct outcome that the sweep then ignores is the failure
 * neither of those suites can see.
 */

const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function stalePost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    postId: 'post-1',
    telegramMessageId: 4242,
    eventPublicId: EVENT,
    kind: 'PAID',
    title: 'شب بازی رومیزی',
    categoryName: 'بازی',
    cityName: 'تهران',
    districtName: null,
    startsAt: new Date('2026-09-20T15:00:00.000Z'),
    capacity: 6,
    acceptedCount: 6,
    costType: 'FREE',
    costAmount: null,
    full: true,
    ...overrides,
  };
}

interface Options {
  takedowns?: { postId: string; telegramMessageId: number }[];
  stale?: Record<string, unknown>[];
  deleted?: string;
  edited?: string;
}

function build(options: Options) {
  const channel = {
    findTakedowns: vi.fn().mockResolvedValue(options.takedowns ?? []),
    markTakenDown: vi.fn().mockResolvedValue(undefined),
    findUnpostedPaid: vi.fn().mockResolvedValue([]),
    claimPending: vi.fn().mockResolvedValue([]),
    findStaleCapacity: vi.fn().mockResolvedValue(options.stale ?? []),
    markCapacityRendered: vi.fn().mockResolvedValue(undefined),
  };
  const telegram = {
    botUsername: 'paayatambot',
    deleteChannelPost: vi.fn().mockResolvedValue(options.deleted ?? 'DELETED'),
    editChannelPost: vi.fn().mockResolvedValue(options.edited ?? 'EDITED'),
  };
  const metrics = { counter: vi.fn(), observe: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    {} as never, // OutboxRelayService
    {} as never, // NotificationService
    {} as never, // UserSettingsService
    telegram as never,
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    channel as never,
    {} as never, // RetentionService
    {} as never, // MessagingService
    {} as never, // ReleaseAnnouncementService
    {} as never, // InvitationService
    metrics as never,
    {} as never, // CoinService
    { alert: vi.fn() } as never, // TelegramLoggerService
    {} as never, // ConversationService
    {} as never, // HostRewardService
    {} as never, // ComebackService
    {} as never, // AdminTelegramService
    {} as never, // ModerationDigestService
    audit as never,
    {} as never, // CityLaunchAnnouncementService
    {} as never, // NoShowClaimService
  );

  return { processors, channel, telegram, metrics, audit };
}

/** Reached the way the scheduled queue reaches it. */
function sync(processors: Processors): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name: JOBS.CHANNEL_SYNC });
}

describe('a takedown Telegram refuses', () => {
  it('stops retrying it, counts it, and records it once per pass', async () => {
    const { processors, channel, metrics, audit } = build({
      takedowns: [
        { postId: 'post-1', telegramMessageId: 11 },
        { postId: 'post-2', telegramMessageId: 12 },
      ],
      deleted: 'UNDELETABLE',
    });

    await sync(processors);

    expect(channel.markTakenDown.mock.calls).toEqual([['post-1'], ['post-2']]);
    expect(
      metrics.counter.mock.calls.filter(([, , labels]) => labels?.outcome === 'undeletable'),
    ).toHaveLength(2);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'SYSTEM',
        action: CHANNEL_POST_UNDELETABLE_ACTION,
        targetType: 'channel_post',
        targetId: 'post-1',
      }),
    );
  });

  it('takes a post that is already gone down without a warning', async () => {
    const { processors, channel, audit } = build({
      takedowns: [{ postId: 'post-1', telegramMessageId: 11 }],
      deleted: 'GONE',
    });

    await sync(processors);

    expect(channel.markTakenDown).toHaveBeenCalledWith('post-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('leaves a post to the next pass when Telegram asks to wait', async () => {
    const { processors, channel, audit } = build({
      takedowns: [{ postId: 'post-1', telegramMessageId: 11 }],
      deleted: 'RETRY',
    });

    await sync(processors);

    expect(channel.markTakenDown).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('a capacity line that crossed a boundary', () => {
  it('rewrites the post with its buttons, and records what it now says', async () => {
    const { processors, channel, telegram } = build({ stale: [stalePost()] });

    await sync(processors);

    expect(telegram.editChannelPost).toHaveBeenCalledOnce();
    const [messageId, text, keyboard] = telegram.editChannelPost.mock.calls[0] ?? [];
    expect(messageId).toBe(4242);
    expect(text).toContain('ظرفیت تکمیل');
    // Without `reply_markup` the edit would strip «🤝 پایتم» off the post.
    expect((keyboard as unknown[][]).flat().length).toBeGreaterThan(0);
    expect(channel.markCapacityRendered).toHaveBeenCalledWith('post-1', true);
  });

  it('tries again next pass when the edit did not land', async () => {
    const { processors, channel } = build({ stale: [stalePost()], edited: 'RETRY' });

    await sync(processors);

    expect(channel.markCapacityRendered).not.toHaveBeenCalled();
  });

  it('stops asking about a post that can never be edited', async () => {
    const { processors, channel } = build({
      stale: [stalePost({ full: false, acceptedCount: 5 })],
      edited: 'UNEDITABLE',
    });

    await sync(processors);

    expect(channel.markCapacityRendered).toHaveBeenCalledWith('post-1', false);
  });
});
