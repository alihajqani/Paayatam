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
 * The channel-membership requirement (M22 phase 6, several channels in v0.3.1).
 *
 * **No Telegram anywhere.** The probe is a port, and this file provides one that
 * returns whatever the test scripted — which is also how the production wiring
 * behaves in the worker and in CI, where no probe is registered at all and every
 * check answers `UNKNOWN`.
 *
 * Two properties this file exists for, and both are easy to get backwards:
 *
 *  - The gate **fails open** on everything except an authoritative refusal. Three
 *    of the five probe outcomes are configuration problems or weather, and
 *    blocking a user for either is how a product stops working at three in the
 *    morning.
 *  - With several channels, a user passes only when **no** channel refuses. That
 *    is not "passes the first one", and it is not "every channel said MEMBER"
 *    either — the second would turn one misconfigured channel into an outage.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
const audit = new AuditService(service, clock);
const config = new ChannelConfigService(service, clock, audit);

/**
 * Records what it was asked and answers with whatever the test set.
 *
 * `perChannel` is what makes the multi-channel assertions possible: the interesting
 * case is one channel saying `MEMBER` and another saying `NOT_MEMBER`, which a
 * single `next` cannot express.
 */
class FakeProbe implements MembershipProbe {
  readonly calls: { chatIdentifier: string; telegramUserId: bigint }[] = [];
  readonly invalidated: string[] = [];
  next: MembershipProbeResult = { kind: 'MEMBER' };
  readonly perChannel = new Map<string, MembershipProbeResult>();

  check(chatIdentifier: string, telegramUserId: bigint): Promise<MembershipProbeResult> {
    this.calls.push({ chatIdentifier, telegramUserId });
    return Promise.resolve(this.perChannel.get(chatIdentifier) ?? this.next);
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
 * A real `admin_user` row, because `required_channel.updated_by_admin_id` is a
 * foreign key — a synthetic id would fail on the constraint rather than on
 * anything this suite is about.
 */
let ADMIN_ID: string;

/** One channel, added through the service so its validation runs. */
async function addChannel(
  title: string,
  overrides: { chatIdentifier?: string | null; inviteUrl?: string | null } = {},
): Promise<string> {
  const created = await config.createChannel(ADMIN_ID, {
    title,
    chatIdentifier: overrides.chatIdentifier === undefined ? '@payetam' : overrides.chatIdentifier,
    inviteUrl: overrides.inviteUrl === undefined ? 'https://t.me/payetam' : overrides.inviteUrl,
  });
  return created.id;
}

/** The switches, straight to the row — the service refuses some of these states. */
async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
  const data = {
    membershipRequired: true,
    requiredActions: ['EVENT_CREATE', 'EVENT_JOIN'],
    verifyViaTelegram: true,
    ...overrides,
  };
  await prisma.eventChannelConfig.upsert({
    where: { id: CHANNEL_CONFIG_ID },
    create: { id: CHANNEL_CONFIG_ID, ...data },
    update: data,
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
   * out. Migration 0021 creates the row with `membership_required = false`, and
   * 0024 adds no channel unless one was already configured.
   */
  it('lets everybody through and asks Telegram nothing', async () => {
    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state).toMatchObject({ required: false, status: 'NOT_REQUIRED', allowed: true });
    expect(state.channels).toEqual([]);
    expect(probe.calls).toHaveLength(0);
    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
  });

  /**
   * The requirement switched on with no channel behind it.
   *
   * `update()` refuses to reach this state, but a row written before 0024 —
   * or by hand — can be in it, and a gate that blocks everybody over an empty
   * list is the outage this whole file is about.
   */
  it('lets everybody through when the requirement is on but no channel exists', async () => {
    await configure();

    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state.allowed).toBe(true);
    expect(state.status).toBe('NOT_REQUIRED');
    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
  });
});

