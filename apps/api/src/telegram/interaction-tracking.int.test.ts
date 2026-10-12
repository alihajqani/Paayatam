import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { InteractionService, normalize } from '@payetam/domain';
import { ERROR_MESSAGES_FA } from '@payetam/shared';
import { encodeAdminCallback, encodeEventCallback } from '@payetam/telegram';
import {
  TEST_CHAT_ENCRYPTION_KEY,
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';

/**
 * Interaction tracking, through the real webhook (migration 0065).
 *
 * Every assertion here is about a row somebody will read in a report, so the
 * updates go in the way Telegram sends them — the controller, the secret check,
 * `parseUpdate`, the whole of `BotService` — and the row is read back from
 * Postgres. A unit test over `dispatch` would prove the hook is called; it
 * could not prove that the six places which annotate an interaction are the
 * places the product actually passes through.
 *
 * The harness is `webhook.int.test.ts`'s, trimmed to what these cases need.
 */

const SECRET_PATH = 'b0f034bb437b9f4d8469b6df04ca1373';
const SECRET_TOKEN = '2cc88ab81c8272b5dfffbe06ce00d2899633f01738d213c3849e7c3639e118fc';

process.env['TELEGRAM_WEBHOOK_SECRET_PATH'] = SECRET_PATH;
process.env['TELEGRAM_WEBHOOK_SECRET_TOKEN'] = SECRET_TOKEN;
process.env['TELEGRAM_BOT_TOKEN'] ??= '1234567890:LOCAL-DEV-ONLY-NOT-A-REAL-TOKEN-0001';
process.env['CHAT_ENCRYPTION_KEY'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);
process.env['TELEGRAM_CHANNEL_ID'] ||= '@payetam_test';

const prisma: PrismaClient = createTestPrisma();

let app: NestFastifyApplication;
let fixture: CatalogFixture;

const HOST_TELEGRAM_ID = 573_914_882;
const GUEST_TELEGRAM_ID = 601_222_333;
const NEWCOMER_TELEGRAM_ID = 733_818_204;
const STRANGER_TELEGRAM_ID = 799_000_111;

let updateSequence = 80_000;
let telegramMessageSequence = 300;

interface Sender {
  id: number;
  first_name: string;
  language_code: string;
}

function sender(id: number): Sender {
  return { id, first_name: 'علی', language_code: 'fa' };
}

function update(body: Record<string, unknown>): Record<string, unknown> {
  updateSequence += 1;
  return { update_id: updateSequence, ...body };
}

function typed(telegramUserId: number, text: string): Record<string, unknown> {
  telegramMessageSequence += 1;
  return update({
    message: {
      message_id: telegramMessageSequence,
      from: sender(telegramUserId),
      chat: { id: telegramUserId, type: 'private' },
      text,
    },
  });
}

function tapped(telegramUserId: number, data: string, messageId = 55): Record<string, unknown> {
  return update({
    callback_query: {
      id: `cb-${String(updateSequence + 1)}`,
      from: sender(telegramUserId),
      message: { message_id: messageId, chat: { id: telegramUserId, type: 'private' } },
      data,
    },
  });
}

async function post(payload: Record<string, unknown>): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: `/telegram/webhook/${SECRET_PATH}`,
    headers: { 'x-telegram-bot-api-secret-token': SECRET_TOKEN },
    payload,
  });
  return response.statusCode;
}

/** Every recorded interaction, in the order the updates were sent. */
async function recorded() {
  return prisma.botInteraction.findMany({ orderBy: { updateId: 'asc' } });
}

async function internalIdOf(telegramUserId: number): Promise<string> {
  const account = await prisma.telegramAccount.findUniqueOrThrow({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { userId: true },
  });
  return account.userId;
}

