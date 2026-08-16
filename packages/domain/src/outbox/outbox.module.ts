import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Global, for the same reason `AuditModule` is: any module that changes state may
 * need to announce it, and "I would have to import a module" is a bad reason to
 * let a notification depend on a write that happens after the commit.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
