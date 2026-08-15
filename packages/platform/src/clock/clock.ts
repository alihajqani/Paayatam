import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The only source of time in the system.
 *
 * ADR-0008: every policy decision — cancellation thresholds, review windows,
 * initData freshness — is computed on the server clock. Domain code takes this
 * interface rather than calling `new Date()`, for two reasons:
 *
 *  1. It makes "no client-supplied time affects policy" checkable by inspection.
 *  2. It makes the exhaustive threshold tables in M10 possible without sleeping in
 *     tests, which is the difference between a 200ms suite and a useless one.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Test double. Lives in production code rather than a test helper file because
 * every package's tests need it, and duplicating it would let the copies drift.
 */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : instant;
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
