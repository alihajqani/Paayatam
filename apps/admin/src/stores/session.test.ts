import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PERMISSIONS } from '@payetam/shared';
import { useSessionStore } from './session';

/**
 * The session, and the one property that is easy to get wrong: **nothing is
 * persisted.**
 *
 * The cookie is `HttpOnly` and the panel cannot read it; the CSRF token lives in
 * this store and nowhere else. So the tests below assert the *absence* of
 * storage as much as the presence of behaviour — a future "remember me" that
 * writes either half to `localStorage` hands it to anything that runs on the
 * origin, and the reason the two are split would be gone.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SESSION = {
  email: 'mod@payetam.test',
  displayName: 'ناظر',
  roles: ['MODERATOR'],
  permissions: [PERMISSIONS.DASHBOARD_READ, PERMISSIONS.USER_READ, PERMISSIONS.REPORT_REVIEW],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signing in', () => {
  it('keeps the identity and the token, and writes neither to storage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    const session = useSessionStore();

    await session.login({ email: SESSION.email, password: 'x'.repeat(12), totpCode: '123456' });

    expect(session.signedIn).toBe(true);
    expect(session.canMutate).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('leaves the store signed out when the credentials are refused', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'INVALID_CREDENTIALS', messageFa: 'ایمیل، رمز عبور یا کد نادرست است.' } },
        401,
      ),
    );
    const session = useSessionStore();

    await expect(
      session.login({ email: SESSION.email, password: 'x'.repeat(12), totpCode: '000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(session.signedIn).toBe(false);
    expect(session.canMutate).toBe(false);
  });
});

describe('restoring after a reload', () => {
  /**
   * The whole reason `/me` returns the CSRF token: the cookie survives a reload
   * and the token does not, so without this the panel would come back able to
   * read everything and mutate nothing.
   */
  it('brings back the identity and the ability to act', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    const session = useSessionStore();

    await session.restore();

    expect(session.signedIn).toBe(true);
    expect(session.canMutate).toBe(true);
    expect(session.ready).toBe(true);
  });

  it('is read-only if the server answers without a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ csrfToken: '', session: SESSION }));
    const session = useSessionStore();

    await session.restore();

    expect(session.signedIn).toBe(true);
    expect(session.canMutate).toBe(false);
  });

  /**
   * "Not signed in" is the ordinary state of this call on a fresh browser.
   * Surfacing it would put a red box on the login screen every time somebody
   * opens the panel.
   */
  it('treats a 401 as signed-out rather than as an error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHENTICATED', messageFa: 'وارد شوید.' } }, 401),
    );
    const session = useSessionStore();

    await expect(session.restore()).resolves.toBeUndefined();

    expect(session.signedIn).toBe(false);
    expect(session.ready).toBe(true);
  });
});

describe('a session that expires mid-use', () => {
  it('is cleared by the client’s 401 handler without anybody calling logout', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    const session = useSessionStore();
    await session.login({ email: SESSION.email, password: 'x'.repeat(12), totpCode: '123456' });
    expect(session.signedIn).toBe(true);

    // Anything at all, answered 401 — the handler the store registered fires.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHENTICATED', messageFa: 'وارد شوید.' } }, 401),
    );
    const { request } = await import('@/api/client');
    await expect(request('/users')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(session.signedIn).toBe(false);
    expect(session.canMutate).toBe(false);
  });
});

describe('signing out', () => {
  it('ends the session server-side and forgets everything locally', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    const session = useSessionStore();
    await session.login({ email: SESSION.email, password: 'x'.repeat(12), totpCode: '123456' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await session.logout();

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/v1/auth/logout');
    expect(session.signedIn).toBe(false);
  });

  /**
   * A failing logout must still sign the tab out. The cookie expires on its own
   * twelve-hour idle timer, and a panel that stayed "signed in" because the
   * network blinked would be showing stale data behind a dead session.
   */
  it('forgets locally even when the call fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    const session = useSessionStore();
    await session.login({ email: SESSION.email, password: 'x'.repeat(12), totpCode: '123456' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await session.logout();

    expect(session.signedIn).toBe(false);
  });
});

describe('what the panel is allowed to show', () => {
  beforeEach(async () => {
    fetchMock.mockResolvedValue(jsonResponse({ csrfToken: 'tok', session: SESSION }));
    await useSessionStore().restore();
  });

  it('answers for a permission the session holds', () => {
    expect(useSessionStore().can(PERMISSIONS.REPORT_REVIEW)).toBe(true);
  });

  it('refuses one it does not', () => {
    // A `MODERATOR` never holds this — ADR-0010 keeps minting coins with
    // `SUPER_ADMIN` alone.
    expect(useSessionStore().can(PERMISSIONS.GIFT_CODE_MANAGE)).toBe(false);
  });

  it('answers «any of these» for a navigation section', () => {
    const session = useSessionStore();
    expect(session.canAny(PERMISSIONS.GIFT_CODE_MANAGE, PERMISSIONS.USER_READ)).toBe(true);
    expect(session.canAny(PERMISSIONS.GIFT_CODE_MANAGE, PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
  });

  it('grants nothing at all when signed out', () => {
    const session = useSessionStore();
    session.clear();
    expect(session.can(PERMISSIONS.DASHBOARD_READ)).toBe(false);
  });
});
