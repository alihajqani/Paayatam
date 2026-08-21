/**
 * `TRUST_PROXY` → Fastify's `trustProxy` option (M20).
 *
 * Fastify hands this value to `proxy-addr`, which accepts three shapes and gives
 * each a different meaning. Turning one environment string into the right shape is
 * the whole job, and it is a separate function because the wrong shape fails
 * *silently*: a hop count passed as the string `'1'` is read as an address, matches
 * nothing, and the API goes on reporting the proxy's own address as `request.ip`
 * with no error anywhere. The symptom shows up weeks later as a rate limiter that
 * refuses real users.
 *
 * @param value the raw `TRUST_PROXY`, or `undefined` when the API is reached directly
 * @returns `false` when nothing is trusted, a number for a hop count, the string
 *          otherwise — `proxy-addr` parses addresses, CIDR blocks and its own names
 *          (`loopback`, `linklocal`, `uniquelocal`) out of it.
 */
export function resolveTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined) return false;

  const trimmed = value.trim();
  if (trimmed === '') return false;

  // `/^\d+$/` rather than `Number.isInteger(Number(x))`: `Number('')` is 0 and
  // `Number(' 2 ')` is 2, so the looser test turns a blank or a typo into "trust
  // the nearest hop" — the one answer that must never be reached by accident.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}
