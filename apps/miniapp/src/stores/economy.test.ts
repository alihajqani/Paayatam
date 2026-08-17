import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  request,
  ApiError: class extends Error {},
  setAccessToken: vi.fn(),
  newIdempotencyKey: () => 'fixed-key',
}));

const { useEconomyStore } = await import('./economy');
const { useModerationStore } = await import('./moderation');

const COINS = {
  balance: 50,
  entries: [{ amount: 50, balanceAfter: 50, type: 'ONBOARDING_REWARD' }],
};
const TRUST = { score: 60, entries: [] };
const REFERRAL = { code: 'ABC123', invited: 2, converted: 1 };

function routeResponses(): void {
  request.mockImplementation((path: string) => {
    if (path === '/me/coins') return Promise.resolve(COINS);
    if (path === '/me/trust') return Promise.resolve(TRUST);
    if (path === '/me/referral') return Promise.resolve(REFERRAL);
    return Promise.resolve({});
  });
}

describe('economy store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
  });

  it('loads the three reads together', async () => {
    routeResponses();
    const store = useEconomyStore();

    await store.load();

    expect(store.coins?.balance).toBe(50);
    expect(store.trust?.score).toBe(60);
    expect(store.referral?.code).toBe('ABC123');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps the ledger, not only the balance', async () => {
    // ADR-0007: a balance with no history cannot answer "where did my coins go?".
    routeResponses();
    const store = useEconomyStore();

    await store.load();

    expect(store.coins?.entries).toHaveLength(1);
  });

  it('claims a referral with an idempotency key and reloads', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/referrals/claim') return Promise.resolve({ pendingCoins: 20 });
      if (path === '/me/coins') return Promise.resolve(COINS);
      if (path === '/me/trust') return Promise.resolve(TRUST);
      return Promise.resolve(REFERRAL);
    });
    const store = useEconomyStore();

    const result = await store.claimReferral('ABC123');

    expect(result.pendingCoins).toBe(20);
    expect(request).toHaveBeenCalledWith('/referrals/claim', {
      method: 'POST',
      body: { code: 'ABC123' },
      idempotencyKey: 'fixed-key',
    });
  });

  it('clears loading when a read fails', async () => {
    request.mockRejectedValue(new Error('offline'));
    const store = useEconomyStore();

    await expect(store.load()).rejects.toThrow('offline');
    expect(store.loading).toBe(false);
  });
});

describe('moderation store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    request.mockReset();
    request.mockResolvedValue({ publicId: 'r-1', status: 'OPEN', triggeredReview: false });
  });

  it.each([
    ['EVENT', 'x', '/events/x/report'],
    ['USER', 'x', '/users/x/report'],
    ['REVIEW', 'x', '/reviews/x/report'],
    ['MESSAGE', 'x', '/chats/x/report'],
  ] as const)('routes a %s report to %s', async (target, publicId, path) => {
    const store = useModerationStore();

    await store.report(target, publicId, { reason: 'SPAM' });

    expect(request).toHaveBeenCalledWith(path, { method: 'POST', body: { reason: 'SPAM' } });
  });

  it('sends no idempotency key — one report per (target, reporter) is a unique index', async () => {
    const store = useModerationStore();

    await store.report('EVENT', 'x', { reason: 'SPAM' });

    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('idempotencyKey');
  });

  it('passes through whether this report crossed the threshold', async () => {
    request.mockResolvedValue({ publicId: 'r-1', status: 'OPEN', triggeredReview: true });
    const store = useModerationStore();

    const result = await store.report('EVENT', 'x', { reason: 'SAFETY' });

    expect(result.triggeredReview).toBe(true);
  });

  it('clears the submitting flag when a report fails', async () => {
    request.mockRejectedValue(new Error('nope'));
    const store = useModerationStore();

    await expect(store.report('EVENT', 'x', { reason: 'SPAM' })).rejects.toThrow('nope');
    expect(store.submitting).toBe(false);
  });
});
