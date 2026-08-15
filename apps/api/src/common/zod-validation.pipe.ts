import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { AppError, ErrorCode } from '@payetam/shared';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a zod schema from `@payetam/shared`.
 *
 * Deliberately not Nest's class-validator `ValidationPipe` (ADR-0003): the Vue
 * frontends validate with these same schemas, so using a second validation system
 * on the server would be two sets of rules to keep in step. Roughly thirty lines
 * is a better trade than that.
 *
 * zod's `.strict()` behaviour matters here: unknown keys are stripped by default,
 * which is the mass-assignment defence the class-validator pipe would have given.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Field paths are safe to return — they are our own contract, not user data —
      // and they turn "invalid request" into something a client can act on.
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
