import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { ReferralService } from '../economy/referral.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { ROLE_KEYS } from './permissions';
import { ReferralAdminService } from './referral-admin.service';

/**
 * Rejecting a referral, against a real database (M19, T6).
 *
 * The state this exercises has existed in the enum since M9 and was written by
 * nothing. What makes it worth a suite of its own is not the column — it is the
 * three refusals the state machine encodes, each of which protects a different
 * thing:
 *
 *  - a `QUALIFIED` referral cannot be rejected, because two `coin_ledger` rows
 *    already say it paid and the ledger is append-only;
 *  - a reinstated referral is `PENDING` and **not** paid, because the reward
 *    still has to be earned;
 *  - a rejected referral cannot be paid by the settlement path, however many
 *    times attendance is settled.
 *
 * The last one is the reason the feature exists at all, so it is asserted by
 * *running the settlement*, not by reading the status.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const admin = new ReferralAdminService(service, clock, access, audit);
const referrals = new ReferralService(
  service,
  clock,
  settings,
  coins,
  audit,
  new MetricsRegistry(),
);

let MODERATOR: AdminSession;
let referrer: string;
let referred: string;

/**
 * A real `admin_user` row, because `referral.rejected_by_admin_id` is a real
 * foreign key. Inserted directly so this suite still needs no roles, no Redis
 * and no TOTP.
 */
async function seedAdmin(): Promise<AdminSession> {
  const row = await prisma.adminUser.create({
    data: {
      email: 'fraud@payetam.test',
      passwordHash: 'not-used',
      totpSecretEnc: 'not-used',
      displayName: 'ناظر',
    },
    select: { id: true },
  });
  return {
    adminUserId: row.id,
    email: 'fraud@payetam.test',
    displayName: 'ناظر',
    roles: [ROLE_KEYS.MODERATOR],
    permissions: permissionsFor([ROLE_KEYS.MODERATOR]),
  };
}

/** A claimed referral, which is what every case below starts from. */
async function claim(): Promise<string> {
  await referrals.summaryFor(referrer);
  const { referralCode } = await prisma.user.findUniqueOrThrow({
    where: { id: referrer },
    select: { referralCode: true },
  });
  await referrals.claim(referred, referralCode ?? '');
  const row = await prisma.referral.findUniqueOrThrow({
    where: { referredUserId: referred },
    select: { id: true },
  });
  return row.id;
}

