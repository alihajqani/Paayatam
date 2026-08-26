import { describe, expect, it } from 'vitest';
import { TELEGRAM_MESSAGE_LIMIT, validateTelegramMessage } from './telegram-message';

/**
 * The gate in front of an admin-authored broadcast (M22 phase 4).
 *
 * Every case here is a thing an operator actually does: pastes markup from a
 * document, forgets a closing tag, or drops in a link. The point of rejecting
 * rather than sanitising is that they find out here instead of four thousand
 * people finding out afterwards.
 */
describe('validateTelegramMessage — plain text', () => {
  it('accepts an ordinary sentence', () => {
    expect(validateTelegramMessage('سلام، فردا رویداد داریم.', undefined).ok).toBe(true);
  });

  it('refuses an empty body', () => {
    expect(validateTelegramMessage('   ', undefined).problems).toEqual([{ kind: 'EMPTY' }]);
  });

  it('refuses anything past Telegram’s limit, and says by how much', () => {
    const verdict = validateTelegramMessage('x'.repeat(TELEGRAM_MESSAGE_LIMIT + 1), undefined);

    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      { kind: 'TOO_LONG', length: TELEGRAM_MESSAGE_LIMIT + 1, limit: TELEGRAM_MESSAGE_LIMIT },
    ]);
  });

  /**
   * The reason plain text is the default: with no `parse_mode`, Telegram renders
   * the characters. There is nothing to inject into, so there is nothing to
   * validate — and an operator who pastes a stray angle bracket is not stopped.
   */
  it('does not judge markup it will never interpret', () => {
    expect(validateTelegramMessage('a < b و <script>alert(1)</script>', undefined).ok).toBe(true);
  });
});

describe('validateTelegramMessage — HTML', () => {
  it('accepts the tags Telegram documents', () => {
    const verdict = validateTelegramMessage(
      '<b>مهم</b> — <i>فردا</i> <a href="https://payetam.example/x">جزئیات</a>',
      'HTML',
    );

    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  it('refuses a tag Telegram does not know', () => {
    const verdict = validateTelegramMessage('<div>سلام</div>', 'HTML');

    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContainEqual({ kind: 'UNKNOWN_TAG', tag: 'div' });
  });

  it('refuses an unclosed tag rather than sending half a bold', () => {
    const verdict = validateTelegramMessage('<b>مهم', 'HTML');

    expect(verdict.problems).toContainEqual({ kind: 'UNCLOSED_TAG', tag: 'b' });
  });

  it('refuses a closing tag that opened nothing', () => {
    const verdict = validateTelegramMessage('مهم</b>', 'HTML');

    expect(verdict.problems).toContainEqual({ kind: 'UNEXPECTED_CLOSING_TAG', tag: 'b' });
  });

  it('refuses anything but an https link', () => {
    for (const href of ['http://x.test', 'javascript:alert(1)', 'tg://user?id=1']) {
      const verdict = validateTelegramMessage(`<a href="${href}">x</a>`, 'HTML');
      expect(verdict.ok, href).toBe(false);
      expect(verdict.problems.some((problem) => problem.kind === 'UNSAFE_LINK')).toBe(true);
    }
  });

  it('refuses an attribute that is not href on a link', () => {
    const verdict = validateTelegramMessage('<b class="x">مهم</b>', 'HTML');

    expect(verdict.problems).toContainEqual({
      kind: 'UNSUPPORTED_ATTRIBUTE',
      tag: 'b',
      attribute: 'class',
    });
  });

  it('allows the one attribute Telegram documents on pre', () => {
    expect(validateTelegramMessage('<pre class="language-ts">const x = 1;</pre>', 'HTML').ok).toBe(
      true,
    );
  });

  it('reports every problem, not the first', () => {
    const verdict = validateTelegramMessage('<div>a</div><b>b', 'HTML');

    expect(verdict.problems.length).toBeGreaterThan(1);
  });
});
