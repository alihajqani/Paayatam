import { describe, expect, it } from 'vitest';
import { parseUpdate } from './update';

/**
 * The narrowing adapter, which is the anonymity boundary on the inbound side.
 *
 * `inbound-message.ts` states the rule: *"Whoever adapts a real Telegram update
 * into this shape is therefore the one place that touches the wide object, and it
 * hands over four fields."* These tests assert the *stripping*, not just the
 * routing — a parser that returned the right intent while carrying `forward_from`
 * along inside it would pass a routing test and fail the product's central promise.
 */

const FROM = { id: 573_914_882, first_name: 'علی', username: 'leaky_handle', language_code: 'fa' };
const PRIVATE = { id: 573_914_882, type: 'private' };

function update(body: Record<string, unknown>): Record<string, unknown> {
  return { update_id: 1001, ...body };
}

describe('/start', () => {
  it('is recognised with no payload', () => {
    const parsed = parseUpdate(
      update({ message: { message_id: 5, from: FROM, chat: PRIVATE, text: '/start' } }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'START', payload: null });
    expect(parsed?.updateId).toBe(1001);
  });

  it('carries the deep-link payload', () => {
    const parsed = parseUpdate(
      update({ message: { message_id: 5, from: FROM, chat: PRIVATE, text: '/start ABCD2345' } }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'START', payload: 'ABCD2345' });
  });

  /** Telegram appends the bot's username when the command comes from a group. */
  it('tolerates the @bot suffix', () => {
    const parsed = parseUpdate(
      update({
        message: { message_id: 5, from: FROM, chat: PRIVATE, text: '/start@payetam_bot CODE' },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'START', payload: 'CODE' });
  });

  /**
   * The sender reaches identity creation, so exactly the four fields
   * `findOrCreateByTelegram` needs survive — and the id is a bigint, because
   * `telegram_account.telegram_user_id` is one.
   */
  it('hands over the sender as four fields', () => {
    const parsed = parseUpdate(
      update({ message: { message_id: 5, from: FROM, chat: PRIVATE, text: '/start' } }),
    );

    expect(parsed?.intent.from).toEqual({
      telegramUserId: 573_914_882n,
      firstName: 'علی',
      username: 'leaky_handle',
      languageCode: 'fa',
    });
  });
});

/**
 * Any other command is named rather than relayed.
 *
 * Without this, `/help` typed by somebody with one open chat would be delivered to
 * a stranger as a message reading «/help».
 */
describe('an unknown command', () => {
  it('is a COMMAND, not a chat message', () => {
    const parsed = parseUpdate(
      update({ message: { message_id: 5, from: FROM, chat: PRIVATE, text: '/help' } }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'COMMAND', command: 'help' });
  });
});

describe('plain text', () => {
  it('becomes a relayable message with its Telegram id', () => {
    const parsed = parseUpdate(
      update({
        message: { message_id: 42, from: FROM, chat: PRIVATE, text: 'ساعت هفت جلوی کافه' },
      }),
    );

    expect(parsed?.intent).toMatchObject({
      kind: 'TEXT',
      message: { text: 'ساعت هفت جلوی کافه', telegramMessageId: 42 },
      replyToMessageId: null,
    });
  });

  it('carries the id of the message it replies to', () => {
    const parsed = parseUpdate(
      update({
        message: {
          message_id: 42,
          from: FROM,
          chat: PRIVATE,
          text: 'باشه',
          reply_to_message: { message_id: 40, from: { id: 999, is_bot: true } },
        },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'TEXT', replyToMessageId: 40 });
  });

  /**
   * The `text_mention` entity survives, and it must: it carries a third party's raw
   * Telegram id, and it is the one entity whose payload cannot be recovered from the
   * text — so the sanitizer has to be able to see it in order to drop it.
   */
  it('keeps entities so the sanitizer can drop them', () => {
    const parsed = parseUpdate(
      update({
        message: {
          message_id: 42,
          from: FROM,
          chat: PRIVATE,
          text: 'با علی هماهنگ کن',
          entities: [{ type: 'text_mention', offset: 3, length: 3, user: { id: 12_345 } }],
        },
      }),
    );

    expect(parsed?.intent).toMatchObject({
      kind: 'TEXT',
      message: { entities: [{ type: 'text_mention', user: { id: 12_345 } }] },
    });
  });
});

/**
 * The property the whole file exists for.
 *
 * Zod strips unknown keys, so a field nobody named is *removed by parsing* rather
 * than merely left unread. That is what makes "the relay physically cannot see
 * `forward_from`" true of the next field Telegram adds as well as of today's.
 */
describe('the fields that must not survive', () => {
  it('drops forwarding, quoting and sender-chat metadata', () => {
    const parsed = parseUpdate(
      update({
        message: {
          message_id: 42,
          from: { ...FROM, is_premium: true },
          chat: PRIVATE,
          text: 'سلام',
          forward_from: { id: 111, username: 'somebody_else' },
          forward_origin: { type: 'user', sender_user: { id: 111 } },
          sender_chat: { id: -100, type: 'channel' },
          via_bot: { id: 222, username: 'another_bot' },
          reply_to_message: { message_id: 40, from: { id: 333, username: 'third_party' } },
          contact: { phone_number: '+989121234567' },
        },
      }),
    );

    const serialised = JSON.stringify(parsed, (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );

    expect(serialised).not.toContain('somebody_else');
    expect(serialised).not.toContain('third_party');
    expect(serialised).not.toContain('another_bot');
    expect(serialised).not.toContain('989121234567');
    expect(serialised).not.toContain('sender_chat');
    // The reply *id* is kept — it is how the relay finds the conversation.
    expect(parsed?.intent).toMatchObject({ kind: 'TEXT', replyToMessageId: 40 });
  });
});

describe('anything that is not text', () => {
  it.each([
    ['a voice note', { voice: { file_id: 'x', file_unique_id: 'y', duration: 3 } }],
    ['a contact card', { contact: { phone_number: '+989121234567', first_name: 'a' } }],
    ['a location', { location: { latitude: 35.7, longitude: 51.4 } }],
  ])('%s is UNSUPPORTED', (_name, content) => {
    const parsed = parseUpdate(
      update({ message: { message_id: 7, from: FROM, chat: PRIVATE, ...content } }),
    );

    expect(parsed?.intent.kind).toBe('UNSUPPORTED');
  });
});

/**
 * A photo is its own intent as of v0.6.5, and it used to be UNSUPPORTED.
 *
 * Criterion 11 is about the **chat relay** — an image forwarded between two
 * strangers is a payload the product cannot moderate, encrypt or account for.
 * It was never an argument about the bug-report form, where the screenshot *is*
 * the report. `BotService` still answers the old Persian refusal when no wizard
 * wants the photo, so nothing about the relay changed.
 */
describe('a photo', () => {
  it('is its own intent, carrying the file id', () => {
    const parsed = parseUpdate(
      update({
        message: {
          message_id: 7,
          from: FROM,
          chat: PRIVATE,
          photo: [{ file_id: 'small', file_unique_id: 'y', width: 90, height: 90 }],
        },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'PHOTO', fileId: 'small' });
  });

  /**
   * Telegram sends several renditions of one image. A thumbnail is not a
   * screenshot anybody can read a button label off, so the biggest is taken —
   * by area rather than by position, because "smallest first" is a documented
   * habit rather than a guarantee.
   */
  it('takes the largest rendition, whatever order they arrive in', () => {
    const parsed = parseUpdate(
      update({
        message: {
          message_id: 7,
          from: FROM,
          chat: PRIVATE,
          photo: [
            { file_id: 'big', file_unique_id: 'a', width: 1280, height: 720 },
            { file_id: 'tiny', file_unique_id: 'b', width: 90, height: 51 },
          ],
        },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'PHOTO', fileId: 'big' });
  });

  it('carries a caption when there is one, and omits the key when there is not', () => {
    const withCaption = parseUpdate(
      update({
        message: {
          message_id: 7,
          from: FROM,
          chat: PRIVATE,
          photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
          caption: '  دکمه کار نمی‌کند  ',
        },
      }),
    );
    const without = parseUpdate(
      update({
        message: {
          message_id: 7,
          from: FROM,
          chat: PRIVATE,
          photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
        },
      }),
    );

    expect(withCaption?.intent).toMatchObject({ caption: 'دکمه کار نمی‌کند' });
    expect(without?.intent).not.toHaveProperty('caption');
  });

  /** An empty `photo` array is not a photo. It is something this build refuses. */
  it('is UNSUPPORTED when the array is empty', () => {
    const parsed = parseUpdate(
      update({ message: { message_id: 7, from: FROM, chat: PRIVATE, photo: [] } }),
    );

    expect(parsed?.intent.kind).toBe('UNSUPPORTED');
  });
});

describe('edited_message', () => {
  it('becomes EDITED_TEXT with the original message id', () => {
    const parsed = parseUpdate(
      update({
        edited_message: { message_id: 42, from: FROM, chat: PRIVATE, text: 'ساعت هشت' },
      }),
    );

    expect(parsed?.intent).toMatchObject({
      kind: 'EDITED_TEXT',
      message: { text: 'ساعت هشت', telegramMessageId: 42 },
    });
  });

  /** A caption edit on a photo has no text to propagate. */
  it('is ignored when the edit left no text', () => {
    const parsed = parseUpdate(
      update({ edited_message: { message_id: 42, from: FROM, chat: PRIVATE } }),
    );

    expect(parsed).toBeNull();
  });
});

describe('callback_query', () => {
  it('carries the query id and the opaque data', () => {
    const parsed = parseUpdate(
      update({ callback_query: { id: 'q-1', from: FROM, data: 'chat:accept:x' } }),
    );

    expect(parsed?.intent).toMatchObject({
      kind: 'CALLBACK',
      callbackQueryId: 'q-1',
      data: 'chat:accept:x',
    });
  });

  it('is ignored when there is no data to act on', () => {
    expect(parseUpdate(update({ callback_query: { id: 'q-1', from: FROM } }))).toBeNull();
  });
});

describe('my_chat_member', () => {
  it('reads "kicked" as the bot being blocked', () => {
    const parsed = parseUpdate(
      update({
        my_chat_member: { chat: PRIVATE, from: FROM, new_chat_member: { status: 'kicked' } },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'BLOCK_CHANGED', blocked: true });
  });

  it('reads "member" as unblocked', () => {
    const parsed = parseUpdate(
      update({
        my_chat_member: { chat: PRIVATE, from: FROM, new_chat_member: { status: 'member' } },
      }),
    );

    expect(parsed?.intent).toMatchObject({ kind: 'BLOCK_CHANGED', blocked: false });
  });

  /**
   * The bot is an administrator of its own channel (M14), and that membership
   * changing is not somebody blocking us. Reading it as one would mark the channel
   * as a blocked user.
   */
  it('ignores a membership change outside a private chat', () => {
    const parsed = parseUpdate(
      update({
        my_chat_member: {
          chat: { id: -1_001, type: 'channel' },
          from: FROM,
          new_chat_member: { status: 'kicked' },
        },
      }),
    );

    expect(parsed).toBeNull();
  });
});

describe('what is ignored quietly', () => {
  /** Null is the common case, and the webhook still answers 200 (ADR-0004). */
  it.each([
    [
      'a post in our own channel',
      { channel_post: { message_id: 1, chat: { id: -1, type: 'channel' } } },
    ],
    ['a poll answer', { poll_answer: { poll_id: '1', option_ids: [0] } }],
    [
      'a group message',
      { message: { message_id: 1, from: FROM, chat: { id: -1, type: 'group' }, text: 'hi' } },
    ],
    [
      'a message from another bot',
      { message: { message_id: 1, from: { ...FROM, is_bot: true }, chat: PRIVATE, text: 'hi' } },
    ],
    ['a message with no sender', { message: { message_id: 1, chat: PRIVATE, text: 'hi' } }],
  ])('%s', (_name, body) => {
    expect(parseUpdate(update(body))).toBeNull();
  });

  it.each([
    ['not an object', 'not an update'],
    ['null', null],
    ['missing update_id', { message: { message_id: 1, chat: PRIVATE, text: 'hi' } }],
    ['a hostile update_id', { update_id: 'drop table', message: {} }],
  ])('%s is refused rather than thrown over', (_name, body) => {
    expect(parseUpdate(body)).toBeNull();
  });
});
