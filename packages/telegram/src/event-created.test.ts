import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SHARE = `https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fpayetam_bot%3Fstart%3Devent_${EVENT}`;

/**
 * «فعالیت ثبت شد» leads somewhere (plan 11).
 *
 * It said the host could manage the activity «از بخش فعالیت‌های من» — a menu, a
 * group and a list away — at the moment they most want to look at it or send it
 * to somebody.
 */
describe('the activity-created message', () => {
  const payload = { title: 'قهوه و بازی', eventPublicId: EVENT, shareUrl: SHARE };

  it('links straight to the activity’s own console', () => {
    expect(render(TEMPLATES.BOT_EVENT_CREATED, payload)?.text).toContain('/myevent_0190a1b2c3');
  });

  it('offers Telegram’s share sheet for it', () => {
    const urls = (render(TEMPLATES.BOT_EVENT_CREATED, payload)?.keyboard ?? [])
      .flat()
      .map((button) => button.url);
    expect(urls).toEqual([SHARE]);
  });

  /** A url is only drawn when it is the share sheet — never an arbitrary link. */
  it('draws no button for a url that is not the share sheet', () => {
    const message = render(TEMPLATES.BOT_EVENT_CREATED, {
      ...payload,
      shareUrl: 'https://evil.example',
    });
    expect(message?.keyboard).toBeUndefined();
  });
});
