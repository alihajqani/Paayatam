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
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
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
