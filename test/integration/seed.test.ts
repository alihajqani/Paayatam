import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@payetam/db';
import { SETTING_DEFAULTS } from '@payetam/domain';
import { createTestPrisma, resetDatabase } from './db';

/**
 * The seed scripts and their production rail (plan §9 M17).
 *
 * These run the **real scripts as subprocesses**, not imported functions. That is
 * deliberate and it is the only way to test the thing M17 actually asks for: the rail
 * is made of `process.exit`, an interactive prompt and a TTY check, none of which
 * survive being imported into a test that then asserts on a return value. A test that
 * called an extracted `seedEvents()` would prove the events are right and prove
 * nothing about the refusals — and the refusals are the part that protects a
 * production database.
 *
 * It is also the only test in the suite that verifies the scripts *run at all*.
 * A seed script is code nobody executes until the day it matters.
 */

const run = promisify(execFile);
const prisma: PrismaClient = createTestPrisma();

/** The scripts write wherever `DATABASE_URL` points, so it points at the test database. */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a seed script with an explicit environment.
 *
 * `NODE_ENV` is passed through as `undefined` unless overridden, because a test
 * process running under `NODE_ENV=test` would otherwise never reach the production
 * branch — and the production branch is what is under test here.
 */
async function seed(script: string, env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', `tools/${script}.ts`], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: databaseUrl, ...env },
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

beforeAll(async () => {
  await resetDatabase(prisma);
  // Events need a city, a category and districts to reference; settings need nothing.
  //
  // `seed-geography` first, and the order is load-bearing rather than tidy:
  // cities moved there in M21, and `seed-catalog` attaches Tehran's districts to
  // a city it looks up by slug. Run the other way round it warns and skips them,
  // and `seed-events` then has no active city to place an event in.
  expect((await seed('seed-geography')).code).toBe(0);
  expect((await seed('seed-catalog')).code).toBe(0);
  expect((await seed('seed-settings')).code).toBe(0);
  expect((await seed('seed-events')).code).toBe(0);
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the founding-team events (§9 M17)', () => {
  /** The plan asks for 20–30. Asserted as a range, because that is what it says. */
  it('creates between 20 and 30 published events', async () => {
    const count = await prisma.event.count({ where: { status: 'PUBLISHED' } });

    expect(count).toBeGreaterThanOrEqual(20);
    expect(count).toBeLessThanOrEqual(30);
  });

  /**
   * The property the whole host-resolution dance exists for: **somebody can say yes**.
   *
   * A seeded event with a fabricated or incomplete host is an event whose first join
   * request goes unanswered for twenty-four hours and then expires — the first real
   * user's first action on the platform, silently ignored.
   */
  it('gives every event a host who exists and has completed their profile', async () => {
    const events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      select: {
        host: { select: { onboardingState: true, profile: { select: { userId: true } } } },
      },
    });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.host.onboardingState).toBe('PROFILE_COMPLETE');
      expect(event.host.profile).not.toBeNull();
    }
  });

  it('publishes them all as APPROVED, in the future, in Tehran', async () => {
    const tehran = await prisma.city.findUniqueOrThrow({ where: { slug: 'tehran' } });
    const events = await prisma.event.findMany({ where: { status: 'PUBLISHED' } });

    for (const event of events) {
      expect(event.moderationStatus).toBe('APPROVED');
      expect(event.cityId).toBe(tehran.id);
      expect(event.startsAt.getTime()).toBeGreaterThan(Date.now());
      expect(event.endsAt.getTime()).toBeGreaterThan(event.startsAt.getTime());
      expect(event.publishedAt).not.toBeNull();
    }
  });

  /** Only the two categories launch enables (§2). A seeded event in an inactive one is unreachable. */
  it('uses only active categories', async () => {
    const inactive = await prisma.event.count({
      where: { status: 'PUBLISHED', category: { isActive: false } },
    });

    expect(inactive).toBe(0);
  });

  /**
   * Normalized through the same function the API uses (ADR-0012), so a seeded event is
   * findable by the ي/ك and half-space variants a hosted one is. A row written without
   * it would exist and be unsearchable — which for launch content is the same as not
   * existing.
   */
  it('normalizes the searchable columns', async () => {
    // «پیاده‌روی» carries a ZWNJ; the normalized form should have a plain space.
    const withHalfSpace = await prisma.event.findFirst({
      where: { title: { contains: '‌' } },
      select: { title: true, titleNormalized: true },
    });

    expect(withHalfSpace).not.toBeNull();
    expect(withHalfSpace?.titleNormalized).not.toContain('‌');
    expect(withHalfSpace?.titleNormalized).not.toBe(withHalfSpace?.title);
  });

  /** Small groups are what the product is for, and what makes the waitlist reachable. */
  it('keeps capacities small enough to fill', async () => {
    const events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      select: { capacity: true },
    });

    for (const event of events) {
      expect(event.capacity).toBeGreaterThanOrEqual(4);
      expect(event.capacity).toBeLessThanOrEqual(8);
    }
  });

  /** A partially failed run is fixed by running it again, not by cleaning up by hand. */
  it('is idempotent', async () => {
    const before = await prisma.event.count();

    const result = await seed('seed-events');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 events created');
    expect(await prisma.event.count()).toBe(before);
  }, 120_000);
});

