import { Module } from '@nestjs/common';
import { InteractionService } from './interaction.service';

/**
 * What people do in the bot (migration 0065).
 *
 * One provider, the writer. The reports that read `bot_interaction` live in
 * `AdminAccessModule` beside the other report services, because every one of
 * them is authorised by `AdminAccessService` and this module has no business
 * knowing what an admin session is.
 */
@Module({
  providers: [InteractionService],
  exports: [InteractionService],
})
export class InteractionModule {}
