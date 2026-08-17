import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  METRICS,
  normalizeRequestId,
  runWithRequestContext,
  type MetricsRegistry,
} from '@payetam/platform';

/** The header both nginx and the Mini App use to correlate a request. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * When each request started, keyed on the request object itself.
 *
 * A `WeakMap` rather than a property assigned onto the request: Fastify's request
 * type is augmented by every plugin that touches it, and adding an undeclared field
 * means either a cast at both ends or a module augmentation for one timestamp.
 * Weak keys also mean a request that never reaches `onResponse` — a socket the client
 * dropped mid-flight — is collected rather than retained.
 */
const started = new WeakMap<FastifyRequest, bigint>();

/**
 * Request ids and HTTP metrics (plan §9 M16).
 *
 * Registered as Fastify hooks rather than as a Nest interceptor, and the reason is
 * coverage: an interceptor runs inside the Nest request pipeline, so it never sees a
 * 404 for an unmatched route, a request rejected by a guard before the handler, or a
 * body that failed to parse. Those are exactly the requests worth having a
 * correlation id for. A hook sees everything the server sees.
 *
 * `onRequest` opens the async context and every later hook and handler runs inside
 * it, which is what makes the request id available to a log line written five layers
 * down in a domain service without threading a parameter through the whole stack.
 */
export function registerObservability(app: NestFastifyApplication, metrics: MetricsRegistry): void {
  // Inferred rather than annotated `FastifyInstance`. Every plugin registered on the
  // adapter augments that type, so naming it here couples this file to the set of
  // plugins the app happens to load — which is how the duplicate-fastify problem M16
  // found showed up as a type error in a file that had nothing to do with cookies.
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const requestId = normalizeRequestId(request.headers[REQUEST_ID_HEADER]);
    // Echoed back so a user reporting a problem can quote one string that finds
    // every line the request produced.
    void reply.header(REQUEST_ID_HEADER, requestId);

    runWithRequestContext({ requestId }, () => {
      started.set(request, process.hrtime.bigint());
      done();
    });
  });

  fastify.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const start = started.get(request);
    if (start !== undefined) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.observe(METRICS.HTTP_DURATION, 'HTTP request duration in seconds', seconds, {
        method: request.method,
        route: routeLabel(request),
      });
    }

    metrics.counter(METRICS.HTTP_TOTAL, 'HTTP requests by status', {
      method: request.method,
      route: routeLabel(request),
      status: String(reply.statusCode),
    });
    done();
  });
}

/**
 * The route **pattern**, never the URL.
 *
 * `/api/v1/events/:publicId` is one series; `/api/v1/events/9f3e…` is one series per
 * event, forever. That is the metrics mistake that cannot be walked back — a series
 * per entity is a memory leak that looks like observability, and by the time it
 * hurts, the dashboards depend on it.
 *
 * An unmatched request has no pattern, and reporting its raw path would hand exactly
 * that unbounded cardinality to anyone who can curl the server. It is labelled
 * `unmatched` instead: the count is the interesting part, and the paths are in the
 * logs.
 */
function routeLabel(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  return typeof pattern === 'string' ? pattern : 'unmatched';
}
