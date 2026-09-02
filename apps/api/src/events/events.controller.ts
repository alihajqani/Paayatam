import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  EventService,
  InvitationService,
  UserService,
  type CreateEventInput,
  type UpdateEventInput,
} from '@payetam/domain';
import {
  cancelEventRequest,
  createEventRequest,
  inviteTopRequest,
  updateEventRequest,
  type CancelEventRequest,
  type CreateEventRequest,
  type EventCancellationResponse,
  type EventView,
  type HostCancellationPreviewResponse,
  type InvitePreviewResponse,
  type InviteTopRequest,
  type InviteTopResponse,
  type MyEventsResponse,
  type UpdateEventRequest,
} from '@payetam/shared';
import { JOBS, QUEUES, QueueService, jobId } from '@payetam/platform';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, RequiresCurrentPolicies, type AuthenticatedUser } from '../auth/auth.guard';
import { toEventView } from './event.view';

@Controller('api/v1')
export class EventsController {
  constructor(
    private readonly events: EventService,
    private readonly invitations: InvitationService,
    private readonly users: UserService,
    /** Only ever to enqueue: the API never processes a job (ADR-0005). */
    private readonly queues: QueueService,
  ) {}

  /**
   * Creates an event and runs it through auto-moderation.
   *
   * Returns 201 with the event in whatever state moderation left it, rather than
   * a 4xx when a term matched. That is deliberate: a host whose text tripped the
   * blacklist has still created something, and `status` plus `moderationStatus`
   * tell them exactly where it stands. Refusing the write would also lose the
   * text they wrote — including in the false-positive case, which ADR-0012 says
   * is the outcome to optimise against.
   */
  @RequiresCurrentPolicies()
  @Post('events')
  @RateLimit('EVENT_CREATE')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createEventRequest)) body: CreateEventRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const event = await this.events.create(hostUserId, toCreateInput(body));
    return toEventView(event);
  }

  /**
   * Edits an event the caller hosts.
   *
   * Ownership is asserted in the service, not here (T3.2) — the bot reaches the
   * same method, and a check that lives in one adapter protects one adapter.
   */
  @Patch('events/:publicId')
  async update(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(updateEventRequest)) body: UpdateEventRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const { expectedVersion, ...changes } = body;

    const event = await this.events.update(
      hostUserId,
      publicId,
      toUpdateInput(changes),
      expectedVersion,
    );
    return toEventView(event);
  }

  /**
   * Buy this event a place in the channel (M22 phase 5).
   *
   * Distinct from the free `channel-sync` sweep, which keeps publishing
   * trending events exactly as it did before. This is a host saying
   * "put mine in" and paying `economy.event_channel_send_coins` for it.
   *
   * **Nothing is sent by this request.** The claim row lands unposted and the
   * worker's sweep is what talks to Telegram (ADR-0005, invariant 11), so the
   * response says "bought", not "posted" — and `channelStatus` on the event says
   * which.
   */
  @RequiresCurrentPolicies()
  @Post('events/:publicId/publish-to-channel')
  @HttpCode(HttpStatus.OK)
  async publishToChannel(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    return toEventView(await this.events.publishToChannel(hostUserId, publicId));
  }

  /**
   * What a paid invitation would reach, and what it would cost (M22 phase 11).
   *
   * **Writes nothing and charges nothing.** The requirement that a preview must
   * never trigger a charge is met structurally rather than by care: the service
   * method it calls has no write path in it at all.
   *
   * Counts only, never a list. A host is entitled to understand the selection —
   * "twelve of these twenty live in your city" — and not to a roster of users the
   * platform picked out for them.
   */
  @Get('events/:publicId/invite-preview')
  async invitePreview(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<InvitePreviewResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const preview = await this.invitations.preview(hostUserId, publicId);
    return {
      candidates: preview.candidates,
      selected: preview.selected,
      maxRecipients: preview.maxRecipients,
      cost: preview.cost,
      balance: preview.balance,
      affordable: preview.affordable,
      reasons: preview.reasons,
      blockedReason: preview.blockedReason,
    };
  }

  /**
   * Charge, select and queue the invitations (M22 phase 11).
   *
   * Everything that matters is in the service: the coins and the invitation rows
   * commit together, nobody is invited twice, nobody who opted out is invited at
   * all, and **nothing is charged when nobody is eligible.**
   *
   * The nudge afterwards is a `queue.add` so the sends start in seconds rather
   * than waiting for the next scheduled dispatch. It is deliberately outside the
   * transaction: a queue that was unreachable must not roll back a purchase the
   * database has already recorded, and the minute-by-minute schedule picks it up
   * either way.
   */
  @RequiresCurrentPolicies()
  @Post('events/:publicId/invite-top')
  @RateLimit('EVENT_INVITE')
  @HttpCode(HttpStatus.OK)
  async inviteTop(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(inviteTopRequest)) body: InviteTopRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<InviteTopResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const result = await this.invitations.inviteTop(hostUserId, publicId, body.idempotencyKey);

    if (result.campaignPublicId !== null && !result.replayed) {
      await this.queues.enqueue(
        QUEUES.SCHEDULED,
        JOBS.CAMPAIGN_DISPATCH,
        jobId('campaign-dispatch', result.campaignPublicId.replaceAll('-', '')),
        {},
      );
    }

    return result;
  }

  /**
   * The host calls the whole thing off (ADR-0011, D9).
   *
   * The response is what happened rather than the event: how many people were
   * told, what it cost, and what was refunded. A host who cancels wants to know
   * the damage, and the event row afterwards says none of it.
   *
   * `coinsCharged` can be less than `coinsRequested` — a penalty takes what the
   * account holds rather than refusing — so both are reported and the difference
   * is visible instead of looking like the price changed.
   */
  @Post('events/:publicId/cancel')
  async cancel(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(cancelEventRequest)) body: CancelEventRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventCancellationResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const result = await this.events.cancelByHost(hostUserId, publicId, body.reason);

    return {
      bucket: result.bucket,
      cancelled: result.cancelled,
      hadSeats: result.hadSeats,
      coinsCharged: result.coinsCharged,
      coinsRequested: result.coinsRequested,
      trustApplied: result.trustApplied,
      coinsRefunded: result.coinsRefunded,
    };
  }

  /**
   * What cancelling would cost, charging nothing.
   *
   * A GET for the same reason the participant's preview is one: a dry run reads,
   * and a retried POST must never be able to call off an event by accident.
   */
  @Get('events/:publicId/cancel-preview')
  async cancelPreview(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<HostCancellationPreviewResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const preview = await this.events.previewHostCancellation(hostUserId, publicId);

    return {
      bucket: preview.bucket,
      affected: preview.affected,
      coins: preview.price.coins,
      trust: preview.price.trust,
    };
  }

  /**
   * The caller's own events, in every state.
   *
   * Separate from discovery on purpose: this shows a host their PENDING_MODERATION
   * and REJECTED events, which `GET /events` must never show anyone. M5 builds
   * the public listing with its own narrower mapper.
   */
  @Get('me/events')
  async listMine(@CurrentUser() current: AuthenticatedUser): Promise<MyEventsResponse> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    const events = await this.events.listOwned(hostUserId);
    return { events: events.map(toEventView) };
  }
}