describe('with one channel', () => {
  beforeEach(async () => {
    await addChannel('کانال پایه‌تم');
    await configure();
  });

  it('lets a member through', async () => {
    probe.next = { kind: 'MEMBER' };

    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).resolves.toBeUndefined();
    expect(probe.calls[0]?.chatIdentifier).toBe('@payetam');
  });

  it('refuses somebody who is not a member, with somewhere to go', async () => {
    probe.next = { kind: 'NOT_MEMBER' };

    await expect(membership.assertAllowed(userId, 'EVENT_CREATE')).rejects.toMatchObject({
      code: 'CHANNEL_MEMBERSHIP_REQUIRED',
      details: {
        joinUrl: 'https://t.me/payetam',
        action: 'EVENT_CREATE',
        channels: [{ title: 'کانال پایه‌تم', joinUrl: 'https://t.me/payetam' }],
      },
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
    await resetDatabase(prisma);
    ADMIN_ID = (
      await prisma.adminUser.create({
        data: {
          email: 'super@payetam.test',
          passwordHash: 'x',
          totpSecretEnc: 'x',
          displayName: 'مدیر',
        },
        select: { id: true },
      })
    ).id;
    userId = await createUser(prisma, 'PROFILE_COMPLETE');
    await addChannel('کانال بدون شناسه', { chatIdentifier: null });
    await configure();

    const state = await membership.stateFor(userId, 'EVENT_CREATE');

    expect(state.status).toBe('CHAT_UNAVAILABLE');
    expect(state.allowed).toBe(true);
  });

  it('clears the cached answer before re-checking', async () => {
    await membership.recheck(userId, 'EVENT_CREATE');

    expect(probe.invalidated).toEqual(['@payetam']);
    expect(probe.calls).toHaveLength(1);
  });
});

describe('with several channels', () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    first = await addChannel('کانال یکم', {
      chatIdentifier: '@payetam_one',
      inviteUrl: 'https://t.me/payetam_one',
    });
    second = await addChannel('کانال دوم', {
      chatIdentifier: '@payetam_two',
      inviteUrl: 'https://t.me/payetam_two',
    });
    await configure();
  });

  /** The whole point: joining one of two is not joining the requirement. */
  it('refuses when any one channel refuses', async () => {
    probe.perChannel.set('@payetam_one', { kind: 'MEMBER' });
    probe.perChannel.set('@payetam_two', { kind: 'NOT_MEMBER' });

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.allowed).toBe(false);
    expect(state.status).toBe('NOT_MEMBER');
    // The button points at the one they still owe, not at the first in the list.
    expect(state.joinUrl).toBe('https://t.me/payetam_two');
    await expect(membership.assertAllowed(userId, 'EVENT_JOIN')).rejects.toMatchObject({
      code: 'CHANNEL_MEMBERSHIP_REQUIRED',
    });
  });

  it('allows only when every channel is joined', async () => {
    probe.next = { kind: 'MEMBER' };

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.allowed).toBe(true);
    expect(state.channels.map((channel) => channel.allowed)).toEqual([true, true]);
    expect(probe.calls.map((call) => call.chatIdentifier)).toEqual([
      '@payetam_one',
      '@payetam_two',
    ]);
  });

  /**
   * One channel the bot cannot see must not become an outage for a list that is
   * otherwise fine. This is the combination rule stated as a test: refuse on
   * `NOT_MEMBER`, never on "not every answer was MEMBER".
   */
  it('does not let one misconfigured channel block a joined user', async () => {
    probe.perChannel.set('@payetam_one', { kind: 'MEMBER' });
    probe.perChannel.set('@payetam_two', { kind: 'BOT_CANNOT_VERIFY', reason: 'not an admin' });

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.allowed).toBe(true);
    // Still reported, so the panel and the screen can say something is wrong.
    expect(state.status).toBe('BOT_CANNOT_VERIFY');
  });

  it('reports every outstanding channel, in the operator’s order', async () => {
    probe.next = { kind: 'NOT_MEMBER' };

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.channels.map((channel) => channel.title)).toEqual(['کانال یکم', 'کانال دوم']);
  });

  /** The order is the operator's, and reordering has to change what a user sees. */
  it('follows a reorder', async () => {
    await config.reorderChannels(ADMIN_ID, [second, first]);
    probe.next = { kind: 'NOT_MEMBER' };

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.channels.map((channel) => channel.title)).toEqual(['کانال دوم', 'کانال یکم']);
    expect(state.joinUrl).toBe('https://t.me/payetam_two');
  });

  it('ignores a deactivated channel', async () => {
    await config.updateChannel(ADMIN_ID, second, { isActive: false });
    probe.perChannel.set('@payetam_one', { kind: 'MEMBER' });
    probe.perChannel.set('@payetam_two', { kind: 'NOT_MEMBER' });

    const state = await membership.stateFor(userId, 'EVENT_JOIN');

    expect(state.allowed).toBe(true);
    expect(state.channels).toHaveLength(1);
  });

  it('clears every channel’s cached answer on a re-check', async () => {
    await membership.recheck(userId, 'EVENT_JOIN');

    expect(probe.invalidated).toEqual(['@payetam_one', '@payetam_two']);
  });

  /**
   * One read of `telegram_account` for the whole check, not one per channel.
   *
   * Asserted because the obvious implementation reads it inside the loop, and on a
   * list of four channels that is four queries on a screen somebody is waiting on.
   */
  it('reads the Telegram account once, however many channels there are', async () => {
    probe.next = { kind: 'MEMBER' };
    const ids = new Set<string>();

    await membership.stateFor(userId, 'EVENT_JOIN');
    for (const call of probe.calls) ids.add(String(call.telegramUserId));

    expect(ids.size).toBe(1);
  });
});

