import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from '@payetam/config';

/** DI token for the validated environment. */
export const ENV = Symbol('ENV');

/**
 * Validated once at module construction. If the environment is wrong the process
 * fails at startup rather than at the first request that happens to need a missing
 * variable.
 */
export const envProvider = {
  provide: ENV,
  useFactory: (): Env => loadEnv(),
};

@Global()
@Module({
  providers: [envProvider],
  exports: [ENV],
})
export class ConfigModule {}
