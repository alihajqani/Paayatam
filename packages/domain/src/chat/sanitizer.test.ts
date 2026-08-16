import { describe, expect, it } from 'vitest';
import type { InboundTextMessage } from './inbound-message';
import { REDACTION_PLACEHOLDER, sanitizeInbound } from './sanitizer';

/**
 * The leak tests, written before the relay exists (plan, M8).
 *
 * That ordering is deliberate and worth keeping: this is the function that stands
 * between one user's typing and another user's screen, and the failure it guards
 * against — a Telegram identity crossing the boundary — is not one you can safely
 * discover in production. Writing the tests first means the relay is built against
 * a specification of what must never get through, rather than the tests being
 * written afterwards to describe whatever it happens to do.
 *
 * Everything here is pure. No database, no clock, no Telegram client.
 */

function message(overrides: Partial<InboundTextMessage> = {}): InboundTextMessage {
  return { text: 'سلام، برنامه ساعت چند شروع می‌شود؟', telegramMessageId: 1, ...overrides };
}

/** Nothing in the output may contain any of these, ever. */
function expectNoLeak(text: string): void {
  expect(text).not.toMatch(/@[A-Za-z0-9_]{5,}/);
  expect(text).not.toMatch(/t\.me\//i);
  expect(text).not.toMatch(/tg:\/\//i);
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(text).not.toMatch(/\d{7,}/);
}

describe('entities are dropped, all of them', () => {
  /**
   * The single most important test in the module. `text_mention` carries a raw
   * Telegram user id in the entity object — it appears nowhere in the text, so no
   * amount of string scanning would find it. It can only be handled by refusing
   * to pass entities on at all.
   */
  it('never lets a text_mention carry a Telegram id through', () => {
    const result = sanitizeInbound(
      message({
        text: 'سلام رضا، خوش آمدی',
        entities: [
          { type: 'text_mention', offset: 5, length: 3, user: { id: 573914882, username: 'reza' } },
        ],
      }),
    );

    expect(JSON.stringify(result.text)).not.toContain('573914882');
    expect(result.text).toBe('سلام رضا، خوش آمدی');
    // Recorded for moderation, and only there.
    expect(result.redactions).toContainEqual({
      kind: 'ENTITY',
      original: 'text_mention:573914882',
    });
  });

  it('strips a text_link whose destination never appeared in the text', () => {
    const result = sanitizeInbound(
      message({
        text: 'اینجا را ببین',
        entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://t.me/some_handle' }],
      }),
    );

    expectNoLeak(result.text);
    expect(result.redactions).toContainEqual({
      kind: 'ENTITY',
      original: 'text_link:https://t.me/some_handle',
    });
  });

  it('keeps the visible text of a link but not its destination', () => {
    const result = sanitizeInbound(
      message({
        text: 'کانال ما',
        entities: [{ type: 'text_link', offset: 0, length: 8, url: 'https://t.me/joinchat/xyz' }],
      }),
    );

    expect(result.text).toBe('کانال ما');
    expectNoLeak(result.text);
  });

  it('records nothing for harmless entities, and still drops them', () => {
    const result = sanitizeInbound(
      message({ text: 'خیلی مهم', entities: [{ type: 'bold', offset: 0, length: 4 }] }),
    );

    expect(result.text).toBe('خیلی مهم');
    expect(result.redactions).toEqual([]);
  });
});

describe('contact details in the text are masked', () => {
  it.each([
    ['an Iranian mobile', 'شماره‌ام ۰۹۱۲۱۲۳۴۵۶۷ است'],
    ['the same number in Latin digits', 'شماره‌ام 09121234567 است'],
    ['with the country code', 'تماس با +989121234567'],
    ['spaced out', 'تماس با 0912 123 4567'],
    ['hyphenated', 'تماس با 0912-123-4567'],
    ['dotted', 'تماس با 0912.123.4567'],
  ])('masks %s', (_label, text) => {
    const result = sanitizeInbound(message({ text }));

    expectNoLeak(result.text);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.redactions.some((r) => r.kind === 'PHONE')).toBe(true);
  });

  it.each([
    ['a username', 'به @my_handle پیام بده'],
    ['a t.me link', 'اینجا: https://t.me/my_handle'],
    ['a bare t.me link', 'اینجا: t.me/my_handle'],
    ['a telegram.me link', 'اینجا: telegram.me/my_handle'],
    ['a tg:// deep link', 'tg://resolve?domain=my_handle'],
    ['an email', 'به me@example.com ایمیل بزن'],
  ])('masks %s', (_label, text) => {
    const result = sanitizeInbound(message({ text }));

    expectNoLeak(result.text);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
  });

  /**
   * `t.me/handle` contains something the username rule finds attractive. If the
   * username rule ran first it would claim the tail and leave a bare `t.me/`
   * behind — a link that still tells the recipient where to look.
   */
  it('masks a t.me link whole, not just its handle', () => {
    const result = sanitizeInbound(message({ text: 'من اینجام https://t.me/reza_1990 بیا' }));

    expect(result.text).not.toContain('t.me');
    expect(result.text).not.toContain('reza_1990');
    expect(result.redactions.filter((r) => r.kind === 'TELEGRAM_LINK')).toHaveLength(1);
  });

  it('masks an email whole, rather than leaving its domain', () => {
    const result = sanitizeInbound(message({ text: 'reza.tehrani@gmail.com' }));

    expect(result.text).not.toContain('gmail.com');
    expect(result.text).not.toContain('reza.tehrani');
  });

  it('masks several details in one message, recording each', () => {
    const result = sanitizeInbound(
      message({ text: 'تلفن 09121234567 یا @reza_handle یا reza@example.com' }),
    );

    expectNoLeak(result.text);
    expect(result.redactions.map((r) => r.kind).sort()).toEqual(['EMAIL', 'PHONE', 'USERNAME']);
  });

  it('keeps the original of everything it removed, for moderation', () => {
    const result = sanitizeInbound(message({ text: 'به @reza_handle پیام بده' }));

    expect(result.redactions).toContainEqual({ kind: 'USERNAME', original: '@reza_handle' });
  });
});

describe('what must survive', () => {
  /**
   * The masking is only worth having if ordinary conversation gets through
   * untouched. A relay that mangles «ساعت ۵» is one people stop using, and a chat
   * people abandon for Telegram DMs defeats the entire anonymity design.
   */
  it.each([
    ['a plain question', 'سلام، برنامه ساعت چند شروع می‌شود؟'],
    ['a time', 'ساعت ۵ بعدازظهر می‌بینمت'],
    ['a short number', 'ما ۴ نفریم'],
    ['a price', 'حدود ۲۰۰ هزار تومان'],
    ['a year', 'از سال ۱۴۰۵ شروع شد'],
    ['a street address without a phone', 'خیابان ولیعصر، پلاک ۱۲'],
    ['an @ that is too short to be a handle', 'ایمیلم @ab است'],
  ])('leaves %s alone', (_label, text) => {
    const result = sanitizeInbound(message({ text }));

    expect(result.text).not.toContain(REDACTION_PLACEHOLDER);
    expect(result.redactions).toEqual([]);
  });

  it('normalises Persian digits so the rules see one alphabet', () => {
    const result = sanitizeInbound(message({ text: 'ما ۴ نفریم' }));
    expect(result.text).toBe('ما 4 نفریم');
  });
});

describe('after the sender has consented to share contact details', () => {
  /**
   * ADR-0009 masks "during the anonymous stage", and puts contact exchange behind
   * an explicit button, a confirmation and a `consent` row. Continuing to mask
   * after all three would be the platform overriding a consent it had just
   * recorded — and the user would watch their own number vanish with no
   * explanation.
   */
  it('lets a phone number through', () => {
    const result = sanitizeInbound(message({ text: 'شماره‌ام 09121234567 است' }), {
      maskContactDetails: false,
    });

    expect(result.text).toContain('09121234567');
    expect(result.redactions).toEqual([]);
    expect(result.isEmpty).toBe(false);
  });

  it('still normalises Persian digits', () => {
    const result = sanitizeInbound(message({ text: 'شماره‌ام ۰۹۱۲۱۲۳۴۵۶۷ است' }), {
      maskContactDetails: false,
    });

    expect(result.text).toContain('09121234567');
  });

  /**
   * The one thing consent does *not* unlock. A `text_mention` carries a third
   * party's raw Telegram id, and agreeing to share your own contact details is
   * not agreeing to hand over somebody else's — nor could the sender even see
   * that the entity was there to agree to.
   */
  it('still drops every entity', () => {
    const result = sanitizeInbound(
      message({
        text: 'سلام رضا',
        entities: [
          { type: 'text_mention', offset: 5, length: 3, user: { id: 573914882 } },
          { type: 'text_link', offset: 0, length: 4, url: 'https://t.me/someone' },
        ],
      }),
      { maskContactDetails: false },
    );

    expect(JSON.stringify(result.text)).not.toContain('573914882');
    expect(result.text).toBe('سلام رضا');
    expect(result.redactions.map((r) => r.kind)).toEqual(['ENTITY', 'ENTITY']);
  });

  it('masks by default, so a caller that forgets the option fails safe', () => {
    expect(sanitizeInbound(message({ text: 'تماس با 09121234567' })).text).toContain(
      REDACTION_PLACEHOLDER,
    );
  });
});

describe('a message that is nothing but contact details', () => {
  /**
   * Relaying a lone «حذف شد» tells the recipient nothing and looks like a bug.
   * The relay refuses to send it; the flag is how it knows.
   */
  it('is reported as empty', () => {
    const result = sanitizeInbound(message({ text: '09121234567' }));

    expect(result.isEmpty).toBe(true);
    expect(result.redactions).toHaveLength(1);
  });

  it('collapses a run of masked fragments into one', () => {
    const result = sanitizeInbound(message({ text: '09121234567 09121234568 09121234569' }));

    expect(result.text.match(new RegExp(REDACTION_PLACEHOLDER, 'g'))).toHaveLength(1);
    expect(result.redactions).toHaveLength(3);
  });

  it('is not reported empty when real words survive', () => {
    const result = sanitizeInbound(message({ text: 'سلام 09121234567' }));

    expect(result.isEmpty).toBe(false);
  });
});
