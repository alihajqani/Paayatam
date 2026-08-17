import { ERROR_MESSAGES_FA, type ErrorCode } from '@payetam/shared';

/**
 * The HTTP client.
 *
 * Every backend error arrives as `{ error: { code, messageFa } }` — a stable
 * machine-readable code plus Persian the user can read. This turns that envelope
 * into a typed exception so views branch on `code` and display `messageFa`,
 * never the other way round and never on a status number.
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

/** Empty in development, where Vite proxies `/api` to the local API. */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  /**
   * Names the *intention* behind a mutation, so a retry over a flaky connection is
   * recognised as the same one (plan §6). The server replays the stored response
   * instead of doing the work twice, which is what stands between a lost response on
   * a mobile network and a second 40-coin purchase.
   *
   * Only worth sending where a duplicate is not already impossible: most endpoints
   * are protected by a unique index on a natural key and need nothing here.
   */
  idempotencyKey?: string;
}

/**
 * A key for one user intention.
 *
 * `randomUUID` where it exists — every Telegram WebView has it over https — with a
 * fallback that is unique enough for the same purpose, since this value is scoped to
 * one user and lives for a day.
 */
export function newIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    // A dropped connection is the single most likely failure on a mobile
    // network, and it deserves a Persian sentence rather than "Failed to fetch".
    throw new ApiError(
      'NETWORK_ERROR',
      'ارتباط با سرور برقرار نشد. اتصال اینترنت خود را بررسی کنید.',
      0,
    );
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: ErrorCode; messageFa?: string; details?: unknown };
    };
    const code = body.error?.code;
    if (code) {
      // Prefer the server's message, but fall back to the shared catalogue —
      // both sides read the same table, so a client on an older bundle still
      // renders something meaningful rather than an empty dialog.
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
