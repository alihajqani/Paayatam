import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Security response headers (§8, T5.1, T13).
 *
 * Hand-written rather than `helmet`, and the reason is what this application
 * actually serves: **JSON, from an API**. Most of helmet's value is in headers
 * that govern how a *document* behaves, and there is no document here — the Mini
 * App and the admin panel are separate static bundles served by nginx, which is
 * where a page-level CSP belongs and where M16 puts it.
 *
 * What is left is the short list that matters for an API, and writing it out means
 * each header is here with the reason it is here rather than as an opaque default:
 *
 *  - **`nosniff`** is the one that matters most. T13's polyglot threat is entirely
 *    about a browser disagreeing with the server over what a response is; this
 *    header removes the disagreement.
 *  - **A locked-down CSP** on API responses, because an error page or an
 *    unexpected HTML body should be able to do nothing at all. `frame-ancestors
 *    'none'` also does the job `X-Frame-Options` used to.
 *  - **`no-referrer`**, so a URL containing a `public_id` is never handed to a
 *    third-party site the user navigates to next.
 *  - **HSTS**, set only in production: in development the API is reached over
 *    plaintext localhost, and pinning HTTPS there breaks the dev loop for six
 *    months in whatever browser saw it.
 */
export function registerSecurityHeaders(app: NestFastifyApplication, isProduction: boolean): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_request, reply, payload, done) => {
      void reply.header('X-Content-Type-Options', 'nosniff');
      void reply.header('Referrer-Policy', 'no-referrer');
      void reply.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      // Nothing this API returns should be cached by an intermediary: every
      // response is either personal or authenticated, and both are things a shared
      // cache must not keep.
      void reply.header('Cache-Control', 'no-store');
      void reply.header('X-Frame-Options', 'DENY');
      void reply.header('Cross-Origin-Resource-Policy', 'same-origin');

      if (isProduction) {
        void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      done(null, payload);
    });
}
