import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ParticipationModule } from '../participation/participation.module';
import { SeedEventService } from './seed-event.service';
import { SeedIdentityService } from './seed-identity.service';
import { SeedSchedulerService } from './seed-scheduler.service';

// `EventsModule` for `EventService` (real event creation) — `AppModule`
// importing both is not enough; Nest scopes providers to the module that
// declares them. `ParticipationModule` for `seatSeedParticipant`.
@Module({
  imports: [EventsModule, ParticipationModule],
  providers: [SeedEventService, SeedIdentityService, SeedSchedulerService],
  exports: [SeedEventService, SeedIdentityService, SeedSchedulerService],
})
export class SeedingModule {}
