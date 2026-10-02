import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_POST_UNDELETABLE_ACTION } from '@payetam/domain';
import { JOBS } from '@payetam/platform';
import { renderClosedChannelPost } from '@payetam/telegram';
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
    eventNumber: 25,
    kind: 'PAID',
    title: 'شب بازی رومیزی',
    categoryName: 'بازی',
    cityName: 'تهران',
    districtName: null,
    startsAt: new Date('2026-09-20T15:00:00.000Z'),
    capacity: 6,
    acceptedCount: 4,
    takenCount: 6,
    costType: 'FREE',
    costAmount: null,
    full: true,
    ...overrides,
  };
}

interface Takedown {
  postId: string;
  telegramMessageId: number;
  reason: 'ENDED' | 'SUPERSEDED' | 'WITHDRAWN';
  eventNumber: number;
  title: string;
}

function takedown(postId: string, telegramMessageId: number): Takedown {
  return { postId, telegramMessageId, reason: 'ENDED', eventNumber: 25, title: 'شب بازی رومیزی' };
}

interface Options {
  takedowns?: Takedown[];
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
    {} as never, // SeedSchedulerService
    {} as never, // ProfileService
  );

  return { processors, channel, telegram, metrics, audit };
}

/** Reached the way the scheduled queue reaches it. */
function run(processors: Processors, name: string): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name });
}

function sync(processors: Processors): Promise<void> {
  return run(processors, JOBS.CHANNEL_SYNC);
}

function syncCapacity(processors: Processors): Promise<void> {
  return run(processors, JOBS.CHANNEL_CAPACITY_SYNC);
}

/**
 * A bot cannot delete a channel message older than 48 hours, administrator with
 * «Delete messages» or not — production refused every post past that age. Most
 * posts go up days before their activity, so a refused delete is the ordinary
 * case, and the post is edited into its closed text instead.
 */
describe('a takedown Telegram refuses', () => {
  it('edits the post into its closed text, takes the buttons off, and stays quiet', async () => {
    const { processors, channel, telegram, metrics, audit } = build({
      takedowns: [takedown('post-1', 11)],
      deleted: 'UNDELETABLE',
    });

    await sync(processors);

    expect(telegram.editChannelPost).toHaveBeenCalledOnce();
    expect(telegram.editChannelPost).toHaveBeenCalledWith(
      11,
      renderClosedChannelPost({ reason: 'ENDED', eventNumber: 25, title: 'شب بازی رومیزی' }),
    );
    // No keyboard argument: `editMessageText` without one removes «پایتم».
    expect(telegram.editChannelPost.mock.calls[0]).toHaveLength(2);
    expect(channel.markTakenDown).toHaveBeenCalledWith('post-1');
    expect(audit.record).not.toHaveBeenCalled();
    expect(
      metrics.counter.mock.calls.filter(([, , labels]) => labels?.outcome === 'closed'),
    ).toHaveLength(1);
  });

  it('renders each post for its own reason', async () => {
    const { processors, telegram } = build({
      takedowns: [{ ...takedown('post-1', 11), reason: 'WITHDRAWN' }],
      deleted: 'UNDELETABLE',
    });

    await sync(processors);

    expect(telegram.editChannelPost).toHaveBeenCalledWith(11, '🚫 این رویداد دیگر در دسترس نیست.');
  });

  it('does not edit a post Telegram deleted', async () => {
    const { processors, channel, telegram } = build({ takedowns: [takedown('post-1', 11)] });

    await sync(processors);

    expect(telegram.editChannelPost).not.toHaveBeenCalled();
    expect(channel.markTakenDown).toHaveBeenCalledWith('post-1');
  });

  /** Neither delete nor edit: the bot has lost the channel, and that is the warning. */
  it('warns, counts and records it once per pass when the edit is refused too', async () => {
    const { processors, channel, metrics, audit } = build({
      takedowns: [takedown('post-1', 11), takedown('post-2', 12)],
      deleted: 'UNDELETABLE',
      edited: 'UNEDITABLE',
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

  it('takes a post somebody already removed by hand down without a warning', async () => {
    const { processors, channel, audit } = build({
      takedowns: [takedown('post-1', 11)],
      deleted: 'UNDELETABLE',
      edited: 'GONE',
    });

    await sync(processors);

    expect(channel.markTakenDown).toHaveBeenCalledWith('post-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('leaves the post to the next pass when the edit has to wait', async () => {
    const { processors, channel, audit } = build({
      takedowns: [takedown('post-1', 11)],
      deleted: 'UNDELETABLE',
      edited: 'RETRY',
    });

    await sync(processors);

    expect(channel.markTakenDown).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('takes a post that is already gone down without a warning', async () => {
    const { processors, channel, audit } = build({
      takedowns: [takedown('post-1', 11)],
      deleted: 'GONE',
    });

    await sync(processors);

    expect(channel.markTakenDown).toHaveBeenCalledWith('post-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('leaves a post to the next pass when Telegram asks to wait', async () => {
    const { processors, channel, audit } = build({
      takedowns: [takedown('post-1', 11)],
      deleted: 'RETRY',
    });

    await sync(processors);

    expect(channel.markTakenDown).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('a seats line that fell behind (v0.16.0)', () => {
  it('rewrites the post with its buttons, and records what it now says', async () => {
    const { processors, channel, telegram } = build({ stale: [stalePost()] });

    await syncCapacity(processors);

    expect(telegram.editChannelPost).toHaveBeenCalledOnce();
    const [messageId, text, keyboard] = telegram.editChannelPost.mock.calls[0] ?? [];
    expect(messageId).toBe(4242);
    // Four accepted plus two pending is six of six.
    expect(text).toContain('🔴 ظرفیت تکمیل');
    expect(text).toContain('#رویداد_۲۵');
    // Without `reply_markup` the edit would strip «🤝 پایتم» off the post.
    expect((keyboard as unknown[][]).flat().length).toBeGreaterThan(0);
    expect(channel.markCapacityRendered).toHaveBeenCalledWith(
      'post-1',
      expect.objectContaining({ full: true, takenCount: 6 }),
    );
  });

  it('counts a pending request as a closed seat', async () => {
    const { processors, telegram } = build({
      stale: [stalePost({ acceptedCount: 0, takenCount: 1, capacity: 4, full: false })],
    });

    await syncCapacity(processors);

    const [, text] = telegram.editChannelPost.mock.calls[0] ?? [];
    expect(text).toContain('🟢 ۳ جای خالی از ۴');
  });

  it('tries again next pass when the edit did not land', async () => {
    const { processors, channel } = build({ stale: [stalePost()], edited: 'RETRY' });

    await syncCapacity(processors);

    expect(channel.markCapacityRendered).not.toHaveBeenCalled();
  });

  it('stops asking about a post that can never be edited', async () => {
    const { processors, channel } = build({
      stale: [stalePost({ full: false, takenCount: 5 })],
      edited: 'UNEDITABLE',
    });

    await syncCapacity(processors);

    expect(channel.markCapacityRendered).toHaveBeenCalledWith(
      'post-1',
      expect.objectContaining({ full: false, takenCount: 5 }),
    );
  });

  /** Publishing runs every five minutes; the seats line cannot wait that long. */
  it('is not the publishing sweep’s job any more', async () => {
    const { processors, channel } = build({ stale: [stalePost()] });

    await sync(processors);

    expect(channel.findStaleCapacity).not.toHaveBeenCalled();
  });
});
