import { describe, expect, it } from 'vitest';
import { parseSuggestionCallback } from './callback-data';
import {
  formatSuggestionCard,
  joinExistingKeyboard,
  suggestionKeyboard,
  type SuggestionCardLine,
} from './suggestion';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const LINE: SuggestionCardLine = {
  title: 'اکران فیلم <ویژه>',
  description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
  venueLabel: 'سینما هویزه',
  cityName: 'مشهد',
  categoryName: 'سینما و تئاتر',
  // 19:30 in Tehran — the minute the hour buttons cannot say.
  startsAt: new Date('2026-10-09T16:00:00.000Z'),
  durationHours: 2,
  costType: 'APPROX',
  costAmount: 150_000,
  externalLink: 'https://cinematicket.org/?a=1&b=2',
};

/**
 * The card a `?start=host_` tap opens (migration 0064). Honest about what it is
 * — a real programme outside the product, which nobody has planned yet — because
 * the reader it is for came from a channel post, not from a crowd.
 */
describe('formatSuggestionCard', () => {
  const text = formatSuggestionCard(LINE);

  it('escapes what an operator typed', () => {
    expect(text).toContain('اکران فیلم &lt;ویژه&gt;');
    expect(text).not.toContain('<ویژه>');

    const every = formatSuggestionCard({
      ...LINE,
      description: 'توضیح <b>',
      venueLabel: 'جا <i>',
      cityName: 'شهر <u>',
      categoryName: 'دسته <s>',
    });
    expect(every).not.toMatch(/<(?:i|u|s)>|توضیح <b>/);
  });

  it('says where, and when to the minute, in Persian', () => {
    expect(text).toContain('مشهد');
    expect(text).toContain('سینما هویزه');
    expect(text).toContain('۱۹:۳۰');
  });

  it('states the cost with its amount', () => {
    expect(text).toContain('۱۵۰,۰۰۰ تومان');
  });

  /**
   * No `href` in this package is built from input (escape.ts), so the
   * programme's own page is a URL button, never markup in the text.
   */
  it('puts no link in the text', () => {
    expect(text).not.toContain('<a ');
    expect(text).not.toContain('cinematicket');
  });

  it('says what the button does', () => {
    expect(text).toContain('میزبانش می‌شوم');
  });
});

describe('the suggestion keyboards', () => {
  it('offers to host, carrying the suggestion', () => {
    const [[button]] = suggestionKeyboard(ID, null) as [[{ text: string; callbackData: string }]];
    expect(button.text).toContain('میزبانش می‌شوم');
    expect(parseSuggestionCallback(button.callbackData)).toEqual({ id: ID });
  });

  it('opens the programme’s own page from a button, when it has one', () => {
    const keyboard = suggestionKeyboard(ID, 'https://cinematicket.org/?a=1&b=2');
    expect(keyboard).toHaveLength(2);
    expect(keyboard[1]?.[0]).toMatchObject({ url: 'https://cinematicket.org/?a=1&b=2' });
    expect(suggestionKeyboard(ID, null)).toHaveLength(1);
  });

  /** Beside somebody else's event, going separately is a choice, not a rule. */
  it('offers a separate event of one’s own', () => {
    const [[button]] = joinExistingKeyboard(ID) as [[{ text: string; callbackData: string }]];
    expect(button.text).toContain('جدا');
    expect(parseSuggestionCallback(button.callbackData)).toEqual({ id: ID });
  });
});