/** An attended event, which is the only thing that makes a referral pay. */
async function attend(userId: string): Promise<void> {
  const host = await createUser(prisma, 'PROFILE_COMPLETE');
  const city = await prisma.city.create({
    data: { slug: `city-${String(Date.now())}-${String(Math.random())}`, nameFa: 'تهران' },
  });
  const category = await prisma.category.create({
    data: { slug: `cat-${String(Date.now())}-${String(Math.random())}`, nameFa: 'کافه' },
  });
  const event = await prisma.event.create({
    data: {
      hostUserId: host,
      title: 'دورهمی',
      description: 'یک برنامهٔ دوستانه.',
      titleNormalized: 'دورهمی',
      descriptionNormalized: 'یک برنامهٔ دوستانه',
      categoryId: category.id,
      cityId: city.id,
      startsAt: new Date(NOW.getTime() - 7 * 86_400_000),
      endsAt: new Date(NOW.getTime() - 7 * 86_400_000 + 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'COMPLETED',
      moderationStatus: 'APPROVED',
    },
    select: { id: true },
  });
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId, status: 'COMPLETED', requestedAt: NOW },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  MODERATOR = await seedAdmin();
  referrer = await createUser(prisma, 'PROFILE_COMPLETE');
  referred = await createUser(prisma, 'PROFILE_COMPLETE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rejecting a referral', () => {
  it('records the reason, the note and who signed it', async () => {
    const id = await claim();

    const rejected = await admin.reject(MODERATOR, id, {
      reason: 'FRAUD',
      note: 'Ten referrals in an hour, all from one device fingerprint.',
    });

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('FRAUD');
    expect(rejected.rejectedAt).toEqual(NOW);

    const row = await prisma.referral.findUniqueOrThrow({ where: { id } });
    expect(row.rejectedByAdminId).toBe(MODERATOR.adminUserId);
    expect(row.reviewNote).toContain('device fingerprint');
  });

  it('writes an audit row with what it was before', async () => {
    const id = await claim();

    await admin.reject(MODERATOR, id, { reason: 'ADMIN_DECISION', note: 'Duplicate household.' });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'referral.rejected', targetId: id },
    });
    expect(entry.before).toMatchObject({ status: 'PENDING' });
    expect(entry.after).toMatchObject({ status: 'REJECTED', reason: 'ADMIN_DECISION' });
    expect(entry.actorId).toBe(MODERATOR.adminUserId);
  });

  /**
   * The whole feature, asserted by running the thing it protects against rather
   * than by reading a column: `qualifyForAttendance` checks the condition itself
   * and pays whoever qualifies, so a rejected referral that still paid would be a
   * silent economic bug rather than a visible one.
   */
  it('cannot pay, however many times attendance is settled', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Confirmed farm account.' });

    await attend(referred);
    expect(await referrals.qualifyForAttendance(referred)).toBe(false);
    expect(await referrals.qualifyForAttendance(referred)).toBe(false);

    expect(await coins.balanceOf(referrer)).toBe(0);
    expect(await coins.balanceOf(referred)).toBe(0);
    expect(await prisma.coinLedger.count({ where: { type: 'REFERRAL_REWARD' } })).toBe(0);
    const row = await prisma.referral.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('REJECTED');
  });

  /**
   * A qualified referral has already produced two ledger rows and the ledger is
   * append-only (invariant 3). A status saying "rejected" over them would be a
   * record disagreeing with itself, so the state machine refuses the edge.
   * Clawing coins back is `CoinService.reverse` — a separate, deliberate act.
   */
  it('refuses a referral that has already paid', async () => {
    const id = await claim();
    await attend(referred);
    expect(await referrals.qualifyForAttendance(referred)).toBe(true);

    await expect(
      admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Found out too late.' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    expect(await coins.balanceOf(referrer)).toBe(30);
  });

  it('refuses a rejection nobody explained', async () => {
    const id = await claim();

    await expect(
      admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'no' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const row = await prisma.referral.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
  });

  it('refuses to reject the same referral twice', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Confirmed farm account.' });

    await expect(
      admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Confirmed farm account.' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('refuses a referral that does not exist', async () => {
    await expect(
      admin.reject(MODERATOR, '00000000-0000-4000-8000-000000000000', {
        reason: 'FRAUD',
        note: 'Nothing to reject.',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('reinstating a referral', () => {
  /**
   * A rejection is a judgement, so it has to be reversible. What it must not be
   * is a payment: reinstating restores `PENDING`, and the referral then earns its
   * reward the ordinary way.
   */
  it('restores eligibility and pays nobody by itself', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Looked like a farm.' });

    const back = await admin.reinstate(MODERATOR, id, 'Manual review cleared this one.');

    expect(back.status).toBe('PENDING');
    expect(back.rejectionReason).toBeNull();
    expect(back.rejectedAt).toBeNull();
    expect(await coins.balanceOf(referrer)).toBe(0);
  });

  it('lets the restored referral qualify the ordinary way', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Looked like a farm.' });
    await admin.reinstate(MODERATOR, id, 'Manual review cleared this one.');

    await attend(referred);
    expect(await referrals.qualifyForAttendance(referred)).toBe(true);

    expect(await coins.balanceOf(referrer)).toBe(30);
    expect(await coins.balanceOf(referred)).toBe(10);
  });

  it('refuses to reinstate one that was never rejected', async () => {
    const id = await claim();

    await expect(admin.reinstate(MODERATOR, id, 'Nothing to undo here.')).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('records the reinstatement, including what it was rejected for', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'INELIGIBLE', note: 'Account was deleted.' });

    await admin.reinstate(MODERATOR, id, 'The account was restored.');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'referral.reinstated', targetId: id },
    });
    expect(entry.before).toMatchObject({ status: 'REJECTED', reason: 'INELIGIBLE' });
    expect(entry.after).toMatchObject({ status: 'PENDING' });
  });
});

describe('the review queue', () => {
  it('shows both parties by public id and neither by name', async () => {
    await prisma.userProfile.create({
      data: {
        userId: referrer,
        displayName: 'کاربر معرف',
        cityId: (await prisma.city.create({ data: { slug: 'tehran-q', nameFa: 'تهران' } })).id,
        birthYear: 1995,
      },
    });
    await claim();

    const { referrals: rows, total } = await admin.list(MODERATOR);

    expect(total).toBe(1);
    expect(rows[0]?.referrerPublicId).toBeTypeOf('string');
    // Reviewing a referral for fraud is a question about behaviour. A name
    // answers none of it and puts a profile on a screen with no reason for one.
    expect(JSON.stringify(rows)).not.toContain('کاربر معرف');
  });

  it('filters by state, so the rejected ones stay findable', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Confirmed farm account.' });

    await expect(admin.list(MODERATOR, { status: 'REJECTED' })).resolves.toMatchObject({
      total: 1,
    });
    await expect(admin.list(MODERATOR, { status: 'PENDING' })).resolves.toMatchObject({
      total: 0,
    });
  });

  /**
   * The queue a moderator actually works. The overwhelming majority of referrals
   * carry no signals, which is what makes a non-null `fraud_signals` mean
   * something when somebody goes looking (T6).
   */
  it('can show only the ones a signal fired on', async () => {
    await claim();

    await expect(admin.list(MODERATOR, { flaggedOnly: true })).resolves.toMatchObject({
      total: 0,
    });

    await prisma.referral.updateMany({
      data: { fraudSignals: { reason: 'velocity', recentReferrals: 12 } },
    });

    const flagged = await admin.list(MODERATOR, { flaggedOnly: true });
    expect(flagged.total).toBe(1);
    expect(flagged.referrals[0]?.flagged).toBe(true);
    expect(flagged.referrals[0]?.fraudSignals).toMatchObject({ reason: 'velocity' });
  });

  it('matches nothing for a referrer who does not exist', async () => {
    await claim();

    await expect(
      admin.list(MODERATOR, { referrerPublicId: '00000000-0000-4000-8000-000000000000' }),
    ).resolves.toEqual({ referrals: [], total: 0 });
  });
});

describe('what the referred user is told', () => {
  /**
   * A status and no reason. Naming the signal that fired to the person it fired
   * on is telling a farmer what to change (T6) — and «در انتظار» over a referral
   * that will never pay is the untruth this replaced.
   */
  it('reports the rejection without explaining it', async () => {
    const id = await claim();
    await admin.reject(MODERATOR, id, { reason: 'FRAUD', note: 'Confirmed farm account.' });

    const summary = await referrals.summaryFor(referred);

    expect(summary.referredBy).toEqual({ status: 'REJECTED', qualified: false });
    expect(JSON.stringify(summary)).not.toContain('FRAUD');
    expect(JSON.stringify(summary)).not.toContain('farm account');
  });

  it('still says pending while it is pending', async () => {
    await claim();

    await expect(referrals.summaryFor(referred)).resolves.toMatchObject({
      referredBy: { status: 'PENDING', qualified: false },
    });
  });
});
