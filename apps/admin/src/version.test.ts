import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setCsrfToken: vi.fn(),
  setUnauthenticatedHandler: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));

const { APP_VERSION, fetchServerVersion, isServerAhead } = await import('./version');

describe('APP_VERSION', () => {
  it('is `local` when the bundle was built without the arg', () => {
    expect(APP_VERSION).toBe('local');
  });
});

describe('fetchServerVersion', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('asks `/admin/v1/version` — the prefix the panel is proxied and cookied for', () => {
    request.mockResolvedValue({ version: 'v0.3.0' });

    void fetchServerVersion();

    // The client prepends `/admin/v1`, so the path passed here is the tail.
    expect(request).toHaveBeenCalledWith('/version');
  });

  it('returns null rather than throwing, so a version line cannot break the shell', async () => {
    request.mockRejectedValue(new Error('offline'));

    await expect(fetchServerVersion()).resolves.toBeNull();
  });
});

describe('isServerAhead', () => {
  it('reports the mid-deploy state it exists for', () => {
    // Not reachable through `APP_VERSION` here — it is `local` under vitest —
    // so the comparison itself is covered in `packages/shared/src/version.test.ts`.
    // What this asserts is the wiring: `local` on either side is never a mismatch.
    expect(isServerAhead('v0.3.0')).toBe(false);
    expect(isServerAhead(null)).toBe(false);
  });
});
