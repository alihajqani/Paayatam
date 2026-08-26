import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  AuthResponse,
  CatalogResponse,
  CompleteProfileRequest,
  CompleteProfileResponse,
  MeResponse,
  PolicyView,
  ProfileView,
  SessionUser,
  UpdateProfileRequest,
} from '@payetam/shared';
import { request, setAccessToken } from '@/api/client';
import { webApp } from '@/telegram/webapp';

/**
 * The session and everything hanging off it.
 *
 * One store rather than several, because at this stage there is one flow: sign
 * in, accept the terms, complete the profile. Splitting it now would be three
 * files that always change together.
 *
 * Tokens are held in memory only. A Telegram WebView is reopened from scratch
 * each time, so `initData` is always available to re-authenticate — putting a
 * refresh token in `localStorage` would buy nothing and leave a credential
 * sitting in storage any script on the origin can read (ADR-0004).
 */
export const useSessionStore = defineStore('session', () => {
  const me = ref<MeResponse | null>(null);
  /**
   * The user as the sign-in response described them.
   *
   * Kept because `/me` is behind the terms gate and a `NEW` user cannot call it, so
   * for the length of the terms screen this is the *only* copy of the onboarding
   * state — and the router needs it to know which step to show.
   */
  const authUser = ref<SessionUser | null>(null);
  const policies = ref<PolicyView[]>([]);
  const catalog = ref<CatalogResponse | null>(null);
  const ready = ref(false);

  /** Held so a retry can renew the session instead of replaying `initData`. */
  const refreshToken = ref<string | null>(null);
  const expiresInSeconds = ref<number | null>(null);

  /**
   * Which onboarding step the user is on — the single source of truth for routing.
   *
   * `me` is richer but unavailable until the terms are accepted, so it is preferred
   * when present and the sign-in response answers for the gap. Derived here rather
   * than at each call site: the same fallback written out twice is how the splash
   * ended up routing a `NEW` user to `stepFor(undefined)`.
   */
  const onboardingState = computed(
    () => me.value?.onboardingState ?? authUser.value?.onboardingState,
  );

  function applySession(auth: AuthResponse): void {
    setAccessToken(auth.accessToken);
    authUser.value = auth.user;
    refreshToken.value = auth.refreshToken;
    expiresInSeconds.value = auth.expiresInSeconds;
  }

  /**
   * Loads `/me`, but only when the terms gate will let it through.
   *
   * `GET /me` has no `@AllowPendingTerms` by design, so calling it while the user is
   * still `NEW` returns 403 TERMS_NOT_ACCEPTED — which used to abort sign-in on the
   * one screen whose whole purpose is to accept the terms.
   */
  async function loadMeIfPermitted(state: SessionUser['onboardingState']): Promise<void> {
    if (state !== 'NEW') await refreshMe();
  }

  async function signIn(): Promise<void> {
    /**
     * `initData` is single-use: `InitDataReplayGuard` claims its hash in Redis, and a
     * second attempt with the same blob is refused as INVALID_INIT_DATA — the very
     * code a forged blob gets. Telegram hands the WebView one `initData` for the
     * whole session, so a retry must renew the session rather than re-authenticate.
     */
    if (refreshToken.value !== null) {
      await renew();
      return;
    }

    const initData = webApp?.initData;
    if (!initData) {
      // Deliberately not a silent degradation. Everything downstream assumes an
      // authenticated user, and a browser tab has no way to become one.
      throw new Error(
        'This app must be opened from inside Telegram: there is no initData to authenticate with.',
      );
    }

    const auth = await request<AuthResponse>('/auth/telegram', {
      method: 'POST',
      body: { initData },
    });

    applySession(auth);
    await loadMeIfPermitted(auth.user.onboardingState);
    ready.value = true;
  }

  /** Trades the refresh token for a fresh session. Rotation means the new one replaces it. */
  async function renew(): Promise<void> {
    const token = refreshToken.value;
    if (token === null) {
      throw new Error('renew() requires a refresh token from a previous sign-in.');
    }

    const auth = await request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: token },
    });

    applySession(auth);
    await loadMeIfPermitted(auth.user.onboardingState);
    ready.value = true;
  }

  async function refreshMe(): Promise<void> {
    me.value = await request<MeResponse>('/me');
  }

  async function loadPolicies(): Promise<void> {
    const response = await request<{ policies: PolicyView[] }>('/policies/current');
    policies.value = response.policies;
  }

  async function acceptTerms(): Promise<void> {
    await request('/onboarding/consent', {
      method: 'POST',
      body: { policyVersionIds: policies.value.map((policy) => policy.id) },
    });
    await refreshMe();
  }

  async function loadCatalog(): Promise<void> {
    catalog.value = await request<CatalogResponse>('/catalog');
  }

  async function completeProfile(input: CompleteProfileRequest): Promise<CompleteProfileResponse> {
    const response = await request<CompleteProfileResponse>('/onboarding/profile', {
      method: 'POST',
      body: input,
    });
    await refreshMe();
    return response;
  }

  /**
   * Edit an existing profile (M22 phase 2).
   *
   * `PATCH`, carrying only the fields that changed — the server leaves an absent
   * one alone, so a screen that renders four inputs cannot clear a fifth it never
   * showed.
   *
   * The response is written straight into `me` rather than merged, and then `/me`
   * is **not** re-fetched: the server has just told us the whole profile it
   * stored, so asking again would be a second round trip to learn the same thing.
   * Nothing is applied optimistically — the store is updated after the server
   * agrees, so a failed request leaves the screen showing what is actually saved.
   */
  async function updateProfile(input: UpdateProfileRequest): Promise<ProfileView> {
    const response = await request<{ profile: ProfileView }>('/me/profile', {
      method: 'PATCH',
      body: input,
    });
    if (me.value) me.value = { ...me.value, profile: response.profile };
    return response.profile;
  }

  return {
    me,
    // `refreshToken` is deliberately not returned: nothing outside this store needs
    // it, and a credential that is not reachable cannot be logged by accident.
    authUser,
    onboardingState,
    expiresInSeconds,
    policies,
    catalog,
    ready,
    signIn,
    renew,
    refreshMe,
    loadPolicies,
    acceptTerms,
    loadCatalog,
    completeProfile,
    updateProfile,
  };
});
