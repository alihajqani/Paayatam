import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, PiiHasher, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ConsentService } from '../identity/consent.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { PolicyAdminService } from './policy-admin.service';
import { ROLE_KEYS } from './permissions';

/**
 * Authoring, publishing and accepting legal text (M22 phase 8).
 *
 * Three of the properties here are the *database's* and cannot be shown any other
 * way: the partial unique index that permits one current version per type, the
 * append-only trigger on `consent`, and the conditional UPDATE that makes an
 * optimistic-concurrency token mean something under two concurrent writers.
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
const pii = new PiiHasher({ PII_HASH_PEPPER: TEST_CHAT_ENCRYPTION_KEY } as never);
const consent = new ConsentService(service, clock, pii);
const policies = new PolicyAdminService(service, clock, access, audit);

/**
 * A real `admin_user` row, because `policy_version.created_by_admin_id` is a
 * foreign key — a synthetic session id would fail on the constraint rather than on
 * anything this suite is about.
 */
let ALL: AdminSession;

const CONTENT = 'ماده ۱. '.repeat(20);

async function draftTerms(overrides: { contentMd?: string } = {}) {
  return policies.createDraft(ALL, {
    type: 'TERMS',
    titleFa: 'قوانین استفاده',
    contentMd: overrides.contentMd ?? CONTENT,
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);

  const row = await prisma.adminUser.create({
    data: {
      email: 'super@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'مدیر ارشد',
    },
    select: { id: true },
  });

  ALL = {
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

describe('PolicyAdminService — drafting', () => {
  it('allocates the next version number itself', async () => {
    const first = await draftTerms();
    expect(first.version).toBe(1);
    expect(first.status).toBe('DRAFT');
    expect(first.isCurrent).toBe(false);

    await policies.publish(ALL, first.id, { confirmVersion: 1, reason: 'انتشار اول' });
    const second = await draftTerms();

    expect(second.version).toBe(2);
  });

  it('refuses a second open draft of the same type', async () => {
    await draftTerms();

    await expect(draftTerms()).rejects.toMatchObject({ code: 'POLICY_DRAFT_EXISTS' });
  });

  it('allows a draft of a different type alongside one', async () => {
    await draftTerms();

    await expect(
      policies.createDraft(ALL, {
        type: 'PRIVACY',
        titleFa: 'حریم خصوصی',
        contentMd: CONTENT,
      }),
    ).resolves.toMatchObject({ type: 'PRIVACY', version: 1 });
  });

  it('refuses an edit whose revision has moved on', async () => {
    const draft = await draftTerms();

    await policies.updateDraft(ALL, draft.id, {
      expectedRevision: draft.revision,
      titleFa: 'ویرایش یکم',
    });

    // The second writer still holds the revision they read.
    await expect(
      policies.updateDraft(ALL, draft.id, {
        expectedRevision: draft.revision,
        titleFa: 'ویرایش دوم',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_STALE_VERSION' });

    await expect(policies.get(ALL, draft.id)).resolves.toMatchObject({ titleFa: 'ویرایش یکم' });
  });
});

describe('PolicyAdminService — publishing', () => {
  it('requires the version to be typed back', async () => {
    const draft = await draftTerms();

    await expect(
      policies.publish(ALL, draft.id, { confirmVersion: 99, reason: 'انتشار' }),
    ).rejects.toMatchObject({ code: 'POLICY_CONFIRMATION_MISMATCH' });

    await expect(policies.get(ALL, draft.id)).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('makes exactly one version current per type', async () => {
    const first = await draftTerms();
    await policies.publish(ALL, first.id, { confirmVersion: 1, reason: 'اول' });

    const second = await draftTerms();
    await policies.publish(ALL, second.id, { confirmVersion: 2, reason: 'دوم' });

    const rows = await prisma.policyVersion.findMany({ where: { type: 'TERMS' } });
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(rows.find((row) => row.isCurrent)?.version).toBe(2);
    // The superseded version stays PUBLISHED. Superseding is not archiving, and
    // a consent row pointing at v1 must still find a published document.
    expect(rows.find((row) => row.version === 1)?.status).toBe('PUBLISHED');
  });

  it('never mutates a published version', async () => {
    const draft = await draftTerms();
    const published = await policies.publish(ALL, draft.id, {
      confirmVersion: 1,
      reason: 'انتشار',
    });

    await expect(
      policies.updateDraft(ALL, published.id, {
        expectedRevision: published.revision,
        contentMd: 'متن جایگزین که هرگز نباید نوشته شود'.repeat(4),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_NOT_EDITABLE' });

    await expect(policies.get(ALL, published.id)).resolves.toMatchObject({ contentMd: CONTENT });
  });

  it('refuses to publish empty content', async () => {
    // Past the schema, which the service does not run — this is the service's own
    // last check, and it exists because the schema is not the only caller.
    const draft = await draftTerms();
    await prisma.policyVersion.update({ where: { id: draft.id }, data: { contentMd: '   ' } });

    await expect(
      policies.publish(ALL, draft.id, { confirmVersion: 1, reason: 'انتشار' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to archive the current version', async () => {
    const draft = await draftTerms();
    const published = await policies.publish(ALL, draft.id, {
      confirmVersion: 1,
      reason: 'انتشار',
    });

    // Archiving it would leave TERMS with no current version, which
    // `ConsentService` reads as "nothing can be accepted" — every new user would
    // be stuck at onboarding.
    await expect(policies.archive(ALL, published.id, 'بایگانی')).rejects.toMatchObject({
      code: 'POLICY_IS_CURRENT',
    });
  });

  it('archives a superseded version, and keeps its consent records intact', async () => {
    const first = await draftTerms();
    await policies.publish(ALL, first.id, { confirmVersion: 1, reason: 'اول' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds());

    const second = await draftTerms();
    await policies.publish(ALL, second.id, { confirmVersion: 2, reason: 'دوم' });
    const archived = await policies.archive(ALL, first.id, 'نسخهٔ قدیمی');

    expect(archived.status).toBe('ARCHIVED');
    expect(archived.archivedAt).not.toBeNull();
    // The evidence survives, and it carries its own label so it does not depend on
    // the archived row still being readable.
    const record = await prisma.consent.findFirstOrThrow({
      where: { userId, policyVersionId: first.id },
    });
    expect(record.policyVersionLabel).toBe('TERMS v1');
  });

  it('writes an audit row for every step, with the reason and no content', async () => {
    const draft = await draftTerms();
    await policies.updateDraft(ALL, draft.id, { expectedRevision: 0, titleFa: 'ویرایش' });
    await policies.publish(ALL, draft.id, { confirmVersion: 1, reason: 'آمادهٔ انتشار است' });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: 'policy_version', targetId: draft.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual([
      'policy.draft_created',
      'policy.draft_updated',
      'policy.published',
    ]);
    expect(rows[2]?.after).toMatchObject({ reason: 'آمادهٔ انتشار است', status: 'PUBLISHED' });
    // A length, not the text: `audit_log` is a table staff export, and the row
    // itself is immutable so the text is always recoverable from what it points at.
    expect(JSON.stringify(rows[2]?.after)).not.toContain('ماده ۱');
    expect(rows[2]?.after).toMatchObject({ contentLength: CONTENT.length });
  });
});

async function publishPrivacy(): Promise<void> {
  const draft = await policies.createDraft(ALL, {
    type: 'PRIVACY',
    titleFa: 'حریم خصوصی',
    contentMd: CONTENT,
  });
  await policies.publish(ALL, draft.id, { confirmVersion: draft.version, reason: 'انتشار' });
}

async function currentIds(): Promise<string[]> {
  return (await consent.currentPolicies()).map((policy) => policy.id);
}

describe('ConsentService — acceptance and re-acceptance', () => {
  it('records ONBOARDING for a first acceptance and REACCEPT for the next', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds());

    const first = await prisma.consent.findMany({ where: { userId } });
    expect(first).toHaveLength(2);
    expect(new Set(first.map((row) => row.context))).toEqual(new Set(['ONBOARDING']));
    // The gate that used to be the only one still moves.
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboardingState: true } }),
    ).resolves.toEqual({ onboardingState: 'TERMS_ACCEPTED' });

    const second = await draftTerms();
    await policies.publish(ALL, second.id, { confirmVersion: 2, reason: 'نسخهٔ دوم' });
    await consent.acceptPolicies(userId, await currentIds());

    // One row, not two: PRIVACY v1 did not change, so re-recording consent for it
    // would be evidence of a decision the user never made. Only the document that
    // actually moved is re-accepted.
    const reaccept = await prisma.consent.findMany({ where: { userId, context: 'REACCEPT' } });
    expect(reaccept).toHaveLength(1);
    expect(reaccept[0]?.policyVersionLabel).toBe('TERMS v2');
    await expect(prisma.consent.count({ where: { userId } })).resolves.toBe(3);
  });

  it('snapshots the exact version label, the request id and the app version', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds(), {
      requestId: 'req-abc-123',
      appVersion: 'v0.3.0',
    });

    const row = await prisma.consent.findFirstOrThrow({
      where: { userId, policyVersionId: terms.id },
    });
    expect(row.policyVersionLabel).toBe('TERMS v1');
    expect(row.requestId).toBe('req-abc-123');
    expect(row.appVersion).toBe('v0.3.0');
  });

  it('is idempotent — accepting twice writes one row per version', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    const ids = await currentIds();
    await consent.acceptPolicies(userId, ids);
    await consent.acceptPolicies(userId, ids);

    await expect(prisma.consent.count({ where: { userId } })).resolves.toBe(2);
  });

  it('refuses a stale set', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    const stale = await currentIds();

    const second = await draftTerms();
    await policies.publish(ALL, second.id, { confirmVersion: 2, reason: 'دوم' });

    // The user is holding the ids of v1 — consenting to a superseded document is
    // not consent to the current one.
    await expect(consent.acceptPolicies(userId, stale)).rejects.toMatchObject({
      code: 'POLICY_VERSION_STALE',
    });
  });

  it('reports the new version as pending for somebody who accepted the old one', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds());
    await expect(consent.hasAcceptedCurrentPolicies(userId)).resolves.toBe(true);

    const second = await draftTerms();
    await policies.publish(ALL, second.id, { confirmVersion: 2, reason: 'دوم' });

    await expect(consent.hasAcceptedCurrentPolicies(userId)).resolves.toBe(false);
    const standing = await consent.standingFor(userId);
    expect(standing.pending.map((policy) => policy.label)).toEqual(['TERMS v2']);
    expect(standing.accepted.map((entry) => entry.policy.label)).toEqual(['PRIVACY v1']);
  });

  it('refuses to be edited or deleted — the trigger, not the service', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds());

    await expect(
      prisma.consent.updateMany({ where: { userId }, data: { appVersion: 'tampered' } }),
    ).rejects.toThrow(/append-only/i);
    await expect(prisma.consent.deleteMany({ where: { userId } })).rejects.toThrow(/append-only/i);
  });
});

describe('PolicyAdminService — the acceptance log', () => {
  it('lists acceptances with a public id and never an ip hash', async () => {
    const terms = await draftTerms();
    await policies.publish(ALL, terms.id, { confirmVersion: 1, reason: 'انتشار' });
    await publishPrivacy();

    const userId = await createUser(prisma, 'NEW');
    await consent.acceptPolicies(userId, await currentIds(), { ipAddress: '1.2.3.4' });

    const page = await policies.listConsents(ALL, { policyVersionId: terms.id });

    expect(page.total).toBe(1);
    const [row] = page.rows;
    expect(row?.label).toBe('TERMS v1');
    expect(row?.context).toBe('ONBOARDING');
    // The projection is an allowlist; the hash is on the row and stays there.
    expect(JSON.stringify(row)).not.toContain('ipHash');
    const stored = await prisma.consent.findFirstOrThrow({ where: { userId } });
    expect(stored.ipHash).not.toBeNull();
    expect(stored.ipHash).not.toBe('1.2.3.4');
  });
});
