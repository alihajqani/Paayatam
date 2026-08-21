/**
 * The rules behind the development gift-code seed, separated from the running of
 * it (M19).
 *
 * Split from `seed-gift-codes-dev.ts` for one reason: that file executes on
 * import — it is a script, and a script's whole job is to run — so a test that
 * imported it would run a seed. What is worth testing here is not the procedure
 * but the **gate**: an allowlist of environments that may write codes worth
 * coins. A rule that is only a comment is a rule somebody relaxes.
 */

/** Marks every code this script writes. Never used by anything but a human eye. */
export const DEV_GIFT_CODE_PREFIX = 'DEV';

/**
 * Whether this environment may be seeded with gift codes.
 *
 * Exported and pure so the refusal is a unit test rather than a comment. The
 * rule is an **allowlist**, not a "not production" check: an unset `NODE_ENV`, a
 * typo like `Production`, or a future `staging` all fall through to a refusal,
 * which is the direction a mistake should fall in.
 */
export function maySeedGiftCodes(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

export interface Fixture {
  code: string;
  coins: number;
  maxRedemptions: number | null;
  note: string;
  isActive?: boolean;
  startsAt?: Date;
  expiresAt?: Date;
}

/**
 * One fixture per state a redemption can end in.
 *
 * A developer building the wallet screen needs to see all five refusals, and
 * producing an expired code by hand means editing a timestamp in `psql`. These
 * are the states, named after them, so the Mini App's five branches can each be
 * reached by typing a code.
 */
export function fixtures(now: Date): Fixture[] {
  const day = 86_400_000;
  return [
    {
      code: `${DEV_GIFT_CODE_PREFIX}WELCOME`,
      coins: 50,
      maxRedemptions: 100,
      expiresAt: new Date(now.getTime() + 365 * day),
      note: 'Development fixture: the happy path.',
    },
    {
      code: `${DEV_GIFT_CODE_PREFIX}SMALL`,
      coins: 5,
      maxRedemptions: 100,
      expiresAt: new Date(now.getTime() + 365 * day),
      note: 'Development fixture: a small grant, for balance arithmetic.',
    },
    {
      code: `${DEV_GIFT_CODE_PREFIX}EXPIRED`,
      coins: 25,
      maxRedemptions: 10,
      // Both bounds in the past, so the CHECK on window ordering still holds.
      startsAt: new Date(now.getTime() - 30 * day),
      expiresAt: new Date(now.getTime() - day),
      note: 'Development fixture: GIFT_CODE_EXPIRED.',
    },
    {
      code: `${DEV_GIFT_CODE_PREFIX}SOON`,
      coins: 25,
      maxRedemptions: 10,
      startsAt: new Date(now.getTime() + 30 * day),
      expiresAt: new Date(now.getTime() + 60 * day),
      note: 'Development fixture: a window that has not opened yet.',
    },
    {
      code: `${DEV_GIFT_CODE_PREFIX}OFF`,
      coins: 25,
      maxRedemptions: 10,
      isActive: false,
      note: 'Development fixture: GIFT_CODE_INVALID via the kill switch.',
    },
    {
      code: `${DEV_GIFT_CODE_PREFIX}FULL`,
      coins: 25,
      // Capped at one and redeemed by nobody yet; drain it with one account to
      // reach GIFT_CODE_EXHAUSTED from the second.
      maxRedemptions: 1,
      note: 'Development fixture: one slot, so the second redeemer sees EXHAUSTED.',
    },
  ];
}
