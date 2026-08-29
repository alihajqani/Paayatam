import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { ChatService } from '../chat/chat.service';
import { MessageCipher } from '../chat/message-cipher';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';

/**
 * Where one person can be recognised across two events, and where they cannot
 * (M19, threat model T2.5 and R8).
 *
 * This is a **boundary test**, not a bug test: everything it asserts is the
 * product working as ADR-0009 and ADR-0014 intend. It exists because that
 * boundary has moved twice — layer 3 claimed a protection it never delivered, and
 * ADR-0014 then made the disclosure explicit — and because the next person to
 * widen a projection deserves a failing test rather than a paragraph in a
 * decision record.
 *
 * Read the two halves together. The first pins what a curious host **can** see,
 * so a later attempt to "fix" it has to argue with a test that says the product
 * chose this. The second pins what nobody can see, which is the part that is
 * actually load-bearing: there is **no query in the product that turns a person
 * into a list of the events they touched**, and that absence is what keeps
 * correlation local to one host's own queue instead of global.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as unknown as Env);
const chat = new ChatService(service, clock, cipher, audit, outbox);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
/**
 * The channel-membership gate, in its permissive default state.
 *
 * `event_channel_config` is truncated between tests, so `membershipRequired` is
 * false and every check answers NOT_REQUIRED — the gate is a no-op here, which is
 * what these suites want. `membership.int.test.ts` is where it is switched on.
 */
const membership = new ChannelMembershipService(
  service,
  new ChannelConfigService(service, clock, audit),
);

const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  chat,
  penalties,
  membership,
);

let fixture: CatalogFixture;

/** The three people the scenario needs, plus the names they publish. */
let hostA: string;
let hostB: string;
let guest: string;
let guestPublicId: string;

const GUEST_NAME = 'نگار موسوی';

