import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** What travels with a request, and nothing more. */
export interface RequestContext {
  /** Correlates every log line produced while handling one request. */
  requestId: string;
  /**
   * The caller's **public** id, or undefined before authentication.
   *
   * Public, never internal, and never the Telegram id (invariant 7). A log line is
   * the easiest place in the product to leak an identifier, because nobody reviews
   * logs the way they review API responses.
   */
  userPublicId?: string;
}

/**
 * The ambient request id, carried without threading it through every signature.
 *
 * `AsyncLocalStorage` rather than a parameter, because the thing that most needs a
 * request id is the log line written five layers down inside a service that has no
 * business knowing it is serving HTTP at all. Threading it would put an
 * `Observability` argument on every domain method, and the first person in a hurry
 * would pass `undefined`.
 *
 * The context survives `await`, and it is *copied* into a job's payload rather than
 * carried across the queue boundary — a job runs in another process, and pretending
 * otherwise would give every job the request id of whatever happened to be in flight
 * when the worker started.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Attach the caller once authentication has resolved, in place. */
export function setContextUser(userPublicId: string): void {
  const context = storage.getStore();
  if (context) context.userPublicId = userPublicId;
}

/**
 * A request id: the client's if it supplied a plausible one, otherwise a new UUID.
 *
 * Honouring an inbound `x-request-id` is what makes a trace span nginx and the API.
 * It is also attacker-controlled, so it is constrained rather than trusted: a
 * hostile value here ends up in every log line for that request, and an unbounded
 * one is a cheap way to write a megabyte into the log for the price of one header.
 */
export function normalizeRequestId(supplied: unknown): string {
  if (typeof supplied === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(supplied)) return supplied;
  return randomUUID();
}
