import { z } from 'zod';

/**
 * Event authoring contracts (M4).
 *
 * Every bound here is also a CHECK constraint in migration 0004. The schema
 * protects the API and the Mini App form; the constraints protect the table from
 * a seed script, a migration, or a future service that forgets to validate.
 */

export const costType = z.enum(['FREE', 'APPROX', 'FIXED', 'SPLIT']);
export type CostType = z.infer<typeof costType>;

export const genderPreference = z.enum(['MALE_ONLY', 'FEMALE_ONLY']);
export type GenderPreference = z.infer<typeof genderPreference>;

export const eventStatus = z.enum([
  'DRAFT',
  'PENDING_MODERATION',
  'PUBLISHED',
  'HIDDEN',
  'REJECTED',
  'CANCELLED_BY_HOST',
  'ONGOING',
  'COMPLETED',
  'EXPIRED',
  'DELETED',
]);
export type EventStatus = z.infer<typeof eventStatus>;

export const eventModerationStatus = z.enum(['PENDING', 'APPROVED', 'FLAGGED', 'REJECTED']);
export type EventModerationStatus = z.infer<typeof eventModerationStatus>;

/**
 * T5.3: the link is stored and displayed but never fetched server-side, so the
 * SSRF surface is zero by construction. https-only is still enforced — a listing
 * that sends people to a plaintext URL is a downgrade a host should not be able
 * to talk anyone into.
 */
const httpsUrl = z
  .url()
  .max(500)
  .refine((value) => value.startsWith('https://'), { message: 'must be an https:// URL' });

/**
 * The shape a host submits.
 *
 * Timestamps are ISO-8601 UTC strings, coerced to `Date` here. The server
 * decides whether the schedule is sane against its own clock; nothing about the
 * *policy* reads a client timestamp (invariant 9) — these two are the event's
 * own data, not a claim about what time it is now.
 */
const eventBody = z.object({
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().min(10).max(2000),
  categoryId: z.uuid(),
  /**
   * What the host calls their activity, for a category that `allowsCustomLabel`
   * («سایر»).
   *
   * Required by the server for those categories and refused for every other, so
   * it is `optional()` here and conditional there — the condition depends on a
   * catalog row, which is not something a schema can see.
   *
   * Free text, so it goes through the blacklist like the title does.
   */
  customCategoryLabel: z.string().trim().min(2).max(60).optional(),
  cityId: z.uuid(),
  districtId: z.uuid().optional(),
  /**
   * A neighbourhood the host typed, when the catalogue has no row for one.
   *
   * The `district` table is curated and, in every deployment shipped so far,
   * **empty** — so `districtId` was a field nobody could fill and «کدام محله؟»
   * was a question with no answers. Free text is what a host can actually give.
   *
   * Mutually exclusive with `districtId`; the server chooses the catalogue row
   * when both arrive, and a CHECK on the table is the backstop. Free text, so it
   * goes through the blacklist like the title does.
   */
  districtLabel: z.string().trim().min(2).max(60).optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  capacity: z.number().int().min(1).max(50),
  costType,
  /** Integer Toman. Present exactly when the cost type needs a number. */
  costAmount: z.number().int().min(0).max(100_000_000).optional(),
  costNote: z.string().trim().max(200).optional(),
  rules: z.string().trim().max(1000).optional(),
  genderPreference: genderPreference.optional(),
  minAge: z.number().int().min(18).max(120).optional(),
  maxAge: z.number().int().min(18).max(120).optional(),
  externalLink: httpsUrl.optional(),
});

/**
 * The cross-field rules, shared by create and update.
 *
 * A named checker rather than inline refinements, because `PATCH` validates a
 * partial of the same object and must not silently lose them — the way a client
 * gets to set `costType: 'FREE'` while leaving a stale `costAmount` behind.
 *
 * Every rule short-circuits on an absent field: in a partial body, "not
 * supplied" is not a violation. The database CHECKs are what hold for the merged
 * result, since only the server knows what the other half of the row says.
 */
/**
 * Every field optional *and* explicitly assignable `undefined`.
 *
 * Not `Partial<…>`: under `exactOptionalPropertyTypes` that means "may be
 * absent" but not "may be present and undefined", which is exactly what zod's
 * `.partial()` produces. The two are incompatible, and this is the shape the
 * checker has to accept to work for both schemas.
 */
type EventBodyDraft = {
  [K in keyof z.infer<typeof eventBody>]?: z.infer<typeof eventBody>[K] | undefined;
};

function checkCrossFieldRules(body: EventBodyDraft, ctx: z.RefinementCtx): void {
  if (body.costType !== undefined) {
    const needsAmount = body.costType === 'FIXED' || body.costType === 'APPROX';
    const hasAmount = body.costAmount !== undefined;
    if (needsAmount !== hasAmount) {
      ctx.addIssue({
        code: 'custom',
        path: ['costAmount'],
        message: 'is required for FIXED and APPROX, and not allowed for FREE and SPLIT',
      });
    }
  }

  if (body.minAge !== undefined && body.maxAge !== undefined && body.maxAge < body.minAge) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxAge'],
      message: 'must be greater than or equal to minAge',
    });
  }

  if (
    body.startsAt !== undefined &&
    body.endsAt !== undefined &&
    new Date(body.endsAt) <= new Date(body.startsAt)
  ) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'must be after startsAt' });
  }
}

