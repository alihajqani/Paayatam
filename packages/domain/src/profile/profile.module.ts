import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { ProfileService } from './profile.service';

@Module({
  imports: [CatalogModule, EconomyModule],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