async function seedMember(
  telegramUserId: number,
  onboardingState: 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE' = 'PROFILE_COMPLETE',
): Promise<string> {
  const member = await prisma.user.create({
    data: {
      onboardingState,
      telegramAccount: { create: { telegramUserId: BigInt(telegramUserId) } },
      ...(onboardingState === 'PROFILE_COMPLETE'
        ? {
            profile: {
              create: { displayName: 'عضو', cityId: fixture.tehranId, birthYear: 1995 },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  await prisma.coinAccount.create({ data: { userId: member.id, balance: 1_000 } });
  return member.id;
}

async function seedEvent(hostUserId: string): Promise<string> {
  const title = 'دورهمی بازی رومیزی';
  const description = 'یک شب دوستانه برای بازی و گفتگو.';
  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await prisma.event.create({
    data: {
      hostUserId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { publicId: true },
  });
  return event.publicId;
}

beforeAll(async () => {
  // The built module, as `webhook.int.test.ts` loads it: decorator metadata
  // survives `tsc` and does not survive esbuild (ADR-0013).
  const { AppModule } = (await import('../../dist/app.module.js')) as { AppModule: unknown };

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

describe('what a link brought', () => {
  it('records the /start that creates an account, and marks it', async () => {
    await post(typed(NEWCOMER_TELEGRAM_ID, '/start'));

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'START',
      action: 'start:direct',
      ref: null,
      createdAccount: true,
      userId: await internalIdOf(NEWCOMER_TELEGRAM_ID),
      outcome: 'OK',
    });
    expect(rows[0]?.screen).not.toBeNull();
    expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The gap `user_acquisition` leaves: it is written once, so a member who
   * follows an ad link a week later is invisible there. Here it is a second
   * row, attributed to the campaign and marked as somebody who was already in.
   */
  it('records a member following a campaign link as a returning tap', async () => {
    await post(typed(NEWCOMER_TELEGRAM_ID, '/start'));
    await post(typed(NEWCOMER_TELEGRAM_ID, '/start src_TgAds_1'));

    const rows = await recorded();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      action: 'start:campaign',
      ref: 'tgads_1',
      createdAccount: false,
    });
    expect(await prisma.userAcquisition.count()).toBe(1);
  });

  it('records a member following an event link, with the event it names', async () => {
    const hostId = await seedMember(HOST_TELEGRAM_ID);
    const eventPublicId = await seedEvent(hostId);
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, `/start event_${eventPublicId}`));

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'START',
      action: 'start:event',
      ref: eventPublicId,
      createdAccount: false,
      screen: 'bot.event_detail',
    });
  });

  /** Telegram redelivers any update whose webhook call did not answer 200. */
  it('counts a redelivered update once', async () => {
    const delivery = typed(NEWCOMER_TELEGRAM_ID, '/start');
    await post(delivery);
    await post(delivery);

    expect(await recorded()).toHaveLength(1);
  });
});

describe('what was pressed', () => {
  it('records a button with its verb, its target, the message and the screen', async () => {
    const hostId = await seedMember(HOST_TELEGRAM_ID);
    const eventPublicId = await seedEvent(hostId);
    const guestId = await seedMember(GUEST_TELEGRAM_ID);

    await post(tapped(GUEST_TELEGRAM_ID, encodeEventCallback('show', eventPublicId), 91));

    expect(await recorded()).toMatchObject([
      {
        kind: 'CALLBACK',
        action: 'ev:show',
        ref: eventPublicId,
        messageId: 91,
        userId: guestId,
        outcome: 'OK',
        screen: 'bot.event_detail',
      },
    ]);
  });

  it('records a reply-keyboard tap as a button, not as text', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, '🔎 دیدن برنامه‌ها'));

    expect(await recorded()).toMatchObject([
      { kind: 'KEYBOARD', action: 'kb:discover', outcome: 'OK', screen: 'bot.discover' },
    ]);
  });

  it('records a typed command by its name', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, '/balance'));

    expect(await recorded()).toMatchObject([
      { kind: 'COMMAND', action: 'cmd:balance', screen: 'bot.balance' },
    ]);
  });

  it('records a tap from somebody the bot does not know, against nobody', async () => {
    await post(tapped(STRANGER_TELEGRAM_ID, encodeEventCallback('show', fixture.categoryId)));

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: null, outcome: 'NO_ACCOUNT', action: 'ev:show' });
  });
});

describe('why somebody stopped', () => {
  /**
   * A host asking to join their own activity is refused by
   * `ParticipationService`, and the bot relays the Persian sentence. The row
   * keeps the *code*, which is what a report can count.
   */
  it('records a refusal with the error code that caused it', async () => {
    const hostId = await seedMember(HOST_TELEGRAM_ID);
    const eventPublicId = await seedEvent(hostId);

    await post(tapped(HOST_TELEGRAM_ID, encodeEventCallback('join', eventPublicId)));

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'ev:join', outcome: 'REFUSED' });
    expect(Object.keys(ERROR_MESSAGES_FA)).toContain(rows[0]?.detail);
    expect(await prisma.eventParticipant.count()).toBe(0);
  });

  it('records somebody sent back to finish signing up, and which step they owe', async () => {
    await seedMember(GUEST_TELEGRAM_ID, 'TERMS_ACCEPTED');

    await post(typed(GUEST_TELEGRAM_ID, '/discover'));

    expect(await recorded()).toMatchObject([
      { action: 'cmd:discover', outcome: 'GATED', detail: 'profile', screen: 'bot.wizard' },
    ]);
  });

  /** A moderator's button in the hands of somebody who is not one. */
  it('records a button the bot no longer honours', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(tapped(GUEST_TELEGRAM_ID, encodeAdminCallback('list', null)));

    expect(await recorded()).toMatchObject([{ action: 'ad:list', outcome: 'STALE' }]);
  });

  it('records a block against the person who blocked', async () => {
    const guestId = await seedMember(GUEST_TELEGRAM_ID);

    await post(
      update({
        my_chat_member: {
          chat: { id: GUEST_TELEGRAM_ID, type: 'private' },
          from: sender(GUEST_TELEGRAM_ID),
          new_chat_member: { status: 'kicked' },
        },
      }),
    );

    expect(await recorded()).toMatchObject([
      { kind: 'BLOCKED', action: 'blocked', userId: guestId },
    ]);
  });
});

