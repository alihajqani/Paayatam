// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Lint is where several architectural decisions stop being documentation and start
 * being enforced. The rules below that reference an ADR are not style preferences —
 * they are the invariants in docs/adr/README.md, checked by a machine.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/db/src/generated/**',
      'packages/db/prisma/migrations/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // A dedicated lint project rather than `projectService: true`: the build
        // configs exclude tests and config files (they must not land in dist), but
        // typed rules still need type information for them.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused variables are usually a leftover or a bug; `_`-prefixed ones are
      // an explicit "I know, I am discarding this".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // A floating promise in a request handler or a job processor is a silently
      // swallowed failure — precisely the class of bug the outbox exists to prevent
      // elsewhere (ADR-0005). Make it impossible to write by accident.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // `any` erodes the type safety the whole schema-to-client pipeline buys us.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Reaching into another workspace package's internals defeats the module
      // boundaries that make this a modular monolith rather than a big ball of
      // mud (ADR-0001). Import from the package root, which is its public API.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@payetam/*/src/*', '@payetam/*/dist/*'],
              message:
                'Import from the package root (e.g. @payetam/db), not its internals. Module boundaries are the point — see ADR-0001.',
            },
            {
              group: ['**/generated/prisma/*'],
              message:
                'Import Prisma types from @payetam/db, which re-exports them. The generator output path is an implementation detail.',
            },
          ],
        },
      ],

      // T15: credentials and Telegram identifiers must never reach a log.
      // console.error at bootstrap is the one legitimate case, allowed below.
      'no-console': ['error', { allow: ['error'] }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-param-reassign': 'error',
      'prefer-const': 'error',
    },
  },

  // @payetam/db is the one package that may import the generated Prisma client —
  // it is the package whose whole job is to wrap it and re-export a stable surface.
  // The restriction exists to stop *consumers* reaching past that surface.
  {
    files: ['packages/db/src/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Tests may be looser: fixtures and stubs legitimately need casts that
  // production code should never contain.
  {
    files: ['**/*.test.ts', '**/*.int.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  // Config files are executed by tooling, not by the app.
  {
    files: ['*.config.{js,mjs,ts}', '**/prisma.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  prettier,
);
