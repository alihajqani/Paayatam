import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
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

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof AppError) {
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
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(body);
  }
}
