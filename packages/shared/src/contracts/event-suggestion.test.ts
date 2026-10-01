import { describe, expect, it } from 'vitest';
import { createEventSuggestionRequest } from './admin';

const VALID = {
  cityId: '0199a8f0-0000-7000-8000-000000000001',
  categoryId: '0199a8f0-0000-7000-8000-000000000002',
  title: 'اکران «فیلم»',
  description: 'سانس ساعت هفت و نیم، سینما هویزه.',
  venueLabel: 'سینما هویزه',
  startsAt: '2026-10-09T16:00:00.000Z',
  durationHours: 2,
  capacity: 4,
  costType: 'APPROX',
  costAmount: 150_000,
  externalLink: 'https://cinematicket.org/',
};

/**
 * A suggestion is the pre-filled answer to the event wizard, so it is held to
 * the wizard's rules: one the wizard would refuse is a link that opens on an
 * error, discovered by a reader in the channel rather than by the operator.
 */
describe('createEventSuggestionRequest', () => {
  it('accepts a suggestion the wizard would accept', () => {
    expect(createEventSuggestionRequest.safeParse(VALID).success).toBe(true);
  });

  it('wants an amount for FIXED and APPROX, and none for FREE and SPLIT', () => {
    const { costAmount: _amount, ...withoutAmount } = VALID;
    expect(createEventSuggestionRequest.safeParse(withoutAmount).success).toBe(false);
    expect(createEventSuggestionRequest.safeParse({ ...VALID, costType: 'FREE' }).success).toBe(
      false,
    );
    expect(
      createEventSuggestionRequest.safeParse({ ...withoutAmount, costType: 'SPLIT' }).success,
    ).toBe(true);
  });

  it('refuses a link that is not https', () => {
    expect(
      createEventSuggestionRequest.safeParse({ ...VALID, externalLink: 'http://x.ir' }).success,
    ).toBe(false);
  });

  it('holds the wizard bounds on duration and venue', () => {
    expect(createEventSuggestionRequest.safeParse({ ...VALID, durationHours: 25 }).success).toBe(
      false,
    );
    expect(createEventSuggestionRequest.safeParse({ ...VALID, venueLabel: 'x' }).success).toBe(
      false,
    );
  });
});
