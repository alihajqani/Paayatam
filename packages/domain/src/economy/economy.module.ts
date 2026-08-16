import { Module } from '@nestjs/common';
import { CoinService } from './coin.service';

/**
 * The economy module (plan §3.3).
 *
 * M3 ships the ledger slice only — enough to grant the onboarding reward exactly
 * once. Trust Score, referrals and reversals arrive in M9 alongside the
 * reconciliation test.
 */
@Module({
  providers: [CoinService],
  exports: [CoinService],
})
export class EconomyModule {}
