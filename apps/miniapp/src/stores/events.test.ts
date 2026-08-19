import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredEventView } from '@payetam/shared';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));

const { emptyFilters, useEventsStore } = await import('./events');

function discovered(overrides: Partial<DiscoveredEventView> = {}): DiscoveredEventView {
  const named = { id: '00000000-0000-4000-8000-000000000001', slug: 's', nameFa: 'ن' };
  return {
    publicId: 'e-1',
    title: 'شب بازی',
    description: 'توضیح',
    category: named,
    city: named,
    district: null,
    startsAt: '2026-08-20T16:00:00.000Z',
    endsAt: '2026-08-20T18:00:00.000Z',
    capacity: 6,
    acceptedCount: 2,
    remainingCapacity: 4,
    costType: 'SPLIT',
    costAmount: null,
    costNote: null,
    genderPreference: null,
    minAge: null,
    maxAge: null,
    externalLink: null,
    isVip: false,
    isBoosted: false,
    publishedAt: '2026-08-17T10:00:00.000Z',
    host: { publicId: 'h-1', displayName: 'میزبان' },
    ...overrides,
  };
}

/** The query string the store built, for whichever call is being asserted. */
function queryOf(call: number): URLSearchParams {
  const path = request.mock.calls[call]?.[0] as string;
  return new URLSearchParams(path.slice(path.indexOf('?')));
}

describe('discovery query building', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
    request.mockResolvedValue({ events: [] });
  });

  it('omits empty filters instead of sending blank values', async () => {
    const store = useEventsStore();
    store.filters = { ...emptyFilters(), hasCapacity: false, ageFits: false };

    await store.discover();

    expect(request).toHaveBeenCalledWith('/events?sort=RELEVANCE');
  });

  it('sends the flags as the literal strings the server parses', async () => {
    const store = useEventsStore();

    await store.discover();

    const query = queryOf(0);
    expect(query.get('hasCapacity')).toBe('true');
    expect(query.get('ageFits')).toBe('true');
  });

  it('omits a false flag entirely rather than sending false', async () => {
    // The server refuses z.coerce.boolean() precisely because "false" would read as
    // true; omitting is the only safe way to say "do not filter".
    const store = useEventsStore();
    store.filters = { ...emptyFilters(), hasCapacity: false };

    await store.discover();

    expect(queryOf(0).has('hasCapacity')).toBe(false);
  });

  it('passes the search text through untouched, normalizing nothing', async () => {
    const store = useEventsStore();
    // ي and ك are the Arabic forms ADR-0012 normalizes server-side.
    store.filters = { ...emptyFilters(), q: '  بازي كافه  ' };

    await store.discover();

    expect(queryOf(0).get('q')).toBe('بازي كافه');
  });
});

describe('discovery paging', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('treats a missing nextCursor as the end', async () => {
    request.mockResolvedValue({ events: [discovered()] });
    const store = useEventsStore();

    await store.discover();

    expect(store.hasMore).toBe(false);
    expect(store.isEmpty).toBe(false);
  });

  it('appends the next page and carries the cursor forward', async () => {
    request.mockResolvedValueOnce({ events: [discovered({ publicId: 'e-1' })], nextCursor: 'c1' });
    const store = useEventsStore();
    await store.discover();

    request.mockResolvedValueOnce({ events: [discovered({ publicId: 'e-2' })], nextCursor: 'c2' });
    await store.loadMore();

    expect(store.results.map((event) => event.publicId)).toEqual(['e-1', 'e-2']);
    expect(queryOf(1).get('cursor')).toBe('c1');
    expect(store.cursor).toBe('c2');
  });

  it('replaces rather than appends when filters change', async () => {
    request.mockResolvedValueOnce({ events: [discovered({ publicId: 'e-1' })], nextCursor: 'c1' });
    const store = useEventsStore();
    await store.discover();

    request.mockResolvedValueOnce({ events: [discovered({ publicId: 'e-9' })] });
    store.filters.q = 'دیگر';
    await store.discover();

    expect(store.results.map((event) => event.publicId)).toEqual(['e-9']);
    // A stale cursor from the previous filter set would page into the wrong result.
    expect(store.cursor).toBeNull();
  });

  it('does not ask for more when there is no cursor', async () => {
    request.mockResolvedValue({ events: [discovered()] });
    const store = useEventsStore();
    await store.discover();

    await store.loadMore();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports empty only once loading has finished', async () => {
    request.mockResolvedValue({ events: [] });
    const store = useEventsStore();

    const pending = store.discover();
    expect(store.isEmpty).toBe(false); // still loading — an empty state here would flash
    await pending;
    expect(store.isEmpty).toBe(true);
  });

  it('clears the loading flag when discovery fails', async () => {
    request.mockRejectedValue(new Error('offline'));
    const store = useEventsStore();

    await expect(store.discover()).rejects.toThrow('offline');
    expect(store.discovering).toBe(false);
  });
});

