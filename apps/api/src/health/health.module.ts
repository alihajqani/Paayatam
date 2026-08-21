import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * `/health` and `/ready`, and the readiness check itself.
 *
 * `HealthService` is **exported** from M19, for one consumer: the admin
 * dashboard. A panel that showed every number and could not say whether Redis was
 * up would be one an operator has to leave to answer the first question anybody
 * asks in an incident — and the alternative, a second copy of `ping()` inside the
 * admin service, is two things that can disagree about what "up" means.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
