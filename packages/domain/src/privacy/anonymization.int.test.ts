import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { AnonymizationService, ANONYMOUS_DISPLAY_NAME } from './anonymization.service';

/**
 * Data-subject deletion (§8, plan §12.5 — *"must be built, not promised"*), and
 * the two properties the plan names: **no PII left, and no dangling foreign keys**.
 *
 * The difficulty is that a marketplace's history is jointly owned. A review
 * somebody wrote is part of another person's reputation; a coin ledger row is one
 * side of an accounting identity; a consent record is the evidence that consent was
 * given. So this is anonymisation, and the interesting assertions are as much about
 * what **survives** as about what goes — a test that only checked the deletions
 * would pass just as happily against a `DELETE FROM user CASCADE` that silently
 * moved somebody else's rating and erased the record of a moderation decision.
 *
 * The fixture is deliberately maximal: the user being erased is a host, a guest, a
 * reviewer, a reviewee, a reporter, a referrer and a referred user, with rows in
 * both ledgers and a consent record. Anything less and a table gets forgotten.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const anonymization = new AnonymizationService(service, clock, audit);

const DAY = 24 * 3_600_000;
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

let fixture: CatalogFixture;
/** The account being erased. */
let subjectId: string;
/** Somebody else, whose records must survive intact. */
let otherId: string;
let reviewIdBySubject: string;
let reviewIdAboutSubject: string;

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  subjectId = await createUser(prisma, 'PROFILE_COMPLETE');
  otherId = await createUser(prisma, 'PROFILE_COMPLETE');

  await prisma.userProfile.createMany({
    data: [
      {
        userId: subjectId,
        displayName: 'سارا محمدی',
        bio: 'عاشق کوه‌پیمایی و بازی رومیزی',
        gender: 'FEMALE',
        birthYear: 1993,
        cityId: fixture.tehranId,
        districtId: fixture.tehranDistrictId,
      },
      {
        userId: otherId,
        displayName: 'رضا کریمی',
        bio: 'میزبان',
        cityId: fixture.tehranId,
      },
    ],
  });

  await prisma.userInterest.createMany({
    data: [
      { userId: subjectId, interestId: fixture.boardGamesId },
      { userId: subjectId, interestId: fixture.hikingId },
      { userId: otherId, interestId: fixture.hikingId },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: subjectId,
        templateKey: 'participation.accepted',
        payload: { eventTitle: 'شب بازی' },
        dedupeKey: `notif-subject-${subjectId}`,
      },
      {
        userId: otherId,
        templateKey: 'participation.accepted',
        payload: {},
        dedupeKey: `notif-other-${otherId}`,
      },
    ],
  });

  // Consent, which M2 gave RESTRICT rather than CASCADE for exactly this reason.
  const policy = await prisma.policyVersion.create({
    data: { type: 'TERMS', version: 1, contentMd: '# شرایط', isCurrent: true },
  });
  await prisma.consent.create({
    data: { userId: subjectId, policyVersionId: policy.id, context: 'ONBOARDING' },
  });

  // Both ledgers, which are append-only by trigger and must be untouched.
  await prisma.coinLedger.create({
    data: {
      userId: subjectId,
      idempotencyKey: `onboarding:${subjectId}`,
      type: 'ONBOARDING_REWARD',
      amount: 20,
      balanceBefore: 0,
      balanceAfter: 20,
      reasonCode: 'onboarding_reward',
      actorType: 'SYSTEM',
    },
  });
  await prisma.trustScoreLedger.create({
    data: {
      userId: subjectId,
      idempotencyKey: `trust-init:${subjectId}`,
      type: 'ADMIN_ADJUSTMENT',
      delta: 5,
      scoreBefore: 50,
      scoreAfter: 55,
      reasonCode: 'manual',
      algoVersion: 1,
      actorType: 'SYSTEM',
    },
  });

  // A referral in each direction: the subject referred somebody, and was referred.
  const thirdId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.user.update({ where: { id: subjectId }, data: { referralCode: 'SARA123' } });
  await prisma.referral.createMany({
    data: [
      {
        referrerUserId: subjectId,
        referredUserId: otherId,
        code: 'SARA123',
        status: 'QUALIFIED',
        qualifiedAt: daysAgo(5),
      },
      {
        referrerUserId: thirdId,
        referredUserId: subjectId,
        code: 'THIRD99',
        status: 'QUALIFIED',
        qualifiedAt: daysAgo(20),
      },
    ],
  });

  // An event the subject hosted, with the other user as a guest, and a review in
  // each direction — so the subject is a reviewer *and* a reviewee.
  const event = await prisma.event.create({
    data: {
      hostUserId: subjectId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date('2026-08-10T15:00:00.000Z'),
      endsAt: new Date('2026-08-10T18:00:00.000Z'),
      capacity: 5,
      costType: 'FREE',
      status: 'COMPLETED',
      moderationStatus: 'APPROVED',
    },
  });

  const [guestParticipant, hostParticipant] = await Promise.all([
    prisma.eventParticipant.create({
      data: {
        eventId: event.id,
        userId: otherId,
        status: 'ACCEPTED',
        acceptedAt: daysAgo(6),
        decidedAt: daysAgo(6),
        attended: true,
      },
    }),
    prisma.eventParticipant.create({
      data: {
        eventId: event.id,
        userId: subjectId,
        status: 'ACCEPTED',
        acceptedAt: daysAgo(6),
        decidedAt: daysAgo(6),
        attended: true,
      },
    }),
  ]);

  const [written, received] = await Promise.all([
    prisma.review.create({
      data: {
        eventId: event.id,
        participantId: hostParticipant.id,
        reviewerUserId: subjectId,
        revieweeUserId: otherId,
        rating: 2,
        comment: 'دیر آمد و بی‌ادب بود',
        editDeadlineAt: NOW,
      },
    }),
    prisma.review.create({
      data: {
        eventId: event.id,
        participantId: guestParticipant.id,
        reviewerUserId: otherId,
        revieweeUserId: subjectId,
        rating: 5,
        comment: 'میزبان فوق‌العاده‌ای بود',
        editDeadlineAt: NOW,
      },
    }),
  ]);
  reviewIdBySubject = written.id;
  reviewIdAboutSubject = received.id;

  await prisma.report.create({
    data: {
      targetType: 'USER',
      targetId: otherId,
      reporterUserId: subjectId,
      reason: 'HARASSMENT',
      description: 'در چت پیام‌های آزاردهنده فرستاد',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('what is erased', () => {
  it('leaves no residual PII at all', async () => {
    await anonymization.anonymize(subjectId);

    expect(await anonymization.findResidualPii(subjectId)).toEqual([]);
  });

  /**
   * The Telegram link goes **entirely**, not hashed. It is the identifier §3.6
   * builds five layers around, and a hashed Telegram id is still a Telegram id to
   * anybody holding the original.
   */
  it('deletes the telegram account outright', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.telegramAccount.count({ where: { userId: subjectId } })).toBe(0);
  });

  it('deletes interests and notifications', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.userInterest.count({ where: { userId: subjectId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: subjectId } })).toBe(0);
  });

  /**
   * Blanked, not deleted: `user_profile` is what a participant list and a review
   * page read to render a name, and a missing row would turn every one of those
   * into a null check nobody wrote.
   */
  it('blanks the profile in place rather than removing the row', async () => {
    await anonymization.anonymize(subjectId);

    const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId: subjectId } });
    expect(profile).toMatchObject({
      displayName: ANONYMOUS_DISPLAY_NAME,
      bio: null,
      gender: null,
      birthYear: null,
      districtId: null,
    });
  });

  it('clears the referral code so it stops working', async () => {
    await anonymization.anonymize(subjectId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: subjectId } });
    expect(user.referralCode).toBeNull();
    expect(user.status).toBe('DELETED');
    expect(user.deletedAt).toEqual(NOW);
  });

  it('reports how much free text it removed', async () => {
    const result = await anonymization.anonymize(subjectId);

    expect(result).toEqual({ userId: subjectId, redactedReviews: 1, redactedReports: 1 });
  });
});

