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

  /**
   * The channel gate (v0.3.1, report 3). It applies only after onboarding, for the
   * same reason the policy gate does: a user still choosing a city has a screen of
   * their own to be on.
   */
  it('holds a finished user at the channel gate when one is outstanding', () => {
    expect(stepFor('PROFILE_COMPLETE', 0, true)).toBe('/join-channels');
  });

  /**
   * Both gates closed at once. The terms win, and that ordering is deliberate:
   * accepting the rules is a screen a user can always complete, while the channel
   * check depends on Telegram answering — so starting at the one that can clear
   * itself is the difference between two dead ends and one.
   */
  it('sends a user who owes both to the terms first', () => {
    expect(stepFor('PROFILE_COMPLETE', 1, true)).toBe('/terms');
  });

  it('does not apply the channel gate mid-funnel', () => {
    expect(stepFor('NEW', 0, true)).toBe('/terms');
    expect(stepFor('TERMS_ACCEPTED', 0, true)).toBe('/profile');
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

  /**
   * The gate screen exists to have no way out of it, so the header — which is the
   * way home — must not be drawn on it, nor anywhere else while it is closed.
   */
  it('never draws it while the channel gate is closed', () => {
    expect(showsHomeButton('join-channels', 'PROFILE_COMPLETE', 0, true)).toBe(false);
    expect(showsHomeButton('home', 'PROFILE_COMPLETE', 0, true)).toBe(false);
    expect(showsHomeButton('discover', 'PROFILE_COMPLETE', 0, true)).toBe(false);
  });
});
