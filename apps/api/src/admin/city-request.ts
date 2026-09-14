import type { GeographyAdminService } from '@payetam/domain';
import type { UpdateCityRequest } from '@payetam/shared';

type UpdateCityInput = Parameters<GeographyAdminService['updateCity']>[2];

/**
 * The request body of `PATCH /admin/v1/cities/:id`, as the service takes it.
 *
 * Its own function, with a test that walks the contract's fields, because the
 * inline version dropped `isLaunched`: the panel's «باز کردن» answered 200 and
 * opened nothing (found during plan 17). Only what was sent is passed — `undefined`
 * keys are omitted rather than forwarded, which is what `exactOptionalPropertyTypes`
 * and the service's "undefined means unchanged" reading both expect.
 */
export function toUpdateCityInput(body: UpdateCityRequest): UpdateCityInput {
  return {
    ...(body.nameFa !== undefined ? { nameFa: body.nameFa } : {}),
    ...(body.provinceId !== undefined ? { provinceId: body.provinceId } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    ...(body.isLaunched !== undefined ? { isLaunched: body.isLaunched } : {}),
    ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    ...(body.confirmReferences !== undefined ? { confirmReferences: body.confirmReferences } : {}),
  };
}
