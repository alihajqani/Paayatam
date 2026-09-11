import { describe, expect, it } from 'vitest';
import { CoinLedgerType } from '@payetam/db';
import { ledgerLabelFa } from '@payetam/telegram';

/**
 * Every coin movement has a Persian name (v0.12.1).
 *
 * ── The bug this exists to stop repeating ───────────────────────────────────
 *
 * `LEDGER_TYPE_FA` is written by hand, and `ledgerLabelFa` falls back to the raw
 * enum value for anything it does not know. That fallback is a **rollout guard**
 * — a worker on the old build must not drop a row it cannot name — and for three
 * releases it quietly doubled as cover for a gap: v0.11.0 added four ledger
 * types and none of them got a label, so «کیف پول» answered
 * «+۳۰ — FOUNDING_REWARD» to a Persian reader. Nothing failed, because falling
 * back is exactly what it was built to do.
 *
 * Found in a real production wallet on 2026-09-11, not by any test.
 *
 * ── Why the test is here and not beside the map ─────────────────────────────
 *
 * `packages/telegram` deliberately depends on neither `@payetam/db` nor Prisma —
 * the message catalogue is testable with no client and no database, and that is
 * worth keeping. This package already depends on both, so the property is
 * enforced without moving Prisma into the catalogue.
 */
describe('the coin ledger labels', () => {
  it('names every member of CoinLedgerType in Persian', () => {
    const unlabelled = Object.values(CoinLedgerType).filter((type) => ledgerLabelFa(type) === type);

    expect(unlabelled).toEqual([]);
  });

  /**
   * The fallback still has to work. A row written by a newer deploy renders as
   * itself rather than vanishing from somebody's ledger, which is the whole
   * reason `labelFor` does not throw.
   */
  it('still falls back to the raw value for a type it has never heard of', () => {
    expect(ledgerLabelFa('SOMETHING_A_NEWER_DEPLOY_WRITES')).toBe(
      'SOMETHING_A_NEWER_DEPLOY_WRITES',
    );
  });

  /** No Latin letters in a label — that is precisely what went unnoticed. */
  it('has no label that is still an enum name', () => {
    for (const type of Object.values(CoinLedgerType)) {
      expect(ledgerLabelFa(type)).not.toMatch(/[A-Za-z_]{4,}/);
    }
  });
});
