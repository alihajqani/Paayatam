import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { FoundingModule } from '../founding/founding.module';
import { ProfileService } from './profile.service';

@Module({
  imports: [CatalogModule, EconomyModule, FoundingModule],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
