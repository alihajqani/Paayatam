import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { CoinService } from './coin.service';
import { GiftCodeService } from './gift-code.service';
import { PenaltyService } from './penalty.service';
import { ReferralService } from './referral.service';
import { TrustService } from './trust.service';

/**
 * The economy module (plan §3.3).
 *
 * M3 shipped the ledger slice alone, because the onboarding reward could not be
 * granted exactly once without it. M9 completes it: the Trust Score ledger beside
 * the coin one, reversals, and the referral that spends both.
 *
 * `CatalogModule` for `SettingsService` — every amount here is a policy number
 * read from `app_setting` rather than a constant, so tuning the economy is a
 * config change with no deploy (ADR-0007).
 */
@Module({
  imports: [CatalogModule],
  providers: [CoinService, TrustService, ReferralService, PenaltyService, GiftCodeService],
  exports: [CoinService, TrustService, ReferralService, PenaltyService, GiftCodeService],
})
export class EconomyModule {}
