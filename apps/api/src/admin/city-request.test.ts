import { describe, expect, it } from 'vitest';
import { updateCityRequest } from '@payetam/shared';
import { toUpdateCityInput } from './city-request';

/**
 * `PATCH /admin/v1/cities/:id` — every field the contract accepts reaches the service.
 *
 * The controller spelled the fields out one by one and left `isLaunched` behind
 * when v0.10.0 added it to the contract, so the panel's «باز کردن» answered 200,
 * showed «باز شد», and opened nothing. Nothing failed: the pipe accepted the
 * field, the service would have honoured it, and the one line between them never
 * passed it on. Found while building plan 17 on top of that button.
 */
describe('toUpdateCityInput', () => {
  it('carries every field the request contract declares', () => {
    const body = {
      nameFa: 'شیراز',
      provinceId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      isActive: true,
      isLaunched: true,
      sortOrder: 10,
      confirmReferences: true,
    };
    // The fixture is the contract: a field added there and not here fails first.
    expect(Object.keys(body).sort()).toEqual(Object.keys(updateCityRequest.shape).sort());

    expect(toUpdateCityInput(updateCityRequest.parse(body))).toEqual(body);
  });

  it('opens a city', () => {
    expect(toUpdateCityInput({ isLaunched: true })).toEqual({ isLaunched: true });
  });

  it('passes nothing that was not sent', () => {
    expect(toUpdateCityInput({})).toEqual({});
  });
});
