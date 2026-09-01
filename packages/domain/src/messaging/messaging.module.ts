import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { MessagingService } from './messaging.service';
import { ReleaseAnnouncementService } from './release-announcement.service';

/**
 * Outbound campaigns (M22 phases 4, 11 and 12).
 *
 * Imported by the API, which creates and confirms them, and by the worker, which
 * delivers them. One service on both sides rather than two, for the reason
 * `packages/domain` exists at all: the rules about what may be sent, to whom and
 * exactly once are the product's, not the transport's.
 *
 * `CatalogModule` arrives with `ReleaseAnnouncementService` (v0.6.5), which
 * reads `release.announce_enabled` — a kill switch an operator throws *before* a
 * deploy rather than a dialog they have to be awake for during one.
 *
 * `AuditModule` is `@Global`, so it needs no import here.
 */
@Module({
  imports: [CatalogModule],
  providers: [MessagingService, ReleaseAnnouncementService],
  exports: [MessagingService, ReleaseAnnouncementService],
})
export class MessagingModule {}
