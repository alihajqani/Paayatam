import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { EventLifecycleService, ParticipationService, UserService } from '@payetam/domain';
import {
  cancelParticipationRequest,
  type CancelParticipationRequest,
  type CancellationPreviewResponse,
  type EventParticipantsResponse,
  type MyParticipationsResponse,
  type ParticipationView,
} from '@payetam/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { toParticipantSummaryView, toParticipationView } from './participation.view';

@Controller('api/v1')
export class ParticipationController {
  constructor(
    private readonly participation: ParticipationService,
    private readonly lifecycle: EventLifecycleService,
    private readonly users: UserService,
  ) {}

  /**
   * Ask to join an event.
   *
   * Takes no body: everything that decides the outcome is on the server. The
   * response says which of the two things happened — a seat (`PENDING`) or a
   * place in the queue (`WAITLISTED` with a rank) — because from the caller's
   * side they are the same request and only the server knows which it was.
   *
   * 201 either way. A waitlisted request is a created request, not a refused one.
   */
  @Post('events/:publicId/join')
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ParticipationView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toParticipationView(await this.participation.join(userId, publicId));
  }

  /**
   * The host accepts a request.
   *
   * Ownership is asserted in the service, not here (T3.2): the bot will reach the
   * same method, and a check that lives in one adapter protects one adapter.
   */
  @Post('participants/:publicId/accept')
  async accept(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ParticipationView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    return toParticipationView(await this.participation.accept(hostUserId, publicId));
  }

  @Post('participants/:publicId/reject')
  async reject(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ParticipationView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    return toParticipationView(await this.participation.reject(hostUserId, publicId));
  }

  /**
   * The participant withdraws.
   *
   * The response carries the `cancellationBucket` the server decided on, so the
   * Mini App can tell someone what their cancellation cost without computing a
   * threshold against a clock the server does not trust (ADR-0008).
   */
  @Post('participants/:publicId/cancel')
  async cancel(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(cancelParticipationRequest)) body: CancelParticipationRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ParticipationView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toParticipationView(await this.participation.cancel(userId, publicId, body.reason));
  }

  /**
   * What cancelling would cost, charging nothing (§6's `?dryRun=true`).
   *
   * A **GET**, not the `POST … ?dryRun=true` §6 describes. A dry run reads and
   * changes nothing, and giving it its own verb is what stops a proxy retry, a
   * double-tap or a mistyped query string from cancelling somebody's plans —
   * which is exactly the failure a confirmation dialog exists to prevent. The
   * price it quotes comes from the same code the charge uses.
   */
  @Get('participants/:publicId/cancel-preview')
  async cancelPreview(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<CancellationPreviewResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const preview = await this.participation.previewCancellation(userId, publicId);
    return { bucket: preview.bucket, coins: preview.price.coins, trust: preview.price.trust };
  }

  /**
   * The host reports that somebody did not turn up (plan §11).
   *
   * An addition to §6's endpoint list. §11 prices a no-show at −60 coins and −15
   * trust and §7 draws the transition, but the plan never says who decides one —
   * and the platform is not at the café. Left unbuilt, the most expensive penalty
   * in the product would be unreachable. Disputes are M12's moderation.
   */
  @Post('participants/:publicId/no-show')
  @HttpCode(HttpStatus.NO_CONTENT)
  async noShow(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    await this.lifecycle.markNoShow(hostUserId, publicId);
  }

  /** Everything the caller has asked to join. */
  @Get('me/participations')
  async mine(@CurrentUser() current: AuthenticatedUser): Promise<MyParticipationsResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const rows = await this.participation.listMine(userId);
    return { participations: rows.map(toParticipationView) };
  }

  /**
   * Who asked to join an event the caller hosts.
   *
   * A non-host gets the same 404 as a nonexistent event rather than a 403:
   * "this exists but is not yours" is more than a stranger is entitled to know
   * (T3.3).
   */
  @Get('events/:publicId/participants')
  async forEvent(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventParticipantsResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const rows = await this.participation.listForEvent(hostUserId, publicId);
    return { participants: rows.map(toParticipantSummaryView) };
  }
}
