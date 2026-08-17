import { describe, expect, it } from 'vitest';
import { AppLogger } from './logger.service';
import { runWithRequestContext, normalizeRequestId, setContextUser } from './request-context';

/**
 * Structured logging (plan §9 M16), and the two properties that make it worth having
 * over `console.log`.
 *
 * **Every line goes through M15's redactor.** This is the whole reason `AppLogger`
 * wraps pino rather than exposing it: a logger that *can* be used unsafely eventually
 * will be, and the failure is silent and permanent — a Telegram id in a log
 * aggregator a dozen people can search and nobody can purge.
 *
 * **Every line carries its request id.** Not because a request id is interesting, but
 * because without one, "which of the forty concurrent requests produced this?" has no
 * answer, and every incident starts by guessing.
 *
 * Asserted against the JSON pino actually writes, captured through a destination
 * stream. Mocking pino would test the mock, and the thing most likely to break here is
 * the wiring.
 *
 * The stream is passed in rather than spied for a reason worth knowing: pino writes
 * through `sonic-boom` straight to the file descriptor, so a spy on
 * `process.stdout.write` captures **nothing** — and every `not.toContain` assertion
 * below would then pass against an empty string. A redaction test that is green
 * because it is reading nothing is the worst outcome available here, which is why
 * `output()` refuses to return an empty capture.
 */

let written: string[] = [];

function capture(): AppLogger {
  written = [];
  // Not pretty-printed: the assertions are about the JSON, which is what production
  // emits and what a log pipeline parses.
  return new AppLogger('trace', false, {
    write(chunk: string) {
      written.push(chunk);
    },
  });
}

/** The captured output, and proof there *was* some. */
function output(): string {
  const joined = written.join('');
  expect(joined, 'nothing was captured — the negative assertions would be vacuous').not.toBe('');
  return joined;
}

function lines(): Array<Record<string, unknown>> {
  return output()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('redaction is not optional', () => {
  it('redacts a sensitive field in a structured event', () => {
    const logger = capture();

    logger.event('info', 'auth attempt', {
      telegramUserId: 573_914_882n,
      initData: 'user=%7B%22id%22%3A573914882%7D',
      eventPublicId: 'abc-123',
    });

    const emitted = output();
    expect(emitted).not.toContain('573914882');
    expect(emitted).toContain('[redacted]');
    // And the diagnosable part survives, or the line is useless.
    expect(emitted).toContain('abc-123');
  });

  it('redacts a whole object passed as the message', () => {
    const logger = capture();

    logger.error({ err: 'failed', phone: '+989121234567' });

    expect(output()).not.toContain('989121234567');
  });

  /** A pattern match, not a field name — the net under the denylist. */
  it('redacts a shape inside a plain string message', () => {
    const logger = capture();

    logger.warn('could not reach https://t.me/some_handle');

    expect(output()).not.toContain('some_handle');
  });
});

describe('correlation', () => {
  it('stamps the ambient request id on every line', () => {
    const logger = capture();

    runWithRequestContext({ requestId: 'req-abcdef12' }, () => {
      logger.log('first');
      logger.log('second');
    });

    const emitted = lines();
    expect(emitted).toHaveLength(2);
    expect(emitted.every((line) => line['requestId'] === 'req-abcdef12')).toBe(true);
  });

  it('includes the caller once authentication has resolved', () => {
    const logger = capture();

    runWithRequestContext({ requestId: 'req-abcdef12' }, () => {
      setContextUser('user-public-id');
      logger.log('after auth');
    });

    expect(lines()[0]).toMatchObject({ userPublicId: 'user-public-id' });
  });

  /**
   * The context survives `await`, which is the only reason this is worth using —
   * a request id that vanished at the first asynchronous boundary would be absent
   * from exactly the log lines written while something was slow.
   */
  it('survives an await', async () => {
    const logger = capture();

    await runWithRequestContext({ requestId: 'req-abcdef12' }, async () => {
      await Promise.resolve();
      logger.log('after await');
    });

    expect(lines()[0]).toMatchObject({ requestId: 'req-abcdef12' });
  });

  it('logs without a request id outside a request', () => {
    const logger = capture();

    logger.log('a scheduled sweep');

    expect(lines()[0]).not.toHaveProperty('requestId');
  });
});

describe('the shape of a line', () => {
  it('writes the level as a name rather than a number', () => {
    const logger = capture();
    logger.warn('careful');

    expect(lines()[0]).toMatchObject({ level: 'warn' });
  });

  it('names the service, so two processes are separable in one stream', () => {
    const logger = capture();
    logger.log('hello');

    expect(lines()[0]).toHaveProperty('service');
  });

  it('carries the Nest context when one is given', () => {
    const logger = capture();
    logger.log('starting', 'EventService');

    expect(lines()[0]).toMatchObject({ context: 'EventService' });
  });
});

describe('normalizeRequestId', () => {
  /** Honouring an inbound id is what makes a trace span nginx and the API. */
  it('keeps a plausible client-supplied id', () => {
    expect(normalizeRequestId('abc-123_XY.z')).toBe('abc-123_XY.z');
  });

  /**
   * It is also attacker-controlled, and whatever it is ends up in every log line for
   * that request. An unbounded value is a cheap way to write a megabyte into the log
   * for the price of one header.
   */
  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['a newline, which would forge a second log line', 'abcdefgh\nlevel=fatal'],
    ['spaces', 'abc def ghi'],
    ['not a string', 12_345_678],
    ['absent', undefined],
    ['an array, which is what a duplicated header produces', ['abcdefgh', 'ijklmnop']],
  ])('replaces %s with a fresh uuid', (_label, supplied) => {
    const generated = normalizeRequestId(supplied);

    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated).not.toBe(supplied);
  });
});
