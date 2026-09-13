import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * The no-show, told to the person it was recorded against (review H1).
 *
 * The heaviest penalty in the economy, and the message said only that the host
 * had reported it — not what it cost — and pointed at «بخش پشتیبانی», which is
 * not the name of anything on screen.
 */
describe('a recorded no-show', () => {
  it('says what it cost', () => {
    const text = String(
      render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه و بازی', coinsCharged: 60 })?.text,
    );
    expect(text).toContain('قهوه و بازی');
    expect(text).toContain('۶۰ سکه');
  });

  it('says nothing about coins when nothing was taken', () => {
    const text = String(render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه' })?.text);
    expect(text).not.toContain('سکه');
  });

  it('names where to object by a label the menu actually shows', () => {
    const text = String(render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه' })?.text);
    expect(text).not.toContain('بخش پشتیبانی');
    expect(text).toContain('🆘 راهنما و پشتیبانی');
  });
});
