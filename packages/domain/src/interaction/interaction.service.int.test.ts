import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { InteractionService, type InteractionRecord } from './interaction.service';

/**
 * The one writer of `bot_interaction`, against the real table (migration 0065).
 *
 * A database rather than a unit test because the three properties that matter
 * are the table's, not the service's: a redelivered update is counted once
 * (the UNIQUE index), a typed sentence cannot be stored in a name column (the
 * CHECKs), and neither of those ever reaches the caller as a throw.
 */

const prisma: PrismaClient = createTestPrisma();
const interactions = new InteractionService(prisma as unknown as PrismaService);

let updateId = 5_000;
let userId: string;

function row(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  updateId += 1;
  return {
    updateId,
    userId,
    kind: 'CALLBACK',
    action: 'ev:show',
    ref: '11111111-1111-4111-8111-111111111111',
    createdAccount: false,
    messageId: 42,
    wizardKind: null,
    wizardStep: null,
    finishedWizard: null,
    outcome: 'OK',
    detail: null,
    screen: 'bot.event_detail',
    durationMs: 18,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  userId = await createUser(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('InteractionService.record', () => {
  it('writes one row, exactly as described', async () => {
    const written = await interactions.record(
      row({
        wizardKind: 'CREATE_EVENT',
        wizardStep: 'title',
        finishedWizard: 'ACCEPT_POLICIES',
        outcome: 'REFUSED',
        detail: 'EVENT_FULL',
      }),
    );

    expect(written).toBe(true);
    const stored = await prisma.botInteraction.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      updateId: BigInt(updateId),
      userId,
      kind: 'CALLBACK',
      action: 'ev:show',
      ref: '11111111-1111-4111-8111-111111111111',
      createdAccount: false,
      messageId: 42,
      wizardKind: 'CREATE_EVENT',
      wizardStep: 'title',
      finishedWizard: 'ACCEPT_POLICIES',
      outcome: 'REFUSED',
      detail: 'EVENT_FULL',
      screen: 'bot.event_detail',
      durationMs: 18,
    });
  });

  /**
   * Telegram redelivers any update whose webhook call did not answer 200. The
   * second delivery is the same tap, so it is the same row.
   */
  it('counts a redelivered update once, and says so without throwing', async () => {
    const first = row();
    expect(await interactions.record(first)).toBe(true);
    expect(await interactions.record({ ...first, outcome: 'FAILED' })).toBe(false);

    const stored = await prisma.botInteraction.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe('OK');
  });

  it('records somebody without an account, with no user', async () => {
    expect(await interactions.record(row({ userId: null, outcome: 'NO_ACCOUNT' }))).toBe(true);
    const stored = await prisma.botInteraction.findFirstOrThrow();
    expect(stored.userId).toBeNull();
    expect(stored.outcome).toBe('NO_ACCOUNT');
  });

  /**
   * The rule "no message text" is the writer's, and a writer gets edited. So it
   * is the table's as well: a sentence in a name column loses the row.
   */
  it.each([
    ['action', { action: 'شمارهٔ من ۰۹۱۲۰۰۰۰۰۰۰' }],
    ['action with spaces', { action: 'call me maybe' }],
    ['ref', { ref: 'سلام، خوبی؟' }],
    ['detail', { detail: 'my phone is 0912' }],
    ['screen', { screen: 'Hello there' }],
    ['wizard step', { wizardKind: 'CREATE_EVENT', wizardStep: 'یک جواب' }],
    ['finished wizard', { finishedWizard: 'my form' }],
  ] as const)('refuses typed text in %s, and does not throw', async (_column, overrides) => {
    expect(await interactions.record(row(overrides))).toBe(false);
    expect(await prisma.botInteraction.count()).toBe(0);
  });

  /** A duration read off a clock that went backwards is a zero, not a lost row. */
  it('clamps a negative duration', async () => {
    expect(await interactions.record(row({ durationMs: -5 }))).toBe(true);
    expect((await prisma.botInteraction.findFirstOrThrow()).durationMs).toBe(0);
  });

  it('goes with the user when the user is removed', async () => {
    await interactions.record(row());
    await prisma.telegramAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.botInteraction.count()).toBe(0);
  });
});
