import { Controller, Get, Header } from '@nestjs/common';
import { CatalogService } from '@payetam/domain';
import type { CatalogResponse } from '@payetam/shared';

@Controller('api/v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Every list a user may pick from: active provinces, active cities with their
   * districts, active categories, active interests.
   *
   * Authenticated but not `@AllowPendingTerms` — the wizard reaches this screen
   * only after accepting the terms, so there is no reason to widen the gate.
   *
   * Nothing here is personal, so there is nothing to scope to the caller.
   *
   * ── The cache header, and why this route has one ─────────────────────────
   *
   * M21 took the city list from one row to 1,252, which is ~190 KiB of JSON
   * (~15 KiB once nginx gzips it — this is the one proxied route allowed to,
   * see `docker/nginx.conf`). Refetching that on every Mini App open would be
   * the largest single cost of a session, for data that changes when an admin
   * edits a catalog row and not otherwise.
   *
   * `public` is safe here **because nothing in this response is scoped to the
   * caller** — the same bytes are correct for every authenticated user, which is
   * exactly the property that makes a shared cache legitimate. It is the
   * property to re-check before adding a field: the day this carries anything
   * per-user, this header becomes a leak between users and has to go.
   *
   * Five minutes rather than an hour: an operator who activates a city expects
   * to see it, and waiting an hour to find out whether a change took is how a
   * cache turns into a bug report.
   */
  @Get('catalog')
  @Header('Cache-Control', 'public, max-age=300')
  async list(): Promise<CatalogResponse> {
    return this.catalog.snapshot();
  }
}
