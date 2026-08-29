import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  grantCoins,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { InvitationService, inviteSpendKey } from './invitation.service';

/**
 * Paying to invite the twenty most likely attendees (M22 phase 11).
 *
 * The scorer has its own unit test; this one is about everything a database has
 * to answer for — the exclusions, the exactly-once charge, the cap, and the two
 * cases the requirement leaves open and this implementation had to decide:
 * **fewer than twenty still costs ten, and zero costs nothing.**
 *
 * Nothing here sends. `InvitationService` writes rows and a campaign; the worker
 * is what talks to Telegram, and its own suite does so through a fake gateway.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;

const settings = new SettingsService(service);
const coins = new CoinService(service, clock);
const audit = new AuditService(service, clock);
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

const invitations = new InvitationService(service, clock, env, settings, coins, membership, audit);

let fixture: CatalogFixture;
let hostId: string;
let eventPublicId: string;
let eventId: string;

const HOST_COINS = 500;

async function profiledUser(
  options: { cityId?: string; interestIds?: string[]; optOut?: boolean; blocked?: boolean } = {},
): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'کاربر',
      cityId: options.cityId ?? fixture.tehranId,
      birthYear: 1995,
      inviteOptOut: options.optOut ?? false,
    },
  });
  for (const interestId of options.interestIds ?? []) {
    await prisma.userInterest.create({ data: { userId, interestId } });
  }
  if (options.blocked === true) {
    await prisma.telegramAccount.update({ where: { userId }, data: { botBlocked: true } });
  }
  return userId;
}

async function publishEvent(): Promise<{ id: string; publicId: string }> {
  const row = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ در یک کافهٔ آرام.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ در یک کافهٔ آرام.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date(NOW.getTime() + 5 * 86_400_000),
      endsAt: new Date(NOW.getTime() + 5 * 86_400_000 + 7_200_000),
      capacity: 8,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { id: true, publicId: true },
  });
  return row;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  hostId = await profiledUser();
  await grantCoins(prisma, hostId, HOST_COINS);
  const event = await publishEvent();
  eventId = event.id;
  eventPublicId = event.publicId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the preview', () => {
  it('writes nothing and charges nothing', async () => {
    await profiledUser();

    const preview = await invitations.preview(hostId, eventPublicId);

    expect(preview.selected).toBe(1);
    expect(preview.cost).toBe(10);
    expect(preview.balance).toBe(HOST_COINS);
    // The requirement that a preview cannot trigger a charge, asserted rather
    // than trusted.
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS);
    await expect(prisma.eventInvitation.count()).resolves.toBe(0);
    await expect(prisma.messageCampaign.count()).resolves.toBe(0);
  });

  it('explains the selection in counts, and names nobody', async () => {
    await profiledUser({ interestIds: [fixture.boardGamesId] });
    await profiledUser({ cityId: fixture.karajId });

    const preview = await invitations.preview(hostId, eventPublicId);

    // One selected, and the Karaj profile is not it (report 5). Everybody who
    // *can* be selected is in the event's city, so `sameCity` equals `selected`.
    expect(preview.selected).toBe(1);
    expect(preview.reasons.sameCity).toBe(1);
    expect(preview.reasons.interestMatch).toBe(1);
    expect(JSON.stringify(preview)).not.toContain(hostId);
  });

  /**
   * Report 5: an invitation is a message telling somebody to be at a specific
   * place on a specific evening. Sending it to a person in another city is spam
   * however well they match the category, so the city is a filter now rather than
   * a term in the score.
   */
  describe('the city is a filter, not a preference', () => {
    it('never invites somebody in another city, whatever else matches', async () => {
      // A perfect match on every other axis, in the wrong city.
      await profiledUser({ cityId: fixture.karajId, interestIds: [fixture.boardGamesId] });

      const preview = await invitations.preview(hostId, eventPublicId);

      expect(preview.selected).toBe(0);
      expect(preview.blockedReason).toBe('NO_CANDIDATES');
    });

    it('invites somebody in the event’s city with no matching interest at all', async () => {
      await profiledUser({ cityId: fixture.tehranId, interestIds: [] });

      const preview = await invitations.preview(hostId, eventPublicId);

      expect(preview.selected).toBe(1);
    });

    /** Nobody eligible costs nothing — the outcome the preview promised. */
    it('charges nothing when the event’s city is empty', async () => {
      await profiledUser({ cityId: fixture.karajId, interestIds: [fixture.boardGamesId] });

      const result = await invitations.inviteTop(hostId, eventPublicId, 'city-filter-key');

      expect(result.invited).toBe(0);
      expect(result.charged).toBe(0);
      await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS);
    });
  });

  it('says so when nobody qualifies', async () => {
    const preview = await invitations.preview(hostId, eventPublicId);

    expect(preview.selected).toBe(0);
    expect(preview.blockedReason).toBe('NO_CANDIDATES');
  });

  it('says so when the host cannot afford it', async () => {
    await profiledUser();
    const pauper = await profiledUser();
    const theirEvent = await prisma.event.update({
      where: { id: eventId },
      data: { hostUserId: pauper },
      select: { publicId: true },
    });

    const preview = await invitations.preview(pauper, theirEvent.publicId);

    expect(preview.affordable).toBe(false);
    expect(preview.blockedReason).toBe('INSUFFICIENT_COINS');
  });

  it('tells a stranger the event does not exist', async () => {
    const stranger = await profiledUser();

    await expect(invitations.preview(stranger, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
  });

  it('refuses an event that has already started', async () => {
    await prisma.event.update({
      where: { id: eventId },
      data: { startsAt: new Date(NOW.getTime() - 3_600_000) },
    });

    await expect(invitations.preview(hostId, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_INVITABLE',
    });
  });
});

