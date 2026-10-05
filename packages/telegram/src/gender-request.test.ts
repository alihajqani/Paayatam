import { describe, expect, it } from 'vitest';
import { encodeGenderChoice, parseGenderChoice } from './callback-data';
import { notificationCategory } from './notification-category';
import { TEMPLATES, render } from './templates';

/**
 * The one-time question to an account that chose «ترجیح می‌دهم نگویم» (v0.21.2).
 *
 * The choice was removed because an event can be for women or for men only,
 * and a guest who said neither could join neither.
 */
describe('the gender question', () => {
  it('offers «آقا» and «خانم», and nothing else', () => {
    const message = render(TEMPLATES.PROFILE_GENDER_REQUEST, {});

    expect(message?.keyboard).toEqual([
      [
        { text: 'آقا', callbackData: 'gn:M' },
        { text: 'خانم', callbackData: 'gn:F' },
      ],
    ]);
    expect(message?.text).toContain('عوض نمیشه');
  });

  it('round-trips both answers and refuses anything else', () => {
    expect(parseGenderChoice(encodeGenderChoice('FEMALE'))).toBe('FEMALE');
    expect(parseGenderChoice(encodeGenderChoice('MALE'))).toBe('MALE');
    for (const data of ['gn', 'gn:', 'gn:P', 'gn:F:x', 'gd:F', 'gn:f']) {
      expect(parseGenderChoice(data), data).toBeNull();
    }
  });

  /** About the account itself: no notification setting may silence it. */
  it('is essential', () => {
    expect(notificationCategory(TEMPLATES.PROFILE_GENDER_REQUEST)).toBe('essential');
  });
});
