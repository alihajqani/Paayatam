import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `webApp` is captured at module load from `window.Telegram`, so each case has to
 * set the global first and then re-import. `resetModules` is what makes the second
 * import actually re-run rather than return the first one's binding.
 */
async function targetFor(startParam: string | undefined): Promise<string | null> {
  vi.resetModules();
  (window as unknown as { Telegram?: unknown }).Telegram = {
    WebApp: { initDataUnsafe: startParam === undefined ? {} : { start_param: startParam } },
  };
  const { deepLinkTarget } = await import('./webapp');
  return deepLinkTarget();
}

afterEach(() => {
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

describe('deepLinkTarget', () => {
  it('is null when Telegram sent no start param', async () => {
    expect(await targetFor(undefined)).toBeNull();
  });

  it('is null for an empty start param', async () => {
    expect(await targetFor('')).toBeNull();
  });

  it('resolves the targets the notification buttons actually send', async () => {
    expect(await targetFor('home')).toBe('/home');
    expect(await targetFor('wallet')).toBe('/wallet');
    expect(await targetFor('my-requests')).toBe('/my-requests');
  });

  /** `openAppButton` encodes `/` as `_`, because Telegram allows no slash. */
  it('decodes the underscore the button encoded a slash as', async () => {
    expect(await targetFor('reviews_pending')).toBe('/reviews');
  });

  /**
   * The payload is attacker-supplied: anyone can send anyone a `?startapp=` link.
   * An unknown target opens nothing rather than being treated as a path.
   */
  it('refuses anything not on the allowlist', async () => {
    expect(await targetFor('events_abc123_edit')).toBeNull();
    expect(await targetFor('../admin')).toBeNull();
    expect(await targetFor('/home')).toBeNull();
    expect(await targetFor('https://example.com')).toBeNull();
  });
});
