import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventStatus, PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { EVENT_DISCLAIMER_SHORT_FA, UNLIMITED_CAPACITY } from '@payetam/shared';
import { renderChannelPost, type RenderedChannelPost } from '@payetam/telegram';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import { ChannelService } from './channel.service';

/**
 * Channel publishing (M14).
 *
 * The plan names four properties and each has its own section below: only
 * PUBLISHED and approved events publish; no duplicate post per event per kind; a
 * hidden event's post is deleted; and the post body carries no host identity.
 *
 * The last one is the reason this milestone is worth care despite being small. The
 * channel is a **public surface with no authentication in front of it** — whatever
 * appears there is readable by anyone who finds it, forever, including after the
 * event is over and the account is deleted.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const channel = new ChannelService(service, clock, settings);

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;

interface EventOptions {
  status?: EventStatus;
  moderationStatus?: 'PENDING' | 'APPROVED' | 'FLAGGED' | 'REJECTED';
  requestCount?: number;
  startsAt?: Date;
  deletedAt?: Date | null;
  title?: string;
  capacity?: number;
  acceptedCount?: number;
}

async function createEvent(options: EventOptions = {}): Promise<{ id: string; publicId: string }> {
  const status = options.status ?? 'PUBLISHED';
  return prisma.event.create({
    data: {
      hostUserId: hostId,
      title: options.title ?? 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      districtId: fixture.tehranDistrictId,
      startsAt: options.startsAt ?? STARTS_AT,
      endsAt: new Date((options.startsAt ?? STARTS_AT).getTime() + 3 * 3_600_000),
      capacity: options.capacity ?? 6,
      acceptedCount: options.acceptedCount ?? 2,
      costType: 'FREE',
      status,
      moderationStatus: options.moderationStatus ?? 'APPROVED',
      publishedAt: status === 'PUBLISHED' || status === 'HIDDEN' ? NOW : null,
      requestCount: options.requestCount ?? 0,
      deletedAt: options.deletedAt ?? null,
    },
    select: { id: true, publicId: true },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId: hostId,
      displayName: 'مریم رضایی',
      cityId: fixture.tehranId,
      birthYear: 1995,
      bio: 'برای هماهنگی به من پیام بدهید',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('only PUBLISHED and approved events publish', () => {
  it('claims a trending event as TRENDING', async () => {
    await createEvent({ requestCount: 10 });
    const claimed = await channel.claimPending();

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe('TRENDING');
  });

  it('claims a trending event at the threshold and not below it', async () => {
    await createEvent({ requestCount: 9, title: 'کمتر' });
    await expect(channel.claimPending()).resolves.toEqual([]);

    await createEvent({ requestCount: 10, title: 'در آستانه' });
    await expect(channel.claimPending()).resolves.toHaveLength(1);
  });

  it.each<EventStatus>(['DRAFT', 'PENDING_MODERATION', 'HIDDEN', 'REJECTED', 'CANCELLED_BY_HOST'])(
    'refuses a %s event however popular it is',
    async (status) => {
      await createEvent({ status, requestCount: 100 });
      await expect(channel.claimPending()).resolves.toEqual([]);
    },
  );

  /**
   * ADR-0012's rule applied to a public surface: FLAG publishes and opens a case,
   * BLOCK does not publish. A blocked event reaching the channel would be the
   * automation failing in the most visible place it could.
   */
  it('publishes a FLAGGED event and refuses a REJECTED one', async () => {
    await createEvent({ requestCount: 10, moderationStatus: 'FLAGGED', title: 'پرچم‌دار' });
    await expect(channel.claimPending()).resolves.toHaveLength(1);

    await resetAndSeed();
    await createEvent({ requestCount: 10, moderationStatus: 'REJECTED', title: 'ردشده' });
    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  it('refuses a soft-deleted event', async () => {
    await createEvent({ requestCount: 10, deletedAt: NOW });
    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  /** A channel advertising last Tuesday is worse than an empty one. */
  it('refuses an event that has already started', async () => {
    await createEvent({ requestCount: 10, startsAt: new Date(NOW.getTime() - 3_600_000) });
    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  it('refuses an unpromoted event, however ordinary and valid', async () => {
    await createEvent({});
    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  /** The kill switch: a public surface the product cannot stop writing to. */
  it('publishes nothing at all when the channel is switched off', async () => {
    await prisma.appSetting.create({ data: { key: 'channel.enabled', value: 0 } });
    await createEvent({ requestCount: 10 });

    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  /**
   * …including a post somebody paid for (review H4.2).
   *
   * `channel.enabled` was read only by `claimPending`, and the worker sends
   * `findUnpostedPaid()` first on every pass — so the switch whose guide says
   * «خاموش یعنی هیچ پستی منتشر نمی‌شود» stopped the free posts and let every
   * registration through. The claim is kept, not released: it is the record that
   * somebody paid, and it posts when the channel is switched back on.
   */
  it('publishes no paid post either while switched off, and keeps the claim', async () => {
    const event = await createEvent({});
    await prisma.channelPost.create({ data: { eventId: event.id, kind: 'PAID', createdAt: NOW } });

    await prisma.appSetting.create({ data: { key: 'channel.enabled', value: 0 } });
    await expect(channel.findUnpostedPaid()).resolves.toEqual([]);

    await prisma.appSetting.update({ where: { key: 'channel.enabled' }, data: { value: 1 } });
    await expect(channel.findUnpostedPaid()).resolves.toHaveLength(1);
  });

  async function resetAndSeed(): Promise<void> {
    await resetDatabase(prisma);
    fixture = await seedCatalog(prisma);
    hostId = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId: hostId, displayName: 'میزبان', cityId: fixture.tehranId, birthYear: 1995 },
    });
  }
});

describe('no duplicate post per event per kind', () => {
  it('claims an event once, however many passes run', async () => {
    await createEvent({ requestCount: 10 });

    const first = await channel.claimPending();
    const second = await channel.claimPending();

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    await expect(prisma.channelPost.count()).resolves.toBe(1);
  });

  /**
   * TRENDING is the only automatic kind since promotion was removed (v0.7.0), so
   * a popular event produces exactly one claim however popular it is.
   */
  it('posts once for an event well past the threshold', async () => {
    await createEvent({ requestCount: 50 });

    const claimed = await channel.claimPending();

    expect(claimed.map((post) => post.kind)).toEqual(['TRENDING']);
    await expect(channel.claimPending()).resolves.toEqual([]);
  });

  /**
   * One activity, one post — whichever kind got there first (review H4.1).
   *
   * Every registration claims a PAID post, and the trending sweep claimed its own
   * TRENDING one for the same activity once it reached ten requests. The post
   * text does not show the kind, so the channel carried two identical posts, and
   * «انتشار دوباره» replaced only one of them. Unposted counts: the paid post is
   * on its way, and a trending one would race it.
   */
  it.each([
    ['already in the channel', NOW],
    ['still waiting to be sent', null],
  ])('does not trend an activity whose paid post is %s', async (_label, postedAt) => {
    const event = await createEvent({ requestCount: 10 });
    await prisma.channelPost.create({
      data: {
        eventId: event.id,
        kind: 'PAID',
        createdAt: NOW,
        postedAt,
        telegramMessageId: postedAt === null ? null : 7,
      },
    });

    await expect(channel.claimPending()).resolves.toEqual([]);
    await expect(prisma.channelPost.count({ where: { kind: 'TRENDING' } })).resolves.toBe(0);
  });

  /** A paid post Telegram confirmed is gone no longer stands in for one. */
  it('trends an activity whose paid post was taken down', async () => {
    const event = await createEvent({ requestCount: 10 });
    await prisma.channelPost.create({
      data: {
        eventId: event.id,
        kind: 'PAID',
        createdAt: NOW,
        postedAt: NOW,
        telegramMessageId: 7,
        deletedAt: NOW,
      },
    });

    await expect(channel.claimPending()).resolves.toHaveLength(1);
  });

  it('is enforced by the database, not only by the claim path', async () => {
    const event = await createEvent({ requestCount: 10 });
    await channel.claimPending();

    await expect(
      prisma.channelPost.create({ data: { eventId: event.id, kind: 'TRENDING' } }),
    ).rejects.toThrow(/event_id.*kind|kind.*event_id/s);
  });

  /**
   * A claim that never became a post is released, so the next pass can try again.
   * Leaving it would mean one failed send permanently barred that event from the
   * channel, with nothing to say why.
   */
  it('lets a released claim be retried', async () => {
    await createEvent({ requestCount: 10 });
    const claimed = await channel.claimPending();
    await channel.releaseClaim(claimed[0]?.postId ?? '');

    await expect(channel.claimPending()).resolves.toHaveLength(1);
  });

  /** But a claim that *did* become a post is not releasable, so it is not re-posted. */
  it('will not release a claim that was actually posted', async () => {
    await createEvent({ requestCount: 10 });
    const claimed = await channel.claimPending();
    const postId = claimed[0]?.postId ?? '';
    await channel.markPosted(postId, 42, false);

    await channel.releaseClaim(postId);

    await expect(prisma.channelPost.count()).resolves.toBe(1);
    await expect(channel.claimPending()).resolves.toEqual([]);
  });
});

describe('a stale post comes down', () => {
  async function posted(options: EventOptions = {}): Promise<{ id: string; postId: string }> {
    const event = await createEvent({ requestCount: 10, ...options });
    const claimed = await channel.claimPending();
    const postId = claimed[0]?.postId ?? '';
    await channel.markPosted(postId, 4242, false);
    return { id: event.id, postId };
  }

  it('takes down the post of a hidden event', async () => {
    const post = await posted();
    await prisma.event.update({ where: { id: post.id }, data: { status: 'HIDDEN' } });

    const takedowns = await channel.findTakedowns();
    expect(takedowns).toEqual([{ postId: post.postId, telegramMessageId: 4242 }]);
  });

  it.each<EventStatus>(['CANCELLED_BY_HOST', 'REJECTED', 'EXPIRED', 'COMPLETED'])(
    'takes down the post of a %s event',
    async (status) => {
      const post = await posted();
      await prisma.event.update({ where: { id: post.id }, data: { status } });

      await expect(channel.findTakedowns()).resolves.toHaveLength(1);
    },
  );

  it('takes down the post of an event that has started', async () => {
    await posted();
    clock.set(new Date(STARTS_AT.getTime() + 60_000));

    await expect(channel.findTakedowns()).resolves.toHaveLength(1);
  });

  it('leaves a live event’s post alone', async () => {
    await posted();
    await expect(channel.findTakedowns()).resolves.toEqual([]);
  });

  it('offers a post for takedown only once', async () => {
    const post = await posted();
    await prisma.event.update({ where: { id: post.id }, data: { status: 'HIDDEN' } });

    await channel.markTakenDown(post.postId);
    await expect(channel.findTakedowns()).resolves.toEqual([]);
  });

  /**
   * The row survives a takedown, which matters twice: it is the record that this
   * event *was* in the channel — a host who lost the post to moderation has a
   * question, and "there is no row" is not an answer — and it stops the
   * event being re-posted the moment it becomes publishable again.
   */
  it('keeps the record, and does not re-post afterwards', async () => {
    const post = await posted();
    await prisma.event.update({ where: { id: post.id }, data: { status: 'HIDDEN' } });
    await channel.markTakenDown(post.postId);

    await prisma.event.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });

    await expect(channel.claimPending()).resolves.toEqual([]);
    const row = await prisma.channelPost.findFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
    expect(row.telegramMessageId).toBe(4242);
  });

  /** A row claiming to be posted with no message id is a post nothing can remove. */
  it('refuses a posted row with no message id at the database level', async () => {
    const event = await createEvent({ requestCount: 10 });

    await expect(
      prisma.channelPost.create({ data: { eventId: event.id, kind: 'TRENDING', postedAt: NOW } }),
    ).rejects.toThrow(/channel_post_posted_has_message_id/);
  });
});

/**
 * **The post body contains no host identity.**
 *
 * The renderer takes a narrow content type rather than an event row, so there is
 * no host field for a future edit to casually interpolate. This asserts the
 * outcome anyway, against a host whose profile is full of things that must not
 * appear.
 */
/**
 * Everything the channel actually shows: the message and the button under it.
 *
 * The keyboard is not decoration — it carries a URL built from the event, so an
 * identity smuggled into a label or a link is the same leak as one in the body.
 * Scanning only `text` would have been a check that stopped covering half the
 * post the moment report 7 landed.
 */
function wholePost(rendered: RenderedChannelPost): string {
  return `${rendered.text}\n${JSON.stringify(rendered.keyboard)}`;
}

describe('the post body carries no host identity', () => {
  it('names the event and never the person running it', async () => {
    await createEvent({ requestCount: 10 });
    const claimed = await channel.claimPending();
    const post = claimed[0];
    expect(post).toBeDefined();

    const rendered = renderChannelPost({
      kind: post?.kind ?? 'TRENDING',
      title: post?.title ?? '',
      categoryName: post?.categoryName ?? '',
      cityName: post?.cityName ?? '',
      districtName: post?.districtName ?? null,
      startsAt: post?.startsAt ?? NOW,
      capacity: post?.capacity ?? 0,
      acceptedCount: post?.acceptedCount ?? 0,
      costType: post?.costType ?? 'FREE',
      costAmount: post?.costAmount ?? null,
      eventPublicId: post?.eventPublicId ?? '',
      botUsername: 'payetam_bot',
    });
    // Text *and* button. The keyboard is part of the post the channel shows, so
    // an identity smuggled into a button label or a URL is the same leak.
    const body = wholePost(rendered);

    expect(body).toContain('شب بازی رومیزی');
    expect(body).toContain('تهران');
    // The host's display name, their bio, and every id that is not the event's.
    expect(body).not.toContain('مریم رضایی');
    expect(body).not.toContain('برای هماهنگی');
    expect(body).not.toContain(hostId);
  });

  /** Report 8: the disclaimer is above the event, on every post, whatever the kind. */
  it.each(['VIP', 'BOOSTED', 'TRENDING', 'PAID'] as const)(
    'carries the disclaimer above the event on a %s post',
    (kind) => {
      const rendered = renderChannelPost({
        kind,
        title: 'شب بازی رومیزی',
        categoryName: 'کافه',
        cityName: 'تهران',
        districtName: null,
        startsAt: STARTS_AT,
        capacity: 6,
        acceptedCount: 2,
        costType: 'FREE',
        costAmount: null,
        eventPublicId: '00000000-0000-4000-8000-000000000000',
        botUsername: 'payetam_bot',
      });

      expect(rendered.text).toContain(EVENT_DISCLAIMER_SHORT_FA);
      // Above, not below: "above every event" is the requirement, and a liability
      // line under the fold is a line nobody reads.
      expect(rendered.text.indexOf(EVENT_DISCLAIMER_SHORT_FA)).toBeLessThan(
        rendered.text.indexOf('شب بازی رومیزی'),
      );
    },
  );

  /**
   * Report 7: the post is reachable *from*, by a button rather than a blue word.
   *
   * Two buttons since v0.6.3, and both into the **bot**: the single one used to
   * open the Mini App, which v0.4.6 removed every other button to. A reader who
   * has decided should not have to open a detail screen to act, so «پایتم»
   * is its own row.
   */
  it('carries the two inline buttons that reach the bot', () => {
    const rendered = renderChannelPost({
      kind: 'PAID',
      title: 'x',
      categoryName: 'y',
      cityName: 'z',
      districtName: null,
      startsAt: STARTS_AT,
      capacity: 6,
      acceptedCount: 2,
      costType: 'FREE',
      costAmount: null,
      eventPublicId: '11111111-1111-4111-8111-111111111111',
      botUsername: 'payetam_bot',
    });

    expect(rendered.keyboard).toHaveLength(2);
    expect(rendered.keyboard[0]?.[0]?.url).toBe(
      'https://t.me/payetam_bot?start=event_11111111-1111-4111-8111-111111111111',
    );
    expect(rendered.keyboard[1]?.[0]?.url).toBe(
      'https://t.me/payetam_bot?start=join_11111111-1111-4111-8111-111111111111',
    );
    expect(rendered.keyboard[1]?.[0]?.text).toContain('پایتم');

    // URL buttons, never callbacks: a channel post has no session behind a tap,
    // and the bot cannot message a reader who has never opened a chat with it —
    // so a `callback_data` answer would be a toast and nothing else. Following a
    // link opens the chat, which is what makes every message after it deliverable.
    for (const row of rendered.keyboard) {
      for (const button of row) expect(button.callbackData).toBeUndefined();
    }
  });

  /** T9 on the widest audience any host-authored text reaches. */
  it('escapes a title that contains markup', async () => {
    await createEvent({ requestCount: 10, title: '<a href="http://evil">تخفیف</a>' });
    const claimed = await channel.claimPending();
    const post = claimed[0];

    const body = renderChannelPost({
      kind: 'TRENDING',
      title: post?.title ?? '',
      categoryName: 'کافه',
      cityName: 'تهران',
      districtName: null,
      startsAt: STARTS_AT,
      capacity: 6,
      acceptedCount: 2,
      costType: 'FREE',
      costAmount: null,
      eventPublicId: post?.eventPublicId ?? '',
      botUsername: 'payetam_bot',
    }).text;

    expect(body).not.toContain('<a href="http://evil"');
    expect(body).toContain('&lt;a href=');
    // No anchor at all any more: the link became a button (report 7), so the only
    // `<a` a body can contain is one a host wrote — and that one is escaped.
    expect(body.match(/<a /g) ?? []).toHaveLength(0);
  });

  it('links by public id, which is the only identifier that leaves the backend', async () => {
    const event = await createEvent({ requestCount: 10 });
    const claimed = await channel.claimPending();

    const body = renderChannelPost({
      kind: 'TRENDING',
      title: 'x',
      categoryName: 'y',
      cityName: 'z',
      districtName: null,
      startsAt: STARTS_AT,
      capacity: 6,
      acceptedCount: 2,
      costType: 'FREE',
      costAmount: null,
      eventPublicId: claimed[0]?.eventPublicId ?? '',
      botUsername: 'payetam_bot',
    });

    // The button carries the id now, so the assertion has to look at both halves.
    expect(wholePost(body)).toContain(event.publicId);
    expect(wholePost(body)).not.toContain(event.id);
  });
});

/**
 * A post that still says there are seats (plan 14, item 3).
 *
 * The post is rendered once, and nothing edited it: «۳ جای خالی» stayed after the
 * activity filled. Editing on every acceptance would put a busy channel against
 * Telegram's rate limit, so only the two boundaries are edited — it filled, or a
 * seat opened again on a post that said it was full.
 */
describe('a post whose capacity line has gone stale', () => {
  async function livePost(
    options: EventOptions,
    renderedFull = false,
  ): Promise<{ eventId: string; postId: string }> {
    const event = await createEvent(options);
    const post = await prisma.channelPost.create({
      data: {
        eventId: event.id,
        kind: 'PAID',
        createdAt: NOW,
        postedAt: NOW,
        telegramMessageId: 4242,
        renderedFull,
      },
      select: { id: true },
    });
    return { eventId: event.id, postId: post.id };
  }

  it('finds a post that says there are seats on an activity that has filled', async () => {
    const { postId } = await livePost({ capacity: 6, acceptedCount: 6 });

    const stale = await channel.findStaleCapacity();

    expect(stale.map((post) => [post.postId, post.full, post.telegramMessageId])).toEqual([
      [postId, true, 4242],
    ]);
  });

  it('stops finding it once the full line has been rendered', async () => {
    const { postId } = await livePost({ capacity: 6, acceptedCount: 6 });

    await channel.markCapacityRendered(postId, true);

    await expect(channel.findStaleCapacity()).resolves.toEqual([]);
  });

  it('finds a post that says full once a seat opens again', async () => {
    const { postId } = await livePost({ capacity: 6, acceptedCount: 5 }, true);

    const stale = await channel.findStaleCapacity();

    expect(stale.map((post) => [post.postId, post.full])).toEqual([[postId, false]]);
  });

  /** A seat taken is not a boundary crossed — the number is allowed to lag. */
  it('leaves a post alone while the activity is on the same side of full', async () => {
    await livePost({ capacity: 6, acceptedCount: 5, title: 'یکی مانده' });
    await livePost({ capacity: 6, acceptedCount: 6, title: 'فعالیت پرشده' }, true);

    await expect(channel.findStaleCapacity()).resolves.toEqual([]);
  });

  it('never edits an activity with no limit', async () => {
    await livePost({ capacity: UNLIMITED_CAPACITY, acceptedCount: UNLIMITED_CAPACITY });
    await livePost(
      { capacity: UNLIMITED_CAPACITY, acceptedCount: 3, title: 'فعالیت بی‌سقف' },
      true,
    );

    await expect(channel.findStaleCapacity()).resolves.toEqual([]);
  });

  it('only looks at posts that are live in the channel', async () => {
    await livePost({
      capacity: 6,
      acceptedCount: 6,
      title: 'شروع‌شده',
      startsAt: new Date(NOW.getTime() - 3_600_000),
    });
    const takenDown = await livePost({ capacity: 6, acceptedCount: 6, title: 'برداشته' });
    await channel.markTakenDown(takenDown.postId);
    const replaced = await livePost({ capacity: 6, acceptedCount: 6, title: 'جایگزین' });
    await prisma.channelPost.update({
      where: { id: replaced.postId },
      data: { supersededAt: NOW },
    });
    const unposted = await createEvent({ capacity: 6, acceptedCount: 6, title: 'در صف' });
    await prisma.channelPost.create({
      data: { eventId: unposted.id, kind: 'PAID', createdAt: NOW },
    });

    await expect(channel.findStaleCapacity()).resolves.toEqual([]);
  });

  /** The first render is recorded too, or a post sent full is edited to full. */
  it('records whether the post went out full when it is posted', async () => {
    const event = await createEvent({ capacity: 6, acceptedCount: 6 });
    await prisma.channelPost.create({ data: { eventId: event.id, kind: 'PAID', createdAt: NOW } });

    const [post] = await channel.findUnpostedPaid();
    expect(post?.full).toBe(true);
    await channel.markPosted(post?.postId ?? '', 4242, post?.full ?? false);

    await expect(channel.findStaleCapacity()).resolves.toEqual([]);
  });

  it('edits at most a bounded number per pass', async () => {
    for (const title of ['فعالیت اول', 'فعالیت دوم', 'فعالیت سوم']) {
      await livePost({ capacity: 6, acceptedCount: 6, title });
    }

    await expect(channel.findStaleCapacity(2)).resolves.toHaveLength(2);
  });
});
