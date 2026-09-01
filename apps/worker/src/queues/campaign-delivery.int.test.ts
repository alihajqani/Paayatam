import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  AuditService,
  ChannelConfigService,
  ChannelMembershipService,
  InvitationService,
  MessagingService,
} from '@payetam/domain';
import { FakeClock, JOBS, jobId } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import type { SendOutcome } from '../telegram/telegram.client';
import { Processors } from './processors.service';

/**
 * Delivering a campaign, against a real database and a **fake Telegram** (M22
 * phase 4).
 *
 * No test in this repository may send a real message, and the way that is
 * guaranteed here is structural rather than procedural: the `Processors` under
 * test is constructed with a gateway that records calls and returns whatever the
 * test scripted. There is no token, no `Bot`, and no code path from here to
 * `api.telegram.org`.
 *
 * What is worth a real database: the recipient row is the second idempotency
 * layer, and a redelivered job resolving one twice is exactly the failure a mock
 * would assert away.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const messaging = new MessagingService(service, clock, audit);
/**
 * Real, because the worker writes to both tables on every outcome and the two
 * must not be able to disagree. Its other half — pricing and charging — is
 * exercised in `invitation.service.int.test.ts`.
 */
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

const invitations = new InvitationService(
  service,
  clock,
  { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as never,
  {} as never,
  {} as never,
  membership,
  audit,
);

/** Every outbound call the worker makes, recorded rather than performed. */
class FakeTelegramGateway {
  readonly sent: { chatId: bigint; text: string; parseMode: 'HTML' | undefined }[] = [];
  readonly botUsername = 'payetam_bot';

  /** What the next `send` returns. Replaced per test. */
  next: SendOutcome = { kind: 'SENT', messageId: 1 };

  send(
    chatId: bigint,
    text: string,
    _keyboard?: unknown,
    options: { parseMode?: 'HTML' | undefined } = {},
  ): Promise<SendOutcome> {
    this.sent.push({ chatId, text, parseMode: options.parseMode });
    return Promise.resolve(this.next);
  }
}

/** Records the job ids the dispatcher produces, so duplicates are visible. */
class FakeQueues {
  readonly enqueued: { id: string; data: unknown }[] = [];

  enqueue(_queue: string, _name: string, id: string, data: unknown): Promise<void> {
    this.enqueued.push({ id, data });
    return Promise.resolve();
  }
}

class FakeAlerts {
  readonly alerts: { key: string; title: string }[] = [];
  alert(key: string, _level: string, title: string): void {
    this.alerts.push({ key, title });
  }
}

let telegram: FakeTelegramGateway;
let queues: FakeQueues;
let alerts: FakeAlerts;
let processors: Processors;
let fixture: CatalogFixture;

/**
 * The processor under test, with everything it does not exercise stubbed.
 *
 * `{} as never` for the services this file never reaches. A real one would be a
 * dependency this suite is not about, and a `vi.fn()` for each would be fifteen
 * lines of ceremony that assert nothing.
 */
function buildProcessors(): Processors {
  return new Processors(
    {} as never, // WorkerFactory — `onModuleInit` is never called
    queues as never,
    {} as never, // OutboxRelayService
    {} as never, // NotificationService
    {} as never, // UserSettingsService
    telegram as never,
    {} as never, // ChatService
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    messaging,
    // ReleaseAnnouncementService: reached only from `onModuleInit`, which this
    // suite never calls.
    {} as never,
    invitations,
    { counter: vi.fn(), observe: vi.fn() } as never,
    {} as never, // CoinService — the nightly reconciliation is not this suite
    alerts as never,
    {} as never, // ConversationService — this suite never reaches a wizard
    // AdminTelegramService: nobody here is a moderator, so the menu carries no
    // moderation button.
    { isLinked: () => Promise.resolve(false) } as never,
  );
}

/** The private handlers, reached the way a queue would reach them. */
function dispatch(): Promise<void> {
  return (processors as unknown as { onCampaignDispatch: () => Promise<void> })
    .onCampaignDispatch()
    .then(() => undefined);
}

function sendJob(recipientId: string, campaignId: string, attemptsMade = 0): Job {
  return {
    name: JOBS.CAMPAIGN_SEND,
    data: { recipientId, campaignId },
    attemptsMade,
    opts: { attempts: 5 },
  } as unknown as Job;
}

function runSend(job: Job): Promise<void> {
  return (processors as unknown as { onCampaignSend: (job: Job) => Promise<void> }).onCampaignSend(
    job,
  );
}

async function reachableUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function confirmedCampaign(recipients: number): Promise<{ id: string; publicId: string }> {
  for (let index = 0; index < recipients; index += 1) await reachableUser();

  /**
   * A `SYSTEM` actor, which names neither an admin nor a user.
   *
   * Legal under migration 0021's three-way CHECK, and the right shape for a suite
   * about *delivery*: who authored the campaign is `MessagingAdminService`'s
   * concern and is tested there, and borrowing a staff session here would mean
   * creating an `admin_user` row for something no assertion looks at.
   */
  const campaign = await messaging.createCampaign({
    kind: 'BROADCAST',
    bodyText: 'سلام به همه',
    audience: { everyone: true },
    idempotencyKey: `worker-${String(Date.now())}-${String(Math.random())}`,
    actor: { type: 'SYSTEM' } as never,
  });

  // Confirmed directly rather than through the admin service, for the same
  // reason: the transition is what the dispatcher needs, not the permission check.
  await prisma.messageCampaign.update({
    where: { publicId: campaign.publicId },
    data: { status: 'QUEUED', confirmedAt: NOW },
  });

  const row = await prisma.messageCampaign.findUniqueOrThrow({
    where: { publicId: campaign.publicId },
    select: { id: true, publicId: true },
  });
  return row;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  telegram = new FakeTelegramGateway();
  queues = new FakeQueues();
  alerts = new FakeAlerts();
  processors = buildProcessors();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the dispatcher', () => {
  it('turns a confirmed campaign into one job per recipient', async () => {
    const campaign = await confirmedCampaign(3);

    await dispatch();

    expect(queues.enqueued).toHaveLength(3);
    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({ status: 'SENDING' });
  });

  /**
   * The first of the two idempotency layers. A dispatcher that runs twice adds the
   * same ids twice, and BullMQ ignores the second add — so the ids being identical
   * *is* the duplicate prevention.
   */
  it('produces the same job ids on a second pass', async () => {
    await confirmedCampaign(2);

    await dispatch();
    const first = queues.enqueued.map((job) => job.id);
    queues.enqueued.length = 0;
    await dispatch();

    expect(queues.enqueued.map((job) => job.id)).toEqual(first);
    expect(new Set(first).size).toBe(2);
    // Derived from the recipient row, and legal as a BullMQ id (no colons).
    for (const id of first) expect(id).toMatch(/^campaign-[A-Za-z0-9_-]+$/);
  });

  it('enqueues nothing for a paused campaign', async () => {
    const campaign = await confirmedCampaign(2);
    await dispatch();
    queues.enqueued.length = 0;

    await messaging.pause(campaign.id, 'paused by hand');
    await dispatch();

    expect(queues.enqueued).toHaveLength(0);
  });

  it('finishes a campaign once nothing is pending', async () => {
    const campaign = await confirmedCampaign(1);
    await dispatch();
    const [delivery] = await messaging.pendingDeliveries(campaign.id);
    await messaging.recordDelivery(delivery!.recipientId, { status: 'SENT' });

    await dispatch();

    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({ status: 'COMPLETED' });
  });
});