describe('the policy numbers (§11: "all in app_setting, runtime-changeable")', () => {
  /**
   * Every key, not a sample. Until M17 the catalog seed wrote two rows and the other
   * forty-eight existed only as code defaults — working correctly and **invisible**,
   * which is not what "runtime-changeable" means.
   */
  it('writes a row for every documented default', async () => {
    const rows = await prisma.appSetting.findMany({ select: { key: true } });
    const stored = new Set(rows.map((row) => row.key));

    const missing = Object.keys(SETTING_DEFAULTS).filter((key) => !stored.has(key));
    expect(missing).toEqual([]);
  });

  it('stores the documented value', async () => {
    for (const [key, expected] of Object.entries(SETTING_DEFAULTS)) {
      const row = await prisma.appSetting.findUnique({ where: { key } });
      expect(row?.value, key).toEqual(expected);
    }
  });

  /**
   * The half that matters in production: an operator who tuned a number must not have
   * it reset because somebody ran a seed. That also means this script cannot be used
   * to revert a setting, which is correct — reverting is an admin action with an audit
   * trail, not a shell command.
   */
  it('never overwrites a value somebody has tuned', async () => {
    await prisma.appSetting.update({
      where: { key: 'moderation.report_threshold' },
      data: { value: 7 },
    });

    expect((await seed('seed-settings')).code).toBe(0);

    const row = await prisma.appSetting.findUniqueOrThrow({
      where: { key: 'moderation.report_threshold' },
    });
    expect(row.value).toBe(7);

    await prisma.appSetting.update({
      where: { key: 'moderation.report_threshold' },
      data: { value: SETTING_DEFAULTS['moderation.report_threshold'] },
    });
  }, 120_000);
});

describe('the production rail (§9 M17)', () => {
  /**
   * The plan's requirement in full: *"refuses to run when `NODE_ENV=production` unless
   * `ALLOW_PROD_SEED=1` AND an interactive typed confirmation is given, and it writes
   * an audit row"*. Each part is tested because each defends against a different
   * mistake, and any one of them alone is defeatable.
   */
  it('refuses in production without the flag', async () => {
    const result = await seed('seed-events', { NODE_ENV: 'production' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing to run seed.events in production');
  }, 120_000);

  /**
   * With the flag but no terminal, it still refuses — which is what makes the word
   * "interactive" true rather than decorative. `yes | pnpm seed:events` and a CI job
   * both land here.
   */
  it('refuses in production with the flag but no terminal', async () => {
    const result = await seed('seed-events', { NODE_ENV: 'production', ALLOW_PROD_SEED: '1' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(result.stderr).toContain('Piping a confirmation is not a confirmation');
  }, 120_000);

  it('writes nothing when it refuses', async () => {
    const before = await prisma.event.count();

    await seed('seed-events', { NODE_ENV: 'production' });
    await seed('seed-events', { NODE_ENV: 'production', ALLOW_PROD_SEED: '1' });

    expect(await prisma.event.count()).toBe(before);
  }, 180_000);

  it('refuses without DATABASE_URL rather than guessing', async () => {
    const result = await seed('seed-events', { DATABASE_URL: '' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is not set');
  }, 120_000);
});

describe('the audit trail', () => {
  /**
   * Seeded data appearing in production with nothing recording how is
   * indistinguishable from a compromise, and somebody will have to prove which it was.
   */
  it('records every seed that ran', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'seed.' } },
      select: { action: true, actorType: true, targetType: true, after: true },
    });

    const actions = new Set(rows.map((row) => row.action));
    expect(actions).toContain('seed.catalog');
    expect(actions).toContain('seed.settings');
    expect(actions).toContain('seed.events');

    for (const row of rows) {
      // SYSTEM rather than ADMIN: `actor_id` references `admin_user`, and whoever runs
      // a seed from a shell has no row there. The operating user goes in the payload,
      // which is weaker evidence and is what is actually available.
      expect(row.actorType).toBe('SYSTEM');
      expect(row.targetType).toBe('database');
      expect(row.after).toMatchObject({ environment: 'development' });
      expect(row.after).toHaveProperty('operator');
      expect(row.after).toHaveProperty('seededAt');
    }
  });

  /** A summary of what happened, not of what was intended. */
  it('records the outcome of the run', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'seed.events' },
      orderBy: { createdAt: 'desc' },
    });

    expect(row.after).toHaveProperty('eventsCreated');
    expect(row.after).toHaveProperty('eventsUpdated');
  });

  /** The audit trail is append-only by trigger (ADR-0007), seeds included. */
  it('cannot be deleted afterwards', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seed.events' } });

    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only|audit/i,
    );
  });
});