describe('forms', () => {
  /**
   * The step recorded is the one **now on screen** — the question the person
   * was left looking at — so the last row of an abandoned form names where it
   * was abandoned.
   */
  it('records the form and the step left on screen, then the answer', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, '/bug'));
    await post(typed(GUEST_TELEGRAM_ID, 'دکمهٔ ثبت کار نمی‌کند'));

    expect(await recorded()).toMatchObject([
      { action: 'cmd:bug', wizardKind: 'BUG_REPORT', wizardStep: 'what', screen: 'bot.wizard' },
      { kind: 'TEXT', action: 'text:answer', wizardKind: 'BUG_REPORT', wizardStep: 'shots' },
    ]);
  });
});

describe('a form that is finished', () => {
  /**
   * Accepting the terms opens the profile form **in the same update**. The row
   * has one place for "the form now on screen", and the second form took it —
   * so the first was recorded as never finished, and the terms looked like a
   * form nobody completes. `finished_wizard` is the other fact: which form
   * this update submitted, whatever was drawn afterwards.
   */
  it('is recorded as finished even when the same update opens the next form', async () => {
    await prisma.policyVersion.create({
      data: {
        type: 'TERMS',
        version: 9,
        status: 'PUBLISHED',
        isCurrent: true,
        titleFa: 'قوانین',
        summaryFa: 'خلاصه',
        contentMd: '# سند',
      },
    });

    await post(typed(NEWCOMER_TELEGRAM_ID, '/start'));
    await post(tapped(NEWCOMER_TELEGRAM_ID, 'wz:agree:'));

    const rows = await recorded();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'start:direct',
      wizardKind: 'ACCEPT_POLICIES',
      finishedWizard: null,
    });
    expect(rows[1]).toMatchObject({
      action: 'wz:agree',
      finishedWizard: 'ACCEPT_POLICIES',
      wizardKind: 'EDIT_PROFILE',
      outcome: 'OK',
    });
    expect(rows[1]?.wizardStep).toMatch(/^[a-z0-9_]+$/);
  });

  /** Nothing is on screen after a form is sent, and the record says exactly that. */
  it('is recorded as finished with no form left on screen', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, '/bug'));
    await post(typed(GUEST_TELEGRAM_ID, 'دکمهٔ ثبت کار نمی‌کند'));
    await post(tapped(GUEST_TELEGRAM_ID, 'wz:skip:'));
    await post(tapped(GUEST_TELEGRAM_ID, 'wz:confirm:'));

    const rows = await recorded();
    expect(rows.map((row) => [row.wizardStep, row.finishedWizard])).toEqual([
      ['what', null],
      ['shots', null],
      ['$summary', null],
      [null, 'BUG_REPORT'],
    ]);
    expect(rows[3]).toMatchObject({ action: 'wz:confirm', wizardKind: null, outcome: 'OK' });
    expect(await prisma.bugReport.count()).toBe(1);
  });
});

describe('what is never kept', () => {
  it('records that something was typed, and nothing of what', async () => {
    await seedMember(GUEST_TELEGRAM_ID);
    const secret = 'شمارهٔ من ۰۹۱۲۱۲۳۴۵۶۷ است';

    await post(typed(GUEST_TELEGRAM_ID, secret));

    const rows = await recorded();
    expect(rows).toMatchObject([{ kind: 'TEXT', action: 'text:unclaimed' }]);
    const stored = JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(stored).not.toContain('۰۹۱۲');
    expect(stored).not.toContain('شماره');
  });

  it('holds no Telegram user id in any column', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(typed(GUEST_TELEGRAM_ID, '/balance'));
    await post(tapped(GUEST_TELEGRAM_ID, encodeAdminCallback('list', null)));

    const stored = JSON.stringify(await recorded(), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(stored).not.toContain(String(GUEST_TELEGRAM_ID));
  });

  /** The bot ignores edits, and Telegram sends one for every edit in the chat. */
  it('does not record an edit', async () => {
    await seedMember(GUEST_TELEGRAM_ID);

    await post(
      update({
        edited_message: {
          message_id: 7,
          from: sender(GUEST_TELEGRAM_ID),
          chat: { id: GUEST_TELEGRAM_ID, type: 'private' },
          text: 'اصلاح‌شده',
        },
      }),
    );

    expect(await recorded()).toHaveLength(0);
  });
});

describe('a recorder that fails', () => {
  /**
   * The report must never be able to break the product it reports on: the
   * reply was queued before the row is written, and the webhook still says 200.
   */
  it('costs the row and nothing else', async () => {
    await seedMember(GUEST_TELEGRAM_ID);
    const failing = vi
      .spyOn(app.get(InteractionService), 'record')
      .mockRejectedValueOnce(new Error('the database is on fire'));

    const status = await post(typed(GUEST_TELEGRAM_ID, '/balance'));

    expect(failing).toHaveBeenCalledTimes(1);
    expect(status).toBe(200);
    expect(await recorded()).toHaveLength(0);
    expect(await prisma.notification.count({ where: { templateKey: 'bot.balance' } })).toBe(1);

    failing.mockRestore();
  });
});
