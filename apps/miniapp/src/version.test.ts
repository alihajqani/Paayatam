import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));

const { APP_VERSION, fetchServerVersion, isStaleBundle } = await import('./version');

/**
 * The version line, and the one thing it is for beyond reading out loud: telling
 * a user sitting on a cached bundle that they are.
 */
describe('APP_VERSION', () => {
  it('is `local` when the bundle was built without the arg, as in development', () => {
    // `VITE_APP_VERSION` is unset under vitest, which is the same state as a
    // `pnpm dev` build — and `resolveVersion` turns that into `local` rather than
    // an empty string on the screen.
    expect(APP_VERSION).toBe('local');
  });
});

describe('fetchServerVersion', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('asks the public endpoint and returns what it says', async () => {
    request.mockResolvedValue({ version: 'v0.3.0' });

    await expect(fetchServerVersion()).resolves.toBe('v0.3.0');
    expect(request).toHaveBeenCalledWith('/version');
  });

  it('puts the answer through the same shape rule as the bundle version', async () => {
    // A deployment whose `PAYETAM_VERSION` never got substituted. The server
    // already resolves it; this is the belt to that braces, because the value is
    // rendered.
    request.mockResolvedValue({ version: '${PAYETAM_VERSION}' });

    await expect(fetchServerVersion()).resolves.toBe('local');
  });

  it('returns null rather than throwing when the API cannot be reached', async () => {
    request.mockRejectedValue(new Error('offline'));

    await expect(fetchServerVersion()).resolves.toBeNull();
  });
});

describe('isStaleBundle', () => {
  it('says nothing in development, where neither side knows its version', () => {
    // Both are `local` here, which is the state every developer sees. A warning
    // that fires on every `pnpm dev` is a warning nobody reads in production.
    expect(isStaleBundle('local')).toBe(false);
    expect(isStaleBundle(null)).toBe(false);
  });

  it('says nothing when the API did not answer', () => {
    expect(isStaleBundle(null)).toBe(false);
  });
});
