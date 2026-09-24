import { describe, expect, it } from 'vitest';
import { renderSummary } from './render';

const LINES = [
  { label: 'نام رویداد', value: 'قهوه و بازی' },
  { label: 'شهر', value: 'تهران' },
];

/**
 * The last screen before a host commits.
 *
 * The `note` is what this suite is for. Registering an activity charges coins,
 * and the coins come back when the activity is actually held — a fact the host
 * has no way to know unless this screen says it. Charging and staying silent
 * reads as a fee, and a fee on the scarce side of a marketplace is how a
 * marketplace runs out of supply.
 */
describe('renderSummary', () => {
  it('puts the note above the commit instruction, not under the fields', () => {
    const screen = renderSummary(LINES, false, 'ثبت رویداد', 'ثبت رویداد ۲۵ سکه است.');
    // The order is the point: it is the last thing read before the button, not a
    // footnote under a form somebody has already scrolled past.
    expect(screen.text.indexOf('۲۵ سکه')).toBeGreaterThan(screen.text.indexOf('قهوه و بازی'));
    expect(screen.text.indexOf('۲۵ سکه')).toBeLessThan(screen.text.indexOf('اگر همه‌چیز درست است'));
  });

  it('renders exactly as before when there is no note', () => {
    // Four other wizards reach this screen and none of them has a price.
    const screen = renderSummary(LINES, false, 'ثبت نمایه');
    expect(screen.text).toContain('بازبینی نهایی');
    expect(screen.text).toContain('«ثبت نمایه» را بزنید');
  });

  it('escapes the note', () => {
    // It is assembled at the call site from settings, so it is not a stranger's
    // text today — but every other value on this screen is escaped, and the one
    // exception is always the one that later carries user input.
    const screen = renderSummary(LINES, false, 'ثبت رویداد', '<b>x</b>');
    expect(screen.text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