/**
 * The half a naive implementation gets wrong. Every assertion here fails against a
 * cascading delete, and every one of them protects somebody who is not the person
 * asking to be forgotten.
 */
describe('what survives, because it is not only theirs', () => {
  it('keeps the rating the subject wrote and removes only the words', async () => {
    await anonymization.anonymize(subjectId);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewIdBySubject } });
    expect(review.comment).toBeNull();
    // The rating belongs to the person reviewed. Erasing it would silently move
    // somebody else's reputation.
    expect(review.rating).toBe(2);
    expect(review.revieweeUserId).toBe(otherId);
  });

  it('leaves reviews *about* the subject completely untouched', async () => {
    await anonymization.anonymize(subjectId);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewIdAboutSubject } });
    expect(review.comment).toBe('میزبان فوق‌العاده‌ای بود');
    expect(review.rating).toBe(5);
  });

  /**
   * A moderation decision that cites vanishing evidence is not reviewable, so the
   * report row stays and only the reporter's own writing goes.
   */
  it('keeps the report and removes its description', async () => {
    await anonymization.anonymize(subjectId);

    const report = await prisma.report.findFirstOrThrow({
      where: { reporterUserId: subjectId },
    });
    expect(report.description).toBeNull();
    expect(report.reason).toBe('HARASSMENT');
    expect(report.targetId).toBe(otherId);
  });

  it('leaves both ledgers exactly as they were', async () => {
    const before = await Promise.all([
      prisma.coinLedger.findMany({ where: { userId: subjectId } }),
      prisma.trustScoreLedger.findMany({ where: { userId: subjectId } }),
    ]);

    await anonymization.anonymize(subjectId);

    expect(
      await Promise.all([
        prisma.coinLedger.findMany({ where: { userId: subjectId } }),
        prisma.trustScoreLedger.findMany({ where: { userId: subjectId } }),
      ]),
    ).toEqual(before);
  });

  /**
   * M2 chose RESTRICT over CASCADE on `consent` with this in the comment: "account
   * deletion anonymises; it must not erase the record that consent was given."
   */
  it('keeps the consent record', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.consent.count({ where: { userId: subjectId } })).toBe(1);
  });

  /**
   * Each referral row is half of somebody else's reward. Deleting them would make a
   * paid-out referral unaccountable in both directions.
   */
  it('keeps referrals the subject made and received', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.referral.count({ where: { referrerUserId: subjectId } })).toBe(1);
    expect(await prisma.referral.count({ where: { referredUserId: subjectId } })).toBe(1);
  });

  it('keeps the events they hosted and the participations they made', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.event.count({ where: { hostUserId: subjectId } })).toBe(1);
    expect(await prisma.eventParticipant.count({ where: { userId: subjectId } })).toBe(1);
  });
});

