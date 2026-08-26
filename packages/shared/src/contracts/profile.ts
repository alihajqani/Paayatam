import { z } from 'zod';
import { onboardingState } from './auth';

/**
 * Profile contracts.
 *
 * The bounds here are duplicated as CHECK constraints in migration 0003. That is
 * deliberate: this schema protects the API and the Mini App form, the constraints
 * protect the table from a seed script, a migration or a psql session.
 */

export const gender = z.enum(['MALE', 'FEMALE', 'PREFER_NOT_SAY']);
export type Gender = z.infer<typeof gender>;

/**
 * `birthYear` is a **Gregorian** year, and required even though the column is
 * nullable — the column allows null so M15 can anonymise a profile without
 * deleting it, not so a user can decline to answer and skip the 18+ gate
 * (ADR-0009).
 *
 * The upper bound is loose on purpose. Whether the user is old enough is a
 * question about *today*, which only the server's clock may answer (invariant 9),
 * so this schema checks plausibility and `ProfileService` checks age. A client
 * that computed the age itself would be trusting a client clock.
 */
export const completeProfileRequest = z.object({
  displayName: z.string().trim().min(2).max(40),
  gender: gender.optional(),
  birthYear: z.number().int().min(1900).max(2200),
  cityId: z.uuid(),
  districtId: z.uuid().optional(),
  bio: z.string().trim().max(300).optional(),
  interestIds: z.array(z.uuid()).min(1).max(10),
});
export type CompleteProfileRequest = z.infer<typeof completeProfileRequest>;

/**
 * Editing a profile that already exists (M22 phase 2).
 *
 * Deliberately **not** `completeProfileRequest.partial()`. Three of these fields
 * are nullable here and are not optional-with-absent-meaning-null there, and the
 * distinction is the whole contract: an **absent** key means "leave it alone" and
 * an explicit `null` means "clear it". `.partial()` collapses those into one
 * `undefined`, which would make "remove my bio" unexpressible and "I only changed
 * my city" indistinguishable from "wipe everything else".
 *
 * `cityId` has no null: a profile must always name a city (the column is NOT
 * NULL), so the only edit available is to a different one. `interestIds`, when
 * present, is the **whole** new set — a replace rather than a patch, because a
 * user unticking their last interest is a legitimate edit that an add/remove pair
 * would need two more fields to express.
 *
 * At least one key must be present. An empty body is a client bug, and answering
 * it with 200 would hide the bug behind a success.
 */
export const updateProfileRequest = z
  .object({
    displayName: z.string().trim().min(2).max(40).optional(),
    gender: gender.nullable().optional(),
    birthYear: z.number().int().min(1900).max(2200).optional(),
    cityId: z.uuid().optional(),
    districtId: z.uuid().nullable().optional(),
    bio: z.string().trim().max(300).nullable().optional(),
    interestIds: z.array(z.uuid()).min(1).max(10).optional(),
    /** Whether to stop receiving paid event invitations (phase 11). */
    inviteOptOut: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequest>;

/**
 * The admin's version of the same edit.
 *
 * Narrower on purpose, and the omissions are the interesting part.
 * `interestIds` is absent because a moderator retagging somebody’s interests is
 * editing a *preference*, not correcting a record — and `inviteOptOut` is absent
 * for the stronger version of the same reason: opting a user back in to messages
 * they asked not to receive is not an administrative correction, it is undoing a
 * consent decision.
 *
 * What is left is exactly the set a support conversation needs to fix:
 * a display name that breaks the rules, a birth year typed wrong, a city that
 * moved, a bio that has to go.
 */
export const adminUpdateProfileRequest = z
  .object({
    displayName: z.string().trim().min(2).max(40).optional(),
    gender: gender.nullable().optional(),
    birthYear: z.number().int().min(1900).max(2200).optional(),
    cityId: z.uuid().optional(),
    districtId: z.uuid().nullable().optional(),
    bio: z.string().trim().max(300).nullable().optional(),
    /** Why. Required, and recorded in the audit row — an unexplained edit to
     *  somebody else’s profile is not reviewable later. */
    reason: z.string().trim().min(3).max(280),
  })
  .refine((body) => Object.keys(body).length > 1, {
    message: 'at least one field must be provided alongside the reason',
  });
export type AdminUpdateProfileRequest = z.infer<typeof adminUpdateProfileRequest>;

const namedRef = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
});

export const profileView = z.object({
  displayName: z.string(),
  gender: gender.nullable(),
  birthYear: z.number().int().nullable(),
  city: namedRef,
  district: namedRef.nullable(),
  bio: z.string().nullable(),
  interests: z.array(namedRef),
  /** Whether this user has asked not to receive event invitations (M22). */
  inviteOptOut: z.boolean(),
  /** ISO-8601 UTC. The Mini App renders Jalali; the API never speaks it (ADR-0008). */
  completedAt: z.iso.datetime().nullable(),
});
export type ProfileView = z.infer<typeof profileView>;

export const coinBalanceView = z.object({
  balance: z.number().int().nonnegative(),
});
export type CoinBalanceView = z.infer<typeof coinBalanceView>;

export const meResponse = z.object({
  publicId: z.uuid(),
  onboardingState,
  locale: z.string(),
  timezone: z.string(),
  /** Null until the user completes onboarding. */
  profile: profileView.nullable(),
  coins: coinBalanceView,
});
export type MeResponse = z.infer<typeof meResponse>;

export const completeProfileResponse = z.object({
  onboardingState,
  profile: profileView,
  coins: coinBalanceView,
  /**
   * False when the reward was already granted — which is what a retry, a
   * double-tapped button or a second concurrent request all get. The client
   * shows the "+۵۰ سکه" celebration only when this is true, so the idempotency
   * of the grant is visible rather than merely claimed.
   */
  rewardGranted: z.boolean(),
  /**
   * The score after the profile-completion movement (plan §11: +5).
   *
   * Reported alongside the coins because completing a profile moves both, and a
   * response that mentions one half of what just happened reads as though the
   * other did not. The full explanation is `GET /me/trust`.
   */
  trustScore: z.number().int().min(0).max(100),
});
export type CompleteProfileResponse = z.infer<typeof completeProfileResponse>;
