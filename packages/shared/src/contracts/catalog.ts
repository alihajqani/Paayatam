import { z } from 'zod';

/**
 * The catalog: every list a user is allowed to pick from.
 *
 * One request returns all of it. The onboarding wizard needs every list at once,
 * they change rarely, and three round trips over an Iranian mobile connection to
 * render one form would be the wrong trade.
 *
 * M21 made that trade tighter rather than wrong. The city list went from one row
 * to 1,252 — about 190 KiB of JSON — so `GET /api/v1/catalog` is now the one
 * proxied response nginx is allowed to gzip (~15 KiB) and the one the client is
 * told it may cache. The alternative, a `?provinceId=` endpoint the picker calls
 * on every province change, would trade one 15 KiB fetch per session for a round
 * trip per interaction, on connections where the round trip is the expensive
 * part. Provinces are carried alongside so the picker can be a cascade over data
 * it already holds rather than a `<select>` with 1,252 options in it.
 *
 * Only active rows are ever returned. "An interest outside the admin list is
 * rejected" is then the same fact on both sides: the client cannot offer one and
 * the server will not accept one.
 */

/**
 * A province, purely as a grouping for the city picker.
 *
 * Nothing references a province id — `user_profile` and `event` still record a
 * city, exactly as they did before M21. Adding a province column to either would
 * have been a denormalisation that can disagree with `city.province_id`, and the
 * join to find a profile's province is over 31 rows.
 */
export const provinceView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
});
export type ProvinceView = z.infer<typeof provinceView>;

export const cityView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
  /**
   * Nullable because `city.province_id` is (migration 0020): a city an admin
   * created before filing it under a province is a real state. A client
   * grouping by province should show these under a "بدون استان" heading rather
   * than dropping them.
   */
  provinceId: z.uuid().nullable(),
  districts: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      nameFa: z.string(),
    }),
  ),
});
export type CityView = z.infer<typeof cityView>;

export const categoryView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
  icon: z.string().nullable(),
  /**
   * The «سایر» behaviour: this category invites the host to name their own
   * activity, and the API will accept a `customCategoryLabel` alongside it.
   *
   * A flag on the row rather than a `slug === 'other'` check in the client, so
   * renaming the category or adding a second catch-all needs no release.
   */
  allowsCustomLabel: z.boolean(),
  /**
   * The cities this category is offered in, or `null` for "everywhere".
   *
   * `null` rather than `[]` for the common case, so "offered nowhere" stays
   * expressible and distinguishable from "unrestricted" — a distinction an
   * empty array would collapse, with the two meanings being opposites.
   */
  cityIds: z.array(z.uuid()).nullable(),
});
export type CategoryView = z.infer<typeof categoryView>;

export const interestView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
  categoryId: z.uuid().nullable(),
});
export type InterestView = z.infer<typeof interestView>;

/**
 * What promotion costs, as the server currently has it configured.
 *
 * These are `app_setting` rows an admin can change at runtime (plan §11: "all in
 * `app_setting`, runtime-changeable"), so the client must ask rather than assume.
 * A price hardcoded in a shipped bundle is a price that is wrong the first time
 * anybody edits it, and the person who finds out is the host being charged.
 *
 * Carried on the catalog because it is exactly the same kind of thing: a small,
 * rarely-changing, admin-managed list the client needs before it can render a
 * choice. The alternative was a fourth round trip on a connection where round
 * trips are the expensive part.
 */
export const promotionPricing = z.object({
  /** A temporary lift, priced per window. */
  boostCoins: z.number().int().nonnegative(),
  /** How long one boost purchase lasts. */
  boostDurationHours: z.number().int().positive(),
  /** Permanent VIP standing for the event. */
  vipCoins: z.number().int().nonnegative(),
  /**
   * The three M22 sinks (phase 5), on the same terms as the two above: the
   * server's current configuration, asked for rather than assumed, so the
   * price the host is *shown* before confirming and the price they are
   * *charged* cannot disagree.
   *
   * Zero is meaningful and means free — which is how the whole feature is
   * rolled back — so a client must render "رایگان" rather than «۰ سکه».
   */
  eventCreateCoins: z.number().int().nonnegative(),
  eventChannelSendCoins: z.number().int().nonnegative(),
  eventTopInviteCoins: z.number().int().nonnegative(),
  /** How many people one paid invitation reaches, at most. */
  topInviteMaxRecipients: z.number().int().positive(),
});
export type PromotionPricing = z.infer<typeof promotionPricing>;

