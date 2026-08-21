import { ERROR_MESSAGES_FA, type ErrorCode } from '@payetam/shared';

/**
 * The admin HTTP client (ADR-0010, ADR-0016 §6).
 *
 * Three things it does that the Mini App's client does not, all of them because
 * this surface authenticates with a **cookie** rather than a bearer token:
 *
 *  - **`credentials: 'same-origin'`** on every request. The session lives in an
 *    `HttpOnly` cookie the panel cannot read, which is the point — script on this
 *    origin cannot steal what it cannot see.
 *  - **The CSRF token on every mutation.** `SameSite=Lax` still permits top-level
 *    GET navigations, so a cookie alone is not sufficient for a state-changing
 *    request. The token is held in memory by the session store and echoed in
 *    `x-csrf-token`, which a cross-site form post can neither read nor set.
 *  - **A 401 is a *session* event, not just an error.** The panel has to sign the
 *    operator out and send them to the login screen rather than leaving a dead
 *    page with a red box on it, so the store registers a callback here.
 *
 * The token is never written to `localStorage`, `sessionStorage` or a cookie the
 * panel sets. It lives for the lifetime of the tab, and a reload re-reads
 * `GET /admin/v1/me` — which either works, because the cookie is still valid, or
 * does not, in which case the operator signs in again.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR',
    readonly messageFa: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * Empty in development, where Vite proxies `/admin` to the API — see
 * `vite.config.ts`. A different origin does not work, and fails on the cookie
 * rather than on the fetch.
 */
const BASE_URL = import.meta.env.VITE_ADMIN_API_BASE_URL ?? '';

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * What to do when the API says the session is gone.
 *
 * A callback rather than an import of the store, because the store imports this
 * module — and a cycle between "the thing that makes requests" and "the thing
 * that holds the session" is how one of them ends up half-initialised.
 */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Appended as a query string; `undefined` and `''` are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Names the *intention* behind a mutation, so a retry over a dropped
   * connection is recognised as the same one (§6). Only worth sending where a
   * duplicate is not already impossible — `coins/adjust` is the case that
   * matters, and it takes its own `reference` besides.
   */
  idempotencyKey?: string;
}

export function newIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  // Reads never carry it, and the guard never asks for it on one. Sending it
  // anyway would make a missing token look like a working session until the
  // first mutation.
  if (method !== 'GET' && csrfToken !== null) headers['x-csrf-token'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/admin/v1${path}${toQuery(options.query)}`, {
      method,
      headers,
      // The session cookie. `same-origin` rather than `include`: the panel and the
      // API *are* the same origin by design, and `include` would quietly make a
      // misconfigured deployment appear to work until the browser tightened.
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید.', 0);
  }

  if (response.status === 401) {
    // The session is gone — expired in Redis, revoked, or never established.
    // Tell the store before throwing, so the panel is already on the login screen
    // by the time the caller renders its error.
    onUnauthenticated?.();
    throw await toApiError(response);
  }

  if (!response.ok) throw await toApiError(response);

  // 204, which several mutations answer with.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function toQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: ErrorCode; messageFa?: string; details?: unknown };
    };
    const code = body.error?.code;
    if (code) {
      // Prefer the server's sentence, fall back to the shared catalogue — both
      // sides read the same table, so an older bundle still renders something
      // meaningful rather than an empty dialog.
      return new ApiError(
        code,
        body.error?.messageFa ?? ERROR_MESSAGES_FA[code],
        response.status,
        body.error?.details,
      );
    }
  } catch {
    // Not JSON — a proxy error page, most likely.
  }

  return new ApiError('INTERNAL_ERROR', ERROR_MESSAGES_FA.INTERNAL_ERROR, response.status);
}

/** The Persian sentence for anything thrown, so no view writes this branch twice. */
export function messageOf(cause: unknown, fallback = 'انجام نشد. دوباره تلاش کنید.'): string {
  return cause instanceof ApiError ? cause.messageFa : fallback;
}