describe('authoring', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('shows a newly created event immediately', async () => {
    const created = { publicId: 'e-new', title: 'تازه' };
    request.mockResolvedValue(created);
    const store = useEventsStore();

    await store.create({ title: 'تازه' } as never);

    expect(store.myEvents[0]).toEqual(created);
  });

  it('replaces the edited event in place', async () => {
    request.mockResolvedValueOnce({ events: [{ publicId: 'e-1', title: 'قدیم' }] });
    const store = useEventsStore();
    await store.loadMyEvents();

    request.mockResolvedValueOnce({ publicId: 'e-1', title: 'نو' });
    await store.update('e-1', { title: 'نو' });

    expect(store.myEvents).toHaveLength(1);
    expect(store.myEvents[0]?.title).toBe('نو');
  });

  /**
   * The one endpoint where a duplicate request costs real money. The domain key is
   * derived from the *window* a boost produces, so a genuine second purchase
   * correctly charges again — which is exactly why the HTTP key is what stands
   * between a dropped response and a second 40-coin charge.
   */
  it('sends an Idempotency-Key with a boost', async () => {
    request.mockResolvedValue({ publicId: 'e-1', isVip: false });
    const store = useEventsStore();

    await store.boost('e-1');

    expect(request).toHaveBeenCalledWith('/events/e-1/boost', {
      method: 'POST',
      body: { kind: 'BOOST' },
      idempotencyKey: 'fixed-key',
    });
  });

  it('sends the kind the host chose', async () => {
    request.mockResolvedValue({ publicId: 'e-1', isVip: true });
    const store = useEventsStore();

    await store.boost('e-1', 'VIP');

    expect(request).toHaveBeenCalledWith(
      '/events/e-1/boost',
      expect.objectContaining({ body: { kind: 'VIP' } }),
    );
  });

  it('replaces the event in place so the new promotion state is shown', async () => {
    request.mockResolvedValueOnce({ events: [{ publicId: 'e-1', isVip: false }] });
    const store = useEventsStore();
    await store.loadMyEvents();

    request.mockResolvedValueOnce({ publicId: 'e-1', isVip: true, channelStatus: 'QUEUED' });
    await store.boost('e-1', 'VIP');

    expect(store.myEvents).toHaveLength(1);
    expect(store.myEvents[0]?.isVip).toBe(true);
    expect(store.myEvents[0]?.channelStatus).toBe('QUEUED');
  });

  it('asks the dry-run endpoint without mutating anything', async () => {
    request.mockResolvedValue({ bucket: 'LATE', affected: 2, coins: 30, trust: 5 });
    const store = useEventsStore();

    const preview = await store.cancelPreview('e-1');

    expect(request).toHaveBeenCalledWith('/events/e-1/cancel-preview');
    expect(preview.affected).toBe(2);
  });
});
