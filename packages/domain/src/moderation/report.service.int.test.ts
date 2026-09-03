import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { OutboxService } from '../outbox/outbox.service';
import { ReportService } from './report.service';

/**
 * Reports and the threshold that acts on them (M12, plan §11).
 *
 * The plan asks for the threshold "tested at 2 and 4" as well as at 3, and that is
 * the interesting part: the boundary is where an off-by-one either hides an event
 * two people disliked, or lets a fourth report be the one that finally works.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const reports = new ReportService(service, clock, settings, audit, outbox);

let fixture: CatalogFixture;
let hostId: string;
let hostPublicId: string;

async function createProfiledUser(): Promise<{ id: string; publicId: string }> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { id: userId, publicId: user.publicId };
}

async function publishEvent(): Promise<string> {
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date('2026-09-20T15:00:00.000Z'),
      endsAt: new Date('2026-09-20T18:00:00.000Z'),
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

/** `count` different people each report the same event once. */
async function reportedBy(eventPublicId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const reporter = await createProfiledUser();
    await reports.file(reporter.id, {
      targetType: 'EVENT',
      targetPublicId: eventPublicId,
      reason: 'SPAM',
    });
  }
}

async function statusOf(publicId: string): Promise<string> {
  const row = await prisma.event.findUniqueOrThrow({
    where: { publicId },
    select: { status: true },
  });
  return row.status;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  const host = await createProfiledUser();
  hostId = host.id;
  hostPublicId = host.publicId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('one report per person per thing (invariant 5)', () => {
  it('refuses a second report from the same person', async () => {
    const eventPublicId = await publishEvent();
    const reporter = await createProfiledUser();

    await reports.file(reporter.id, {
      targetType: 'EVENT',
      targetPublicId: eventPublicId,
      reason: 'SPAM',
    });

    await expect(
      reports.file(reporter.id, {
        targetType: 'EVENT',
        targetPublicId: eventPublicId,
        reason: 'HARASSMENT',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_REPORTED' });
  });

  /** The service check is one refactor from being skipped; this is not. */
  it('is refused by the database too', async () => {
    const eventPublicId = await publishEvent();
    const reporter = await createProfiledUser();
    await reports.file(reporter.id, {
      targetType: 'EVENT',
      targetPublicId: eventPublicId,
      reason: 'SPAM',
    });

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true },
    });

    await expect(
      prisma.report.create({
        data: {
          targetType: 'EVENT',
          targetId: event.id,
          reporterUserId: reporter.id,
          reason: 'SCAM',
        },
      }),
    ).rejects.toThrow(/target_type.*target_id.*reporter_user_id/s);
  });

  it('lets the same person report two different things', async () => {
    const first = await publishEvent();
    const second = await publishEvent();
    const reporter = await createProfiledUser();

    await reports.file(reporter.id, {
      targetType: 'EVENT',
      targetPublicId: first,
      reason: 'SPAM',
    });
    await expect(
      reports.file(reporter.id, {
        targetType: 'EVENT',
        targetPublicId: second,
        reason: 'SPAM',
      }),
    ).resolves.toMatchObject({ status: 'OPEN' });
  });

  /** Inflating a count towards your own threshold is not a thing anybody may do. */
  it('refuses somebody reporting their own event', async () => {
    const eventPublicId = await publishEvent();

    await expect(
      reports.file(hostId, {
        targetType: 'EVENT',
        targetPublicId: eventPublicId,
        reason: 'SPAM',
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_REPORT_OWN_CONTENT' });
  });
});

describe('the threshold (plan §11: three distinct reporters)', () => {
  it('leaves an event visible at two', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 2);

    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');
    await expect(prisma.moderationCase.count()).resolves.toBe(0);
  });

  it('hides it and opens a case at exactly three', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 3);

    await expect(statusOf(eventPublicId)).resolves.toBe('HIDDEN');

    const opened = await prisma.moderationCase.findFirstOrThrow();
    expect(opened).toMatchObject({
      subjectType: 'EVENT',
      trigger: 'REPORT_THRESHOLD',
      status: 'OPEN',
      reportCount: 3,
    });
  });

  /**
   * A fourth report updates the case that exists rather than opening another.
   * A queue holding three cases about one event is a queue three people work in
   * parallel.
   */
  it('opens no second case at four, and keeps the count current', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 4);

    await expect(prisma.moderationCase.count()).resolves.toBe(1);
    const opened = await prisma.moderationCase.findFirstOrThrow();
    expect(opened.reportCount).toBe(4);
  });

  /**
   * The report as an operator described it: **four different accounts, one
   * activity**, and the expectation that it goes out of sight.
   *
   * The three tests above already cover the mechanism at 2, 3 and 4. This one
   * exists because the mechanism was *reported as not working in production*, and
   * a test named after the scenario is what a future reader will look for when it
   * is reported again.
   */
  it('hides an activity four different accounts reported', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 4);

    await expect(statusOf(eventPublicId)).resolves.toBe('HIDDEN');
    await expect(
      prisma.moderationCase.count({ where: { status: 'OPEN', trigger: 'REPORT_THRESHOLD' } }),
    ).resolves.toBe(1);
  });

  /**
   * The production incident, as its rows actually were (v0.7.0).
   *
   * Four reports, four distinct reporters, **two already `ACTIONED`** — and the
   * activity stayed visible, because the threshold counted only the reports
   * nobody had touched. The filter was subtracting *agreement*: `ACTIONED` means
   * a moderator looked and decided the complaint was right, and it was the one
   * status that pushed the threshold further away.
   */
  it('counts a complaint a moderator agreed with, not only an untouched one', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 2);
    await prisma.report.updateMany({ data: { status: 'ACTIONED' } });
    // Back to visible, as a moderator restoring it would leave it. Two people
    // have objected and a third has not yet, so nothing is due to happen.
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { status: 'PUBLISHED' },
    });
    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');

    await reportedBy(eventPublicId, 1);

    /**
     * Two actioned plus one fresh is three people who objected, and three is the
     * threshold.
     *
     * Under the old `status: 'OPEN'` filter this same third report counted **one**
     * — a moderator having worked the first two took them out of the sum — and
     * the activity stayed visible however many more arrived. That is the reported
     * bug, in one assertion.
     */
    await expect(statusOf(eventPublicId)).resolves.toBe('HIDDEN');
  });

  /**
   * And the opposite case, which is why `DISMISSED` is the one status excluded.
   *
   * Deciding a case `APPROVED` marks its reports dismissed. A restored activity
   * therefore starts from zero and needs three *fresh* objections — which is what
   * "a moderator cleared it" has to mean, or three refuted complaints would hide
   * it again the moment a fourth arrived.
   */
  it('starts from zero again once a moderator has cleared the complaints', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 3);
    await expect(statusOf(eventPublicId)).resolves.toBe('HIDDEN');

    await prisma.report.updateMany({ data: { status: 'DISMISSED' } });
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { status: 'PUBLISHED' },
    });

    await reportedBy(eventPublicId, 2);
    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');
  });

  /**
   * One determined person is not three people.
   *
   * The threshold counts rows, and rows mean *reporters* only because of
   * `UNIQUE (target_type, target_id, reporter_user_id)`. Without that index this
   * test is how somebody discovers they can hide a rival's activity alone.
   */
  it('cannot be reached by one account reporting three times', async () => {
    const eventPublicId = await publishEvent();
    const persistent = await createProfiledUser();

    await reports.file(persistent.id, {
      targetType: 'EVENT',
      targetPublicId: eventPublicId,
      reason: 'SPAM',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        reports.file(persistent.id, {
          targetType: 'EVENT',
          targetPublicId: eventPublicId,
          reason: 'SPAM',
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_REPORTED' });
    }

    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');
    await expect(prisma.report.count()).resolves.toBe(1);
  });

  /**
   * Reporting the **host** is a different subject, and does not move the
   * activity's count.
   *
   * Worth pinning because the bot offers «گزارش فعالیت» and «گزارش میزبان» side
   * by side, so four people objecting to one evening can easily be two of each —
   * and neither target reaches three. That is correct (they are complaints about
   * different things) and it is the most likely reading of an activity that "was
   * reported four times and nothing happened".
   */
  it('counts a report against the host separately from one against the activity', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 2);

    const host = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { host: { select: { publicId: true } } },
    });
    const other = await createProfiledUser();
    const another = await createProfiledUser();
    for (const reporter of [other, another]) {
      await reports.file(reporter.id, {
        targetType: 'USER',
        targetPublicId: host.host.publicId,
        reason: 'HARASSMENT',
      });
    }

    // Four complaints, two subjects, neither at three.
    await expect(prisma.report.count()).resolves.toBe(4);
    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');
    await expect(prisma.moderationCase.count()).resolves.toBe(0);
  });

  it('reads the threshold from config, so tuning it needs no deploy', async () => {
    await prisma.appSetting.create({ data: { key: 'moderation.report_threshold', value: 2 } });
    const eventPublicId = await publishEvent();

    await reportedBy(eventPublicId, 1);
    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');

    await reportedBy(eventPublicId, 1);
    await expect(statusOf(eventPublicId)).resolves.toBe('HIDDEN');
  });

  it('tells the reporter whether theirs was the one that triggered review', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 2);

    const third = await createProfiledUser();
    const filed = await reports.file(third.id, {
      targetType: 'EVENT',
      targetPublicId: eventPublicId,
      reason: 'SPAM',
    });

    expect(filed.triggeredReview).toBe(true);
  });

  it('attaches every report to the case, including the ones filed before it', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 3);

    const unattached = await prisma.report.count({ where: { moderationCaseId: null } });
    expect(unattached).toBe(0);
  });
});

