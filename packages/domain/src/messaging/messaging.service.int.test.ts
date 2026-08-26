import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import {
  AdminAccessService,
  permissionsFor,
  type AdminSession,
} from '../adminaccess/admin-access.service';
import { AdminCredentials } from '../adminaccess/admin-credentials';
import { MessagingAdminService } from '../adminaccess/messaging-admin.service';
import { ROLE_KEYS } from '../adminaccess/permissions';
import { MessagingService } from './messaging.service';

/**
 * Selecting, confirming and recording an outbound campaign (M22 phase 4).
 *
 * **Nothing in this file talks to Telegram, and nothing in the code it exercises
 * could.** `MessagingService` never calls the API — selection and bookkeeping are
 * the domain's, delivery is the worker's — so a fake gateway is not needed here
 * and its absence is the point: the one class that *can* send is not reachable
 * from anything under test.
 *
 * What is worth a real database: the unique key that makes a double-tap one
 * campaign, the unique index that makes a dispatcher safe to run twice, and the
 * `PENDING → terminal` transition that makes a redelivered send job a no-op.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const messaging = new MessagingService(service, clock, audit);
const admin = new MessagingAdminService(service, access, messaging, audit);

let fixture: CatalogFixture;
let SUPER: AdminSession;

/** A user who can be messaged: profile complete, in Tehran, bot not blocked. */
async function reachableUser(options: { cityId?: string; blocked?: boolean } = {}) {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'کاربر',
      cityId: options.cityId ?? fixture.tehranId,
      birthYear: 1995,
    },
  });
  if (options.blocked === true) {
    await prisma.telegramAccount.update({ where: { userId }, data: { botBlocked: true } });
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { userId, publicId: user.publicId };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  const row = await prisma.adminUser.create({
    data: {
      email: 'super@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'مدیر ارشد',
    },
    select: { id: true },
  });
  SUPER = {
    adminUserId: row.id,
    email: 'super@payetam.test',
    displayName: 'مدیر ارشد',
    roles: [ROLE_KEYS.SUPER_ADMIN],
    permissions: permissionsFor([ROLE_KEYS.SUPER_ADMIN]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('audience selection', () => {
  it('refuses an audience that narrows nothing', async () => {
    await expect(messaging.estimate({})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('excludes banned, deleted and bot-blocked accounts without being asked', async () => {
    await reachableUser();
    await reachableUser({ blocked: true });
    const banned = await reachableUser();
    await prisma.user.update({ where: { id: banned.userId }, data: { status: 'BANNED' } });

    // Three users exist and one is reachable. None of these exclusions is a filter
    // an operator sets, because none of them is a choice.
    await expect(messaging.estimate({ everyone: true })).resolves.toBe(1);
  });

  it('filters by city', async () => {
    await prisma.city.update({ where: { id: fixture.karajId }, data: { isActive: true } });
    await reachableUser();
    await reachableUser({ cityId: fixture.karajId });

    await expect(messaging.estimate({ cityIds: [fixture.karajId] })).resolves.toBe(1);
  });

  it('filters by profile completeness', async () => {
    await reachableUser();
    await createUser(prisma, 'TERMS_ACCEPTED');

    await expect(messaging.estimate({ profileComplete: true })).resolves.toBe(1);
    await expect(messaging.estimate({ profileComplete: false })).resolves.toBe(1);
  });

  it('filters by whether somebody has hosted', async () => {
    const host = await reachableUser();
    await reachableUser();
    await prisma.event.create({
      data: {
        hostUserId: host.userId,
        title: 'شب بازی',
        description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ در یک کافهٔ آرام.',
        titleNormalized: 'شب بازی',
        descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ در یک کافهٔ آرام.',
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: new Date(NOW.getTime() + 86_400_000),
        endsAt: new Date(NOW.getTime() + 90_000_000),
        capacity: 4,
        costType: 'FREE',
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        publishedAt: NOW,
      },
    });

    await expect(messaging.estimate({ hasHostedEvent: true })).resolves.toBe(1);
  });
});

describe('creating a campaign', () => {
  const KEY = 'idem-key-0001';

  it('materialises one recipient row per selected user, and stays DRAFT', async () => {
    await reachableUser();
    await reachableUser();

    const campaign = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'سلام به همه',
      audience: { everyone: true },
      idempotencyKey: KEY,
    });

    expect(campaign.status).toBe('DRAFT');
    expect(campaign.estimatedRecipients).toBe(2);
    expect(campaign.counts).toMatchObject({ total: 2, pending: 2, sent: 0 });
  });

  it('produces one campaign for a double-tapped button', async () => {
    await reachableUser();

    const first = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'سلام',
      audience: { everyone: true },
      idempotencyKey: KEY,
    });
    const second = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'سلام',
      audience: { everyone: true },
      idempotencyKey: KEY,
    });

    expect(second.publicId).toBe(first.publicId);
    await expect(prisma.messageCampaign.count()).resolves.toBe(1);
  });

  it('refuses a body Telegram would reject, before anybody is selected', async () => {
    await reachableUser();

    await expect(
      admin.create(SUPER, {
        kind: 'BROADCAST',
        bodyText: 'x'.repeat(5000),
        audience: { everyone: true },
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_FORMAT_INVALID' });

    await expect(prisma.messageCampaign.count()).resolves.toBe(0);
  });

  it('refuses HTML with a tag Telegram does not know', async () => {
    await reachableUser();

    await expect(
      admin.create(SUPER, {
        kind: 'BROADCAST',
        bodyText: '<div>سلام</div>',
        parseMode: 'HTML',
        audience: { everyone: true },
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_FORMAT_INVALID' });
  });

  /**
   * The rehearsal. It selects, counts and finishes — and migration 0021's CHECK
   * is what makes it impossible to turn one into a send afterwards.
   */
  it('a dry run completes without ever entering a sending state', async () => {
    await reachableUser();

    const campaign = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'پیش‌نمایش',
      audience: { everyone: true },
      dryRun: true,
      idempotencyKey: KEY,
    });

    expect(campaign.status).toBe('COMPLETED');
    expect(campaign.dryRun).toBe(true);
    expect(campaign.counts.total).toBe(1);
    // Every recipient is still PENDING — selected, never delivered to.
    expect(campaign.counts.pending).toBe(1);
    await expect(admin.confirm(SUPER, campaign.publicId)).rejects.toMatchObject({
      code: 'MESSAGE_DRY_RUN',
    });
  });

  it('records the audit row with the body length and never the body', async () => {
    await reachableUser();

    const campaign = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'متنی که نباید در گزارش رخدادها باشد',
      audience: { cityIds: [fixture.tehranId] },
      idempotencyKey: KEY,
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { targetType: 'message_campaign', targetId: campaign.publicId },
    });
    expect(row.action).toBe('message.drafted');
    expect(JSON.stringify(row.after)).not.toContain('نباید در گزارش');
    // The filters are named and counted, never listed: a city id in an exported
    // audit row is a record of who was targeted with what.
    expect(row.after).toMatchObject({ bodyLength: 35, audience: ['cities:1'] });
  });
});

describe('confirming, delivering and finishing', () => {
  async function draftFor(count: number) {
    for (let index = 0; index < count; index += 1) await reachableUser();
    return admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'سلام',
      audience: { everyone: true },
      idempotencyKey: `key-${String(count)}-${String(Date.now())}`,
    });
  }

  it('only a confirmed campaign is ever claimed', async () => {
    const draft = await draftFor(1);

    await expect(messaging.claimSendingCampaigns()).resolves.toEqual([]);

    await admin.confirm(SUPER, draft.publicId);
    const claimed = await messaging.claimSendingCampaigns();

    expect(claimed.map((row) => row.publicId)).toEqual([draft.publicId]);
    await expect(messaging.get(draft.publicId)).resolves.toMatchObject({ status: 'SENDING' });
  });

  it('hands the same recipients back until they are resolved', async () => {
    const draft = await draftFor(2);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();

    const first = await messaging.pendingDeliveries(claimed!.id);
    const second = await messaging.pendingDeliveries(claimed!.id);

    // Nothing is mutated by claiming. Re-enqueueing is harmless because the BullMQ
    // job id is derived from the recipient — the row's own transition is the guard.
    expect(second.map((row) => row.recipientId)).toEqual(first.map((row) => row.recipientId));
  });

  it('resolves a delivery exactly once, however many times the job runs', async () => {
    const draft = await draftFor(1);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    const [delivery] = await messaging.pendingDeliveries(claimed!.id);

    await messaging.recordDelivery(delivery!.recipientId, {
      status: 'SENT',
      telegramMessageId: 111,
    });
    // A redelivered job: `loadDelivery` finds the row already resolved and the
    // worker returns without sending.
    await expect(messaging.loadDelivery(delivery!.recipientId)).resolves.toBeNull();
    await messaging.recordDelivery(delivery!.recipientId, { status: 'FAILED' });

    const row = await prisma.messageRecipient.findUniqueOrThrow({
      where: { id: delivery!.recipientId },
    });
    expect(row.status).toBe('SENT');
    expect(row.telegramMessageId).toBe(111);
  });

  it('finishes as COMPLETED when everything landed', async () => {
    const draft = await draftFor(2);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    for (const delivery of await messaging.pendingDeliveries(claimed!.id)) {
      await messaging.recordDelivery(delivery.recipientId, { status: 'SENT' });
    }

    await expect(messaging.finalizeIfDone(claimed!.id)).resolves.toBe(true);
    await expect(messaging.get(draft.publicId)).resolves.toMatchObject({
      status: 'COMPLETED',
      counts: expect.objectContaining({ sent: 2, failed: 0 }),
    });
  });

  /**
   * A blocked recipient is not a failure. There was nobody to deliver to, which is
   * a fact about them rather than about the send — so a campaign where everybody
   * blocked the bot is `COMPLETED`, not `PARTIALLY_FAILED`.
   */
  it('does not count a blocked recipient as a failure', async () => {
    const draft = await draftFor(2);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    const deliveries = await messaging.pendingDeliveries(claimed!.id);
    await messaging.recordDelivery(deliveries[0]!.recipientId, { status: 'SENT' });
    await messaging.recordDelivery(deliveries[1]!.recipientId, { status: 'BLOCKED' });

    await messaging.finalizeIfDone(claimed!.id);
    await expect(messaging.get(draft.publicId)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('finishes as PARTIALLY_FAILED when something genuinely failed', async () => {
    const draft = await draftFor(2);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    const deliveries = await messaging.pendingDeliveries(claimed!.id);
    await messaging.recordDelivery(deliveries[0]!.recipientId, { status: 'SENT' });
    await messaging.recordDelivery(deliveries[1]!.recipientId, { status: 'FAILED', error: 'boom' });

    await messaging.finalizeIfDone(claimed!.id);
    await expect(messaging.get(draft.publicId)).resolves.toMatchObject({
      status: 'PARTIALLY_FAILED',
    });
  });

  it('will not finish while anything is still pending', async () => {
    const draft = await draftFor(2);
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    const deliveries = await messaging.pendingDeliveries(claimed!.id);
    await messaging.recordDelivery(deliveries[0]!.recipientId, { status: 'SENT' });

    await expect(messaging.finalizeIfDone(claimed!.id)).resolves.toBe(false);
  });
});

describe('pausing and cancelling', () => {
  async function sendingCampaign() {
    await reachableUser();
    await reachableUser();
    const draft = await admin.create(SUPER, {
      kind: 'BROADCAST',
      bodyText: 'سلام',
      audience: { everyone: true },
      idempotencyKey: `pausing-${String(Date.now())}`,
    });
    await admin.confirm(SUPER, draft.publicId);
    const [claimed] = await messaging.claimSendingCampaigns();
    return { publicId: draft.publicId, id: claimed!.id };
  }

  it('a paused campaign stops being claimed, and resumes when told', async () => {
    const campaign = await sendingCampaign();

    await messaging.pause(campaign.id, 'rate limited 3 times in a row');
    await expect(messaging.claimSendingCampaigns()).resolves.toEqual([]);
    // The recipients are untouched: pause holds the audience rather than throwing
    // it away, which is the difference from cancel.
    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({
      status: 'SENDING',
      pauseReason: 'rate limited 3 times in a row',
      counts: expect.objectContaining({ pending: 2 }),
    });

    await admin.resume(SUPER, campaign.publicId);
    await expect(messaging.claimSendingCampaigns()).resolves.toHaveLength(1);
  });

  it('a paused campaign refuses to deliver a job already in the queue', async () => {
    const campaign = await sendingCampaign();
    const [delivery] = await messaging.pendingDeliveries(campaign.id);

    await messaging.pause(campaign.id, 'paused');

    await expect(messaging.loadDelivery(delivery!.recipientId)).resolves.toBeNull();
  });

  it('cancelling skips everything still pending', async () => {
    const campaign = await sendingCampaign();
    const deliveries = await messaging.pendingDeliveries(campaign.id);
    await messaging.recordDelivery(deliveries[0]!.recipientId, { status: 'SENT' });

    const cancelled = await admin.cancel(SUPER, campaign.publicId);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.counts).toMatchObject({ sent: 1, skipped: 1, pending: 0 });
    // Anything already delivered stays delivered — nothing can recall a Telegram
    // message, and pretending otherwise would be the wrong kind of honesty.
    await expect(messaging.loadDelivery(deliveries[1]!.recipientId)).resolves.toBeNull();
  });

  it('refuses to cancel one that has already finished', async () => {
    const campaign = await sendingCampaign();
    for (const delivery of await messaging.pendingDeliveries(campaign.id)) {
      await messaging.recordDelivery(delivery.recipientId, { status: 'SENT' });
    }
    await messaging.finalizeIfDone(campaign.id);

    await expect(admin.cancel(SUPER, campaign.publicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('Telegram identity (phase 12)', () => {
  it('returns the id as a string, with a link when there is a username', async () => {
    const user = await reachableUser();
    await prisma.telegramAccount.update({
      where: { userId: user.userId },
      data: { usernameCached: 'payetam_user' },
    });

    const identity = await admin.telegramIdentity(SUPER, user.publicId);

    expect(identity.telegramUserId).toMatch(/^\d+$/);
    expect(identity.username).toBe('payetam_user');
    expect(identity.directLink).toBe('https://t.me/payetam_user');
    expect(identity.linkUnavailableReason).toBeNull();
  });

  it('offers no link when there is no username, and says why', async () => {
    const user = await reachableUser();

    const identity = await admin.telegramIdentity(SUPER, user.publicId);

    expect(identity.username).toBeNull();
    // Not a `tg://user?id=…`: that resolves only for a client that already knows
    // the peer, so it would work for whoever tested it and silently fail for
    // everyone else.
    expect(identity.directLink).toBeNull();
    expect(identity.linkUnavailableReason).toBe('NO_USERNAME');
  });

  it('refuses a cached username that could not be a Telegram username', async () => {
    const user = await reachableUser();
    await prisma.telegramAccount.update({
      where: { userId: user.userId },
      data: { usernameCached: 'evil/../path' },
    });

    const identity = await admin.telegramIdentity(SUPER, user.publicId);

    // The value ends up in a URL the panel renders as a link. Validated rather
    // than trusted, so a cached string with a slash in it cannot build a link to
    // somewhere else.
    expect(identity.username).toBeNull();
    expect(identity.directLink).toBeNull();
  });

  it('writes an audit row naming who looked, and never what they saw', async () => {
    const user = await reachableUser();

    await admin.telegramIdentity(SUPER, user.publicId);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.telegram_viewed' },
    });
    expect(row.actorId).toBe(SUPER.adminUserId);
    expect(row.targetId).toBe(user.userId);
    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { userId: user.userId },
    });
    // The Telegram id is the thing this permission exists to protect. Putting it
    // in `audit_log` would defeat the table it was kept out of.
    expect(JSON.stringify(row.after)).not.toContain(account.telegramUserId.toString());
  });

  it('is 404 for a user that does not exist, rather than a different error', async () => {
    await expect(
      admin.telegramIdentity(SUPER, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