describe('no dangling foreign keys', () => {
  /**
   * The plan's second named property, checked against the database's own catalog
   * rather than against a list somebody maintained by hand: **every** foreign key in
   * the schema, walked, looking for a child row whose parent is missing.
   *
   * Written this way because the failure mode is a table added in a later milestone
   * that nobody remembered to think about here — and a hand-written list would still
   * pass green on the day that happens.
   *
   * The per-constraint count is built by Postgres, not by JavaScript. `format`
   * quotes the identifiers it takes from `pg_catalog` and `query_to_xml` runs the
   * result, which keeps the whole thing inside one tagged `$queryRaw` with nothing
   * interpolated from this side — `$queryRawUnsafe` with a template literal would
   * read exactly like the injection pattern CI greps for (T10), and "it was only a
   * catalog name" is what the next person to copy it will also believe.
   */
  it('leaves every foreign key in the schema satisfied', async () => {
    await anonymization.anonymize(subjectId);

    const constraints = await prisma.$queryRaw<
      { child: string; parent: string; child_col: string; key_width: number; orphans: bigint }[]
    >`
      WITH fk AS (
        SELECT
          con.conrelid::regclass::text AS child,
          con.confrelid::regclass::text AS parent,
          (SELECT att.attname FROM pg_attribute att
            WHERE att.attrelid = con.conrelid AND att.attnum = con.conkey[1]) AS child_col,
          (SELECT att.attname FROM pg_attribute att
            WHERE att.attrelid = con.confrelid AND att.attnum = con.confkey[1]) AS parent_col,
          array_length(con.conkey, 1) AS key_width
        FROM pg_constraint con
        JOIN pg_class cls ON cls.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE con.contype = 'f' AND ns.nspname = 'public'
      )
      SELECT
        fk.child, fk.parent, fk.child_col, fk.key_width,
        (xpath('/row/c/text()', query_to_xml(
          format(
            'SELECT COUNT(*) AS c FROM %s ch WHERE ch.%I IS NOT NULL AND NOT EXISTS ' ||
            '(SELECT 1 FROM %s pa WHERE pa.%I = ch.%I)',
            fk.child, fk.child_col, fk.parent, fk.parent_col, fk.child_col
          ), false, true, '')))[1]::text::bigint AS orphans
      FROM fk
    `;

    // A sanity check on the walk itself: a query that matched nothing would report
    // no orphans just as cheerfully.
    expect(constraints.length).toBeGreaterThan(20);
    // Composite keys would need a wider comparison; the schema has none, and this
    // asserts that rather than quietly checking only their first column.
    expect(constraints.filter((row) => row.key_width !== 1)).toEqual([]);

    expect(
      constraints
        .filter((row) => Number(row.orphans) > 0)
        .map((row) => `${row.child}.${row.child_col} -> ${row.parent}`),
    ).toEqual([]);
  });

  /** The user row itself has to survive; everything above points at it. */
  it('keeps the user row', async () => {
    await anonymization.anonymize(subjectId);

    expect(await prisma.user.findUnique({ where: { id: subjectId } })).not.toBeNull();
  });
});

