import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PERMISSIONS } from '@payetam/shared';
import router from './router';
import { useSessionStore } from './stores/session';

/**
 * The route guard.
 *
 * **It is a courtesy, not a control** — every permission below is checked again
 * in the service layer, and an operator who edits the URL gets the same refusals
 * from the API either way. What it buys is that somebody who cannot use a page
 * does not land on a page full of 403s, and that a link they follow from an alert
 * survives signing in.
 *
 * The one case worth the most is the hard refresh: navigation happens before the
 * first `/me` resolves, and a guard that did not wait would bounce a signed-in
 * operator to the login screen every time they reloaded.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ANALYST = {
  email: 'analyst@payetam.test',
  displayName: 'تحلیل‌گر',
  roles: ['ANALYST'],
  // ADR-0010: the dashboard and nothing else.
  permissions: [PERMISSIONS.DASHBOARD_READ],
};

const SUPER = {
  email: 'super@payetam.test',
  displayName: 'مدیر ارشد',
  roles: ['SUPER_ADMIN'],
  permissions: Object.values(PERMISSIONS),
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Sign the store in as this session before the guard runs. */
function signedInAs(session: unknown): void {
  fetchMock.mockResolvedValue(jsonResponse({ csrfToken: 'tok', session }));
}

function signedOut(): void {
  fetchMock.mockResolvedValue(
    jsonResponse({ error: { code: 'UNAUTHENTICATED', messageFa: 'وارد شوید.' } }, 401),
  );
}

beforeEach(async () => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Start every case from a known location that needs no session.
  signedOut();
  await router.push('/login');
  await router.isReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a signed-out browser', () => {
  it('is sent to the login screen', async () => {
    await router.push('/users');

    expect(router.currentRoute.value.name).toBe('login');
  });

  it('is told where it was going, so signing in finishes the journey', async () => {
    await router.push('/gift-codes');

    expect(router.currentRoute.value.query.redirect).toBe('/gift-codes');
  });

  /** The dashboard is the default landing, so a bare `/` needs no round trip. */
  it('carries no redirect for the root', async () => {
    await router.push('/');

    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });
});

describe('a hard refresh with a live cookie', () => {
  it('restores the session rather than bouncing to login', async () => {
    signedInAs(SUPER);
    useSessionStore().clear();
    useSessionStore().ready = false;

    await router.push('/gift-codes');

    expect(router.currentRoute.value.name).toBe('gift-codes');
  });
});

describe('a session that cannot open a page', () => {
  beforeEach(() => {
    signedInAs(ANALYST);
    useSessionStore().ready = false;
  });

  /**
   * ADR-0010's line, enforced by the router as well as by the service:
   * *"`ANALYST` gets `dashboard.read` and nothing else."*
   */
  it('lands on «دسترسی ندارید» rather than being silently redirected', async () => {
    await router.push('/users');

    expect(router.currentRoute.value.name).toBe('forbidden');
  });

  it('names the permission it lacked, because the fix is a role change', async () => {
    await router.push('/settings');

    expect(router.currentRoute.value.query.required).toBe(PERMISSIONS.SETTINGS_MANAGE);
  });

  it('still opens the one page it does hold', async () => {
    await router.push('/');

    expect(router.currentRoute.value.name).toBe('dashboard');
  });
});

describe('a signed-in operator', () => {
  beforeEach(() => {
    signedInAs(SUPER);
    useSessionStore().ready = false;
  });

  it('is kept off the login screen', async () => {
    // Away first: `beforeEach` leaves the router *on* `/login`, and pushing the
    // location it is already at is a navigation vue-router skips entirely — the
    // guard would never run and the test would pass for the wrong reason.
    await router.push('/users');

    await router.push('/login');

    expect(router.currentRoute.value.name).toBe('dashboard');
  });

  it('reaches every screen a SUPER_ADMIN holds', async () => {
    for (const path of [
      '/',
      '/users',
      '/events',
      '/reports',
      '/cases',
      '/gift-codes',
      '/referrals',
      '/ledger',
      '/audit',
      '/settings',
    ]) {
      await router.push(path);
      expect(router.currentRoute.value.path, path).toBe(path);
    }
  });
});

describe('the route table itself', () => {
  /**
   * The navigation is built from `meta`, and the guard reads the same field — so
   * a route that declares a group and no permission would be a menu entry
   * anybody can click. Only the login and forbidden screens are exempt, and
   * neither is in a group.
   */
  it('declares a permission for every screen in the navigation', () => {
    for (const route of router.getRoutes()) {
      if (route.meta.group === null || route.meta.group === undefined) continue;
      expect(route.meta.permission, String(route.name)).toBeDefined();
    }
  });

  it('gives every screen a Persian title for the menu and the tab', () => {
    for (const route of router.getRoutes()) {
      if (route.name === undefined) continue;
      expect(route.meta.title, String(route.name)).toBeTruthy();
    }
  });
});
