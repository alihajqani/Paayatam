import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * The guest who was just let in has to be able to reach the activity (review H2).
 *
 * The acceptance said «از صفحهٔ رویداد پیام بدهید» and carried no button, and
 * nothing else the guest holds opens that screen: `/requests` lists titles, and
 * `/discover` shows only their own city. So the one step the product exists for —
 * agreeing where to meet — started with a hunt.
 */
describe('the messages that put a guest on an activity', () => {
  const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const payload = { eventTitle: 'قهوه و بازی', eventPublicId: EVENT };

  function callbacks(templateKey: string, body: Record<string, unknown>): string[] {
    return (render(templateKey, body)?.keyboard ?? []).flat().map((b) => String(b.callbackData));
  }

  it('offers the host and the activity under an acceptance', () => {
    expect(callbacks(TEMPLATES.PARTICIPATION_ACCEPTED, payload)).toEqual([
      `dm:write:${EVENT}`,
      `ev:show:${EVENT}`,
    ]);
  });

  it('offers the same two under a request that was just filed', () => {
    expect(callbacks(TEMPLATES.PARTICIPATION_REQUESTED_GUEST, payload)).toEqual([
      `dm:write:${EVENT}`,
      `ev:show:${EVENT}`,
    ]);
  });

  it('offers the activity to somebody taken off the waiting list', () => {
    expect(callbacks(TEMPLATES.WAITLIST_PROMOTED_GUEST, payload)).toEqual([`ev:show:${EVENT}`]);
  });

  /** The sentence must not send them looking for a screen the button now opens. */
  it('stops telling the guest to find the activity page themselves', () => {
    for (const key of [TEMPLATES.PARTICIPATION_ACCEPTED, TEMPLATES.PARTICIPATION_REQUESTED_GUEST]) {
      expect(render(key, payload)?.text, key).not.toContain('از صفحهٔ');
    }
  });

  /** A notification queued by an older deploy has no id, and must still send. */
  it('draws no button that names nothing', () => {
    const old = { eventTitle: 'قهوه و بازی' };
    for (const key of [
      TEMPLATES.PARTICIPATION_ACCEPTED,
      TEMPLATES.PARTICIPATION_REQUESTED_GUEST,
      TEMPLATES.WAITLIST_PROMOTED_GUEST,
    ]) {
      const message = render(key, old);
      expect(message?.text, key).toContain('قهوه و بازی');
      expect(message?.keyboard, key).toBeUndefined();
    }
  });
});
