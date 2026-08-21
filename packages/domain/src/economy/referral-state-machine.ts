import type { ReferralStatus } from '@payetam/db';
import { assertTransition, type TransitionTable } from '../state-machine';

/**
 * A referral's lifecycle (M19, plan §7, invariant 10).
 *
 * ```
 *  PENDING ─► QUALIFIED          (the referred user attended something)
 *      │
 *      └────► REJECTED ─► PENDING   (an admin decided, and can undecide)
 * ```
 *
 * Three edges, and every one of them is an argument.
 *
 * **`PENDING → REJECTED` is the edge M18 left undeclared.** `referral_status` has
 * carried `REJECTED` since M9 and nothing wrote it, because T6 is explicit that
 * velocity is *recorded* rather than enforced: an automatic rejection that is
 * wrong silently steals a real user's reward, and nobody ever finds out. So the
 * signals went in front of a human and the human had no button. This is the
 * button, and it is only ever pressed by a person.
 *
 * **`QUALIFIED → REJECTED` is deliberately absent.** A qualified referral has
 * already paid, and `coin_ledger` is append-only (invariant 3): a status that
 * said "rejected" over two ledger rows that granted coins would be a record
 * disagreeing with itself. Taking coins back is `CoinService.reverse` — a
 * separate, audited, deliberate act — and it does not change what the referral
 * was.
 *
 * **`REJECTED → PENDING` exists because a rejection is a judgement.** A moderator
 * who rejects the wrong referral must be able to put it back, and the referral
 * then earns its reward the ordinary way: `qualifyForAttendance` still checks the
 * attendance itself and the idempotency key still guards the payout, so
 * reinstating pays nobody by itself. There is no `REJECTED → QUALIFIED` for
 * exactly that reason — an admin may restore eligibility and may not grant it.
 */
export const REFERRAL_TRANSITIONS: TransitionTable<ReferralStatus> = {
  PENDING: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: [],
  REJECTED: ['PENDING'],
};

export function assertReferralTransition(
  from: ReferralStatus,
  to: ReferralStatus,
  referralId?: string,
): void {
  assertTransition(REFERRAL_TRANSITIONS, from, to, {
    entity: 'referral',
    ...(referralId !== undefined ? { id: referralId } : {}),
  });
}
