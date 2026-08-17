import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  EventService,
  UserService,
  type CreateEventInput,
  type UpdateEventInput,
} from '@payetam/domain';
import {
  boostEventRequest,
  cancelEventRequest,
  createEventRequest,
  updateEventRequest,
  type BoostEventRequest,
  type CancelEventRequest,
  type CreateEventRequest,
  type EventCancellationResponse,
  type EventView,
  type HostCancellationPreviewResponse,
  type MyEventsResponse,
  type UpdateEventRequest,
} from '@payetam/shared';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { toEventView } from './event.view';

@Controller('api/v1')
export class EventsController {
  constructor(
    private readonly events: EventService,
    private readonly users: UserService,
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
   * Spend coins to promote an event — the only two coin sinks in MVP (plan §2.9).
   *
   * The response is the event, so the caller sees the new `boostedUntil` or
   * `isVip` rather than being told "ok" and having to refetch. The coins spent
   * are in `GET /me/coins` as a ledger row with a reason and this event as its
   * subject, which is the point of ADR-0007: a purchase somebody can look up
   * later.
   */
  @Post('events/:publicId/boost')
  async boost(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(boostEventRequest)) body: BoostEventRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<EventView> {
    const hostUserId = await this.users.resolveInternalId(current.publicId);
    return toEventView(await this.events.boost(hostUserId, publicId, body.kind));
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
