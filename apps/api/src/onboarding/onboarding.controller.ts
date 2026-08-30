import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Env } from '@payetam/config';
import {
  CoinService,
  ConsentService,
  ProfileService,
  UserService,
  UserSettingsService,
} from '@payetam/domain';
import {
  acceptConsentRequest,
  completeProfileRequest,
  updateNotificationSettingsRequest,
  updateProfileRequest,
  type NotificationSettingsView,
  type UpdateNotificationSettingsRequest,
  type CompleteProfileRequest,
  type CompleteProfileResponse,
  type MeResponse,
  type MyPoliciesResponse,
  type PolicyView,
  type ProfileView,
  type UpdateProfileRequest,
} from '@payetam/shared';
import { ENV, currentRequestContext } from '@payetam/platform';
import type { FastifyRequest } from 'fastify';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AllowPendingTerms, CurrentUser, Public, type AuthenticatedUser } from '../auth/auth.guard';
import { toProfileView } from './profile.view';

@Controller('api/v1')
export class OnboardingController {
  constructor(
    private readonly consent: ConsentService,
    private readonly users: UserService,
    private readonly profiles: ProfileService,
    private readonly coins: CoinService,
    private readonly userSettings: UserSettingsService,
    // For `APP_LOCALE`, which `GET /me/settings` reports as the language: it is
    // configuration rather than a per-user column, and the settings screen is
    // where somebody looks for it.
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * The signed-in user, their profile and their coin balance.
   *
   * Deliberately has no `@AllowPendingTerms`, so it is subject to the terms gate —
   * which makes it the endpoint the gate's tests exercise. Trust Score joins this
   * response in M9.
   */
  @Get('me')
  async me(@CurrentUser() current: AuthenticatedUser): Promise<MeResponse> {
    const user = await this.users.findByPublicId(current.publicId);
    const internalId = await this.users.resolveInternalId(current.publicId);

    const [profile, balance] = await Promise.all([
      this.profiles.find(internalId),
      this.coins.balanceOf(internalId),
    ]);

    return {
      publicId: user.publicId,
      onboardingState: user.onboardingState,
      locale: user.locale,
      timezone: user.timezone,
      profile: profile ? toProfileView(profile) : null,
      coins: { balance },
    };
  }

  /** Public: the terms must be readable before anyone has a reason to sign in. */
  @Public()
  @Get('policies/current')
  async currentPolicies(): Promise<{ policies: PolicyView[] }> {
    const policies = await this.consent.currentPolicies();
    return { policies };
  }

  /**
   * What this user still has to accept, and what they already have (M22 phase 8).
   *
   * `@AllowPendingTerms` for the same reason `POST /onboarding/consent` has it:
   * the whole point of this endpoint is to be reachable by somebody who has not
   * accepted anything yet.
   *
   * `pending` is what the Mini App routes on. It is **not** the authority — the
   * `@RequiresCurrentPolicies()` guard re-checks on every protected write, because
   * a client that skips a screen is not a client that skipped the rule.
   */
  @AllowPendingTerms()
  @Get('me/policies')
  async myPolicies(@CurrentUser() current: AuthenticatedUser): Promise<MyPoliciesResponse> {
    const internalId = await this.users.resolveInternalId(current.publicId);
    const standing = await this.consent.standingFor(internalId);

    return {
      pending: standing.pending,
      accepted: standing.accepted.map((entry) => ({
        policy: entry.policy,
        acceptedAt: entry.acceptedAt.toISOString(),
      })),
    };
  }

  /**
   * Records acceptance and advances onboarding.
   *
   * `@AllowPendingTerms` because this is the endpoint that resolves the pending
   * state — gating it behind the terms gate would deadlock onboarding.
   *
   * Idempotent: the unique constraint on (user, version, context) means repeated or
   * concurrent submissions produce one row and one success.
   */
  @AllowPendingTerms()
  @Post('onboarding/consent')
  @HttpCode(HttpStatus.OK)
  async accept(
    // The pipe is attached to the parameter, NOT via @UsePipes. A method-level
    // @UsePipes runs against *every* parameter, so it would also try to zod-validate
    // @CurrentUser() and @Req() and reject every request as VALIDATION_FAILED.
    @Body(new ZodValidationPipe(acceptConsentRequest)) body: { policyVersionIds: string[] },
    @CurrentUser() current: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<{ onboardingState: string }> {
    const user = await this.users.findByPublicId(current.publicId);
    const internalId = await this.users.resolveInternalId(user.publicId);
    // The same id `x-request-id` echoes back and every log line for this request
    // carries, so an acceptance can be found in the access log by one string.
    const requestId = currentRequestContext()?.requestId;

    await this.consent.acceptPolicies(internalId, body.policyVersionIds, {
      // Hashed with a server pepper before storage; the raw values never persist.
      ...(request.ip ? { ipAddress: request.ip } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      // Correlation id and a release string (M22). Both go in clear, because
      // neither identifies a person: one ties the record to the access log, the
      // other says which build of the app the document was read in.
      ...(requestId !== undefined ? { requestId } : {}),
      ...(typeof request.headers['x-app-version'] === 'string'
        ? { appVersion: request.headers['x-app-version'].slice(0, 32) }
        : {}),
    });

    const updated = await this.users.findByPublicId(current.publicId);
    return { onboardingState: updated.onboardingState };
  }

  /**
   * Completes the profile and grants the onboarding reward.
   *
   * Behind the terms gate, which is the point: a profile is only collectable
   * from someone who has agreed to the rules it will be judged against.
   *
   * Safe to repeat. A second call updates the profile and returns
   * `rewardGranted: false` — the coins are keyed on the user in the ledger, so
   * the reward cannot be earned twice however many times this is called.
   */
  @Post('onboarding/profile')
  @HttpCode(HttpStatus.OK)
  async completeProfile(
    @Body(new ZodValidationPipe(completeProfileRequest)) body: CompleteProfileRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<CompleteProfileResponse> {
    const internalId = await this.users.resolveInternalId(current.publicId);

    const completion = await this.profiles.complete(internalId, {
      displayName: body.displayName,
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      birthYear: body.birthYear,
      cityId: body.cityId,
      ...(body.districtId !== undefined ? { districtId: body.districtId } : {}),
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      interestIds: body.interestIds,
    });

    return {
      onboardingState: completion.onboardingState,
      profile: toProfileView(completion.profile),
      coins: { balance: completion.balance },
      rewardGranted: completion.rewardGranted,
      trustScore: completion.trustScore,
    };
  }

  /**
   * Edit the signed-in user's own profile (M22 phase 2).
   *
   * `PATCH`, and the verb is the contract: an absent field is left alone, so a
   * client that only changed the bio sends only the bio and cannot accidentally
   * clear the interests it did not render. `POST /onboarding/profile` stays
   * exactly as it was — it is the onboarding step, it takes a whole profile, and
   * it is the only path that grants coins.
   *
   * **Authorisation is structural rather than checked.** The user id comes from
   * the session, never from the body or the path, so there is no parameter a
   * caller could point at somebody else's profile. Editing another user is an
   * admin capability behind `user.profile.edit`, on a different route.
   *
   * Behind the terms gate like every other authenticated route, and behind the
   * global rate limiter's `PROFILE_UPDATE` bucket — a profile edit is a write a
   * script could run in a loop, and the moderation surface it feeds (display
   * name, bio) is exactly what makes that worth bounding.
   */
  /**
   * `GET /me/settings` — what this person has chosen to be told about.
   *
   * Never 404s. Somebody who has never opened the screen has no row, and the
   * service resolves that to the defaults — so a client renders toggles rather
   * than having to distinguish "off" from "never asked".
   */
  @Get('me/settings')
  async settings(@CurrentUser() current: AuthenticatedUser): Promise<NotificationSettingsView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.settingsView(userId);
  }

  /**
   * `PUT /me/settings` — change one toggle or several.
   *
   * `PUT` on a resource this small rather than `PATCH`: there is no field whose
   * absence means anything but "leave it alone", and the client is a row of
   * toggles each of which sends exactly one. It returns the whole resolved
   * settings so a client never has to merge its own optimistic state.
   */
  @Put('me/settings')
  @RateLimit('PROFILE_UPDATE')
  @HttpCode(HttpStatus.OK)
  async updateSettings(
    @Body(new ZodValidationPipe(updateNotificationSettingsRequest))
    body: UpdateNotificationSettingsRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<NotificationSettingsView> {
    const userId = await this.users.resolveInternalId(current.publicId);

    /**
     * Two stores, one request, and the profile written **first**.
     *
     * `ProfileService.update` is the half that can refuse — `PROFILE_INCOMPLETE`
     * for somebody with no profile row — and doing it first means a refusal
     * leaves nothing written. The other order would turn one invalid request into
     * a half-applied one, with the notification toggles saved and the caller
     * holding an error that says nothing about them.
     *
     * Not a transaction: they are two independent rows in two independent tables,
     * and the failure this ordering removes is the only one available.
     */
    if (body.inviteOptOut !== undefined) {
      await this.profiles.update(userId, { inviteOptOut: body.inviteOptOut });
    }
    await this.userSettings.update(userId, body);
    return this.settingsView(userId);
  }

  /**
   * The whole settings screen, from the three places its state lives.
   *
   * Notifications are `user_settings`, privacy is `user_profile.invite_opt_out`,
   * language is `user.locale` — and nothing is copied between them, which is why
   * this assembles rather than reads. The bot's board is drawn from exactly the
   * same three reads, so the two surfaces cannot show a user different answers.
   */
  private async settingsView(userId: string): Promise<NotificationSettingsView> {
    const [settings, profile] = await Promise.all([
      this.userSettings.get(userId),
      this.profiles.find(userId),
    ]);

    return {
      ...settings,
      // No profile row means nothing has opted out, which is the default — but
      // `hasProfile` keeps that distinguishable from a flag somebody set.
      inviteOptOut: profile?.inviteOptOut ?? false,
      locale: this.env.APP_LOCALE,
      hasProfile: profile !== null,
    };
  }

  @Patch('me/profile')
  @RateLimit('PROFILE_UPDATE')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Body(new ZodValidationPipe(updateProfileRequest)) body: UpdateProfileRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<{ profile: ProfileView }> {
    const internalId = await this.users.resolveInternalId(current.publicId);

    // Rebuilt key by key rather than spread, because `exactOptionalPropertyTypes`
    // distinguishes an absent key from an explicit `undefined` — and a parsed Zod
    // body carries the second for every field the client omitted.
    const profile = await this.profiles.update(internalId, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      ...(body.birthYear !== undefined ? { birthYear: body.birthYear } : {}),
      ...(body.cityId !== undefined ? { cityId: body.cityId } : {}),
      ...(body.districtId !== undefined ? { districtId: body.districtId } : {}),
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.interestIds !== undefined ? { interestIds: body.interestIds } : {}),
      ...(body.inviteOptOut !== undefined ? { inviteOptOut: body.inviteOptOut } : {}),
    });

    return { profile: toProfileView(profile) };
  }
}
