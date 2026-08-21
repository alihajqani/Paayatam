import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy', () => {
  it('trusts nothing when the variable is absent', () => {
    // The default has to stay "trust nothing": a process reached directly must not
    // let a client choose its own apparent address by sending X-Forwarded-For.
    expect(resolveTrustProxy(undefined)).toBe(false);
  });

  it('trusts nothing when the variable is blank', () => {
    expect(resolveTrustProxy('')).toBe(false);
    expect(resolveTrustProxy('   ')).toBe(false);
  });

  it('reads an all-digit value as a hop count, not as an address', () => {
    // The failure this prevents is silent: proxy-addr given the *string* '1'
    // looks for a host called 1, matches no request, and leaves request.ip as
    // the proxy's own address with nothing logged.
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  it('passes a CIDR list through for proxy-addr to parse', () => {
    expect(resolveTrustProxy('172.18.0.0/16,127.0.0.1')).toBe('172.18.0.0/16,127.0.0.1');
  });

  it("passes proxy-addr's own names through", () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('uniquelocal')).toBe('uniquelocal');
  });

  it('never returns true, whatever it is given', () => {
    // `true` trusts every hop, which hands an attacker both the rate limiter and
    // the ip_hash column. env.ts refuses the spellings that mean "everything";
    // this asserts the conversion cannot produce `true` by another route either —
    // note '1' comes back as the *number* 1, a hop count, not as a boolean.
    for (const input of [undefined, '', 'true', '1', 'loopback', '10.0.0.0/8']) {
      expect(resolveTrustProxy(input)).not.toBe(true);
    }
  });
});
