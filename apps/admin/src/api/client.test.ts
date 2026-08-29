import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, messageOf, request, setCsrfToken, setUnauthenticatedHandler } from './client';

/**
 * The client, and the three properties that make cookie authentication work.
 *
 * Every one of these is a rule that fails **silently** if it regresses: a request
 * without `credentials` is signed out with no error to read, a mutation without
 * the CSRF header is a 403 that looks like a permission problem, and a 401 that
 * does not reach the store leaves a dead page with a red box on it.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A fresh `Response` per call, not one object resolved repeatedly: a body can
  // only be read once, and a test that makes two requests would otherwise fail on
  // "Body has already been read" rather than on anything it meant to assert.
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
  vi.stubGlobal('fetch', fetchMock);
  setCsrfToken(null);
  setUnauthenticatedHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `RequestInit` the client actually built. */
function init(): RequestInit & { headers: Record<string, string> } {
  return fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
}

describe('every request', () => {
  it('sends the session cookie, and only to this origin', async () => {
    await request('/me');

    // `same-origin` rather than `include`: the panel and the API *are* the same
    // origin by design, and `include` would make a misconfigured deployment
    // appear to work until a browser tightened.
    expect(init().credentials).toBe('same-origin');
  });

  it('addresses the admin API and nothing else', async () => {
    await request('/gift-codes');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/v1/gift-codes');
  });

  it('drops empty and absent query values rather than sending them', async () => {
    await request('/users', { query: { query: '', status: undefined, limit: 25, offset: 0 } });

    // An empty filter must not become `?status=` — the zod query schema would
    // refuse it, and the panel clears filters by emptying the box.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/v1/users?limit=25&offset=0');
  });
});

describe('the CSRF token', () => {
  it('rides on a mutation', async () => {
    setCsrfToken('token-value');

    await request('/gift-codes', { method: 'POST', body: { code: 'X' } });

    expect(init().headers['x-csrf-token']).toBe('token-value');
  });

  /**
   * Reads never carry it and the guard never asks for one. Sending it anyway
   * would make a *missing* token look like a working session right up until the
   * first mutation.
   */
  it('never rides on a read', async () => {
    setCsrfToken('token-value');

    await request('/me');

    expect(init().headers['x-csrf-token']).toBeUndefined();
  });

  it('is absent when the tab does not have one', async () => {
    await request('/gift-codes', { method: 'POST', body: {} });

    expect(init().headers['x-csrf-token']).toBeUndefined();
  });
});

describe('when the session is gone', () => {
  it('tells the store before it throws', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHENTICATED', messageFa: 'دوباره وارد شوید.' } }, 401),
    );

    await expect(request('/me')).rejects.toBeInstanceOf(ApiError);
    // Before, so the panel is already on the login screen by the time the caller
    // renders its error.
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('does not fire the handler for an ordinary refusal', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', messageFa: 'دسترسی ندارید.' } }, 403),
    );

    await expect(request('/settings')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  it('carries the server’s Persian sentence, not a status number', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'GIFT_CODE_DUPLICATE', messageFa: 'کدی با این عنوان از قبل وجود دارد.' } },
        409,
      ),
    );

    await expect(request('/gift-codes', { method: 'POST' })).rejects.toMatchObject({
      code: 'GIFT_CODE_DUPLICATE',
      messageFa: 'کدی با این عنوان از قبل وجود دارد.',
      status: 409,
    });
  });

  it('falls back to the shared catalogue when the body carries no sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'VALIDATION_FAILED' } }, 400));

    await expect(request('/settings/x', { method: 'POST' })).rejects.toMatchObject({
      messageFa: 'اطلاعات واردشده کامل یا معتبر نیست.',
    });
  });

  it('turns a dropped connection into a sentence rather than «Failed to fetch»', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(request('/me')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('answers an HTML error page with the catalogue rather than crashing', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(request('/me')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 502,
    });
  });
});

describe('a 204', () => {
  it('resolves rather than failing to parse an empty body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(request('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('messageOf', () => {
  it('prefers the ApiError’s sentence', () => {
    expect(messageOf(new ApiError('FORBIDDEN', 'شما به این بخش دسترسی ندارید.', 403))).toBe(
      'شما به این بخش دسترسی ندارید.',
    );
  });

  it('falls back for anything else thrown', () => {
    expect(messageOf(new Error('boom'), 'ذخیره نشد.')).toBe('ذخیره نشد.');
  });
});

/**
 * In-flight deduplication (M22 phase 3).
 *
 * Every case below is a real duplicate the panel produces on its own: a `watch`
 * that fires twice in a tick, a moderator clicking through pages faster than the
 * network answers, a screen that mounts and re-reads. The properties that matter
 * are that the *query* is part of the identity and that nothing is ever cached.
 */
describe('in-flight deduplication', () => {
  it('collapses two identical GETs that overlap into one request', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const first = request('/users');
    const second = request('/users');
    release(jsonResponse({ users: [] }));

    await expect(first).resolves.toEqual({ users: [] });
    await expect(second).resolves.toEqual({ users: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not collapse two pages of the same list', async () => {
    // The bug this prevents: serving page one to somebody who asked for page two.
    await Promise.all([
      request('/users', { query: { offset: 0 } }),
      request('/users', { query: { offset: 25 } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is not a cache — a second call after the first settles goes to the network', async () => {
    await request('/dashboard');
    await request('/dashboard');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never collapses a mutation, because two POSTs are two intentions', async () => {
    await Promise.all([
      request('/coins/adjust', { method: 'POST', body: { amount: 1 } }),
      request('/coins/adjust', { method: 'POST', body: { amount: 1 } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives every waiter the same failure when the one request fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', messageFa: 'خطا' } }, 500),
    );

    const first = request('/users');
    const second = request('/users');

    await expect(first).rejects.toBeInstanceOf(ApiError);
    await expect(second).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops what is in flight when the session changes', async () => {
    // An answer fetched for the previous operator must not be handed to the next.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const first = request('/me');
    setCsrfToken('a-new-session');
    const second = request('/me');
    release(jsonResponse({ ok: true }));

    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
