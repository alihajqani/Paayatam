import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { currentRequestContext } from './request-context';
import { redact } from './redact';

/**
 * Structured logging (plan §9 M16), wired to M15's redactor.
 *
 * Nest's default logger writes a human-readable line to stdout and nothing else.
 * That is fine on a laptop and useless in production: the moment two requests
 * interleave, "which request was that?" has no answer, and the only way to search a
 * week of it is grep over free text.
 *
 * Three decisions, in the order they matter:
 *
 * **Everything goes through `redact()` — the same function M15's 141 tests cover.**
 * This is the whole reason the logger is a wrapper rather than a call to `pino`
 * directly. A logger that *can* be used unsafely eventually will be: somebody writes
 * `logger.error({ err, request })` on a bad afternoon, and a Telegram id ends up in
 * a log aggregator that a dozen people can search and nobody can purge. Making the
 * redactor unavoidable costs one indirection.
 *
 * **The request id is pulled from ambient context, not passed in.** The call sites
 * that most need correlating are deep inside domain services that have no business
 * knowing they are serving HTTP — see `request-context.ts`.
 *
 * **JSON in production, pretty in development**, decided once at construction. A
 * developer reading `pino`'s raw output has a worse day than the format is worth,
 * and JSON in a terminal is how people learn to stop reading logs.
 */
@Injectable()
export class AppLogger implements LoggerService {
  private readonly pino: PinoLogger;

  /**
   * `destination` exists for the tests, and it exists because there is no other way.
   *
   * pino writes through `sonic-boom` straight to the file descriptor, so a spy on
   * `process.stdout.write` sees nothing — and a test asserting "the output does not
   * contain the Telegram id" passes *vacuously* against no output at all. That is the
   * worst possible failure for a redaction test: permanently green, testing nothing.
   * Taking the stream as a parameter is pino's own documented shape, and it makes the
   * assertion real.
   */
  constructor(level = 'info', pretty = false, destination?: DestinationStream) {
    const options = {
      level,
      // `msg`, `time` and `level` are pino's; `service` distinguishes the API's
      // lines from the worker's once both ship to the same place.
      base: { service: process.env['PAYETAM_SERVICE'] ?? 'api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        // `"level":"info"` rather than `"level":30`. The number is smaller and
        // every human who reads it has to look it up.
        level: (label: string) => ({ level: label }),
      },
      // A transport and an explicit destination are mutually exclusive in pino —
      // the transport *is* the destination, in a worker thread.
      ...(pretty && destination === undefined
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
            },
          }
        : {}),
    };

    this.pino = destination === undefined ? pino(options) : pino(options, destination);
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.write('error', message, context ?? stackOrContext);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  /**
   * A structured event with its own fields.
   *
   * The fields are redacted like everything else, so this stays safe for the
   * objects it is most useful on — a failed job, a rejected request, an error with
   * its cause attached.
   */
  event(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    this.pino[level]({ ...this.ambient(), ...(redact(fields) as object) }, message);
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    context?: string,
  ): void {
    const bindings = { ...this.ambient(), ...(context !== undefined ? { context } : {}) };

    if (typeof message === 'string') {
      this.pino[level](bindings, redact(message) as string);
      return;
    }
    this.pino[level]({ ...bindings, detail: redact(message) }, '');
  }

  /** The request id and caller, when there is a request. */
  private ambient(): Record<string, unknown> {
    const context = currentRequestContext();
    if (!context) return {};
    return {
      requestId: context.requestId,
      ...(context.userPublicId !== undefined ? { userPublicId: context.userPublicId } : {}),
    };
  }
}
