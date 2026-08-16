import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type DiscoveryCursor } from './cursor';

/**
 * The cursor is pure, so it is unit-tested with no database.
 *
 * What matters here is not the encoding but the refusals: a cursor is the one
 * piece of pagination state that leaves the server and comes back, so every way
 * it can arrive wrong is a case the decoder has to name rather than assume.
 */

const cursor: DiscoveryCursor = {
  sort: 'RELEVANCE',
  epoch: Date.UTC(2026, 7, 15, 9, 0, 0),
  key: 0.8134,
  publicId: '976577c1-30a2-4f4b-b481-ad620a2bc098',
};

describe('encode → decode', () => {
  it('round-trips a relevance cursor, score and all', () => {
    expect(decodeCursor(encodeCursor(cursor), 'RELEVANCE')).toEqual(cursor);
  });

  it('round-trips a date cursor, whose key is a string', () => {
    const dated: DiscoveryCursor = {
      ...cursor,
      sort: 'SOONEST',
      key: '2026-08-20T14:00:00.000Z',
    };

    expect(decodeCursor(encodeCursor(dated), 'SOONEST')).toEqual(dated);
  });

  it('preserves the epoch exactly, because relevance is computed against it', () => {
    const decoded = decodeCursor(encodeCursor(cursor), 'RELEVANCE');
    expect(decoded.epoch).toBe(cursor.epoch);
  });

  it('is opaque — the shape is not part of the contract', () => {
    const encoded = encodeCursor(cursor);

    expect(encoded).not.toContain(cursor.publicId);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('rejections', () => {
  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 of something that is not JSON', Buffer.from('nonsense').toString('base64url')],
    ['JSON that is not an object', Buffer.from('42').toString('base64url')],
    ['an object missing its fields', Buffer.from('{"v":1}').toString('base64url')],
    [
      'a version this decoder does not know',
      Buffer.from(JSON.stringify({ v: 2, s: 'RELEVANCE', e: 1, k: 1, p: 'x' })).toString(
        'base64url',
      ),
    ],
    [
      'an empty public id',
      Buffer.from(JSON.stringify({ v: 1, s: 'RELEVANCE', e: 1, k: 1, p: '' })).toString(
        'base64url',
      ),
    ],
    [
      'a non-finite epoch',
      Buffer.from(JSON.stringify({ v: 1, s: 'RELEVANCE', e: null, k: 1, p: 'x' })).toString(
        'base64url',
      ),
    ],
  ])('refuses %s', (_label, raw) => {
    expect(() => decodeCursor(raw, 'RELEVANCE')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  /**
   * The case worth naming separately. Changing the sort mid-pagination makes the
   * key meaningless — a score compared against a timestamp — and silently
   * restarting from the first page would look exactly like the duplicate-rows bug
   * keyset pagination exists to prevent.
   */
  it('refuses a cursor issued for a different sort order', () => {
    const encoded = encodeCursor(cursor);

    expect(() => decodeCursor(encoded, 'SOONEST')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('says which field was wrong, so the client can act on it', () => {
    try {
      decodeCursor('!!!!', 'RELEVANCE');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as { details: { fields: Array<{ path: string }> } }).details.fields[0]?.path,
      ).toBe('cursor');
    }
  });
});
