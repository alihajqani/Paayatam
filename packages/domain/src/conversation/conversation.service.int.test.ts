import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { MessageCipher } from '../chat/message-cipher';
import { ConversationService, DRAFT_TTL_DAYS, asCreateEventForm } from './conversation.service';

/**
 * The conversation store against a real database.
 *
 * The two properties worth a real Postgres are both properties *of* Postgres:
 * the UNIQUE index that makes one wizard per user true rather than intended, and
 * the round trip through an encrypted column — a draft that cannot be read back
 * is a draft that silently loses somebody's typing, and only a real column
 * proves it can.
 *
 * The third property, idempotency, is not Postgres's but it is the one ADR-0017
 * puts in place of "the bot has no memory", so it is asserted here rather than
 * against a mock that would agree with whatever the code does.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-15T09:00:00.000Z'));
const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
} as never);
const conversations = new ConversationService(service, cipher, clock);

let userId: string;

beforeEach(async () => {
  await resetDatabase(prisma);
  userId = await createUser(prisma);
});

describe('starting a wizard', () => {
  it('opens at the first step and stores nothing else', async () => {
    const outcome = await conversations.start(userId, 'CREATE_EVENT', 1);

    expect(outcome.kind).toBe('step');
    if (outcome.kind === 'step') {
      expect(outcome.step.key).toBe('title');
      expect(outcome.position).toBe(1);
    }
    expect(await conversations.current(userId)).toMatchObject({ step: 'title', form: {} });
  });

  /**
   * Somebody who types `/create_event` half-way through another form has said
   * what they want. «شما در حال انجام کار دیگری هستید» is the product arguing
   * with them about a form only they can see.
   */
  it('replaces a conversation already in progress', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.handle(userId, 2, { kind: 'text', value: 'کوهنوردی درکه' });
    await conversations.start(userId, 'CREATE_EVENT', 3);

    expect(await conversations.current(userId)).toMatchObject({ step: 'title', form: {} });
    expect(await prisma.conversationState.count({ where: { userId } })).toBe(1);
  });
});

describe('advancing', () => {
  beforeEach(async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
  });

  it('moves to the next step and keeps the answer', async () => {
    const outcome = await conversations.handle(userId, 2, {
      kind: 'text',
      value: 'کوهنوردی درکه',
    });

    expect(outcome?.kind).toBe('step');
    if (outcome?.kind === 'step') expect(outcome.step.key).toBe('desc');

    const stored = await conversations.current(userId);
    expect(asCreateEventForm(stored!.form).title).toBe('کوهنوردی درکه');
  });

  /** A rejected answer re-renders the same question with the reason above it. */
  it('holds the step and reports why, on a bad answer', async () => {
    const outcome = await conversations.handle(userId, 2, { kind: 'text', value: 'ab' });

    expect(outcome?.kind).toBe('step');
    if (outcome?.kind === 'step') {
      expect(outcome.step.key).toBe('title');
      expect(outcome.error).toBeDefined();
    }
    expect(await conversations.current(userId)).toMatchObject({ step: 'title' });
  });

  it('walks back over «بازگشت»', async () => {
    await conversations.handle(userId, 2, { kind: 'text', value: 'کوهنوردی درکه' });
    const outcome = await conversations.handle(userId, 3, {
      kind: 'callback',
      action: 'back',
      value: '',
    });

    if (outcome?.kind === 'step') expect(outcome.step.key).toBe('title');
  });

  it('is null for somebody who is not in a wizard', async () => {
    const other = await createUser(prisma);

    expect(await conversations.handle(other, 2, { kind: 'text', value: 'x' })).toBeNull();
  });
});

describe('idempotency', () => {
  /**
   * The property ADR-0017 puts in place of "the bot has no memory". Telegram
   * retries any webhook call that did not answer 200; advancing twice would skip
   * a question, leaving the user looking at the answer to one never asked.
   */
  it('re-renders rather than advancing, on a redelivered update', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 10);
    await conversations.handle(userId, 11, { kind: 'text', value: 'کوهنوردی درکه' });

    const replay = await conversations.handle(userId, 11, {
      kind: 'text',
      value: 'کوهنوردی درکه',
    });

    expect(replay?.kind).toBe('redelivery');
    expect(await conversations.current(userId)).toMatchObject({ step: 'desc' });
  });

  it('treats an older update as a redelivery too', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 10);
    await conversations.handle(userId, 11, { kind: 'text', value: 'کوهنوردی درکه' });

    expect((await conversations.handle(userId, 5, { kind: 'text', value: 'x' }))?.kind).toBe(
      'redelivery',
    );
  });

  /** A rejected answer still consumes its update, or the complaint repeats. */
  it('consumes the update even when the answer was refused', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 10);
    await conversations.handle(userId, 11, { kind: 'text', value: 'ab' });

    expect((await conversations.handle(userId, 11, { kind: 'text', value: 'ab' }))?.kind).toBe(
      'redelivery',
    );
  });
});

