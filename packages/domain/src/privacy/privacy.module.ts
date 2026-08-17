import { Module } from '@nestjs/common';
import { AnonymizationService } from './anonymization.service';
import { RetentionService } from './retention.service';
// AuditModule is @Global, so it needs no import here.

/**
 * Data-subject deletion and retention (§8, M15).
 *
 * The two halves of "we do not keep things forever": anonymisation is what a
 * *person* can ask for, and the purge is what the product does on its own. Both
 * are in one module because they answer the same promise from opposite ends, and
 * both deliberately stop short of the append-only ledgers — those exist to answer
 * questions about the past, and a privacy control that erased them would be
 * trading one commitment for another.
 */
@Module({
  providers: [AnonymizationService, RetentionService],
  exports: [AnonymizationService, RetentionService],
})
export class PrivacyModule {}
