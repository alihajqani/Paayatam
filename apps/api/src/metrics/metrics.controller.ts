import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MetricsRegistry } from '@payetam/platform';
import { Public } from '../auth/auth.guard';

/**
 * `GET /metrics` — Prometheus scrape (plan §9 M16).
 *
 * **`@Public()`, and reachable only from inside.** The global AuthGuard is
 * deny-by-default, so without this a scraper gets 401 forever; but a metrics
 * endpoint open to the internet publishes request volumes, error rates and queue
 * depths, which together describe the product's traffic and its health to anyone who
 * asks. The access rule is enforced here rather than trusted to nginx, because a
 * reverse-proxy rule is one config edit away from not existing and this file is
 * reviewed with the code.
 *
 * §11's numbers are the reason this is worth guarding rather than shrugging at: the
 * join-conflict rate is a direct measure of how contended the product's most popular
 * events are, and the queue depth says how far behind delivery is. Neither is secret
 * exactly; both are the sort of thing a competitor would enjoy having on a dashboard.
 */
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    if (!isPrivateCaller(request.ip)) {
      // 404 rather than 403: an endpoint that exists but refuses you is worth
      // probing, and a scraper that is correctly configured never sees either.
      void reply.status(404);
      return '';
    }
    return this.metrics.render();
  }
}

/**
 * Whether the caller is on a private network or the loopback.
 *
 * Deliberately a **network** check rather than a token: Prometheus scrape configs
 * carrying a bearer token are one of the more reliable ways for a credential to end
 * up in a config repository, and the deployment already places the scraper beside
 * the API. Anything arriving from outside is not a scraper.
 *
 * IPv6-mapped IPv4 (`::ffff:10.0.0.4`) is handled because that is what Node reports
 * on a dual-stack socket, and forgetting it is how this check ends up quietly
 * refusing every real scrape and getting removed.
 */
function isPrivateCaller(ip: string | undefined): boolean {
  if (ip === undefined) return false;

  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (address === '127.0.0.1' || address === '::1') return true;

  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;

  const [first, second] = octets as [number, number, number, number];
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}