describe('storage', () => {
  /** A draft that cannot be read back silently loses somebody's typing. */
  it('round-trips a form through the encrypted column', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.handle(userId, 2, { kind: 'text', value: 'کوهنوردی درکه' });
    await conversations.handle(userId, 3, {
      kind: 'text',
      value: 'یک صبح زود، از دربند تا شیرپلا.',
    });

    const form = asCreateEventForm((await conversations.current(userId))!.form);
    expect(form.title).toBe('کوهنوردی درکه');
    expect(form.description).toBe('یک صبح زود، از دربند تا شیرپلا.');
  });

  /** Nothing readable is stored in the clear. */
  it('writes no plaintext into the row', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.handle(userId, 2, { kind: 'text', value: 'کوهنوردی درکه' });

    const row = await prisma.conversationState.findUniqueOrThrow({ where: { userId } });
    expect(Buffer.from(row.formDataCiphertext).toString('utf8')).not.toContain('کوهنوردی');
  });

  it('sets the seven-day clock ADR-0017 chose', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);

    const row = await prisma.conversationState.findUniqueOrThrow({ where: { userId } });
    const days = (row.expiresAt.getTime() - clock.now().getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(DRAFT_TTL_DAYS);
  });
});

describe('purgeExpired', () => {
  it('deletes a draft past its deadline and leaves a live one', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    const other = await createUser(prisma);
    await conversations.start(other, 'CREATE_EVENT', 2);
    await prisma.conversationState.update({
      where: { userId: other },
      data: { expiresAt: new Date(clock.now().getTime() - 1000) },
    });

    expect(await conversations.purgeExpired()).toBe(1);
    expect(await conversations.current(userId)).not.toBeNull();
    expect(await conversations.current(other)).toBeNull();
  });
});

describe('one user cannot reach another’s draft', () => {
  /**
   * The security property ADR-0017 and the threat model both claim, asserted
   * rather than argued. A wizard callback carries a step and a value and no
   * draft id, so the only way to advance a draft is to *be* the account it
   * belongs to — this drives two conversations side by side and checks neither
   * moves the other.
   */
  it('keeps two conversations independent', async () => {
    const other = await createUser(prisma);

    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.start(other, 'CREATE_EVENT', 2);

    await conversations.handle(userId, 3, { kind: 'text', value: 'فعالیت اول' });

    expect(await conversations.current(other)).toMatchObject({ step: 'title', form: {} });
    const mine = asCreateEventForm((await conversations.current(userId))!.form);
    expect(mine.title).toBe('فعالیت اول');
  });

  /** Each conversation carries its own idempotency high-water mark. */
  it('does not let one user’s update id silence another’s', async () => {
    const other = await createUser(prisma);

    await conversations.start(userId, 'CREATE_EVENT', 100);
    await conversations.start(other, 'CREATE_EVENT', 1);

    // An update id far below the *other* user's, but new for this one.
    const outcome = await conversations.handle(other, 2, { kind: 'text', value: 'فعالیت دوم' });

    expect(outcome?.kind).toBe('step');
    expect(await conversations.current(other)).toMatchObject({ step: 'desc' });
  });
});

describe('one wizard per user', () => {
  /** The UNIQUE index is the authorisation model, not only tidiness. */
  it('is enforced by the database', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);

    await expect(
      prisma.conversationState.create({
        data: {
          userId,
          kind: 'CREATE_EVENT',
          step: 'title',
          formDataCiphertext: Buffer.alloc(1),
          formDataNonce: Buffer.alloc(1),
          keyVersion: 1,
          lastUpdateId: BigInt(1),
          expiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('a tap from a keyboard the wizard has moved past', () => {
  /**
   * Production's most confusing symptom, reported as «the Free button is
   * broken». Every step used to send a *new* message, so the chat filled with
   * old keyboards; tapping one sent a callback for a step long since left, and
   * the current step refused it with a message about an entirely different
   * field — «رایگان» answering «نام فعالیت را بنویسید».
   */
  it('re-renders the current step instead of refusing', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);

    // The wizard is on `title`; this is a tap from a cost keyboard.
    const outcome = await conversations.handle(userId, 2, {
      kind: 'callback',
      action: 'cost',
      value: 'FREE',
    });

    expect(outcome?.kind).toBe('step');
    if (outcome?.kind === 'step') {
      expect(outcome.step.key).toBe('title');
      // No complaint: the user did nothing wrong.
      expect(outcome.error).toBeUndefined();
    }
  });

  /** It is still a real update and must not be replayable. */
  it('consumes the update', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.handle(userId, 2, { kind: 'callback', action: 'cost', value: 'FREE' });

    expect(
      (await conversations.handle(userId, 2, { kind: 'callback', action: 'cost', value: 'FREE' }))
        ?.kind,
    ).toBe('redelivery');
  });

  /** A control verb belongs to no step — «می‌پذیرم» is an answer wherever offered. */
  it('does not mistake a control for a stale tap', async () => {
    await conversations.start(userId, 'ACCEPT_POLICIES', 1);

    const outcome = await conversations.handle(userId, 2, {
      kind: 'callback',
      action: 'agree',
      value: '',
    });

    expect(outcome?.kind).toBe('summary');
  });
});

describe('rememberMessage', () => {
  /**
   * The field that makes a wizard a screen. Nothing set it in v0.4.0 — only the
   * worker's GONE fallback did — so it stayed null and `paint` sent a new
   * message every step.
   */
  it('records the message the wizard is drawn on', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    expect((await conversations.current(userId))?.lastMessageId).toBeNull();

    await conversations.rememberMessage(userId, 4242);

    expect((await conversations.current(userId))?.lastMessageId).toBe(4242);
  });

  it('survives the next step', async () => {
    await conversations.start(userId, 'CREATE_EVENT', 1);
    await conversations.rememberMessage(userId, 4242);
    await conversations.handle(userId, 2, { kind: 'text', value: 'کوهنوردی درکه' });

    expect((await conversations.current(userId))?.lastMessageId).toBe(4242);
  });
});
