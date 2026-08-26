import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { CHANNEL_CONFIG_ID, ChannelConfigService } from './channel-config.service';
import {
  ChannelMembershipService,
  type MembershipProbe,
  type MembershipProbeResult,
} from './membership.service';

/**
 * The channel-membership requirement (M22 phase 6).
 *
 * **No Telegram anywhere.** The probe is a port, and this file provides one that
 * returns whatever the test scripted — which is also how the production wiring
 * behaves in the worker and in CI, where no probe is registered at all and every
 * check answers `UNKNOWN`.
 *
 * The property this file exists for is the one that is easy to get backwards: the
 * gate **fails open** on everything except an authoritative refusal. Three of the
 * five probe outcomes are configuration problems or weather, and blocking a user
 * for either is how a product stops working at three in the morning.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
const audit = new AuditService(service, clock);
const config = new ChannelConfigService(service, clock, audit);

/** Records what it was asked and answers with whatever the test set. */
class FakeProbe implements MembershipProbe {
  readonly calls: { chatIdentifier: string; telegramUserId: bigint }[] = [];
  readonly invalidated: string[] = [];
  next: MembershipProbeResult = { kind: 'MEMBER' };

  check(chatIdentifier: string, telegramUserId: bigint): Promise<MembershipProbeResult> {
    this.calls.push({ chatIdentifier, telegramUserId });
    return Promise.resolve(this.next);
  }

  invalidate(chatIdentifier: string): Promise<void> {
    this.invalidated.push(chatIdentifier);
    return Promise.resolve();
  }
}

let probe: FakeProbe;
let membership: ChannelMembershipService;
let userId: string;
/**
 * A real `admin_user` row, because `event_channel_config.updated_by_admin_id` is
 * a foreign key — a synthetic id would fail on the constraint rather than on
 * anything this suite is about.
 */
let ADMIN_ID: string;

async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
  await prisma.eventChannelConfig.upsert({
    where: { id: CHANNEL_CONFIG_ID },
    create: {
      id: CHANNEL_CONFIG_ID,
      chatIdentifier: '@payetam',
      inviteUrl: 'https://t.me/payetam',
      membershipRequired: true,
      requiredActions: ['EVENT_CREATE', 'EVENT_JOIN'],
      verifyViaTelegram: true,
      ...overrides,
    },
    update: {
      chatIdentifier: '@payetam',
      inviteUrl: 'https://t.me/payetam',
      membershipRequired: true,
      requiredActions: ['EVENT_CREATE', 'EVENT_JOIN'],
      verifyViaTelegram: true,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  probe = new FakeProbe();
  membership = new ChannelMembershipService(service, config, probe);
  userId = await createUser(prisma, 'PROFILE_COMPLETE');

  const admin = await prisma.adminUser.create({
    data: {
      email: 'super@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'مدیر ارشد',
    },
    select: { id: true },
  });
  ADMIN_ID = admin.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('when nothing is configured', () => {
  /**
   * The default a fresh deployment has, and the one that must never lock anybody
   * out. Migration 0021 creates the row with `membership_required = false`.
   */
  it('lets everybody through and asks Telegram nothing', async () => {
    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state).toMatchObject({ required: false, status: 'NOT_REQUIRED', allowed: true });
    expect(probe.calls).toHaveLength(0);
    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
  });
});

describe('when the requirement is on', () => {
  it('lets a member through', async () => {
    await configure();
    probe.next = { kind: 'MEMBER' };

    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
    expect(probe.calls[0]?.chatIdentifier).toBe('@payetam');
  });

  it('refuses somebody who is not a member, with somewhere to go', async () => {
    await configure();
    probe.next = { kind: 'NOT_MEMBER' };

    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).rejects.toMatchObject({
      code: 'CHANNEL_MEMBERSHIP_REQUIRED',
      details: { joinUrl: 'https://t.me/payetam', action: 'EVENT_CREATE' },
    });
  });

  it('only gates the actions it was told to', async () => {
    await configure({ requiredActions: ['EVENT_CREATE'] });
    probe.next = { kind: 'NOT_MEMBER' };

    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).rejects.toMatchObject({
      code: 'CHANNEL_MEMBERSHIP_REQUIRED',
    });
    // Not in `requiredActions`, so not gated — and not even asked about.
    probe.calls.length = 0;
    await expect(membership.assertAllowed(userId, 'EVENT_INVITE')).resolves.toBeUndefined();
    expect(probe.calls).toHaveLength(0);
  });

  /**
   * The three fail-open cases. Each one is a configuration problem or weather, and
   * blocking a user for either is the failure this design exists to avoid.
   */
  it.each([
    ['CHAT_UNAVAILABLE', { kind: 'CHAT_UNAVAILABLE', reason: 'chat not found' }],
    ['BOT_CANNOT_VERIFY', { kind: 'BOT_CANNOT_VERIFY', reason: 'not enough rights' }],
    ['UNKNOWN', { kind: 'UNKNOWN', reason: 'network error' }],
  ] as const)('lets the user through on %s', async (expected, result) => {
    await configure();
    probe.next = result;

    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state.status).toBe(expected);
    expect(state.allowed).toBe(true);
    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
  });

  it('lets everybody through when verification is switched off', async () => {
    await configure({ verifyViaTelegram: false });

    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    // Advisory: the user is shown the join button and taken at their word, which
    // is the honest setting for a channel the bot does not administer.
    expect(state.allowed).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it('reports CHAT_UNAVAILABLE, and still allows, when there is no chat id', async () => {
    await configure({ chatIdentifier: null });

    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state.status).toBe('CHAT_UNAVAILABLE');
    expect(state.allowed).toBe(true);
  });

  it('falls back to the username when no invite link is set', async () => {
    await configure({ inviteUrl: null, publicUsername: 'payetam' });
    probe.next = { kind: 'NOT_MEMBER' };

    await expect(membership.stateFor(userId, 'EVENT_CREATE')).resolves.toMatchObject({
      joinUrl: 'https://t.me/payetam',
    });
  });

  it('clears the cached answer before re-checking', async () => {
    await configure();

    await membership.recheck(userId, 'EVENT_CREATE');

    expect(probe.invalidated).toEqual(['@payetam']);
    expect(probe.calls).toHaveLength(1);
  });
});

