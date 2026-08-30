import { describe, expect, it } from 'vitest';
import { escapeHtml, toPersianDigits } from './escape';
import { TEMPLATES, render } from './templates';
import { renderStep } from './wizard/render';

/** Every button's link is built from it, so it is stated once and asserted on. */
const BOT = 'payetam_test_bot';

/**
 * T9's unit test: "bot HTML templates pass every user value through a
 * unit-tested `escapeHtml()`".
 *
 * The threat is concrete. Telegram's `parse_mode: 'HTML'` is what gives the bot
 * bold text and links, and it is also what turns an event title into markup. A
 * host who names their event `<a href="http://evil">tap here</a>` would otherwise
 * have the platform send that link, in a message the recipient has every reason to
 * trust.
 */
describe('escapeHtml', () => {
  it.each([
    ['<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;'],
    ['a & b', 'a &amp; b'],
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['5 > 3', '5 &gt; 3'],
  ])('escapes %o', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  /** Ampersand first, or the escapes escape each other into nonsense. */
  it('does not double-escape its own output', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves Persian text alone', () => {
    expect(escapeHtml('شب بازی رومیزی')).toBe('شب بازی رومیزی');
  });
});

describe('toPersianDigits', () => {
  it('converts digits and leaves everything else', () => {
    expect(toPersianDigits(2026)).toBe('۲۰۲۶');
    expect(toPersianDigits('۷ روز')).toBe('۷ روز');
    expect(toPersianDigits('3 روز')).toBe('۳ روز');
  });
});

/**
 * The property that matters more than any single template: **no user-authored
 * value reaches a message body as markup**.
 *
 * Asserted by feeding a tag into every interpolated field of every template and
 * checking that no template emits a tag it did not write itself. The escaped text
 * still *reads* as `<img src=x onerror=…>` — that is the point, the recipient sees
 * what was written rather than having it rendered — so the assertion is about the
 * angle brackets, not about the words between them.
 */
