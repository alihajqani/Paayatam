import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  ClaimReferralResponse,
  CoinsResponse,
  RedeemGiftCodeResponse,
  ReferralResponse,
  TrustResponse,
} from '@payetam/shared';
import { newIdempotencyKey, request } from '@/api/client';

/**
 * Coins, Trust Score and invitations (M9).
 *
 * Both `/me/coins` and `/me/trust` return a **ledger, not just a number**, and that
 * is ADR-0007's whole point: a balance with no history cannot answer "where did my
 * coins go?", and a reputation score with no history cannot be appealed. The screens
 * built on this show the rows, not only the totals.
 *
 * The referral summary counts the people who used a code and never names them — a
 * referrer is not entitled to a list of their friends' accounts.
 */
export const useEconomyStore = defineStore('economy', () => {
  const coins = ref<CoinsResponse | null>(null);
  const trust = ref<TrustResponse | null>(null);
  const referral = ref<ReferralResponse | null>(null);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      // One round trip each, in parallel: three independent reads over a connection
      // where latency dominates.
      const [coinsResponse, trustResponse, referralResponse] = await Promise.all([
        request<CoinsResponse>('/me/coins'),
        request<TrustResponse>('/me/trust'),
        request<ReferralResponse>('/me/referral'),
      ]);
      coins.value = coinsResponse;
      trust.value = trustResponse;
      referral.value = referralResponse;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Claims somebody else's invite code.
   *
   * Carries a key because it is a mutation whose duplicate the server cannot rule
   * out from a natural key alone, and because the reward is real.
   */
  async function claimReferral(code: string): Promise<ClaimReferralResponse> {
    const result = await request<ClaimReferralResponse>('/referrals/claim', {
      method: 'POST',
      body: { code },
      idempotencyKey: newIdempotencyKey(),
    });
    await load();
    return result;
  }

  /**
   * Redeems a gift or discount code (M18).
   *
   * Carries an `Idempotency-Key` for the same reason the referral claim does: the
   * server cannot tell a retry from a second attempt by looking at the request,
   * and the difference is coins. The key makes the double-tap on a stalled
   * connection replay a stored response rather than reach the service twice —
   * which the `gift_code` row lock and the redemption unique index would both
   * survive anyway, and which should still never get that far.
   *
   * **No coin amount is sent and none is trusted.** What the code is worth is a
   * column, and `balance` in the response is the server's number rather than one
   * this store added up. `load()` follows so the ledger shows the new row.
   */
  async function redeemGiftCode(code: string): Promise<RedeemGiftCodeResponse> {
    const result = await request<RedeemGiftCodeResponse>('/gift-codes/redeem', {
      method: 'POST',
      body: { code },
      idempotencyKey: newIdempotencyKey(),
    });
    await load();
    return result;
  }

  return { coins, trust, referral, loading, load, claimReferral, redeemGiftCode };
});
