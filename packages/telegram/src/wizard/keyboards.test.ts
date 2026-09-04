import { describe, expect, it } from 'vitest';
import { parseWizardCallback } from './callback';
import { tehranToday } from './jalali';
import {
  CHOICES_PER_PAGE,
  calendarKeyboard,
  choiceKeyboard,
  controlRow,
  multiChoiceKeyboard,
  type Choice,
} from './keyboards';

const TODAY = tehranToday(new Date('2026-08-28T12:00:00Z'));

function choices(count: number): Choice[] {
  return Array.from({ length: count }, (_, i) => ({
    value: `v${String(i)}`,
    label: `گزینه ${String(i)}`,
  }));
}

function texts(keyboard: readonly (readonly { text: string }[])[]): string[] {
  return keyboard.flat().map((button) => button.text);
}

describe('choiceKeyboard', () => {
  it('lays options out three to a row', () => {
    expect(choiceKeyboard('city', choices(6), 0)[0]).toHaveLength(3);
  });

  /** Every button Telegram accepts needs callback_data; a missing one is a 400. */
  it('gives every button callback data inside the codec', () => {
    for (const button of choiceKeyboard('city', choices(30), 0).flat()) {
      expect(button.callbackData).toBeDefined();
      expect(parseWizardCallback(button.callbackData!)).not.toBeNull();
    }
  });

  it('shows no navigation when everything fits on one page', () => {
    expect(texts(choiceKeyboard('city', choices(5), 0)).join()).not.toContain('بعدی');
  });

  /**
   * Tehran province has more cities than fits in a message, and a list that
   * silently stops is a list that cannot express where somebody lives.
   */
  it('pages a long list and reaches the last option', () => {
    const all = choices(CHOICES_PER_PAGE * 2 + 3);
    const lastPage = choiceKeyboard('city', all, 2);

    expect(texts(lastPage)).toContain('گزینه 50');
    expect(texts(choiceKeyboard('city', all, 0))).not.toContain('گزینه 50');
  });

  it('offers no «next» on the last page and no «previous» on the first', () => {
    const all = choices(CHOICES_PER_PAGE + 1);

    expect(texts(choiceKeyboard('city', all, 0)).join()).toContain('بعدی');
    expect(texts(choiceKeyboard('city', all, 0)).join()).not.toContain('قبلی');
    expect(texts(choiceKeyboard('city', all, 1)).join()).not.toContain('بعدی');
    expect(texts(choiceKeyboard('city', all, 1)).join()).toContain('قبلی');
  });

  /** A page number out of range is untrusted input, not a crash. */
  it('clamps a page beyond either end', () => {
    expect(() => choiceKeyboard('city', choices(5), 99)).not.toThrow();
    expect(texts(choiceKeyboard('city', choices(5), 99))).toContain('گزینه 0');
    expect(texts(choiceKeyboard('city', choices(5), -3))).toContain('گزینه 0');
  });

  it('renders an empty list without throwing', () => {
    expect(() => choiceKeyboard('city', [], 0)).not.toThrow();
  });
});

