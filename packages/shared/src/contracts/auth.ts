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
  /**
   * The document's own name, and what changed since the previous version (M22).
   *
   * Both nullable, because the versions seeded before M22 have neither and
   * inventing them would be writing legal text nobody approved. A client renders
   * the summary when it is there and the type when it is not.
   */
  titleFa: z.string().nullable(),
  changeSummaryFa: z.string().nullable(),
  /** `TERMS v3` — what a consent record snapshots, shown so the user sees it too. */
  label: z.string(),
});
export type PolicyView = z.infer<typeof policyView>;

export const currentPoliciesResponse = z.object({
  policies: z.array(policyView),
});

/**
 * Which current documents this user still has to accept (M22 phase 8).
 *
 * `pending` is the gate: non-empty means the protected operations refuse until
 * it is empty. `accepted` carries what they have already agreed to and when, so
 * "when did I accept the terms?" is answerable from the app rather than only from
 * a support conversation.
 */
export const myPoliciesResponse = z.object({
  pending: z.array(policyView),
  accepted: z.array(
    z.object({
      policy: policyView,
      acceptedAt: z.iso.datetime(),
    }),
  ),
});
export type MyPoliciesResponse = z.infer<typeof myPoliciesResponse>;

export const acceptConsentRequest = z.object({
  /** Every current required policy version id must be present, or the request is stale. */
  policyVersionIds: z.array(z.uuid()).min(1).max(10),
});
export type AcceptConsentRequest = z.infer<typeof acceptConsentRequest>;
