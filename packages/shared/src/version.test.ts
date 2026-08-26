import { describe, expect, it } from 'vitest';
import { UNKNOWN_VERSION, isVersionMismatch, resolveVersion } from './version';

/**
 * Every case here is a way a release tag actually goes missing on a deploy, not a
 * synthetic edge: an unset variable, a Compose substitution that did not happen,
 * a shell that expanded to nothing.
 */
describe('resolveVersion', () => {
  it('keeps the tags a release actually carries', () => {
    expect(resolveVersion('v0.3.0')).toBe('v0.3.0');
    expect(resolveVersion('0.3.0-rc.1')).toBe('0.3.0-rc.1');
    expect(resolveVersion('0.3.0+build.42')).toBe('0.3.0+build.42');
    expect(resolveVersion('35c662f')).toBe('35c662f');
  });

  it('trims, because a variable read from a file carries the newline', () => {
    expect(resolveVersion('  v0.3.0\n')).toBe('v0.3.0');
  });

  it('falls back when nothing was set', () => {
    expect(resolveVersion(undefined)).toBe(UNKNOWN_VERSION);
    expect(resolveVersion(null)).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('')).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('   ')).toBe(UNKNOWN_VERSION);
  });

  it('falls back on a substitution that never happened', () => {
    expect(resolveVersion('${PAYETAM_VERSION}')).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('$PAYETAM_VERSION')).toBe(UNKNOWN_VERSION);
  });

  it('refuses anything that is not shaped like a tag', () => {
    // A path that leaked in, a value with a space, markup, a leading dash.
    expect(resolveVersion('/srv/releases/v0.3.0')).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('v0.3.0 (dirty)')).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('<script>alert(1)</script>')).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('-rc1')).toBe(UNKNOWN_VERSION);
  });

  it('refuses something too long to be a tag', () => {
    expect(resolveVersion('v'.repeat(49))).toBe(UNKNOWN_VERSION);
    expect(resolveVersion('v'.repeat(48))).toBe('v'.repeat(48));
  });

  it('accepts a non-string without throwing, because JSON can carry anything', () => {
    expect(resolveVersion(42 as unknown as string)).toBe(UNKNOWN_VERSION);
    expect(resolveVersion({} as unknown as string)).toBe(UNKNOWN_VERSION);
  });
});

describe('isVersionMismatch', () => {
  it('reports the case it exists for: a cached bundle against a newer API', () => {
    expect(isVersionMismatch('v0.2.0', 'v0.3.0')).toBe(true);
  });

  it('says nothing when they agree', () => {
    expect(isVersionMismatch('v0.3.0', 'v0.3.0')).toBe(false);
  });

  it('says nothing when either side did not know', () => {
    expect(isVersionMismatch(UNKNOWN_VERSION, 'v0.3.0')).toBe(false);
    expect(isVersionMismatch('v0.3.0', UNKNOWN_VERSION)).toBe(false);
    expect(isVersionMismatch('v0.3.0', null)).toBe(false);
    expect(isVersionMismatch('v0.3.0', undefined)).toBe(false);
    expect(isVersionMismatch('v0.3.0', '')).toBe(false);
  });
});