describe('running it twice', () => {
  /**
   * This will be reached from a job, and a job that cannot be re-run is a job nobody
   * dares re-run.
   */
  it('is idempotent', async () => {
    await anonymization.anonymize(subjectId);
    const second = await anonymization.anonymize(subjectId);

    expect(second.redactedReviews).toBe(0);
    expect(second.redactedReports).toBe(0);
    expect(await anonymization.findResidualPii(subjectId)).toEqual([]);
  });
});

describe('the audit trail', () => {
  it('records the anonymisation with counts and never with content', async () => {
    await anonymization.anonymize(subjectId);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.anonymized', targetId: subjectId },
    });

    expect(entry.after).toMatchObject({ status: 'DELETED', redactedReviews: 1 });
    // An audit row that quoted the text it removed would be a copy of the thing
    // being deleted (T15).
    expect(JSON.stringify(entry)).not.toContain('دیر آمد');
    expect(JSON.stringify(entry)).not.toContain('سارا محمدی');
  });

  it('attributes it to an admin when one asked for it', async () => {
    const admin = await prisma.adminUser.create({
      data: {
        email: 'support@payetam.test',
        passwordHash: 'x',
        totpSecretEnc: 'x',
        displayName: 'پشتیبانی',
      },
    });

    await anonymization.anonymize(subjectId, admin.id);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.anonymized', targetId: subjectId },
    });
    expect(entry.actorType).toBe('ADMIN');
    expect(entry.actorId).toBe(admin.id);
  });
});

describe('an account that does not exist', () => {
  it('is refused rather than silently succeeding', async () => {
    await expect(
      anonymization.anonymize('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
