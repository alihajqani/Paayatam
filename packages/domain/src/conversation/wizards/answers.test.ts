import { describe, expect, it } from 'vitest';
import { acceptInteger, acceptText, quoted, toAsciiDigits, wrongShape } from './answers';

const text = (value: string) => ({ kind: 'text' as const, value });
const tap = (value: string) => ({ kind: 'callback' as const, value });
const photo = { kind: 'photo' as const, value: 'AgACAgQ' };

/**
 * The property under test is the one the whole module exists for: a refusal
 * says what the bot *received*, not only what the rule is. A user who believes
 * they answered the question correctly learns nothing from the rule.
 */
describe('a refused text answer', () => {
  it('quotes what arrived, and its length, when it is too short', () => {
    const result = acceptText(text('ab'), 3, 80, 'نام فعالیت');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('«ab»');
    expect(result.error).toContain('۲ نویسه');
    expect(result.error).toContain('نام فعالیت');
  });

  /**
   * The invisible mistake: a message of spaces looks like an answer on the
   * sender's screen and is empty after the trim. Quoting «» back at somebody
   * would be the bot showing them nothing and calling it their answer.
   */
  it('says nothing arrived rather than quoting an empty string', () => {
    const result = acceptText(text('   '), 3, 80, 'نام فعالیت');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('«»');
    expect(result.error).toContain('چیزی در پیام شما نبود');
  });

  it('says how much too long, and does not echo the whole thing', () => {
    const long = 'ا'.repeat(120);
    const result = acceptText(text(long), 3, 80, 'توضیح');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('۱۲۰ نویسه');
    // «۴۰ نویسه کوتاه‌ترش کنید» — the number that turns a rule into an action.
    expect(result.error).toContain('۴۰');
    expect(result.error).not.toContain(long);
  });

  /**
   * Three shapes reach a step and only one is text, so a step that wants text
   * has three things to say. Answering a stale tap with «نام فعالیت را بنویسید»
   * is advice about a question the user is not looking at — which is what made
   * «رایگان» look broken in production.
   */
  it('tells a tap and a photo apart', () => {
    expect(wrongShape(tap('FREE'), 'نام فعالیت')).toContain('دکمه');
    expect(wrongShape(photo, 'نام فعالیت')).toContain('تصویر');
  });

  it('refuses a tap where text was asked for', () => {
    expect(acceptText(tap('FREE'), 3, 80, 'نام فعالیت').ok).toBe(false);
  });

  it('trims before measuring, so padding does not buy length', () => {
    expect(acceptText(text('  کوه  '), 3, 80, 'نام فعالیت')).toEqual({
      ok: true,
      value: 'کوه',
    });
  });
});

describe('a refused number', () => {
  it('quotes the thing that is not a number', () => {
    const result = acceptInteger(text('چهار'), 1, 50, 'ظرفیت');

    expect(typeof result).toBe('string');
    expect(result).toContain('«چهار»');
  });

  it('names the range and what was sent, in Persian digits', () => {
    const result = acceptInteger(text('۹۹'), 1, 50, 'ظرفیت');

    expect(typeof result).toBe('string');
    expect(result as string).toContain('۹۹');
    // Every number this product shows a user is Persian, refusals included.
    expect(result as string).not.toMatch(/[0-9]/);
  });

  it('reads Persian and Arabic-Indic digits, and thousands separators', () => {
    expect(acceptInteger(text('۵۰٬۰۰۰'), 0, 100_000_000, 'مبلغ')).toBe(50_000);
    expect(acceptInteger(text('٤٢'), 0, 100, 'مبلغ')).toBe(42);
    expect(acceptInteger(text('50,000'), 0, 100_000_000, 'مبلغ')).toBe(50_000);
  });

  it('says the message was empty rather than that it was not a number', () => {
    const result = acceptInteger(text('  '), 1, 50, 'ظرفیت');
    expect(result).toContain('خالی');
  });
});

describe('the echo', () => {
  it('collapses whitespace, so an invisible answer is visible in the quote', () => {
    expect(quoted('a\n\n  b')).toBe('«a b»');
  });

  it('is bounded, because the wizard lives on one message', () => {
    const quote = quoted('ا'.repeat(200));
    expect(quote.length).toBeLessThan(50);
    expect(quote).toContain('…');
  });

  it('is empty when there is nothing worth quoting', () => {
    expect(quoted('   ')).toBe('');
  });
});

describe('digit folding', () => {
  it('handles all three systems a Persian keyboard can produce', () => {
    expect(toAsciiDigits('۱۲۳٤٥٦789')).toBe('123456789');
  });
});
