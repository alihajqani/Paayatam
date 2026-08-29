import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));
vi.mock('@/telegram/webapp', () => ({ webApp: null, haptic: vi.fn() }));

const { useSessionStore } = await import('./session');

const PROFILE = {
  displayName: 'سارا',
  gender: 'FEMALE',
  birthYear: 1996,
  city: { id: 'city-1', slug: 'tehran', nameFa: 'تهران' },
  district: null,
  bio: 'بازی رومیزی',
  interests: [{ id: 'i-1', slug: 'board-games', nameFa: 'بازی رومیزی' }],
  inviteOptOut: false,
  completedAt: '2026-08-01T09:00:00.000Z',
};

const ME = {
  publicId: '11111111-1111-4111-8111-111111111111',
  onboardingState: 'PROFILE_COMPLETE',
  locale: 'fa-IR',
  timezone: 'Asia/Tehran',
  profile: PROFILE,
  coins: { balance: 50 },
};

/**
 * The profile-edit half of the session store (M22 phase 2).
 *
 * Two properties are worth a test rather than a reading: the request is a `PATCH`
 * carrying only what was passed, and the store is updated from the **response**
 * rather than from the request — which is what stops a failed save from leaving
 * the screen showing something the server never accepted.
 */
describe('session store — updateProfile', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('sends a PATCH carrying only the fields it was given', async () => {
    request.mockResolvedValue({ profile: { ...PROFILE, displayName: 'سارای تازه' } });
    const store = useSessionStore();

    await store.updateProfile({ displayName: 'سارای تازه' });

    expect(request).toHaveBeenCalledWith('/me/profile', {
      method: 'PATCH',
      body: { displayName: 'سارای تازه' },
    });
  });

  it('writes the response into `me`, not the request', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/me') return Promise.resolve(ME);
      // The server normalised the name — trimmed, in this case. A store that kept
      // what was *sent* would show the untrimmed version until the next reload.
      return Promise.resolve({ profile: { ...PROFILE, displayName: 'نام تمیز' } });
    });
    const store = useSessionStore();
    await store.refreshMe();

    await store.updateProfile({ displayName: '  نام تمیز  ' });

    expect(store.me?.profile?.displayName).toBe('نام تمیز');
    // The rest of `me` survives: this is a profile edit, not a session reset.
    expect(store.me?.coins.balance).toBe(50);
  });

  it('does not re-fetch /me after a successful save', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/me') return Promise.resolve(ME);
      return Promise.resolve({ profile: PROFILE });
    });
    const store = useSessionStore();
    await store.refreshMe();
    request.mockClear();

    await store.updateProfile({ bio: null });

    // The response already carries the whole stored profile; asking again would
    // be a second round trip to learn the same thing.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/me/profile', { method: 'PATCH', body: { bio: null } });
  });

  it('leaves the store untouched when the save fails', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/me') return Promise.resolve(ME);
      return Promise.reject(new Error('boom'));
    });
    const store = useSessionStore();
    await store.refreshMe();

    await expect(store.updateProfile({ displayName: 'هرگز' })).rejects.toThrow();

    expect(store.me?.profile?.displayName).toBe('سارا');
  });
});
