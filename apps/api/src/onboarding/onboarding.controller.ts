import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { CoinService, ConsentService, ProfileService, UserService } from '@payetam/domain';
import {
  acceptConsentRequest,
  completeProfileRequest,
  type CompleteProfileRequest,
  type CompleteProfileResponse,
  type MeResponse,
  type PolicyView,
} from '@payetam/shared';
import type { FastifyRequest } from 'fastify';
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

    await this.consent.acceptPolicies(internalId, body.policyVersionIds, {
      // Hashed with a server pepper before storage; the raw values never persist.
      ...(request.ip ? { ipAddress: request.ip } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
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
}
