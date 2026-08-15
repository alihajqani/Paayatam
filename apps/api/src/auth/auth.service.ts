import { Inject, Injectable } from '@nestjs/common';
import {
  ConsentService,
  INIT_DATA_VALIDATOR,
  InitDataReplayGuard,
  SessionService,
  UserService,
  type InitDataValidator,
} from '@payetam/domain';
import type { AuthResponse } from '@payetam/shared';

/**
 * Composes the four independent checks that stand between a raw `initData` blob and
 * a session. The order is deliberate — nothing touches the database until the
 * signature has been verified.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(INIT_DATA_VALIDATOR) private readonly validator: InitDataValidator,
    private readonly replayGuard: InitDataReplayGuard,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly consent: ConsentService,
  ) {}

  async authenticateWithTelegram(initData: string): Promise<AuthResponse> {
    // 1. Signature + freshness. Throws before any I/O happens.
    const parsed = this.validator.validate(initData);

    // 2. One-time use. Steps 1 and 2 together are what make a captured blob useless.
    await this.replayGuard.consume(parsed.hash);

    // 3. Now — and only now — is the Telegram id trustworthy enough to write.
    const user = await this.users.findOrCreateByTelegram(parsed.user);

    // 4. Mint our own session; initData is not used again.
    const tokens = await this.sessions.issue(user.publicId, user.onboardingState);

    return {
      ...tokens,
      user: {
        publicId: user.publicId,
        onboardingState: user.onboardingState,
        locale: user.locale,
        timezone: user.timezone,
      },
    };
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const { userPublicId, familyId } = await this.sessions.consumeRefreshToken(refreshToken);

    // Re-read rather than trusting the retired token's copy, so a refresh straight
    // after onboarding reflects the new state. This also re-checks ban status, so a
    // banned user cannot keep refreshing their way to a valid session.
    const user = await this.users.findByPublicId(userPublicId);

    // Same family: rotation continues the chain, so reuse detection still works.
    const tokens = await this.sessions.issue(user.publicId, user.onboardingState, familyId);

    return {
      ...tokens,
      user: {
        publicId: user.publicId,
        onboardingState: user.onboardingState,
        locale: user.locale,
        timezone: user.timezone,
      },
    };
  }

  async hasAcceptedCurrentPolicies(userId: string): Promise<boolean> {
    return this.consent.hasAcceptedCurrentPolicies(userId);
  }
}