describe('eligibility', () => {
  it('never invites the host', async () => {
    await profiledUser();

    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-host');

    const invited = await prisma.eventInvitation.findMany({ select: { userId: true } });
    expect(invited.map((row) => row.userId)).not.toContain(hostId);
    expect(result.invited).toBe(1);
  });

  it('never invites somebody who opted out', async () => {
    await profiledUser({ optOut: true });

    const preview = await invitations.preview(hostId, eventPublicId);

    expect(preview.selected).toBe(0);
  });

  it('never invites somebody who has blocked the bot', async () => {
    await profiledUser({ blocked: true });

    await expect(invitations.preview(hostId, eventPublicId)).resolves.toMatchObject({
      selected: 0,
    });
  });

  it('never invites somebody twice to the same event', async () => {
    const guest = await profiledUser();
    await invitations.inviteTop(hostId, eventPublicId, 'key-first');

    // A second, deliberate batch: same event, different key. The person already
    // invited is out of the pool, so the slots go to somebody new — or to nobody.
    const second = await invitations.inviteTop(hostId, eventPublicId, 'key-second');

    expect(second.invited).toBe(0);
    await expect(prisma.eventInvitation.count({ where: { eventId, userId: guest } })).resolves.toBe(
      1,
    );
  });

  it('never invites somebody already taking part', async () => {
    const guest = await profiledUser();
    await prisma.eventParticipant.create({
      data: { eventId, userId: guest, status: 'PENDING', requestedAt: NOW },
    });

    await expect(invitations.preview(hostId, eventPublicId)).resolves.toMatchObject({
      selected: 0,
    });
  });

  it('never invites a suspended or banned account', async () => {
    const suspended = await profiledUser();
    await prisma.user.update({ where: { id: suspended }, data: { status: 'SUSPENDED' } });

    await expect(invitations.preview(hostId, eventPublicId)).resolves.toMatchObject({
      selected: 0,
    });
  });

  it('never invites somebody who has not finished onboarding', async () => {
    // No profile, so no city and no interests — and nothing to say to them yet.
    await createUser(prisma, 'TERMS_ACCEPTED');

    await expect(invitations.preview(hostId, eventPublicId)).resolves.toMatchObject({
      selected: 0,
    });
  });

  it('caps the selection at the configured maximum', async () => {
    for (let index = 0; index < 25; index += 1) await profiledUser();

    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-cap');

    expect(result.invited).toBe(20);
    await expect(prisma.eventInvitation.count({ where: { eventId } })).resolves.toBe(20);
  });
});

describe('the charge', () => {
  it('takes ten coins once and records the campaign against them', async () => {
    await profiledUser();

    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-charge');

    expect(result.charged).toBe(10);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS - 10);

    const ledger = await prisma.coinLedger.findUniqueOrThrow({
      where: { idempotencyKey: inviteSpendKey(eventId, 'key-charge') },
    });
    expect(ledger.type).toBe('INVITE_SPEND');
    expect(ledger.amount).toBe(-10);
    expect(ledger.refId).toBe(eventId);

    const campaign = await prisma.messageCampaign.findUniqueOrThrow({
      where: { publicId: result.campaignPublicId! },
    });
    expect(campaign.coinLedgerId).toBe(ledger.id);
    expect(campaign.status).toBe('QUEUED');
  });

  it('charges once for a retried request', async () => {
    await profiledUser();

    const first = await invitations.inviteTop(hostId, eventPublicId, 'key-retry');
    const second = await invitations.inviteTop(hostId, eventPublicId, 'key-retry');

    expect(second.replayed).toBe(true);
    expect(second.charged).toBe(0);
    expect(second.campaignPublicId).toBe(first.campaignPublicId);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS - 10);
    await expect(prisma.coinLedger.count({ where: { type: 'INVITE_SPEND' } })).resolves.toBe(1);
  });

  it('charges once under two concurrent requests with the same key', async () => {
    for (let index = 0; index < 5; index += 1) await profiledUser();

    const results = await Promise.allSettled([
      invitations.inviteTop(hostId, eventPublicId, 'key-race'),
      invitations.inviteTop(hostId, eventPublicId, 'key-race'),
    ]);

    // One of them may lose on the unique index and reject; what must hold is that
    // the money moved once.
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    await expect(prisma.coinLedger.count({ where: { type: 'INVITE_SPEND' } })).resolves.toBe(1);
    await expect(prisma.messageCampaign.count()).resolves.toBe(1);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS - 10);
  });

  /**
   * The decision the requirement leaves open, made explicitly: **zero eligible
   * recipients costs nothing.** Charging for a send with nobody to send to would
   * be charging for nothing, and the preview shows the count first.
   */
  it('charges nothing when nobody is eligible, and says so in the trail', async () => {
    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-empty');

    expect(result).toMatchObject({ campaignPublicId: null, invited: 0, charged: 0 });
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_COINS);
    await expect(prisma.messageCampaign.count()).resolves.toBe(0);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'event.invite_top.no_candidates' },
    });
    expect(row.after).toMatchObject({ charged: 0 });
  });

  /**
   * The other half of the same decision: **fewer than twenty still costs ten.**
   * The price buys the operation, not a headcount, and a price that scaled with
   * availability would be unpredictable in the direction that matters.
   */
  it('charges the full price for fewer than the maximum', async () => {
    await profiledUser();
    await profiledUser();

    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-partial');

    expect(result.invited).toBe(2);
    expect(result.charged).toBe(10);
  });

  it('refuses when the host cannot afford it, and writes nothing', async () => {
    const pauper = await profiledUser();
    await profiledUser();
    const theirEvent = await prisma.event.update({
      where: { id: eventId },
      data: { hostUserId: pauper },
      select: { publicId: true },
    });

    await expect(
      invitations.inviteTop(pauper, theirEvent.publicId, 'key-broke'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });

    await expect(prisma.messageCampaign.count()).resolves.toBe(0);
    await expect(prisma.eventInvitation.count()).resolves.toBe(0);
  });
});