/**
 * The notification the plan singles out: *"the owner is notified **without any
 * reporter identity**"*.
 *
 * A notification that named the reporter would make reporting an act with a
 * personal cost, which is how a reporting system stops being used at exactly the
 * moment it is needed.
 */
describe('what the owner is told', () => {
  it('emits one event naming the owner and the count, and no reporter', async () => {
    const eventPublicId = await publishEvent();

    const reporters: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reporter = await createProfiledUser();
      reporters.push(reporter.publicId);
      await reports.file(reporter.id, {
        targetType: 'EVENT',
        targetPublicId: eventPublicId,
        reason: 'SPAM',
      });
    }

    const emitted = await prisma.outboxEvent.findMany({
      where: { eventType: 'moderation.content_hidden' },
    });
    expect(emitted).toHaveLength(1);

    const payload = JSON.stringify(emitted[0]?.payload);
    expect(payload).toContain(hostPublicId);
    expect(payload).toContain(eventPublicId);
    for (const reporter of reporters) {
      expect(payload, 'a reporter must never be named').not.toContain(reporter);
    }
  });

  it('says nothing at all below the threshold', async () => {
    const eventPublicId = await publishEvent();
    await reportedBy(eventPublicId, 2);

    await expect(
      prisma.outboxEvent.count({ where: { eventType: 'moderation.content_hidden' } }),
    ).resolves.toBe(0);
  });

  /**
   * Telling one side of an anonymous chat that the other reported them is the
   * single notification this module must never send.
   */
  it('notifies nobody when a conversation is reported', async () => {
    const guest = await createProfiledUser();
    const eventPublicId = await publishEvent();
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true },
    });
    const participant = await prisma.eventParticipant.create({
      data: { eventId: event.id, userId: guest.id, status: 'PENDING' },
      select: { id: true },
    });
    const chat = await prisma.anonymousChat.create({
      data: { eventId: event.id, participantId: participant.id, status: 'ANONYMOUS' },
      select: { publicId: true },
    });

    for (let index = 0; index < 3; index += 1) {
      const reporter = await createProfiledUser();
      await reports.file(reporter.id, {
        targetType: 'MESSAGE',
        targetPublicId: chat.publicId,
        reason: 'HARASSMENT',
      });
    }

    // A case, so break-glass has something to require — and no notification.
    await expect(prisma.moderationCase.count({ where: { subjectType: 'MESSAGE' } })).resolves.toBe(
      1,
    );
    await expect(
      prisma.outboxEvent.count({ where: { eventType: 'moderation.content_hidden' } }),
    ).resolves.toBe(0);
  });
});
