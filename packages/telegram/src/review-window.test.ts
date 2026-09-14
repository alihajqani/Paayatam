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
    const [stars] = render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'HOST' })
      ?.keyboard ?? [[]];
    expect((stars ?? []).map((button) => button.callbackData)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `rv:rate${String(n)}:${PARTICIPANT}`),
    );
  });

  /**
   * Plan 08: the one message every guest of a finished evening receives is where
   * «میزبان نیامد» lives — a guest rating an evening that did not happen needs a
   * way to say so. The host's copy has no such row.
   */
  it('offers a guest «میزبان نیامد» under the stars, and the host nothing extra', () => {
    const guest = (
      render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'GUEST' })?.keyboard ?? []
    ).map((row) => row.map((button) => button.callbackData));
    expect(guest).toEqual([
      [1, 2, 3, 4, 5].map((n) => `rv:rate${String(n)}:${PARTICIPANT}`),
      [`ev:habs:${PARTICIPANT}`],
    ]);

    const host = render(TEMPLATES.REVIEW_WINDOW_OPEN, { ...base, recipientRole: 'HOST' })?.keyboard;
    expect(host).toHaveLength(1);
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
