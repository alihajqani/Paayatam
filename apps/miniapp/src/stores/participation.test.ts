import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParticipationView } from '@payetam/shared';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
}));

const { useParticipationStore } = await import('./participation');

function participation(overrides: Partial<ParticipationView> = {}): ParticipationView {
  return {
    publicId: 'p-1',
    eventPublicId: 'e-1',
    status: 'PENDING',
    requestedAt: '2026-08-17T12:00:00.000Z',
    hostDeadlineAt: '2026-08-18T12:00:00.000Z',
    graceExpiresAt: null,
    acceptedAt: null,
    cancelledAt: null,
    cancellationBucket: null,
    waitlistRank: null,
    chatPublicId: 'c-1',
    ...overrides,
  };
}

describe('participation store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('sends no body to the join endpoint — the event is in the path', async () => {
    request.mockResolvedValue(participation());
    const store = useParticipationStore();

    await store.join('e-1');

    expect(request).toHaveBeenCalledWith('/events/e-1/join', { method: 'POST' });
  });

  it('keeps whichever outcome the server chose, rather than inferring it', async () => {
    // The same request yields a held seat or a queue place, and only the server
    // knows which — this is the case that breaks if the client predicts from
    // remainingCapacity.
    request.mockResolvedValue(participation({ status: 'WAITLISTED', waitlistRank: 3 }));
    const store = useParticipationStore();

    const result = await store.join('e-1');

    expect(result.status).toBe('WAITLISTED');
    expect(result.waitlistRank).toBe(3);
    expect(store.liveFor('e-1')?.status).toBe('WAITLISTED');
  });

  it('clears the joining flag even when the join is refused', async () => {
    request.mockRejectedValue(new Error('full'));
    const store = useParticipationStore();

    await expect(store.join('e-1')).rejects.toThrow('full');
    // A stuck spinner is how a user concludes the app is broken.
    expect(store.joining).toBe(false);
  });

  it('indexes participations by event so a detail screen can ask in O(1)', async () => {
    request.mockResolvedValue({
      participations: [
        participation({ publicId: 'p-1', eventPublicId: 'e-1' }),
        participation({ publicId: 'p-2', eventPublicId: 'e-2', status: 'ACCEPTED' }),
      ],
    });
    const store = useParticipationStore();

    await store.loadMine();

    expect(store.byEvent.get('e-2')?.status).toBe('ACCEPTED');
  });

  it.each(['REJECTED', 'CANCELLED_BY_PARTICIPANT', 'NO_SHOW', 'COMPLETED', 'EXPIRED'] as const)(
    'treats %s as not-live, so the event can be asked for again',
    async (status) => {
      request.mockResolvedValue({ participations: [participation({ status })] });
      const store = useParticipationStore();

      await store.loadMine();

      expect(store.liveFor('e-1')).toBeNull();
    },
  );

  it.each(['PENDING', 'WAITLISTED', 'ACCEPTED'] as const)(
    'treats %s as live, so a second request is not offered',
    async (status) => {
      request.mockResolvedValue({ participations: [participation({ status })] });
      const store = useParticipationStore();

      await store.loadMine();

      expect(store.liveFor('e-1')?.status).toBe(status);
    },
  );

  it('replaces an existing row on cancel rather than appending a second one', async () => {
    request.mockResolvedValueOnce({ participations: [participation()] });
    const store = useParticipationStore();
    await store.loadMine();

    request.mockResolvedValueOnce(participation({ status: 'CANCELLED_BY_PARTICIPANT' }));
    await store.cancel('p-1', 'دیگر نمی‌توانم');

    expect(store.mine).toHaveLength(1);
    expect(store.mine[0]?.status).toBe('CANCELLED_BY_PARTICIPANT');
    expect(request).toHaveBeenLastCalledWith('/participants/p-1/cancel', {
      method: 'POST',
      body: { reason: 'دیگر نمی‌توانم' },
    });
  });

  it('omits the body entirely when cancelling without a reason', async () => {
    request.mockResolvedValue(participation({ status: 'CANCELLED_BY_PARTICIPANT' }));
    const store = useParticipationStore();

    await store.cancel('p-1');

    // An absent reason and an empty one are different things to the schema.
    expect(request).toHaveBeenCalledWith('/participants/p-1/cancel', { method: 'POST' });
  });

  it.each([
    ['accept', '/participants/p-9/accept'],
    ['reject', '/participants/p-9/reject'],
  ] as const)('routes the host decision %s to the shared service', async (action, path) => {
    request.mockResolvedValue(participation());
    const store = useParticipationStore();

    await store[action]('p-9');

    expect(request).toHaveBeenCalledWith(path, { method: 'POST' });
  });
});
