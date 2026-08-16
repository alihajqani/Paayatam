import { Controller, Get } from '@nestjs/common';
import { CatalogService } from '@payetam/domain';
import type { CatalogResponse } from '@payetam/shared';

@Controller('api/v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Every list a user may pick from: active cities with their districts, active
   * categories, active interests.
   *
   * Authenticated but not `@AllowPendingTerms` — the wizard reaches this screen
   * only after accepting the terms, so there is no reason to widen the gate.
   *
   * Nothing here is personal, so there is nothing to scope to the caller.
   */
  @Get('catalog')
  async list(): Promise<CatalogResponse> {
    return this.catalog.snapshot();
  }
}