describe('no template emits injected markup', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';
  const FIELDS = {
    eventTitle: HOSTILE,
    senderAlias: HOSTILE,
    text: HOSTILE,
    replacementText: HOSTILE,
    participantPublicId: HOSTILE,
    chatPublicId: HOSTILE,
    daysLeft: 7,
    pendingCoins: 5,
  };
  const OWN_MARKUP = new Set(['<b>', '</b>', '<i>', '</i>']);

  /**
   * The templates whose `text` is *not* user input.
   *
   * `BOT_WIZARD` carries a body `renderStep` has already assembled, including its
   * own `<b>`/`<i>`, and having escaped every user-supplied value it
   * interpolated. Escaping it again renders `&lt;i&gt;` at the user.
   *
   * **So the escaping invariant moves rather than disappears**: it is
   * `renderStep`'s instead of the template's, and it is tested in the
   * `BOT_WIZARD` block below, which feeds a hostile *prompt* through the renderer
   * and asserts it comes out escaped. What is exempted here is only the second
   * escape of an already-escaped string.
   *
   * ── The six that were escaped twice ─────────────────────────────────────────
   *
   * The digests were not on this list and should have been from the day they
   * were written. `formatMyRequests`, `formatMyEvents`, `formatMyChats`,
   * `formatDiscovered`, `formatPendingReviews` and `formatStanding` all build
   * `<b>`-marked lists and all escape at the interpolation; `render` then escaped
   * the finished body a **second** time, so the tags survived as text and
   * `/myevents` answered with a literal `<b>سفر شمال</b>`. Five commands and
   * `/terms` read like a view-source of themselves, and this test passed the
   * whole time — because a double-escaped body contains no tags at all, which is
   * exactly what it was asserting.
   *
   * **Do not add an entry to this set** without a reason of the same shape: the
   * writer of the payload must be this package's own renderer, and there must be
   * a test proving that renderer escapes. Each of these seven has one, in the
   * `*.test.ts` beside the formatter. Every other template takes values that
   * originate with a user, and for those the rule is unchanged.
   */
  const PRE_RENDERED: readonly string[] = [
    TEMPLATES.BOT_WIZARD,
    TEMPLATES.BOT_REQUESTS,
    TEMPLATES.BOT_MY_EVENTS,
    TEMPLATES.BOT_CHATS,
    TEMPLATES.BOT_DISCOVER,
    TEMPLATES.BOT_REVIEWS,
    TEMPLATES.BOT_TERMS_STANDING,
    TEMPLATES.BOT_WALLET,
    TEMPLATES.BOT_REFERRAL,
    TEMPLATES.BOT_CONFIRM_SPEND,
    TEMPLATES.BOT_EVENT_DETAIL,
  ];

  it.each(Object.values(TEMPLATES).filter((key) => !PRE_RENDERED.includes(key)))(
    '%s',
    (templateKey) => {
      const message = render(templateKey, FIELDS);

      expect(message).not.toBeNull();
      expect(message?.text).not.toContain('<img');
      // Every tag in the output is one the template itself wrote.
      const tags = message?.text.match(/<[^>]*>/g) ?? [];
      expect(tags.every((tag) => OWN_MARKUP.has(tag))).toBe(true);
    },
  );

  /**
   * The exemption is enumerated, so growing it is a deliberate edit to this line
   * rather than something a new template can drift into.
   */
  it('exempts exactly the pre-rendered bodies', () => {
    expect([...PRE_RENDERED].sort()).toEqual(
      [
        TEMPLATES.BOT_CHATS,
        TEMPLATES.BOT_DISCOVER,
        TEMPLATES.BOT_MY_EVENTS,
        TEMPLATES.BOT_REQUESTS,
        TEMPLATES.BOT_REVIEWS,
        TEMPLATES.BOT_CONFIRM_SPEND,
        TEMPLATES.BOT_EVENT_DETAIL,
        TEMPLATES.BOT_REFERRAL,
        TEMPLATES.BOT_TERMS_STANDING,
        TEMPLATES.BOT_WALLET,
        TEMPLATES.BOT_WIZARD,
      ].sort(),
    );
  });

  /**
   * And the exempted ones really do pass their body through untouched — the
   * regression that started all this was the opposite.
   */
  it('renders a pre-rendered body without escaping it again', () => {
    const body = '<b>سفر شمال</b>';

    for (const templateKey of PRE_RENDERED) {
      expect(render(templateKey, { text: body })?.text).toContain(body);
    }
  });

  /** And the escaped form really is present where a value was interpolated. */
  it('escapes the value rather than dropping it', () => {
    const message = render(TEMPLATES.PARTICIPATION_ACCEPTED, FIELDS);
    expect(message?.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  /**
   * The keyboard is markup too, and it is the half a text assertion cannot see.
   *
   * A hostile value where a public id belongs must not become a `callback_data`
   * value or a URL. Both would be sent to Telegram verbatim — and a long one would
   * make `encodeChatCallback` throw inside `render`, which fails the send job and
   * then fails every retry of it.
   */
  it.each(Object.values(TEMPLATES))('%s builds no button from a hostile id', (templateKey) => {
    const message = render(templateKey, FIELDS);

    for (const button of (message?.keyboard ?? []).flat()) {
      expect(button.callbackData ?? '').not.toContain(HOSTILE);
      // The only links this package emits are to the bot itself.
      expect(button.url ?? `https://t.me/${BOT}`).toMatch(/^https:\/\/t\.me\/payetam_test_bot/);
      expect(button.url ?? '').not.toContain('<img');
    }
  });
});

/**
 * A notification queued by a newer deploy and processed by an older one.
 *
 * Returning null rather than throwing is what keeps a rollout from stalling the
 * whole queue behind one unknown template.
 */
describe('an unknown template', () => {
  it('renders nothing rather than throwing', () => {
    expect(render('something.from.the.future', {})).toBeNull();
  });
});

/**
 * The relayed chat message is the one template where a mistake breaks the
 * product's central promise, so it gets its own assertion.
 */
describe('the chat relay template', () => {
  const CHAT = '11111111-2222-3333-4444-555555555555';

  it('carries the alias and the text, and nothing else', () => {
    const message = render(TEMPLATES.CHAT_MESSAGE, {
      senderAlias: 'میهمان ۱',
      text: 'ساعت هفت جلوی کافه',
      chatPublicId: CHAT,
      // Fields a caller might wrongly include. The template reads neither.
      telegramUserId: '573914882',
      username: 'leaky_handle',
    });

    expect(message?.text).toContain('میهمان ۱');
    expect(message?.text).toContain('ساعت هفت جلوی کافه');
    expect(message?.text).not.toContain('573914882');
    expect(message?.text).not.toContain('leaky_handle');
  });

  /**
   * The close button is where the plan's third callback comes from.
   *
   * `chat:close:<id>` has no other source, so a relay message with no keyboard
   * would leave the handler for it unreachable — dead code that reads as a feature.
   */
  it('offers the close button, keyed on the chat', () => {
    const message = render(TEMPLATES.CHAT_MESSAGE, { senderAlias: 'م', chatPublicId: CHAT });
    const buttons = (message?.keyboard ?? []).flat();

    expect(buttons.map((button) => button.callbackData)).toContain(`chat:close:${CHAT}`);
  });

  /** An edit says so. Silence would leave the recipient acting on a retracted line. */
  it('marks an edited message as edited', () => {
    const message = render(TEMPLATES.CHAT_MESSAGE_EDITED, {
      senderAlias: 'میهمان ۱',
      text: 'ساعت هشت',
      chatPublicId: CHAT,
    });

    expect(message?.text).toContain('ویرایش شد');
    expect(message?.text).toContain('ساعت هشت');
  });
});

/**
 * The host's two buttons, which are the only source of `chat:accept|reject:<id>`.
 */
describe('the host decision keyboard', () => {
  const PARTICIPANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it.each([TEMPLATES.PARTICIPATION_REQUESTED_HOST, TEMPLATES.WAITLIST_PROMOTED_HOST])(
    '%s offers accept and reject',
    (templateKey) => {
      const message = render(templateKey, { participantPublicId: PARTICIPANT });
      const data = (message?.keyboard ?? []).flat().map((button) => button.callbackData);

      expect(data).toContain(`chat:accept:${PARTICIPANT}`);
      expect(data).toContain(`chat:reject:${PARTICIPANT}`);
    },
  );

  /** 64 bytes is Telegram's hard limit, and a UUID leaves it uncomfortably close. */
  it("fits inside Telegram's callback_data limit", () => {
    const message = render(TEMPLATES.PARTICIPATION_REQUESTED_HOST, {
      participantPublicId: PARTICIPANT,
    });

    for (const button of (message?.keyboard ?? []).flat()) {
      expect(Buffer.byteLength(button.callbackData ?? '', 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

/**
 * The wizard's own markup has to survive the template (ADR-0017).
 *
 * `BOT_WIZARD` carries a body `renderStep` already built — `<i>گام ۱ از ۱۱</i>`,
 * a bold heading, a summary — and every user-supplied value inside it was
 * escaped there. Escaping the whole thing a second time in the template renders
 * `&lt;i&gt;` at the user, which is precisely what it did until `raw` existed.
 *
 * This is the assertion the wizard's other tests could not make: they check the
 * notification *payload*, and the payload was always correct. The damage was in
 * the render.
 */
describe('BOT_WIZARD', () => {
  const screen = renderStep({
    prompt: 'نام فعالیت؟',
    ui: 'text',
    stepKey: 'title',
    position: 1,
    total: 11,
    canGoBack: false,
    optional: false,
  });

  it('passes the renderer’s own markup through unescaped', () => {
    const message = render(TEMPLATES.BOT_WIZARD, {
      text: screen.text,
      keyboard: JSON.stringify(screen.keyboard),
    });

    expect(message?.text).toContain('<i>گام ۱ از ۱۱</i>');
    expect(message?.text).not.toContain('&lt;i&gt;');
  });

  /**
   * And the renderer is still the thing that escapes. A prompt carrying markup
   * must not reach Telegram as markup just because the template stopped
   * escaping.
   */
  it('still escapes a value the renderer interpolated', () => {
    const hostile = renderStep({
      prompt: '<img src=x onerror=alert(1)>',
      ui: 'text',
      stepKey: 'title',
      position: 1,
      total: 2,
      canGoBack: false,
      optional: false,
    });
    const message = render(TEMPLATES.BOT_WIZARD, { text: hostile.text });

    expect(message?.text).toContain('&lt;img');
    expect(message?.text).not.toContain('<img');
  });
});