describe('calendarKeyboard', () => {
  const keyboard = calendarKeyboard('date', TODAY, TODAY);

  /** A grid starting on Monday puts every date under the wrong heading. */
  it('heads the grid with the Persian week, beginning on شنبه', () => {
    expect(keyboard[0]!.map((button) => button.text)).toEqual(['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج']);
  });

  it('lays every week out in seven columns', () => {
    for (const row of keyboard.slice(0, -1)) expect(row).toHaveLength(7);
  });

  it('names the Jalali month', () => {
    expect(texts(keyboard)).toContain('شهریور');
  });

  /**
   * An event cannot start in the past, and a button that silently does nothing
   * is worse than an empty square — people press it twice before concluding the
   * bot is broken.
   */
  it('blanks the days before the earliest allowed one', () => {
    const days = keyboard
      .flat()
      .filter((button) => parseWizardCallback(button.callbackData ?? '')?.action === 'date');

    // ۶ شهریور is the earliest; ۱–۵ are behind it and must not be offered.
    expect(days.map((button) => button.text)).not.toContain('۱');
    expect(days.map((button) => button.text)).toContain('۶');
  });

  it('offers no «previous month» when nothing behind it is reachable', () => {
    expect(texts(keyboard).join()).not.toContain('ماه قبل');
    expect(texts(keyboard).join()).toContain('ماه بعد');
  });

  it('carries a Gregorian ISO day on each date button', () => {
    const day = keyboard
      .flat()
      .map((button) => parseWizardCallback(button.callbackData ?? ''))
      .find((callback) => callback?.action === 'date');

    expect(day?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('controlRow', () => {
  it('emits only what was asked for', () => {
    expect(controlRow({})).toHaveLength(0);
    expect(controlRow({ back: true }).map((b) => b.text)).toEqual(['« بازگشت']);
    expect(controlRow({ back: true, skip: true, cancel: true })).toHaveLength(3);
  });
});

/**
 * Choosing several (v0.8.1).
 *
 * The keyboard **is** the state: a ticked label is a chosen value, so there is
 * no second list of what has been selected and no way for the two to disagree.
 * That is what these assert — the ticks, the toggle affordance, and the «تمام»
 * that ends a step whose own answers never advance it.
 */
describe('multiChoiceKeyboard', () => {
  const three = choices(3);

  it('ticks what is chosen and leaves the rest alone', () => {
    const labels = multiChoiceKeyboard('tags', three, ['v1'], 0)
      .flat()
      .map((button) => button.text);

    expect(labels).toContain('✅ گزینه 1');
    expect(labels).toContain('گزینه 0');
    expect(labels).not.toContain('✅ گزینه 0');
  });

  /**
   * A ticked option carries the same `callback_data` as an unticked one.
   *
   * That is the whole of "add and remove": one button, and the step's `accept`
   * reads the current form to decide which way the tap goes. A separate remove
   * action would be a second protocol for one bit of state.
   */
  it('gives a chosen option the same callback as an unchosen one', () => {
    const chosen = multiChoiceKeyboard('tags', three, ['v1'], 0).flat();
    const none = multiChoiceKeyboard('tags', three, [], 0).flat();

    const callbackFor = (buttons: typeof chosen, label: string) =>
      buttons.find((button) => button.text.endsWith(label))?.callbackData;

    expect(callbackFor(chosen, 'گزینه 1')).toBe(callbackFor(none, 'گزینه 1'));
  });

  it('always offers «تمام», and counts what is chosen', () => {
    const empty = multiChoiceKeyboard('tags', three, [], 0)
      .flat()
      .find((button) => parseWizardCallback(button.callbackData ?? '')?.action === 'done');
    expect(empty?.text).toBe('✔️ تمام');

    const two = multiChoiceKeyboard('tags', three, ['v0', 'v1'], 0)
      .flat()
      .find((button) => parseWizardCallback(button.callbackData ?? '')?.action === 'done');
    expect(two?.text).toContain('۲');
  });

  /** «تمام» must be reachable from every page, not only the first. */
  it('keeps «تمام» below the options on a later page', () => {
    const rows = multiChoiceKeyboard('tags', choices(CHOICES_PER_PAGE * 2), ['v0'], 1);
    const done = rows
      .flat()
      .filter((button) => parseWizardCallback(button.callbackData ?? '')?.action === 'done');

    expect(done).toHaveLength(1);
  });

  /** Paging is `choiceKeyboard`'s, reused rather than re-derived. */
  it('pages the options exactly as a single-select does', () => {
    const many = choices(CHOICES_PER_PAGE + 5);
    const options = (rows: readonly (readonly { callbackData?: string }[])[]) =>
      rows.flat().filter((b) => parseWizardCallback(b.callbackData ?? '')?.action === 'tags');

    expect(options(multiChoiceKeyboard('tags', many, [], 0))).toHaveLength(CHOICES_PER_PAGE);
    expect(options(multiChoiceKeyboard('tags', many, [], 1))).toHaveLength(5);
  });

  it('appends the trailer beneath «تمام»', () => {
    const rows = multiChoiceKeyboard('tags', three, [], 0, controlRow({ skip: true }));
    expect(rows[rows.length - 1]?.map((button) => button.text)).toEqual(['رد کردن']);
  });
});
