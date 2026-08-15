import { z } from 'zod';

/**
 * Request/response contracts shared by the backend and the Vue frontends
 * (ADR-0003). One schema, two enforcement points — the client cannot drift from
 * what the server accepts.
 */

export const telegramAuthRequest = z.object({
  /**
   * The raw `initData` query string from `window.Telegram.WebApp.initData`.
   * Never `initDataUnsafe` — that is unsigned client input.
   */
  initData: z.string().min(1).max(4096),
});
export type TelegramAuthRequest = z.infer<typeof telegramAuthRequest>;

export const refreshRequest = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const onboardingState = z.enum(['NEW', 'TERMS_ACCEPTED', 'PROFILE_COMPLETE']);
export type OnboardingState = z.infer<typeof onboardingState>;

/**
 * The authenticated user as the client sees them.
 *
 * Note what is absent: no Telegram id, no username, no internal id. This type is
 * the contract that invariant 7 is checked against.
 */
export const sessionUser = z.object({
  publicId: z.uuid(),
  onboardingState,
  locale: z.string(),
  timezone: z.string(),
});
export type SessionUser = z.infer<typeof sessionUser>;

export const authResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
  user: sessionUser,
});
export type AuthResponse = z.infer<typeof authResponse>;

export const policyType = z.enum(['TERMS', 'PRIVACY', 'COMMUNITY']);

export const policyView = z.object({
  id: z.uuid(),
  type: policyType,
  version: z.number().int().positive(),
  contentMd: z.string(),
  summaryFa: z.string().nullable(),
});
export type PolicyView = z.infer<typeof policyView>;

export const currentPoliciesResponse = z.object({
  policies: z.array(policyView),
});

export const acceptConsentRequest = z.object({
  /** Every current required policy version id must be present, or the request is stale. */
  policyVersionIds: z.array(z.uuid()).min(1).max(10),
});
export type AcceptConsentRequest = z.infer<typeof acceptConsentRequest>;
