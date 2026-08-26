import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';

/**
 * Outbound campaigns (M22 phases 4, 11 and 12).
 *
 * Imported by the API, which creates and confirms them, and by the worker, which
 * delivers them. One service on both sides rather than two, for the reason
 * `packages/domain` exists at all: the rules about what may be sent, to whom and
 * exactly once are the product's, not the transport's.
 *
 * `AuditModule` is `@Global`, so it needs no import here.
 */
@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
