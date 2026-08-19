import { z } from 'zod';

/**
 * The catalog: every list a user is allowed to pick from.
 *
 * One request returns all of it. The lists are small (one city at launch, a few
 * dozen districts, two categories, ~20 interests), they change rarely, and the
 * onboarding wizard needs all of them at once — three round trips over an
 * Iranian mobile connection to render one form would be the wrong trade.
 *
 * Only active rows are ever returned. "An interest outside the admin list is
 * rejected" is then the same fact on both sides: the client cannot offer one and
 * the server will not accept one.
 */

export const cityView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
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
});
export type PromotionPricing = z.infer<typeof promotionPricing>;

export const catalogResponse = z.object({
  cities: z.array(cityView),
  categories: z.array(categoryView),
  interests: z.array(interestView),
  promotion: promotionPricing,
});
export type CatalogResponse = z.infer<typeof catalogResponse>;
