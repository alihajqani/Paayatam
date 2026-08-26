import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  CoinService,
  GiftCodeService,
  ReferralService,
  TrustService,
  UserService,
} from '@payetam/domain';
import {
  claimReferralRequest,
  redeemGiftCodeRequest,
  type ClaimReferralRequest,
  type ClaimReferralResponse,
  type CoinsResponse,
  type RedeemGiftCodeRequest,
  type RedeemGiftCodeResponse,
  type ReferralResponse,
  type TrustResponse,
} from '@payetam/shared';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, RequiresCurrentPolicies, type AuthenticatedUser } from '../auth/auth.guard';
import { toCoinEntryView, toTrustEntryView } from './economy.view';

/**
 * The user's own side of the economy (plan §6).
 *
 * Every read here returns a **ledger** alongside its number, which is ADR-0007's
 * point rather than a convenience: a balance nobody can account for cannot answer
 * a dispute, and a reputation score nobody can account for cannot be appealed.
 * The admin panel (M12) renders the same rows.
 *
 * Everything is scoped to the caller. There is no endpoint here that reads
 * another user's coins, score or invitees, and the referral summary counts the
 * people who used a code without naming any of them.
 */
@Controller('api/v1')
export class EconomyController {
  constructor(
    private readonly coins: CoinService,
    private readonly trust: TrustService,
    private readonly referrals: ReferralService,
    private readonly giftCodes: GiftCodeService,
    private readonly users: UserService,
  ) {}

  @Get('me/coins')
  async myCoins(@CurrentUser() current: AuthenticatedUser): Promise<CoinsResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const [balance, entries] = await Promise.all([
      this.coins.balanceOf(userId),
      this.coins.historyOf(userId),
    ]);
    return { balance, entries: entries.map(toCoinEntryView) };
  }

  /**
   * The score, and why it is what it is.
   *
   * `requestedDelta` appears on an entry the bounds clipped, so "the rule gave me
   * +3 and my score did not move" has a visible answer rather than looking like
   * the platform lost it.
   */
  @Get('me/trust')
  async myTrust(@CurrentUser() current: AuthenticatedUser): Promise<TrustResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const [score, entries] = await Promise.all([
      this.trust.scoreOf(userId),
      this.trust.historyOf(userId),
    ]);
    return { score, entries: entries.map(toTrustEntryView) };
  }

  /** The caller's invite code, generated on first read, and what it has earned. */
  @Get('me/referral')
  async myReferral(@CurrentUser() current: AuthenticatedUser): Promise<ReferralResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.referrals.summaryFor(userId);
  }

  /**
   * "Somebody invited me."
   *
   * Pays nothing yet: the reward lands when the caller **attends** an event, which
   * is what stops a referral programme from being a reward for creating accounts
   * (T6). The response says what is waiting, so the Mini App can be honest about
   * it rather than implying coins that have not arrived.
   */
  @Post('referrals/claim')
  async claim(
    @Body(new ZodValidationPipe(claimReferralRequest)) body: ClaimReferralRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ClaimReferralResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.referrals.claim(userId, body.code);
  }

  /**
   * Redeem a gift or discount code (M18).
   *
   * The request carries a string and nothing else. What the code is worth, when it
   * is valid and how many times it may be used are columns on `gift_code`, read
   * under the row lock that spends them — so there is no field here for a client
   * to be dishonest about (invariant 9), exactly as there is none on join or
   * accept.
   *
   * The response carries the **new balance**, so the screen shows what the server
   * says rather than adding the grant to a number it was holding. Rate-limited on
   * the same bucket family as the rest: guessing at codes is the abusive traffic
   * this endpoint attracts, and `RATE_LIMITS.GIFT_CODE_REDEEM` is what makes
   * guessing slow.
   */
  @RequiresCurrentPolicies()
  @Post('gift-codes/redeem')
  @RateLimit('GIFT_CODE_REDEEM')
  @HttpCode(HttpStatus.OK)
  async redeemGiftCode(
    @Body(new ZodValidationPipe(redeemGiftCodeRequest)) body: RedeemGiftCodeRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<RedeemGiftCodeResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return this.giftCodes.redeem(userId, body.code);
  }
}
