# ADR-0013: TypeScript version and the build / dev loop

- **Status:** Accepted (2026-08-15)
- **Decides:** compiler version, transpiler choice, dev watch loop
- **Discovered during:** M1, by things breaking rather than by planning

## Context

Three constraints collided while building the M1 skeleton, and two of them only
became visible by running the code.

1. **NestJS dependency injection requires `emitDecoratorMetadata`.** Nest resolves a
   constructor parameter's provider from the `design:paramtypes` metadata the
   compiler emits. Without it, injected properties are simply `undefined` — and,
   critically, **the application still starts**. The failure appears later, as a
   `TypeError: Cannot read properties of undefined` on the first request that
   touches the missing dependency.

2. **TypeScript 7 is available and is a full native rewrite.** It is much faster.

3. **The repo's other Telegram bots use `tsx`** for their dev loop, so it was the
   obvious house choice.

## Decision

### TypeScript 5.9.3, pinned exactly — not 7.x

TS 7 was tested directly rather than assumed: with `experimentalDecorators` and
`emitDecoratorMetadata` enabled it **does** emit `__metadata("design:paramtypes", …)`
correctly, so NestJS DI would work.

It is still not adopted, because **`typescript-eslint@8` declares
`typescript: ">=4.8.4 <6.1.0"`**. Type-aware linting is not cosmetic here: it enforces
module boundaries (ADR-0001), bans floating promises, and blocks `v-html` and unsafe
raw SQL. Losing that layer to gain compile speed is the wrong trade at this stage.

Revisit when typescript-eslint supports TS 7.

### `tsc -b` with project references for building

The root `tsconfig.json` is solution-style: no files, only references. `tsc -b`
builds each workspace package in dependency order and emits `.d.ts`, which is also
what makes `@payetam/db` resolvable from `apps/api`.

`pnpm typecheck` and `pnpm build` are therefore the same command. Honest, and it
means CI type-checks exactly what it ships.

### `node --watch` on compiled output for the dev loop — not `tsx`

**`tsx` cannot be used for the Nest applications.** It transpiles with esbuild, and
esbuild does not implement `emitDecoratorMetadata`. This was not a theoretical
concern: the API booted fine under `tsx`, mapped its routes, and then returned 500 on
`/ready` because `HealthController`'s injected `HealthService` was `undefined`.

The dev loop is therefore `tsc -b --watch` alongside `node --watch dist/main.js`.
Slower to start than `tsx`, and worth it — it runs the same compiler output as
production, so a class of "works in dev, broken in prod" bug cannot exist.

`tsx` stays in the toolchain for standalone scripts (`tools/`, seeds) that use no
decorators.

### Environment loading

Dev processes load `.env` through Node's built-in `--env-file`. Production takes
environment from the container, never from a file. `packages/config` itself only ever
reads `process.env`, so it has no opinion about where values came from and stays
testable by passing a plain object.

## Consequences

**Positive**
- DI failures are impossible from this cause: dev and prod run identical output.
- One compiler, one build graph, no second transpiler to keep configured in step.
- Full type-aware lint retained.

**Negative**
- Slower incremental rebuilds than esbuild. Acceptable at this size; if it becomes
  painful, SWC via `@nestjs/cli` supports decorator metadata and is the escape hatch.
- Contributors must remember `tsx` is unsafe for decorator code. Mitigated by the
  `dev` scripts not using it, and by this ADR.
- `pnpm dev` requires an initial build before watching, which the root script does.

## Alternatives considered

- **`tsx` with explicit `@Inject()` everywhere.** Rejected: it makes every constructor
  noisier, and one forgotten `@Inject` reintroduces exactly the silent-undefined bug.
- **SWC via `@nestjs/cli`.** Genuinely good and supports decorator metadata. Rejected
  for M1 only to avoid adding `@nestjs/cli` and `@swc/core` over a link where installs
  were already timing out. Reconsider when rebuild time actually hurts.
- **`ts-node`.** Correct metadata, but markedly slower than the compiled-output loop it
  would replace.
- **TypeScript 7 plus dropping type-aware lint.** Rejected — see above.