describe('with no probe registered at all', () => {
  /**
   * The worker's wiring, and CI's. A deployment with no probe must degrade to
   * "cannot tell", which fails open — not to "not a member", which would block
   * every user of a process that never had a token.
   */
  it('answers UNKNOWN and allows', async () => {
    await configure();
    const withoutProbe = new ChannelMembershipService(service, config);

    const state = await withoutProbe.stateFor(userId, 'EVENT_CREATE');

    expect(state.status).toBe('UNKNOWN');
    expect(state.allowed).toBe(true);
  });
});

describe('the configuration itself', () => {
  it('refuses to require membership with nowhere to send people', async () => {
    await expect(config.update(ADMIN_ID, { membershipRequired: true })).rejects.toMatchObject({
      code: 'CHANNEL_NOT_CONFIGURED',
    });
  });

  it('normalises and rebuilds the invite link', async () => {
    const status = await config.update(ADMIN_ID, {
      inviteUrl: 'https://t.me/payetam?utm_source=nowhere#frag',
    });

    // Query and fragment dropped: neither belongs in a join link, and both are
    // things a pasted URL can smuggle.
    expect(status.inviteUrl).toBe('https://t.me/payetam');
  });

  it.each([
    'http://t.me/payetam',
    'https://evil.test/t.me/payetam',
    'javascript:alert(1)',
    'https://t.me',
  ])('refuses %s as an invite link', async (candidate) => {
    await expect(config.update(ADMIN_ID, { inviteUrl: candidate })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('accepts a private invite link', async () => {
    const status = await config.update(ADMIN_ID, { inviteUrl: 'https://t.me/+AbCdEfGh' });

    expect(status.inviteUrl).toBe('https://t.me/+AbCdEfGh');
  });

  it('accepts both chat identifier forms and refuses anything else', async () => {
    await expect(
      config.update(ADMIN_ID, { chatIdentifier: '-1001234567890' }),
    ).resolves.toMatchObject({ chatIdentifier: '-1001234567890' });
    await expect(config.update(ADMIN_ID, { chatIdentifier: 'payetam' })).resolves.toMatchObject({
      chatIdentifier: '@payetam',
    });
    await expect(
      config.update(ADMIN_ID, { chatIdentifier: 'https://t.me/payetam' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('warns before the switch rather than after it', async () => {
    const status = await config.update(ADMIN_ID, { chatIdentifier: null, inviteUrl: null });

    expect(status.membershipRequired).toBe(false);
    expect(status.warnings).toContain('NO_JOIN_LINK');
    expect(status.warnings).toContain('NO_CHAT_IDENTIFIER');
  });

  it('records old and new values in the audit trail', async () => {
    await config.update(ADMIN_ID, { inviteUrl: 'https://t.me/payetam' });
    await config.update(ADMIN_ID, { membershipRequired: true, requiredActions: ['EVENT_JOIN'] });

    const rows = await prisma.auditLog.findMany({
      where: { action: 'channel.config_updated' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.before).toMatchObject({ membershipRequired: false });
    expect(rows[1]?.after).toMatchObject({
      membershipRequired: true,
      requiredActions: 'EVENT_JOIN',
    });
  });

  it('never stores or returns anything token-shaped', async () => {
    const status = await config.update(ADMIN_ID, {
      chatIdentifier: '@payetam',
      inviteUrl: 'https://t.me/payetam',
    });

    // The bot token is an environment variable and this table has no column for
    // one. Asserted rather than assumed, because "there is no field for it" is
    // exactly the kind of thing a later migration quietly changes.
    expect(Object.keys(status)).not.toContain('botToken');
    expect(JSON.stringify(status)).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{30,}/);
  });
});
