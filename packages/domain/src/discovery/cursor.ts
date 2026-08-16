import { AppError, ErrorCode } from '@payetam/shared';

/**
 * Keyset pagination cursors.
 *
 * Keyset, not OFFSET, for the reason the plan makes a test of: with OFFSET, a
 * row inserted while a user is paging shifts everything after it, so page 2
 * repeats a row page 1 already showed and skips one it never will. A cursor that
 * names the last row seen has neither failure.
 *
 * Three things go in, and each earns its place:
 *
 *  - **`epoch`** — the server time the *first* page was built at. Relevance
 *    depends on `now()` (an event two hours away outranks one next week), so
 *    without a frozen epoch every page would re-rank against a slightly later
 *    clock and the total order would shift underneath the cursor. This is the
 *    subtle one, and the reason a cursor is not just "the last id".
 *  - **`key`** — the sort value of the last row, so the next page can ask for
 *    "strictly after this".
 *  - **`publicId`** — the tiebreaker, because sort values are not unique. It is
 *    the *public* id: cursors are client-visible, and the internal id never
 *    leaves the backend (invariant 7, T3.3).
 *
 * Opaque base64url rather than readable JSON, so the shape stays ours to change.
 * Not signed: a tampered cursor can only produce a wrong page of data the caller
 * is already allowed to see, and the filters are re-sent on every request.
 */

export type DiscoverySort = 'RELEVANCE' | 'SOONEST' | 'NEWEST';

export interface DiscoveryCursor {
  sort: DiscoverySort;
  /** Milliseconds since the epoch, frozen at the first page. */
  epoch: number;
  /** A score for RELEVANCE, an ISO timestamp for the date sorts. */
  key: number | string;
  publicId: string;
}

interface EncodedCursor {
  v: 1;
  s: DiscoverySort;
  e: number;
  k: number | string;
  p: string;
}

export function encodeCursor(cursor: DiscoveryCursor): string {
  const payload: EncodedCursor = {
    v: 1,
    s: cursor.sort,
    e: cursor.epoch,
    k: cursor.key,
    p: cursor.publicId,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Parses a cursor, or rejects it.
 *
 * Every failure is the same `VALIDATION_FAILED`, including a cursor whose sort
 * disagrees with the request's. That last case matters: changing the sort
 * mid-pagination makes the key meaningless — a score compared against a
 * timestamp — and silently starting from the beginning would look like the
 * duplicate-rows bug keyset pagination exists to prevent.
 */
export function decodeCursor(raw: string, expectedSort: DiscoverySort): DiscoveryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('is not a readable cursor');
  }

  if (!isEncodedCursor(parsed)) {
    throw invalidCursor('is not a readable cursor');
  }
  if (parsed.s !== expectedSort) {
    throw invalidCursor('was issued for a different sort order; start again from the first page');
  }

  return { sort: parsed.s, epoch: parsed.e, key: parsed.k, publicId: parsed.p };
}

function isEncodedCursor(value: unknown): value is EncodedCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EncodedCursor>;

  return (
    candidate.v === 1 &&
    (candidate.s === 'RELEVANCE' || candidate.s === 'SOONEST' || candidate.s === 'NEWEST') &&
    typeof candidate.e === 'number' &&
    Number.isFinite(candidate.e) &&
    (typeof candidate.k === 'number' || typeof candidate.k === 'string') &&
    typeof candidate.p === 'string' &&
    candidate.p.length > 0
  );
}

function invalidCursor(message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, { fields: [{ path: 'cursor', message }] });
}
