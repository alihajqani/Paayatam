import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { BugReportService } from './bug-report.service';

/**
 * Bug reports, against a real database.
 *
 * The interesting properties are all constraints: the CHECK that bounds the
 * screenshot array, the one that makes a settled report name who settled it and
 * when, and the fact that filing three in an afternoon is allowed — which is the
 * whole reason this is not a `Report` row (invariant 5's UNIQUE would refuse the
 * second).
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-30T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const bugReports = new BugReportService(service, clock, audit);

const DESCRIPTION = 'دکمهٔ پیوستن در صفحهٔ فعالیت هیچ کاری نمی‌کند.';

let userId: string;

/**
 * `bug_report.handled_by_admin_id` is a real foreign key, so a settled report
 * needs a real `admin_user` row. Inserted directly rather than through
 * `createAdmin`, so this suite still needs no roles, no Redis and no TOTP — the
 * same shortcut `gift-code-admin.int.test.ts` takes for the same reason.
 */
let staffId: string;

function adminId(): string {
  return staffId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  userId = await createUser(prisma, 'PROFILE_COMPLETE');

  const admin = await prisma.adminUser.create({
    data: {
      email: 'triage@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'تیم پشتیبانی',
    },
    select: { id: true },
  });
  staffId = admin.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('filing one', () => {
  it('records the description, the screenshots and the release', async () => {
    const filed = await bugReports.file(userId, {
      description: DESCRIPTION,
      screenshotFileIds: ['file-a', 'file-b'],
      appVersion: 'v0.6.5',
    });

    expect(filed).toMatchObject({
      description: DESCRIPTION,
      screenshotFileIds: ['file-a', 'file-b'],
      appVersion: 'v0.6.5',
      status: 'OPEN',
      adminNote: null,
      handledAt: null,
    });
  });

  /**
   * The distinction from `ReportService`, as a test. `UNIQUE (target_type,
   * target_id, reporter_user_id)` means one moderation report per subject per
   * person, forever; a user who finds three bugs must be able to send three.
   */
  it('lets one person file several', async () => {
    await bugReports.file(userId, { description: DESCRIPTION });
    await bugReports.file(userId, { description: `${DESCRIPTION} و این یکی هم.` });

    const { total } = await bugReports.list();
    expect(total).toBe(2);
  });

  it('de-duplicates a screenshot sent twice', async () => {
    const filed = await bugReports.file(userId, {
      description: DESCRIPTION,
      screenshotFileIds: ['file-a', 'file-a', 'file-b'],
    });

    expect(filed.screenshotFileIds).toEqual(['file-a', 'file-b']);
  });

  it('refuses a description too short to act on', async () => {
    await expect(bugReports.file(userId, { description: 'خرابه' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses more screenshots than the column will hold', async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `file-${String(index)}`);

    await expect(
      bugReports.file(userId, { description: DESCRIPTION, screenshotFileIds: eleven }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /**
   * The body is free text a user typed, and `audit_log` is a staff read surface
   * and an export target. What lands there is that a report exists and how big
   * it was — never its words.
   */
  it('audits the filing without recording what was written', async () => {
    await bugReports.file(userId, {
      description: DESCRIPTION,
      screenshotFileIds: ['file-a'],
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'bugreport.filed' },
      select: { after: true },
    });

    expect(JSON.stringify(entry.after)).not.toContain('پیوستن');
    expect(entry.after).toMatchObject({ screenshots: 1 });
  });
});

describe('the queue', () => {
  it('puts open reports before settled ones, oldest first inside each', async () => {
    const first = await bugReports.file(userId, { description: `${DESCRIPTION} یک` });
    clock.set(new Date(NOW.getTime() + 60_000));
    const second = await bugReports.file(userId, { description: `${DESCRIPTION} دو` });
    clock.set(new Date(NOW.getTime() + 120_000));
    await bugReports.setStatus(first.publicId, adminId(), 'RESOLVED');

    const { reports } = await bugReports.list();

    expect(reports.map((report) => report.publicId)).toEqual([second.publicId, first.publicId]);
  });

  it('filters by status', async () => {
    const open = await bugReports.file(userId, { description: `${DESCRIPTION} یک` });
    const other = await bugReports.file(userId, { description: `${DESCRIPTION} دو` });
    await bugReports.setStatus(other.publicId, adminId(), 'DISMISSED');

    const { reports, total } = await bugReports.list({ status: 'OPEN' });

    expect(total).toBe(1);
    expect(reports[0]?.publicId).toBe(open.publicId);
  });
});

describe('settling one', () => {
  it('records who settled it and when', async () => {
    const filed = await bugReports.file(userId, { description: DESCRIPTION });
    clock.set(new Date(NOW.getTime() + 3_600_000));

    const settled = await bugReports.setStatus(filed.publicId, adminId(), 'RESOLVED', 'رفع شد');

    expect(settled).toMatchObject({
      status: 'RESOLVED',
      adminNote: 'رفع شد',
      handledAt: new Date(NOW.getTime() + 3_600_000),
    });
  });

  /**
   * The CHECK's other direction: reopening clears the handler and the time, so a
   * report that is open again is not still claiming somebody closed it.
   */
  it('clears the handler when a report is reopened', async () => {
    const filed = await bugReports.file(userId, { description: DESCRIPTION });
    await bugReports.setStatus(filed.publicId, adminId(), 'RESOLVED');

    const reopened = await bugReports.setStatus(filed.publicId, adminId(), 'OPEN');

    expect(reopened.handledAt).toBeNull();
  });

  it('leaves an existing note alone when none is given', async () => {
    const filed = await bugReports.file(userId, { description: DESCRIPTION });
    await bugReports.setStatus(filed.publicId, adminId(), 'ACKNOWLEDGED', 'در حال بررسی');

    const later = await bugReports.setStatus(filed.publicId, adminId(), 'RESOLVED');

    expect(later.adminNote).toBe('در حال بررسی');
  });

  it('refuses a report that does not exist', async () => {
    await expect(
      bugReports.setStatus('00000000-0000-4000-8000-000000000000', adminId(), 'RESOLVED'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