describe('one delivery', () => {
  async function firstDelivery(): Promise<{ campaignId: string; recipientId: string }> {
    const campaign = await confirmedCampaign(1);
    await dispatch();
    const [delivery] = await messaging.pendingDeliveries(campaign.id);
    return { campaignId: campaign.id, recipientId: delivery!.recipientId };
  }

  it('sends as plain text when no parse mode was chosen', async () => {
    const { campaignId, recipientId } = await firstDelivery();

    await runSend(sendJob(recipientId, campaignId));

    expect(telegram.sent).toHaveLength(1);
    // Plain, so Telegram renders the characters and there is nothing to inject.
    expect(telegram.sent[0]?.parseMode).toBeUndefined();
    expect(telegram.sent[0]?.text).toBe('سلام به همه');
  });

  it('records the Telegram message id on success', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    telegram.next = { kind: 'SENT', messageId: 4242 };

    await runSend(sendJob(recipientId, campaignId));

    await expect(
      prisma.messageRecipient.findUniqueOrThrow({ where: { id: recipientId } }),
    ).resolves.toMatchObject({ status: 'SENT', telegramMessageId: 4242 });
  });

  /**
   * The second idempotency layer. The first job resolved the row; the redelivery
   * finds it non-pending and returns without touching Telegram.
   */
  it('does nothing at all when the job is redelivered', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    await runSend(sendJob(recipientId, campaignId));

    await runSend(sendJob(recipientId, campaignId, 1));

    expect(telegram.sent).toHaveLength(1);
  });

  it('treats a blocked recipient as terminal, and does not throw', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    telegram.next = { kind: 'BLOCKED', reason: 'Forbidden: bot was blocked by the user' };

    await expect(runSend(sendJob(recipientId, campaignId))).resolves.toBeUndefined();

    await expect(
      prisma.messageRecipient.findUniqueOrThrow({ where: { id: recipientId } }),
    ).resolves.toMatchObject({ status: 'BLOCKED' });
  });

  it('throws on a retryable failure, leaving the row pending', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    telegram.next = { kind: 'RETRY', reason: 'network error reaching Telegram' };

    await expect(runSend(sendJob(recipientId, campaignId))).rejects.toThrow(/network error/);

    const row = await prisma.messageRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
  });

  /**
   * A recipient whose retries are gone must stop being `PENDING`, or the campaign
   * never finalises and the panel shows a broadcast that is permanently "sending".
   */
  it('gives up on the last attempt rather than staying pending forever', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    telegram.next = { kind: 'RETRY', reason: 'still broken' };

    await expect(runSend(sendJob(recipientId, campaignId, 4))).resolves.toBeUndefined();

    await expect(
      prisma.messageRecipient.findUniqueOrThrow({ where: { id: recipientId } }),
    ).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('refuses to deliver to a cancelled campaign, even from a queued job', async () => {
    const { campaignId, recipientId } = await firstDelivery();
    await messaging.cancel(
      (await prisma.messageCampaign.findUniqueOrThrow({ where: { id: campaignId } })).publicId,
      null,
    );

    await runSend(sendJob(recipientId, campaignId));

    expect(telegram.sent).toHaveLength(0);
  });
});

