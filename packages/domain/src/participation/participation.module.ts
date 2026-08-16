import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ParticipationService } from './participation.service';

@Module({
  imports: [CatalogModule],
  providers: [ParticipationService],
  exports: [ParticipationService],
})
export class ParticipationModule {}