export const createEventRequest = eventBody.superRefine(checkCrossFieldRules);
export type CreateEventRequest = z.infer<typeof eventBody>;

/**
 * A partial of the same body, plus the optimistic-concurrency token.
 *
 * `expectedVersion` is how two host sessions editing the same event stop
 * overwriting each other. Omitting it is allowed — last write wins — because the
 * bot will edit the same events without a version to hand.
 */
export const updateEventRequest = eventBody
  .partial()
  .extend({ expectedVersion: z.number().int().min(0).optional() })
  .superRefine(checkCrossFieldRules);
export type UpdateEventRequest = Partial<z.infer<typeof eventBody>> & {
  expectedVersion?: number;
};

const namedRef = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
});

/**
 * What a host sees of their own event.
 *
 * Note what is absent: no host identity, no internal id, no moderation case
 * detail. Discovery's public view (M5) is a *narrower* projection than this one,
 * built by its own mapper rather than by reusing this.
 */
/**
 * Where the channel publication has got to, from the host's side.
 *
 * Three states rather than a boolean, because the channel post is produced by an
 * asynchronous sweep (ADR-0005) and telling a host "published" the instant their
 * coins were taken would be a claim the product cannot support. `QUEUED` is the
 * honest answer between the purchase and Telegram confirming the post.
 */
export const channelPublicationStatus = z.enum(['NONE', 'QUEUED', 'PUBLISHED']);
export type ChannelPublicationStatus = z.infer<typeof channelPublicationStatus>;

export const eventView = z.object({
  publicId: z.uuid(),
  title: z.string(),
  description: z.string(),
  category: namedRef,
  /** The host's own words, when the category invites them. Null otherwise. */
  customCategoryLabel: z.string().nullable(),
  city: namedRef,
  district: namedRef.nullable(),
  /** What the host typed, when no catalogue district was chosen. Never both. */
  districtLabel: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  capacity: z.number().int(),
  acceptedCount: z.number().int(),
  costType,
  costAmount: z.number().int().nullable(),
  costNote: z.string().nullable(),
  rules: z.string().nullable(),
  genderPreference: genderPreference.nullable(),
  minAge: z.number().int().nullable(),
  maxAge: z.number().int().nullable(),
  externalLink: z.string().nullable(),
  status: eventStatus,
  moderationStatus: eventModerationStatus,
  publishedAt: z.iso.datetime().nullable(),
  /** Whether the publication this host bought has reached the channel yet. */
  channelStatus: channelPublicationStatus,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type EventView = z.infer<typeof eventView>;

export const myEventsResponse = z.object({
  events: z.array(eventView),
});
export type MyEventsResponse = z.infer<typeof myEventsResponse>;

// ── Paid invitations (M22 phase 11) ──────────────────────────────────────────

/**
 * What the host is shown before they are asked to pay.
 *
 * Counts only. `reasons` says that twelve of the twenty live in their city and
 * never who those twelve are — a host is entitled to understand the selection and
 * not to a list of users the platform picked out for them.
 */
export const invitePreviewResponse = z.object({
  candidates: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  maxRecipients: z.number().int().positive(),
  cost: z.number().int().nonnegative(),
  balance: z.number().int().nonnegative(),
  affordable: z.boolean(),
  reasons: z.object({
    sameCity: z.number().int().nonnegative(),
    interestMatch: z.number().int().nonnegative(),
    categoryHistory: z.number().int().nonnegative(),
    recentlyActive: z.number().int().nonnegative(),
  }),
  /** Non-null when the send would refuse. The screen renders it before the button. */
  blockedReason: z.enum(['NO_CANDIDATES', 'INSUFFICIENT_COINS', 'EVENT_NOT_INVITABLE']).nullable(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;

/**
 * The purchase.
 *
 * `idempotencyKey` is the client's, minted when the confirmation dialog opens
 * rather than when the button is pressed — so a double tap is one purchase and a
 * deliberate second batch next week is two. It is *also* what the `Idempotency-Key`
 * header protects at the HTTP layer; the two are independent and both are cheap.
 */
export const inviteTopRequest = z.object({
  idempotencyKey: z.string().trim().min(8).max(64),
});
export type InviteTopRequest = z.infer<typeof inviteTopRequest>;

export const inviteTopResponse = z.object({
  /** Null when nobody was eligible, which is also the case that costs nothing. */
  campaignPublicId: z.uuid().nullable(),
  invited: z.number().int().nonnegative(),
  charged: z.number().int().nonnegative(),
  /** True when an identical request had already done this. Nothing was charged. */
  replayed: z.boolean(),
});
export type InviteTopResponse = z.infer<typeof inviteTopResponse>;