async function createEvent(hostUserId: string, title: string): Promise<string> {
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';
  const event = await prisma.event.create({
    data: {
      hostUserId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 3 * 60 * 60 * 1000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return event.publicId;
}

async function nameAndComplete(userId: string, displayName: string): Promise<void> {
  await prisma.userProfile.create({
    data: { userId, displayName, cityId: fixture.tehranId, birthYear: 1995 },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  hostA = await createUser(prisma, 'PROFILE_COMPLETE');
  hostB = await createUser(prisma, 'PROFILE_COMPLETE');
  guest = await createUser(prisma, 'PROFILE_COMPLETE');

  await nameAndComplete(hostA, 'میزبان الف');
  await nameAndComplete(hostB, 'میزبان ب');
  await nameAndComplete(guest, GUEST_NAME);

  guestPublicId = (
    await prisma.user.findUniqueOrThrow({ where: { id: guest }, select: { publicId: true } })
  ).publicId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('one host, two of their own events, one guest', () => {
  /**
   * The accepted risk, asserted rather than assumed (R8).
   *
   * ADR-0014 stopped claiming the per-chat alias prevented this, because it never
   * did: `listForEvent` has returned every requester's display name since M6, in
   * `requested_at` order, which is the same order alias indices are handed out
   * in. A host who wanted to correlate could always do it by counting down their
   * own queue.
   *
   * The test is here so that a future change which *narrows* this is a deliberate
   * product decision with a failing test in front of it, and so that one which
   * widens it — a Telegram handle, a phone number, a list of the guest's other
   * events — cannot be mistaken for the status quo.
   */
  it('lets the host see the same name on both of their queues, and nothing more', async () => {
    const first = await createEvent(hostA, 'شب بازی رومیزی');
    const second = await createEvent(hostA, 'پیاده‌روی صبحگاهی');
    await participation.join(guest, first);
    await participation.join(guest, second);

    const [queueOne, queueTwo] = await Promise.all([
      participation.listForEvent(hostA, first),
      participation.listForEvent(hostA, second),
    ]);

    expect(queueOne[0]?.displayName).toBe(GUEST_NAME);
    expect(queueTwo[0]?.displayName).toBe(GUEST_NAME);
    // The same person, and the host can tell. That is R8.
    expect(queueOne[0]?.userPublicId).toBe(queueTwo[0]?.userPublicId);

    // What comes with it is a public id, a name and a reputation number. Not a
    // Telegram identifier, not a phone, not an email, and not a birth year.
    expect(Object.keys(queueOne[0] ?? {}).sort()).toEqual([
      'displayName',
      'hostDeadlineAt',
      'publicId',
      'requestedAt',
      'status',
      'trustScore',
      'userPublicId',
      'waitlistRank',
    ]);
  });

  /**
   * Aliases are **per event**, not per person, and this is what stops the alias
   * itself from becoming the correlation key ADR-0009 layer 3 was worried about.
   *
   * Both of this guest's conversations are «میهمان ۱» — the first request to each
   * event — which carries no information about who they are. The correlation the
   * host gets comes from the name beside it, deliberately (ADR-0014), and not
   * from a pseudonym the platform assigned and maintained across contexts.
   */
  it('numbers the guest independently in each event', async () => {
    const first = await createEvent(hostA, 'شب بازی رومیزی');
    const second = await createEvent(hostA, 'پیاده‌روی صبحگاهی');
    const other = await createUser(prisma, 'PROFILE_COMPLETE');
    await nameAndComplete(other, 'کاربر دیگر');

    // Somebody else asks first on the second event, so the two indices would
    // differ if they were global.
    await participation.join(guest, first);
    await participation.join(other, second);
    await participation.join(guest, second);

    const aliases = await prisma.chatParticipant.findMany({
      where: { userId: guest, role: 'GUEST' },
      select: { alias: true, aliasIndex: true },
      orderBy: { createdAt: 'asc' },
    });

    expect(aliases.map((row) => row.aliasIndex)).toEqual([1, 2]);
    // Which is exactly the point: an alias index is a position in one event's
    // queue, so it says nothing about the person holding it.
  });
});

describe('a second host, and a guest who asked to join both', () => {
  it('cannot read the other host’s queue at all', async () => {
    const hostAEvent = await createEvent(hostA, 'شب بازی رومیزی');
    await participation.join(guest, hostAEvent);

    // NOT_FOUND rather than FORBIDDEN: telling a stranger "this exists but is not
    // yours" is more than they are entitled to know (T3.3).
    await expect(participation.listForEvent(hostB, hostAEvent)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
  });

  /**
   * **The load-bearing absence.**
   *
   * A host holding a guest's `user_public_id` — which every host of an event that
   * guest asked to join does hold — must not be able to turn it into the list of
   * events that guest touched. The protection is not a permission check; it is
   * that no such query exists anywhere on the user-facing surface. Discovery
   * filters on city, district, category, date, cost, gender and age, and on no
   * identity at all.
   *
   * Asserted against the contract rather than by calling something, because the
   * property is an absence and the only way to assert an absence is to name what
   * would have to appear.
   */
  it('exposes no filter that maps a person to the events they touched', async () => {
    const { discoveryQuery } = await import('@payetam/shared');
    const filters = Object.keys(discoveryQuery.shape);

    for (const identityish of ['hostPublicId', 'userPublicId', 'participantPublicId', 'hostId']) {
      expect(filters).not.toContain(identityish);
    }
  });

  /**
   * A revealed review is a public reputation signal, and it says what somebody
   * was like — never where. If it carried the event, one review would hand a
   * stranger a place, a date and a person, which is a different disclosure from
   * the one ADR-0011 designed.
   */
  it('reveals reviews about a person without naming the event they happened at', async () => {
    const { revealedReviewView } = await import('@payetam/shared');
    const fields = Object.keys(revealedReviewView.shape);
    expect(fields).not.toContain('eventPublicId');
    expect(fields).not.toContain('eventTitle');
    // Nor who wrote it: a reader is entitled to know what was said about this
    // person, not who said it.
    expect(fields).not.toContain('reviewerPublicId');
    expect(fields).not.toContain('reviewerDisplayName');
    void guestPublicId;
  });
});

describe('what the guest can see of the host', () => {
  /**
   * Symmetry check. The guest learns the host's name from the event page, which
   * is public to any authenticated viewer and always has been — a host is
   * publishing an invitation, and an invitation with no name behind it is not
   * one anybody sensible accepts.
   *
   * What the guest does **not** get is a route from that name back to the host's
   * other guests: the participant list is host-only, and the chat carries the
   * counterpart's name without their public id.
   */
  it('gives the guest a conversation title and no identifier behind it', async () => {
    const event = await createEvent(hostA, 'شب بازی رومیزی');
    await participation.join(guest, event);

    const [summary] = await chat.listForUser(guest);
    expect(summary?.counterpartName).toBe('میزبان الف');
    expect(summary?.eventTitle).toBe('شب بازی رومیزی');
    // The chat names a person and an event, and hands over no identifier for
    // either the person or their other conversations.
    expect(Object.keys(summary ?? {})).not.toContain('counterpartPublicId');
    expect(JSON.stringify(summary)).not.toContain(guestPublicId);
  });
});
