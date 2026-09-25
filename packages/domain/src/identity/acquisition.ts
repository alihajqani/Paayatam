import type { AcquisitionSource } from '@payetam/shared';
import {
  isStartPayload,
  parseCampaignTag,
  parseStartPayload,
  stripReferralPrefix,
} from '@payetam/telegram';
import { isReferralCodeShape } from '../economy/referral.service';

/** What `user_acquisition` records about one new account. */
export interface Acquisition {
  source: AcquisitionSource;
  ref: string | null;
}

/**
 * What a `/start` payload says about where somebody came from.
 *
 * ── Decided by shape, before anything is looked up ──────────────────────────
 *
 * The row is written in the INSERT that creates the account, which is before
 * the referral claim runs and before any event is read. So a referral-shaped
 * payload is `REFERRAL` whether or not the code exists — somebody who followed a
 * stale invite still came through an invite — and an event link is `EVENT_LINK`
 * whether or not the event is still published. The referral table and the event
 * table answer "did it work"; this answers "what was tapped".
 *
 * ── The order is the order the bot routes in ────────────────────────────────
 *
 * Campaign first, because its prefix is unambiguous; then the event links,
 * which `onStart` also tries first; then referral codes. `OTHER` keeps the
 * payload when Telegram could have carried it, so an ad link built without the
 * `src_` prefix still shows up on the report under its own name instead of
 * vanishing into «مستقیم».
 */
export function acquisitionFor(payload: string | null): Acquisition {
  if (payload === null || payload.trim() === '') return { source: 'DIRECT', ref: null };

  const tag = parseCampaignTag(payload);
  if (tag !== null) return { source: 'CAMPAIGN', ref: tag };

  const link = parseStartPayload(payload);
  if (link !== null) return { source: 'EVENT_LINK', ref: link.id };

  if (isReferralCodeShape(stripReferralPrefix(payload))) return { source: 'REFERRAL', ref: null };

  return { source: 'OTHER', ref: isStartPayload(payload) ? payload : null };
}
