import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AuthResponse,
  CatalogResponse,
  CompleteProfileRequest,
  CompleteProfileResponse,
  MeResponse,
  PolicyView,
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
  const policies = ref<PolicyView[]>([]);
  const catalog = ref<CatalogResponse | null>(null);
  const ready = ref(false);

  async function signIn(): Promise<void> {
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

    setAccessToken(auth.accessToken);
    await refreshMe();
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

  return {
    me,
    policies,
    catalog,
    ready,
    signIn,
    refreshMe,
    loadPolicies,
    acceptTerms,
    loadCatalog,
    completeProfile,
  };
});
