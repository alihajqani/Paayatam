import { describe, expect, it } from 'vitest';
import { updateCitySeedConfigRequest } from './contracts/admin';

/**
 * The floor is the number of upcoming events a city should always have, real and
 * seeded together. It used to be capped at 3 because seed events were held to the
 * host's three-at-a-time quota; they are exempt now, so a realistic floor for a
 * busy city must be accepted.
 */
describe('updateCitySeedConfigRequest', () => {
  it('accepts a floor well above the old cap of three', () => {
    expect(updateCitySeedConfigRequest.parse({ floorCount: 10 }).floorCount).toBe(10);
    expect(updateCitySeedConfigRequest.parse({ floorCount: 50 }).floorCount).toBe(50);
  });

  it('still refuses an absurd floor, and a negative one', () => {
    expect(updateCitySeedConfigRequest.safeParse({ floorCount: 51 }).success).toBe(false);
    expect(updateCitySeedConfigRequest.safeParse({ floorCount: -1 }).success).toBe(false);
  });
});
