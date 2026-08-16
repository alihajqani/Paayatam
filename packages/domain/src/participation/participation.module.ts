import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ParticipationService } from './participation.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

@Module({
  imports: [CatalogModule],
  providers: [ParticipationService],
  exports: [ParticipationService],
})
export class ParticipationModule {}
