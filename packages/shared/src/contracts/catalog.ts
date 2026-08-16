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

export const catalogResponse = z.object({
  cities: z.array(cityView),
  categories: z.array(categoryView),
  interests: z.array(interestView),
});
export type CatalogResponse = z.infer<typeof catalogResponse>;
