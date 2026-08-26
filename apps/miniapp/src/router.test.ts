import { describe, expect, it } from 'vitest';
import { showsHomeButton, stepFor } from './router';

/**
 * The two navigation rules the shell reads, tested as the pure functions they
 * are. The guard itself is not exercised here — it needs a live Pinia and a
 * router — but the decisions it makes are these, so a mistake in either is a
 * mistake the guard makes too.
 */
describe('stepFor', () => {
  it('sends each unfinished state to its one screen', () => {
    expect(stepFor('NEW')).toBe('/terms');
    expect(stepFor('TERMS_ACCEPTED')).toBe('/profile');
    expect(stepFor('PROFILE_COMPLETE')).toBe('/home');
  });

  it('sends a finished user back to the terms when a version is outstanding', () => {
    expect(stepFor('PROFILE_COMPLETE', 1)).toBe('/terms');
  });

  it('sends an unknown state to the splash, which signs in again', () => {
    expect(stepFor(undefined)).toBe('/');
    expect(stepFor('SOMETHING_ELSE')).toBe('/');
  });
});

describe('showsHomeButton', () => {
  it('draws the header on a product screen for a finished user', () => {
    expect(showsHomeButton('home', 'PROFILE_COMPLETE')).toBe(true);
    expect(showsHomeButton('discover', 'PROFILE_COMPLETE')).toBe(true);
    expect(showsHomeButton('event-detail', 'PROFILE_COMPLETE')).toBe(true);
    expect(showsHomeButton('wallet', 'PROFILE_COMPLETE')).toBe(true);
    // The edit screen is a product screen, not a funnel step — the same
    // distinction `ONBOARDING_PATHS` makes for the guard.
    expect(showsHomeButton('profile-edit', 'PROFILE_COMPLETE')).toBe(true);
  });

  it('never draws it where the guard would bounce the tap', () => {
    // Mid-funnel: `/home` is not reachable, so a link to it does nothing.
    expect(showsHomeButton('terms', 'NEW')).toBe(false);
    expect(showsHomeButton('profile', 'TERMS_ACCEPTED')).toBe(false);
    expect(showsHomeButton('splash', undefined)).toBe(false);
  });

  it('never draws it while a policy acceptance is outstanding', () => {
    // The case M22 added: a finished user re-reading the terms because a new
    // version was published. `/home` is closed to them until they accept.
    expect(showsHomeButton('terms', 'PROFILE_COMPLETE', 1)).toBe(false);
    expect(showsHomeButton('home', 'PROFILE_COMPLETE', 1)).toBe(false);
  });

  it('does not draw it on the terms screen even for a user who owes nothing', () => {
    // Reachable from home since M22, and still not a screen to hang a second
    // navigation off — the user came from home and can go back.
    expect(showsHomeButton('terms', 'PROFILE_COMPLETE')).toBe(false);
  });

  it('treats a route with no name as not a funnel screen', () => {
    expect(showsHomeButton(undefined, 'PROFILE_COMPLETE')).toBe(true);
  });
});
