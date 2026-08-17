import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { METRICS, MetricsRegistry } from '@payetam/platform';
import { AppError, ErrorCode, ERROR_MESSAGES_FA, type ErrorBody } from '@payetam/shared';

/**
 * Turns every thrown error into the documented envelope:
 *
 *   { error: { code, messageFa, details? } }
 *
 * Two rules this filter exists to enforce:
 *
 * 1. **An unrecognised error never reaches the client.** Anything that is not an
 *    AppError becomes a generic INTERNAL_ERROR. Stack traces, driver messages and
 *    constraint names stay in the logs — they are a map of the schema to an attacker.
 *
 * 2. **Every client-visible error has a Persian message.** The catalogue in
 *    @payetam/shared guarantees the mapping is total.
 */
/**
 * Nest's own HttpExceptions (a 404 from an unmatched route, a guard's 403) carry a
 * numeric status, not one of our codes. Map them so those responses use the same
 * envelope and the same Persian catalogue as everything else — a user should never
 * be able to tell which layer produced an error.
 */
const HTTP_STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  constructor(private readonly metrics: MetricsRegistry) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof AppError) {
      this.count(exception.code);
      void reply.status(exception.httpStatus).send(exception.toBody());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_STATUS_TO_ERROR_CODE[status] ?? ErrorCode.VALIDATION_FAILED;

      const body: ErrorBody = { error: { code, messageFa: ERROR_MESSAGES_FA[code] } };
      void reply.status(status).send(body);
      return;
    }

    // Unknown failure: log everything, disclose nothing.
    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
      'Unhandled exception',
    );

    const body: ErrorBody = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        messageFa: ERROR_MESSAGES_FA[ErrorCode.INTERNAL_ERROR],
      },
    };
    this.count(ErrorCode.INTERNAL_ERROR);
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(body);
  }

  /**
   * The **join-conflict rate** (plan §9 M16), counted where every rejection already
   * passes through rather than inside the capacity path.
   *
   * `CAPACITY_EXCEEDED` is the metric the plan names: it is what a request loses
   * with when two people take the last seat at the same moment, and its rate against
   * total joins is the only external evidence that ADR-0006's row lock is doing its
   * job — a *rising* conflict rate means the product's popular events are contended,
   * while a rate of exactly zero on a busy day means something has stopped checking.
   *
   * Every code is counted, not only that one. The alternative is a special case here
   * and a second metric the next time somebody wants a different rate, and the label
   * set is closed by `ErrorCode` so the cardinality cannot grow with traffic.
   */
  private count(code: ErrorCode): void {
    this.metrics.counter(METRICS.JOIN_CONFLICTS, 'Rejected requests by error code', { code });
  }
}
