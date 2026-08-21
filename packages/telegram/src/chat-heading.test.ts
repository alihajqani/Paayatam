import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

const BOT = 'payetam_test_bot';

/**
 * The header on a relayed message (M18, ADR-0014).
 *
 * The bot's DM carries **every** conversation a person is in, so a message headed
 * «میهمان ۱:» and nothing else was unreadable the moment somebody had two events
 * running: two different people were «میهمان ۱», and neither header said which
 * event either of them was asking about. What is asserted here is the pairing, its
 * two fallbacks, and that neither of them can smuggle markup into a message the
 * recipient has every reason to trust.
 */
describe('the relayed message header', () => {
  it('pairs the sender name with the event', () => {
    const message = render(
      TEMPLATES.CHAT_MESSAGE,
      {
        senderName: 'علی رضایی',
        senderAlias: 'میهمان ۱',
        eventTitle: 'سفر شمال',
        text: 'سلام',
      },
      BOT,
    );

    expect(message?.text).toContain('<b>علی رضایی — سفر شمال:</b>');
  });

  it('falls back to the alias when there is no profile name', () => {
    // An anonymised profile (M15) or an account mid-onboarding. «میهمان ۱ — سفر
    // شمال» is still a usable header; a blank bold tag is not.
    const message = render(
      TEMPLATES.CHAT_MESSAGE,
      { senderAlias: 'میهمان ۱', eventTitle: 'سفر شمال', text: 'سلام' },
      BOT,
    );

    expect(message?.text).toContain('<b>میهمان ۱ — سفر شمال:</b>');
  });

  it('renders whichever half a payload from an older deploy carries', () => {
    // A rollout is not atomic: rows queued by the previous build carry neither
    // `senderName` nor `eventTitle`. A stray em dash with nothing on one side of
    // it would be the visible symptom of that, in a message a user reads.
    const legacy = render(TEMPLATES.CHAT_MESSAGE, { senderAlias: 'میهمان ۲', text: 'سلام' }, BOT);

    expect(legacy?.text).toContain('<b>میهمان ۲:</b>');
    expect(legacy?.text).not.toContain('—');
  });

  it('carries the same header through an edit and a deletion', () => {
    const payload = {
      senderName: 'علی رضایی',
      senderAlias: 'میهمان ۱',
      eventTitle: 'سفر شمال',
      text: 'سلام دوباره',
      replacementText: 'پیام حذف شد',
    };

    expect(render(TEMPLATES.CHAT_MESSAGE_EDITED, payload, BOT)?.text).toContain(
      'علی رضایی — سفر شمال',
    );
    // The deletion notice used to carry no attribution at all, which in a DM full
    // of conversations said "somebody, somewhere, retracted something".
    expect(render(TEMPLATES.CHAT_MESSAGE_DELETED, payload, BOT)?.text).toContain(
      'علی رضایی — سفر شمال',
    );
  });

  it('escapes a display name and an event title that contain markup', () => {
    // T9's threat, now reachable through one more field: a display name is user
    // input, and `parse_mode: 'HTML'` is what would turn it into a link.
    const message = render(
      TEMPLATES.CHAT_MESSAGE,
      {
        senderName: '<a href="http://evil">tap</a>',
        eventTitle: '<b>x</b>',
        text: 'سلام',
      },
      BOT,
    );

    expect(message?.text).not.toContain('<a href');
    expect(message?.text).toContain('&lt;a href=');
    expect(message?.text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
