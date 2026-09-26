import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import { ErrorCode } from '@payetam/shared';
import {
  createTestPrisma,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { HELP_GUIDE_DEFAULTS } from '../catalog/help-guide-defaults';
import { HelpGuideService } from '../catalog/help-guide.service';
import { SettingsService } from '../catalog/settings.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { HelpGuideAdminService } from './help-guide-admin.service';

/**
 * Editing the in-bot guide from the panel (migration 0063), against a real
 * database: what a save stores, what a reset removes, what is refused, and what
 * the bot then reads.
 */
const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-09-27T09:00:00.000Z'));
const env = { CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY } as unknown as Env;
const audit = new AuditService(service, clock);
// Never authenticates, so Redis is never reached.
const access = new AdminAccessService(
  service,
  clock,
  { client: {} } as unknown as RedisService,
  new AdminCredentials(env),
  audit,
);
const guides = new HelpGuideService(service, new SettingsService(service));
const admin = new HelpGuideAdminService(service, access, audit, guides);

function session(role: 'SUPER_ADMIN' | 'SUPPORT' | 'ANALYST'): AdminSession {
  return {
    adminUserId: `guide-${role}`,
    email: `${role.toLowerCase()}@payetam.test`,
    displayName: role,
    roles: [role],
    permissions: permissionsFor([role]),
  };
}

const owner = session('SUPER_ADMIN');
const trust = HELP_GUIDE_DEFAULTS.find((guide) => guide.slug === 'trust');
if (trust === undefined) throw new Error('the trust section is part of the fixture');

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('HelpGuideAdminService', () => {
  it('lists every section with its default, and every placeholder with today’s value', async () => {
    await prisma.appSetting.create({ data: { key: 'economy.event_join_coins', value: 12 } });

    const { guides: listed, placeholders } = await admin.list(owner);

    expect(listed.map((guide) => guide.slug)).toEqual(HELP_GUIDE_DEFAULTS.map((g) => g.slug));
    expect(listed.every((guide) => !guide.titleCustomized && !guide.bodyCustomized)).toBe(true);
    expect(placeholders).toContainEqual({
      key: 'economy.event_join_coins',
      label: 'هزینهٔ درخواست شرکت',
      value: 12,
    });
    expect(placeholders.find((p) => p.key === 'derived.event_register_coins')?.value).toBe(25);
  });

  it('saves a new title and text, and the bot reads them with the numbers filled', async () => {
    const saved = await admin.update(owner, 'trust', {
      title: '⭐️ اعتماد',
      body: 'همه از {{trust.initial_score}} شروع می‌کنن.',
      hidden: false,
    });

    expect(saved).toMatchObject({
      title: '⭐️ اعتماد',
      titleCustomized: true,
      bodyCustomized: true,
    });
    const page = await guides.render('trust');
    expect(page).toMatchObject({ title: '⭐️ اعتماد', body: 'همه از ۵۰ شروع می‌کنن.' });

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'help_guide.updated' } });
    expect(row).toMatchObject({ actorId: owner.adminUserId, targetId: 'trust' });
  });

  /** So a section saved unchanged still receives the next release's corrections. */
  it('stores text equal to the default as the default', async () => {
    await admin.update(owner, 'trust', { title: trust.title, body: trust.body, hidden: false });

    expect(await prisma.helpGuide.count()).toBe(0);
  });

  it('hides a section from the contents and from paging', async () => {
    await admin.update(owner, 'trust', { title: null, body: null, hidden: true });

    const visible = (await guides.visible()).map((guide) => guide.slug);
    expect(visible).not.toContain('trust');
    expect(await guides.render('trust')).toBeNull();
    // Its neighbours now point past it.
    expect((await guides.render('intro'))?.nextSlug).toBe('reviews');
  });

  it('resets a section to the default and says so in the trail', async () => {
    await admin.update(owner, 'trust', { title: 'x', body: 'y', hidden: true });

    const reset = await admin.reset(owner, 'trust');

    expect(reset).toMatchObject({ title: trust.title, body: trust.body, hidden: false });
    expect(await prisma.helpGuide.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'help_guide.reset' } })).toBe(1);
  });

  it('refuses a placeholder no setting answers to', async () => {
    await expect(
      admin.update(owner, 'trust', { title: null, body: 'سکه: {{economy.nope}}', hidden: false }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      details: { unknownPlaceholders: ['economy.nope'] },
    });
    expect(await prisma.helpGuide.count()).toBe(0);
  });

  it('refuses a title that would not fit a button, and text that would not fit a message', async () => {
    await expect(
      admin.update(owner, 'trust', { title: 'ا'.repeat(41), body: null, hidden: false }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    await expect(
      admin.update(owner, 'trust', { title: null, body: 'ا'.repeat(3501), hidden: false }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('answers not found for a section the code does not define', async () => {
    await expect(
      admin.update(owner, 'nope', { title: 'x', body: null, hidden: false }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  /** Support may read the guide, as it reads the terms; only `policy.manage` edits it. */
  it('lets support read and refuses them an edit', async () => {
    await expect(admin.list(session('SUPPORT'))).resolves.toBeDefined();
    await expect(
      admin.update(session('SUPPORT'), 'trust', { title: 'x', body: null, hidden: false }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    await expect(admin.list(session('ANALYST'))).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });
});
