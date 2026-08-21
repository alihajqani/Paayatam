import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AdminLoginRequest, AdminLoginResponse, AdminSessionView } from '@payetam/shared';
import { request, setCsrfToken, setUnauthenticatedHandler } from '@/api/client';

/**
 * The staff session (ADR-0010).
 *
 * **Nothing here is persisted.** The session itself is an `HttpOnly` cookie the
 * panel cannot read — which is the point, since script on this origin cannot
 * steal what it cannot see — and the CSRF token lives in this store for the
 * lifetime of the tab and nowhere else. Putting it in `localStorage` would hand
 * the second half of the pair to anything that can run on the origin, which
 * defeats splitting them in the first place.
 *
 * A reload therefore starts from `GET /admin/v1/me`: the cookie either still
 * resolves, in which case the panel comes back signed in and gets the token back
 * with it, or it does not, and the operator signs in again.
 */
export const useSessionStore = defineStore('session', () => {
  const session = ref<AdminSessionView | null>(null);
  /**
   * True once `restore()` has finished, however it finished.
   *
   * The router waits on it: navigating before the first `/me` resolves would
   * bounce a signed-in operator to the login screen on every hard refresh.
   */
  const ready = ref(false);
  /**
   * Whether this tab holds the token every mutation has to echo.
   *
   * Effectively always true while signed in, because `/me` returns the token as
   * well as the identity. It exists as a separate flag rather than as an
   * assumption so that a deployment where the two ever diverge disables the
   * buttons instead of producing a 403 per click.
   */
  const canMutate = ref(false);

  const signedIn = computed(() => session.value !== null);
  const permissions = computed(() => new Set(session.value?.permissions ?? []));

  /** Whether the signed-in account holds a permission. A courtesy, never a control. */
  function can(permission: string): boolean {
    return permissions.value.has(permission);
  }

  /** Whether it holds **any** of these — what a navigation section asks. */
  function canAny(...required: string[]): boolean {
    return required.some((permission) => permissions.value.has(permission));
  }

  async function login(credentials: AdminLoginRequest): Promise<void> {
    const result = await request<AdminLoginResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    });
    setCsrfToken(result.csrfToken);
    session.value = result.session;
    canMutate.value = true;
  }

  /**
   * Bring back a session the cookie still holds.
   *
   * Swallows the failure on purpose: "not signed in" is the ordinary state of
   * this call on a fresh browser, and surfacing it as an error would put a red
   * box on the login screen every time somebody opens the panel.
   */
  async function restore(): Promise<void> {
    try {
      const result = await request<AdminLoginResponse>('/me');
      setCsrfToken(result.csrfToken === '' ? null : result.csrfToken);
      session.value = result.session;
      canMutate.value = result.csrfToken !== '';
    } catch {
      clear();
    } finally {
      ready.value = true;
    }
  }

  /** Forget everything this tab knows. Does not call the API. */
  function clear(): void {
    session.value = null;
    canMutate.value = false;
    setCsrfToken(null);
  }

  /**
   * End the session, and forget it locally whatever the server says.
   *
   * The failure is swallowed on purpose. A panel that stayed "signed in" because
   * the network blinked would be showing stale data behind a session the operator
   * believes they closed — and the cookie expires on its own twelve-hour idle
   * timer regardless, so the worst case of swallowing is a session that outlives
   * the tab rather than one that outlives the intention.
   */
  async function logout(): Promise<void> {
    try {
      if (canMutate.value) await request<void>('/auth/logout', { method: 'POST' });
    } catch {
      // See above.
    } finally {
      clear();
    }
  }

  /**
   * What the client calls when the API says 401.
   *
   * Registered once, here, because the store is the only thing that knows what a
   * dead session means for the rest of the panel.
   */
  setUnauthenticatedHandler(() => {
    clear();
    ready.value = true;
  });

  return {
    session,
    ready,
    canMutate,
    signedIn,
    permissions,
    can,
    canAny,
    login,
    restore,
    logout,
    clear,
  };
});
