/**
 * What the launch campaign's tiers are called (v0.9.0).
 *
 * ── Why the name is looked up by tier, not computed from the rank ───────────
 *
 * The rank-to-tier boundaries are runtime settings and may be retuned mid
 * campaign. The tier is snapshotted on `founding_member` at the moment it is
 * allocated, exactly as the coins are, so the label has to follow the stored
 * tier — not what today's boundaries would compute for the same rank. Deriving
 * the name from the rank here would quietly rename people the first time an
 * operator moved a boundary.
 *
 * A tier this copy does not know falls back to the last name rather than
 * rendering a bare number: the campaign can be reconfigured with more waves than
 * there is copy for, and «همراه نخست» is true of every member.
 */
const TIER_NAMES: Record<number, string> = {
  1: 'بنیان‌گذار',
  2: 'پیشگام',
  3: 'همراه نخست',
};

export function foundingTierName(tier: number): string {
  return TIER_NAMES[tier] ?? 'همراه نخست';
}

/**
 * The tier's medal — Telegram's own 🥇🥈🥉, because three waves are a podium.
 *
 * It used to be one 🎟 for all three, which said "member" and nothing about
 * which wave; in a roster where the tier is all a stranger is shown, that was
 * the one fact the badge existed to carry. Falls back exactly as the name does,
 * so a tier this copy does not know gets «همراه نخست» *and* its medal, never a
 * medal from one wave beside the name of another.
 */
const TIER_MEDALS: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

export function foundingTierMedal(tier: number): string {
  return TIER_MEDALS[tier] ?? '🥉';
}

/**
 * The badge as it appears next to somebody's name in a list.
 *
 * **The tier, never the rank.** The number belongs on the member's own profile
 * because it is theirs; «نفر ۱۲» next to a name in a roster strangers read would
 * rank the people in the room against one another, which is a hierarchy the
 * product has no reason to draw. It would also collide outright with the two
 * other things a roster line already numbers — the button index and the waitlist
 * position — and «نفر ۳» meaning three different things on one screen is a bug
 * whoever reads it has to untangle.
 *
 * Empty string for a non-member, so a caller concatenates rather than branches.
 */
export function foundingBadge(tier: number | null): string {
  return tier === null ? '' : ` ${foundingTierMedal(tier)} ${foundingTierName(tier)}`;
}