/**
 * Wire shape → domain input.
 *
 * The two differ in exactly one way that matters: timestamps arrive as ISO
 * strings and the domain works in `Date`. Doing the conversion here keeps every
 * domain service free of string-date handling.
 *
 * Optional fields are spread conditionally rather than passed as `undefined`,
 * because `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined" — and for a PATCH those mean different things.
 */
function toCreateInput(body: CreateEventRequest): CreateEventInput {
  return {
    title: body.title,
    description: body.description,
    categoryId: body.categoryId,
    cityId: body.cityId,
    ...(body.districtId !== undefined ? { districtId: body.districtId } : {}),
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    capacity: body.capacity,
    costType: body.costType,
    ...(body.costAmount !== undefined ? { costAmount: body.costAmount } : {}),
    ...(body.costNote !== undefined ? { costNote: body.costNote } : {}),
    ...(body.rules !== undefined ? { rules: body.rules } : {}),
    ...(body.genderPreference !== undefined ? { genderPreference: body.genderPreference } : {}),
    ...(body.minAge !== undefined ? { minAge: body.minAge } : {}),
    ...(body.maxAge !== undefined ? { maxAge: body.maxAge } : {}),
    ...(body.externalLink !== undefined ? { externalLink: body.externalLink } : {}),
  };
}

function toUpdateInput(body: Omit<UpdateEventRequest, 'expectedVersion'>): UpdateEventInput {
  return {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
    ...(body.cityId !== undefined ? { cityId: body.cityId } : {}),
    ...(body.districtId !== undefined ? { districtId: body.districtId } : {}),
    ...(body.startsAt !== undefined ? { startsAt: new Date(body.startsAt) } : {}),
    ...(body.endsAt !== undefined ? { endsAt: new Date(body.endsAt) } : {}),
    ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
    ...(body.costType !== undefined ? { costType: body.costType } : {}),
    ...(body.costAmount !== undefined ? { costAmount: body.costAmount } : {}),
    ...(body.costNote !== undefined ? { costNote: body.costNote } : {}),
    ...(body.rules !== undefined ? { rules: body.rules } : {}),
    ...(body.genderPreference !== undefined ? { genderPreference: body.genderPreference } : {}),
    ...(body.minAge !== undefined ? { minAge: body.minAge } : {}),
    ...(body.maxAge !== undefined ? { maxAge: body.maxAge } : {}),
    ...(body.externalLink !== undefined ? { externalLink: body.externalLink } : {}),
  };
}
