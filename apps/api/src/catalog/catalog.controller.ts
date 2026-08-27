import { Controller, Get, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CatalogService, ChannelMembershipService, UserService } from '@payetam/domain';
import type { MembershipState } from '@payetam/domain';
import type { CatalogResponse, MembershipStateResponse } from '@payetam/shared';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';

@Controller('api/v1')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly membership: ChannelMembershipService,
    private readonly users: UserService,
  ) {}

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

  /**
   * Where this user stands with the channel requirement (M22 phase 6).
   *
   * Cheap and cached: the probe reuses an answer for two minutes, so opening
   * several screens is one Telegram call. It is a **read** — the button that
   * actually re-asks is below.
   */
  @Get('me/channel-membership')
  async membershipState(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<MembershipStateResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toMembershipView(await this.membership.stateFor(userId));
  }

  /**
   * «بررسی دوباره» — ask Telegram again, now.
   *
   * Clears the cached answer first, which is the whole point: a user who has just
   * joined must not be told for another two minutes that they have not. Rate
   * limited, because it is the one endpoint in the product that turns a tap
   * directly into a Telegram call.
   *
   * The answer is re-derived server-side. Nothing the client says about its own
   * membership is trusted anywhere.
   */
  @Post('me/channel-membership/check')
  @RateLimit('MEMBERSHIP_CHECK')
  @HttpCode(HttpStatus.OK)
  async recheckMembership(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<MembershipStateResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    // One call. Clearing the cache needs the Telegram id, and that stays inside
    // the membership service — a controller that assembled the same three steps
    // would be a second place holding one (ADR-0009).
    return toMembershipView(await this.membership.recheck(userId));
  }
}

/**
 * Field by field, never a spread (§3.6 layer 2). Nothing here names a chat id.
 *
 * `channels` carries a title and a join URL per channel and **not**
 * `chatIdentifier`: the client has no use for `-1001234567890`, and a value in a
 * response is a value in somebody's log.
 */
function toMembershipView(state: MembershipState): MembershipStateResponse {
  return {
    required: state.required,
    requiredActions: state.requiredActions,
    // Order preserved from the server, which is the operator's order.
    channels: state.channels.map((channel) => ({
      id: channel.id,
      title: channel.title,
      joinUrl: channel.joinUrl,
      status: channel.status,
      allowed: channel.allowed,
    })),
    joinUrl: state.joinUrl,
    status: state.status,
    allowed: state.allowed,
    reason: state.reason,
  };
}