describe('with no probe registered at all', () => {
  /**
   * The worker's wiring, and CI's. A deployment with no probe must degrade to
   * "cannot tell", which fails open — not to "not a member", which would block
   * every user of a process that never had a token.
   */
  it('answers UNKNOWN and allows', async () => {
    await addChannel('کانال پایه‌تم');
    await configure();
    const withoutProbe = new ChannelMembershipService(service, config);

    const state = await withoutProbe.stateFor(userId, 'EVENT_CREATE');

    expect(state.status).toBe('UNKNOWN');
    expect(state.allowed).toBe(true);
  });
});

describe('the configuration itself', () => {
  it('refuses to require membership with no channel to send people to', async () => {
    await expect(config.update(ADMIN_ID, { membershipRequired: true })).rejects.toMatchObject({
      code: 'CHANNEL_NOT_CONFIGURED',
    });
  });

  it('normalises and rebuilds the invite link', async () => {
    const channel = await config.createChannel(ADMIN_ID, {
      title: 'کانال',
      inviteUrl: 'https://t.me/payetam?utm_source=nowhere#frag',
    });

    // Query and fragment dropped: neither belongs in a join link, and both are
    // things a pasted URL can smuggle.
    expect(channel.inviteUrl).toBe('https://t.me/payetam');
  });

  it.each([
    'http://t.me/payetam',
    'https://evil.test/t.me/payetam',
    'javascript:alert(1)',
    'https://t.me',
  ])('refuses %s as an invite link', async (candidate) => {
    await expect(
      config.createChannel(ADMIN_ID, { title: 'کانال', inviteUrl: candidate }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts a private invite link', async () => {
    const channel = await config.createChannel(ADMIN_ID, {
      title: 'کانال خصوصی',
      inviteUrl: 'https://t.me/+AbCdEfGh',
    });

    expect(channel.inviteUrl).toBe('https://t.me/+AbCdEfGh');
  });

  it('refuses a channel with nowhere to send anybody', async () => {
    await expect(config.createChannel(ADMIN_ID, { title: 'کانال' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('accepts both chat identifier forms and refuses anything else', async () => {
    await expect(
      config.createChannel(ADMIN_ID, {
        title: 'عددی',
        chatIdentifier: '-1001234567890',
        inviteUrl: 'https://t.me/a_channel',
      }),
    ).resolves.toMatchObject({ chatIdentifier: '-1001234567890' });
    await expect(
      config.createChannel(ADMIN_ID, {
        title: 'نام‌دار',
        chatIdentifier: 'payetam',
        inviteUrl: 'https://t.me/payetam',
      }),
    ).resolves.toMatchObject({ chatIdentifier: '@payetam' });
    await expect(
      config.createChannel(ADMIN_ID, {
        title: 'اشتباه',
        chatIdentifier: 'https://t.me/payetam',
        inviteUrl: 'https://t.me/payetam',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses the same channel twice', async () => {
    await addChannel('یکم');

    await expect(addChannel('دوباره همان')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /**
   * Removing the last channel while the requirement is on leaves a gate with
   * nothing behind it: the user is told to join something and shown no button.
   */
  it('refuses to remove the last active channel while the requirement is on', async () => {
    const only = await addChannel('تنها کانال');
    await config.update(ADMIN_ID, { membershipRequired: true, requiredActions: ['EVENT_JOIN'] });

    await expect(config.deleteChannel(ADMIN_ID, only)).rejects.toMatchObject({
      code: 'CHANNEL_NOT_CONFIGURED',
    });
    await expect(config.updateChannel(ADMIN_ID, only, { isActive: false })).rejects.toMatchObject({
      code: 'CHANNEL_NOT_CONFIGURED',
    });
  });

  it('allows removing the last channel once the requirement is off', async () => {
    const only = await addChannel('تنها کانال');

    await expect(config.deleteChannel(ADMIN_ID, only)).resolves.toBeUndefined();
    await expect(config.listChannels()).resolves.toEqual([]);
  });

  it('warns before the switch rather than after it', async () => {
    const status = await config.status();

    expect(status.membershipRequired).toBe(false);
    expect(status.warnings).toContain('NO_CHANNELS');
  });

  it('records old and new values in the audit trail', async () => {
    await addChannel('کانال');
    await config.update(ADMIN_ID, { membershipRequired: true, requiredActions: ['EVENT_JOIN'] });

    const rows = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'channel.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual([
      'channel.required_channel_created',
      'channel.config_updated',
    ]);
    expect(rows[1]?.before).toMatchObject({ membershipRequired: false });
    expect(rows[1]?.after).toMatchObject({
      membershipRequired: true,
      requiredActions: 'EVENT_JOIN',
    });
  });

  it('never stores or returns anything token-shaped', async () => {
    await addChannel('کانال');
    const status = await config.status();

    // The bot token is an environment variable and neither table has a column for
    // one. Asserted rather than assumed, because "there is no field for it" is
    // exactly the kind of thing a later migration quietly changes.
    expect(Object.keys(status)).not.toContain('botToken');
    expect(JSON.stringify(status)).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{30,}/);
  });
});