describe('what is recorded', () => {
  it('stores an explainable breakdown beside every invitation', async () => {
    await profiledUser({ interestIds: [fixture.boardGamesId] });

    await invitations.inviteTop(hostId, eventPublicId, 'key-breakdown');

    const invitation = await prisma.eventInvitation.findFirstOrThrow();
    expect(invitation.score).toBeGreaterThan(0);
    expect(invitation.scoreBreakdown).toMatchObject({
      sameCity: 30,
      interestMatch: 20,
      total: invitation.score,
    });
    // Numbers only. A breakdown naming the city would be a profile of the
    // recipient sitting in a column somebody can export.
    expect(JSON.stringify(invitation.scoreBreakdown)).not.toContain('تهران');
  });

  it('writes one recipient row per invitation, for the dispatcher to claim', async () => {
    await profiledUser();
    await profiledUser();

    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-recipients');

    const campaign = await prisma.messageCampaign.findUniqueOrThrow({
      where: { publicId: result.campaignPublicId! },
      select: { id: true, bodyText: true, parseMode: true },
    });
    await expect(
      prisma.messageRecipient.count({ where: { campaignId: campaign.id } }),
    ).resolves.toBe(2);
    // Rendered once, at purchase: the row is what proves what was sent.
    expect(campaign.bodyText).toContain('شب بازی رومیزی');
    expect(campaign.parseMode).toBe('HTML');
  });

  it('records the purchase with the score range and no recipient identities', async () => {
    await profiledUser();

    await invitations.inviteTop(hostId, eventPublicId, 'key-audit');

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'event.invite_top.purchased' },
    });
    expect(row.after).toMatchObject({ invited: 1, coinsCharged: 10 });
    const invited = await prisma.eventInvitation.findFirstOrThrow();
    expect(JSON.stringify(row.after)).not.toContain(invited.userId);
  });

  it('reports delivery statistics once the worker has recorded them', async () => {
    await profiledUser();
    await profiledUser();
    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-stats');
    const campaign = await prisma.messageCampaign.findUniqueOrThrow({
      where: { publicId: result.campaignPublicId! },
      select: { id: true },
    });
    const [first, second] = await prisma.eventInvitation.findMany({ select: { userId: true } });

    await invitations.recordInvitationOutcome(campaign.id, first!.userId, 'SENT');
    await invitations.recordInvitationOutcome(campaign.id, second!.userId, 'BLOCKED');

    await expect(invitations.statsFor(result.campaignPublicId!)).resolves.toEqual({
      SENT: 1,
      BLOCKED: 1,
    });
  });

  it('records an outcome once, so a redelivered job cannot overwrite it', async () => {
    await profiledUser();
    const result = await invitations.inviteTop(hostId, eventPublicId, 'key-once');
    const campaign = await prisma.messageCampaign.findUniqueOrThrow({
      where: { publicId: result.campaignPublicId! },
      select: { id: true },
    });
    const invitation = await prisma.eventInvitation.findFirstOrThrow();

    await invitations.recordInvitationOutcome(campaign.id, invitation.userId, 'SENT');
    await invitations.recordInvitationOutcome(campaign.id, invitation.userId, 'FAILED');

    await expect(
      prisma.eventInvitation.findUniqueOrThrow({ where: { id: invitation.id } }),
    ).resolves.toMatchObject({ status: 'SENT' });
  });
});
