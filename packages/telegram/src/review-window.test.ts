import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

const PARTICIPANT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const base = {
  eventTitle: 'قهوه و بازی',
  daysLeft: 7,
  participantPublicId: PARTICIPANT,
  hostDisplayName: 'مریم',
  guestDisplayName: 'سارا',
};

/**
 * «چطور بود؟» carries the rating it asks for (plan 11).
 *
 * It only said that a review was owed; the stars were under `/reviews`, a menu
 * and a list away. One row of five, the same callback `/reviews` draws, which
 * works for either side because the pair is named by the participation.
 */
describe('the review window notification', () => {
  it('offers the five ratings', () => {
    const data = (
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'GUEST' })?.keyboard ?? []
    )
      .flat()
      .map((button) => button.callbackData);
    expect(data).toEqual([1, 2, 3, 4, 5].map((n) => `rv:rate${String(n)}:${PARTICIPANT}`));
  });

  /** A host with five guests gets five of these; the name is what tells them apart. */
  it('names the guest to the host and the host to the guest', () => {
    expect(
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'HOST' })?.text,
    ).toContain('سارا');
    expect(
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'GUEST' })?.text,
    ).toContain('مریم');
  });

  /** Review H5: the deposit waits for these reviews, and the host was never told. */
  it('tells the host, and only the host, what the deposit waits for', () => {
    expect(
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'HOST' })?.text,
    ).toContain('سپرده');
    expect(
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'GUEST' })?.text,
    ).not.toContain('سپرده');
  });

  it('still renders a payload from before the names and the role', () => {
    const message = render(TEMPLATES.REVIEW_WINDOW_OPEN, {
      eventTitle: 'قهوه و بازی',
      daysLeft: 7,
    });
    expect(message?.text).toContain('قهوه و بازی');
    expect(message?.keyboard).toBeUndefined();
  });

  it('escapes a display name', () => {
    expect(
      render(TEMPLATES.REVIEW_WINDOW_OPEN, {
        ...base,
        guestDisplayName: '<i>x</i>',
        recipientRole: 'HOST',
      })?.text,
    ).toContain('&lt;i&gt;x&lt;/i&gt;');
  });
});
