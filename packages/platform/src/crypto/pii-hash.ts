import { createHmac } from 'node:crypto';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { ENV } from '../config/env.provider';

/**
 * Peppered one-way hashes for the two identifiers §8 forbids storing raw.
 *
 * An IP address and a user agent are both written to `consent` and `audit_log` —
 * the first because a consent record nobody can tie to a request is not evidence of
 * anything, the second because "who did this, from where" is the question an audit
 * trail exists to answer. Neither may be stored as itself.
 *
 * **HMAC with a server-side pepper, not a bare hash.** The IPv4 space is 2³²
 * addresses: a plain SHA-256 of an IP is reversible by anybody with a laptop and an
 * afternoon, which makes an unpeppered "hash" a longer way of writing the address
 * down. The pepper lives in the environment and never in the database, so a dump of
 * `audit_log` on its own reveals nothing — which is the only property that makes
 * storing these columns defensible at all.
 *
 * **Null when there is no pepper.** Not a fallback hash, and not the address: a
 * deployment without `PII_HASH_PEPPER` stores nothing rather than storing something
 * reversible, and production cannot start without one (`env.ts` requires it there).
 * The cost is a development database with null IP columns, which is the right way
 * round.
 */
@Injectable()
export class PiiHasher {
  constructor(@Inject(ENV) private readonly env: Env) {}

  hash(value: string | undefined | null): string | null {
    if (!value || !this.env.PII_HASH_PEPPER) return null;
    return createHmac('sha256', this.env.PII_HASH_PEPPER).update(value).digest('hex');
  }
}

/**
 * Global, because the callers are spread across the API, the domain and the bot,
 * and threading a pepper through constructors is how one of them ends up with its
 * own copy of the hashing rule.
 */
@Global()
@Module({
  providers: [PiiHasher],
  exports: [PiiHasher],
})
export class PiiHashModule {}
