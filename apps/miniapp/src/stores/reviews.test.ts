import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnReviewView, PendingReviewView } from '@payetam/shared';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));

const { useReviewsStore } = await import('./reviews');

function pending(overrides: Partial<PendingReviewView> = {}): PendingReviewView {
  return {
    participantPublicId: 'p-1',
    eventPublicId: 'e-1',
    eventTitle: 'شب بازی',
    revieweePublicId: 'u-2',
    revieweeDisplayName: 'مهمان',
    role: 'HOST',
    opensAt: '2026-08-17T00:00:00.000Z',
    deadlineAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function own(overrides: Partial<OwnReviewView> = {}): OwnReviewView {
  return {
    publicId: 'r-1',
    participantPublicId: 'p-1',
    rating: 5,
    tags: ['PUNCTUAL'],
    comment: null,
    submittedAt: '2026-08-17T00:00:00.000Z',
    editableUntil: '2026-08-17T01:00:00.000Z',
    ...overrides,
  } as OwnReviewView;
}

describe('reviews store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('submits with an idempotency key, because a review carries a reward', async () => {
    request.mockResolvedValue(own());
    const store = useReviewsStore();

    await store.submit('p-1', { rating: 5, tags: [] });

    expect(request).toHaveBeenCalledWith('/participants/p-1/review', {
      method: 'POST',
      body: { rating: 5, tags: [] },
      idempotencyKey: 'fixed-key',
    });
  });

  it('drops a submitted review from the pending list', async () => {
    request.mockResolvedValueOnce({
      reviews: [pending(), pending({ participantPublicId: 'p-2' })],
    });
    const store = useReviewsStore();
    await store.loadPending();

    request.mockResolvedValueOnce(own());
    await store.submit('p-1', { rating: 4, tags: [] });

    expect(store.pending.map((review) => review.participantPublicId)).toEqual(['p-2']);
  });

  it('edits with PUT and sends no key — an edit is not a duplicate risk', async () => {
    request.mockResolvedValue(own({ rating: 3 }));
    const store = useReviewsStore();

    await store.edit('p-1', { rating: 3, tags: [] });

    expect(request).toHaveBeenCalledWith('/participants/p-1/review', {
      method: 'PUT',
      body: { rating: 3, tags: [] },
    });
  });

  it('separates reviews whose window has opened from those that have not', async () => {
    vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'));
    request.mockResolvedValue({
      reviews: [
        pending({ participantPublicId: 'open', opensAt: '2026-08-17T06:00:00.000Z' }),
        pending({ participantPublicId: 'later', opensAt: '2026-08-18T06:00:00.000Z' }),
      ],
    });
    const store = useReviewsStore();

    await store.loadPending();

    expect(store.openNow.map((review) => review.participantPublicId)).toEqual(['open']);
    vi.useRealTimers();
  });

  it('caches an own review under its participation', async () => {
    request.mockResolvedValue(own());
    const store = useReviewsStore();

    await store.loadOwn('p-1');

    expect(store.own['p-1']?.rating).toBe(5);
  });

  it('records that a review can no longer be edited', async () => {
    // `editableUntil` is null once the hour passed *or* the pair revealed, and only
    // the server knows which — the store must not infer it from `submittedAt`.
    request.mockResolvedValue(own({ editableUntil: null }));
    const store = useReviewsStore();

    await store.loadOwn('p-1');

    expect(store.own['p-1']?.editableUntil).toBeNull();
  });

  it('clears the submitting flag when submission fails', async () => {
    request.mockRejectedValue(new Error('nope'));
    const store = useReviewsStore();

    await expect(store.submit('p-1', { rating: 5, tags: [] })).rejects.toThrow('nope');
    expect(store.submitting).toBe(false);
  });
});