export const catalogResponse = z.object({
  provinces: z.array(provinceView),
  cities: z.array(cityView),
  categories: z.array(categoryView),
  interests: z.array(interestView),
  promotion: promotionPricing,
  /**
   * The bot's @username, so a client can send somebody into the conversation
   * with one tap instead of "close this and go find the bot" (report 6).
   *
   * Public by definition — it is already in every deep link the bot and the
   * channel emit — and **not** a token. Empty when the deployment has not
   * configured one, which a client renders as "no link" rather than as a broken
   * `https://t.me/`.
   */
  botUsername: z.string(),
});
export type CatalogResponse = z.infer<typeof catalogResponse>;

// ── Channel membership (M22 phase 6) ─────────────────────────────────────────

/**
 * `APP_ACCESS` is the odd one out and the wire contract should say so.
 *
 * The other four name a server-enforced operation. `APP_ACCESS` names a
 * *navigation* rule the Mini App's router enforces from
 * `GET /me/channel-membership` — there is no single endpoint behind it, and
 * putting one in `AuthGuard` would refuse the very calls the screen that clears
 * the gate is built from. See `GATED_ACTIONS` in the domain for the full
 * argument.
 */
export const gatedAction = z.enum([
  'APP_ACCESS',
  'EVENT_CREATE',
  'EVENT_JOIN',
  'EVENT_CHANNEL_SEND',
  'EVENT_INVITE',
]);
export type GatedActionView = z.infer<typeof gatedAction>;

/**
 * One required channel, and where the caller stands with it.
 *
 * No chat identifier: the client never needs it, and `-1001234567890` in a
 * response is one more thing an allowlist has to keep out of a log (§3.6 layer 2).
 */
export const channelMembershipView = z.object({
  id: z.string(),
  /** What the user reads above the join button. Operator-authored. */
  title: z.string(),
  joinUrl: z.url().nullable(),
  status: z.enum(['MEMBER', 'NOT_MEMBER', 'CHAT_UNAVAILABLE', 'BOT_CANNOT_VERIFY', 'UNKNOWN']),
  allowed: z.boolean(),
});
export type ChannelMembershipView = z.infer<typeof channelMembershipView>;

/**
 * Where this user stands with the channel requirement.
 *
 * `status` is five outcomes rather than a boolean because they lead to five
 * different sentences, and three of them are **not the user's fault**: the chat is
 * unavailable, the bot cannot see the member list, or Telegram did not answer.
 * `allowed` is true for all three — the product fails open — and the screen says
 * something honest instead of asking somebody to fix a configuration problem.
 */
export const membershipStateResponse = z.object({
  required: z.boolean(),
  requiredActions: z.array(gatedAction),
  /**
   * Every required channel, **in the order the operator set**.
   *
   * The client renders this list as given and must not sort it: the order of
   * joining and of display is a product decision made in the admin panel.
   */
  channels: z.array(channelMembershipView),
  /**
   * The first channel the caller has not joined — so a one-button surface still
   * takes them somewhere useful. Null when nothing is outstanding.
   */
  joinUrl: z.url().nullable(),
  status: z.enum([
    'NOT_REQUIRED',
    'MEMBER',
    'NOT_MEMBER',
    'CHAT_UNAVAILABLE',
    'BOT_CANNOT_VERIFY',
    'UNKNOWN',
  ]),
  allowed: z.boolean(),
  reason: z.string().nullable(),
});
export type MembershipStateResponse = z.infer<typeof membershipStateResponse>;
