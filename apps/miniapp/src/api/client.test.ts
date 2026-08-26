import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, setAccessToken } from './client';

/**
 * The Mini App's client. The properties here are the ones that fail *silently*
 * on a mobile network — a duplicate round trip nobody sees on a desk, and a
 * dropped connection reported as "Failed to fetch" instead of Persian.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A fresh `Response` per call: a body can only be read once, so a shared object
  // would fail any test that makes two requests.
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
  vi.stubGlobal('fetch', fetchMock);
  setAccessToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every request', () => {
  it('sends the bearer token once there is one', async () => {
    setAccessToken('a-token');
    await request('/me');

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer a-token');
  });

  it('turns a dropped connection into Persian rather than "Failed to fetch"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(request('/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});

/**
 * In-flight deduplication (M22 phase 3). The round trip is the expensive part on
 * the connections this app is built for, so two components asking for the same
 * thing in the same tick must cost one request — without ever becoming a cache
 * that can answer with something stale.
 */
describe('in-flight deduplication', () => {
  it('collapses two identical GETs that overlap into one request', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const first = request('/me');
    const second = request('/me');
    release(jsonResponse({ id: 'u1' }));

    await expect(first).resolves.toEqual({ id: 'u1' });
    await expect(second).resolves.toEqual({ id: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps different paths apart', async () => {
    await Promise.all([request('/me'), request('/catalog')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is not a cache — a second call after the first settles goes to the network', async () => {
    await request('/me/coins');
    await request('/me/coins');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never collapses a mutation, because two POSTs are two intentions', async () => {
    // What makes a repeat of one of these safe is `Idempotency-Key`, which is a
    // different mechanism with a different guarantee.
    await Promise.all([
      request('/events', { method: 'POST', body: { title: 'x' } }),
      request('/events', { method: 'POST', body: { title: 'x' } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives every waiter the same failure when the one request fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', messageFa: 'خطا' } }, 500),
    );

    const first = request('/me');
    const second = request('/me');

    await expect(first).rejects.toBeInstanceOf(ApiError);
    await expect(second).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops what is in flight when the token changes', async () => {
    // A reply fetched under the previous token must never be handed to a caller
    // asking under the new one.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const first = request('/me');
    setAccessToken('a-new-token');
    const second = request('/me');
    release(jsonResponse({ ok: true }));

    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
