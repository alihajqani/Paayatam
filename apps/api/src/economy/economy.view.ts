import type { CoinEntry, TrustEntry } from '@payetam/domain';
import type { CoinEntryView, TrustEntryView } from '@payetam/shared';

/**
 * Maps ledger entries to the wire shape.
 *
 * Field by field, never a spread. A ledger row carries `idempotency_key` — which
 * names the internal cause, often an internal id — plus `actor_id`, `ref_id` and
 * whatever a caller put in `metadata`. A spread would hand all of it over the
 * moment somebody added a column (§3.6 layer 2).
 */
export function toCoinEntryView(entry: CoinEntry): CoinEntryView {
  return {
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    type: entry.type,
    reasonCode: entry.reasonCode,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toTrustEntryView(entry: TrustEntry): TrustEntryView {
  return {
    delta: entry.delta,
    scoreBefore: entry.scoreBefore,
    scoreAfter: entry.scoreAfter,
    type: entry.type,
    reasonCode: entry.reasonCode,
    algoVersion: entry.algoVersion,
    requestedDelta: entry.requestedDelta,
    createdAt: entry.createdAt.toISOString(),
  };
}
