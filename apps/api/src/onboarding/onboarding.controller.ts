import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ConsentService, UserService } from '@payetam/domain';
import { acceptConsentRequest, type PolicyView } from '@payetam/shared';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AllowPendingTerms, CurrentUser, Public, type AuthenticatedUser } from '../auth/auth.guard';

@Controller('api/v1')
export class OnboardingController {
  constructor(
    private readonly consent: ConsentService,
    private readonly users: UserService,
  ) {}

  /**
   * The signed-in user.
   *
   * Deliberately has no `@AllowPendingTerms`, so it is subject to the terms gate —
   * which makes it the endpoint the gate's tests exercise. Profile, coins and trust
   * are added to this response in M3 and M9.
   */
  @Get('me')
  async me(@CurrentUser() current: AuthenticatedUser): Promise<{
    publicId: string;
    onboardingState: string;
    locale: string;
    timezone: string;
  }> {
    const user = await this.users.findByPublicId(current.publicId);
    return {
      publicId: user.publicId,
      onboardingState: user.onboardingState,
      locale: user.locale,
      timezone: user.timezone,
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
}
