import { Module } from '@nestjs/common';
import { SuggestionService } from './suggestion.service';

// Prisma and the clock are global; nothing else is needed to answer a tap.
@Module({
  providers: [SuggestionService],
  exports: [SuggestionService],
})
export class SuggestionsModule {}
