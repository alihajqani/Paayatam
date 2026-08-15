import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * Connection URLs moved out of schema.prisma in v7 and live here.
 *
 * The `.env` path is explicit rather than a bare `import 'dotenv/config'`: the CLI
 * runs with this package as its working directory, so the default lookup would miss
 * the repo-root `.env` and fail with "Cannot resolve environment variable".
 * This must execute before `defineConfig`, which is why it is a statement rather
 * than an import side effect.
 */
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env') });

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
