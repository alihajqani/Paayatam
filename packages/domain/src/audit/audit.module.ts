import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global, because invariant 10 applies to every module: a state transition that
 * forgets to write `audit_log` is a bug, and making the writer available
 * everywhere removes "I'd have to import a module" as a reason to skip it.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
