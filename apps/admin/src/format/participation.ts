import type { AdminParticipationView } from '@payetam/shared';
import { formatNumber } from './fa';

/**
 * The join charge of one request, as the panel says it: «۲۰ سکه» and what became
 * of it, or «رایگان» for a request that took nothing.
 *
 * A rejection, an expiry, an unreached waiting place and a host cancellation give
 * the charge back; the guest's own withdrawal keeps it — so «برنگشت» on a
 * cancelled row is somebody who paid and withdrew.
 */
export function joinCoinsLine(coins: AdminParticipationView['joinCoins']): {
  amount: string;
  fate: string | null;
} {
  if (coins.charged === 0) return { amount: 'رایگان', fate: null };
  const amount = `${formatNumber(coins.charged)} سکه`;
  if (coins.refunded >= coins.charged) return { amount, fate: 'برگشت خورد' };
  if (coins.refunded > 0) return { amount, fate: `${formatNumber(coins.refunded)} سکه برگشت خورد` };
  return { amount, fate: 'برنگشت' };
}
