import { Controller, Get, Inject } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import { resolveVersion } from '@payetam/shared';
import { Public } from '../auth/auth.guard';

/**
 * Which release the API is running (M22 phase 10, plan §4).
 *
 * The release string and nothing else. That is not an oversight and the endpoint
 * must not grow: `/api/v1/version` is `@Public()`, so whatever it returns is
 * returned to anyone who asks — a build timestamp, a commit sha with a branch
 * name, an uptime, a dependency list are all things an unauthenticated caller
 * would then know about a production deployment for no benefit to the user in
 * front of the screen.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * Both bundles already know their *own* version: it is compiled into them by
 * `VITE_APP_VERSION`. This answers the different question — which release is the
 * *server* on — and the two disagreeing is a routine state rather than an exotic
 * one. A Telegram WebView caches a bundle hard, so the screen in front of a user
 * the day after a deploy is often the previous release talking to the current
 * API. `isVersionMismatch()` in `@payetam/shared` is what each client does with
 * the answer.
 *
 * It is also the cheapest possible "did the deploy actually land" check, which is
 * why `@Public()` is the right call rather than a reluctant one: it has to be
 * answerable from a shell on the host with no credentials, at the moment when
 * whether anything is working at all is the open question.
 */
@Public()
@Controller('api/v1')
export class VersionController {
  private readonly version: string;

  constructor(@Inject(ENV) env: Env) {
    // Resolved once, at construction. The value cannot change while the process
    // lives, and a per-request `resolveVersion()` would be a regex on a hot public
    // endpoint for an answer that is always the same one.
    this.version = resolveVersion(env.PAYETAM_VERSION);
  }

  @Get('version')
  read(): { version: string } {
    return { version: this.version };
  }
}