describe('the circuit breaker', () => {
  it('pauses the campaign after three consecutive rate limits, and alerts once', async () => {
    const campaign = await confirmedCampaign(4);
    await dispatch();
    const deliveries = await messaging.pendingDeliveries(campaign.id);
    telegram.next = {
      kind: 'RATE_LIMITED',
      reason: '429: Too Many Requests',
      retryAfterSeconds: 30,
    };

    for (const delivery of deliveries.slice(0, 3)) {
      await expect(runSend(sendJob(delivery.recipientId, campaign.id))).rejects.toThrow(/429/);
    }

    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({
      pauseReason: expect.stringContaining('rate limited'),
    });
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]?.key).toBe(`campaign-paused:${campaign.id}`);
    // Paused, not cancelled: the remaining audience is kept for a resume.
    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({ status: 'SENDING' });
  });

  it('a success in between clears the streak', async () => {
    const campaign = await confirmedCampaign(4);
    await dispatch();
    const deliveries = await messaging.pendingDeliveries(campaign.id);

    telegram.next = { kind: 'RATE_LIMITED', reason: '429', retryAfterSeconds: null };
    await expect(runSend(sendJob(deliveries[0]!.recipientId, campaign.id))).rejects.toThrow();
    await expect(runSend(sendJob(deliveries[1]!.recipientId, campaign.id))).rejects.toThrow();

    telegram.next = { kind: 'SENT', messageId: 7 };
    await runSend(sendJob(deliveries[2]!.recipientId, campaign.id));

    telegram.next = { kind: 'RATE_LIMITED', reason: '429', retryAfterSeconds: null };
    await expect(runSend(sendJob(deliveries[3]!.recipientId, campaign.id))).rejects.toThrow();

    // Two, then a success, then one. Never three in a row, so nothing paused.
    await expect(messaging.get(campaign.publicId)).resolves.toMatchObject({ pausedAt: null });
    expect(alerts.alerts).toHaveLength(0);
  });
});

describe('the job id helper', () => {
  it('refuses a colon, which BullMQ would reject at add time', () => {
    expect(() => jobId('campaign', 'a:b')).toThrow(/only letters/);
  });
});
