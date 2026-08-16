import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ParticipationService, UserService } from '@payetam/domain';
import {
  cancelParticipationRequest,
  type CancelParticipationRequest,
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
