# syntax=docker/dockerfile:1.7
#
# PayeTam production images (M20).
#
# One file, five publishable targets: `api`, `worker`, `web` (nginx plus both built
# SPAs) and `tools` (migrations and seeds). They share a build so the API, the
# worker and the two bundles are always compiled from one tree — which matters
# here more than it usually does, because the frontends validate with the *same*
# zod schemas the backend validates with (ADR-0003), and a bundle built at a
# different moment from the API it talks to is a contract mismatch nobody sees
# until a form starts failing.
#
# Two things about the layout are load-bearing and worth knowing before editing:
#
#  1. **The workspace is preserved in the runtime image.** `pnpm` links
#     `@payetam/*` as symlinks into `packages/*`, and `tsc -b` emits plain
#     CommonJS rather than a bundle — so `node dist/main.js` resolves its imports
#     through the same directory structure it was built in. Flattening it into a
#     single directory would need a bundler this project deliberately does not have.
#
#  2. **The runtime dependency tree is installed separately, with `--prod`.**
#     Copying the build stage's `node_modules` would carry vite, vue-tsc, vitest,
#     the Prisma CLI and typescript into production — around 400 MB of tooling
#     that also widens the attack surface for nothing.

# ── base ─────────────────────────────────────────────────────────────────────
# Node 22 because `engines.node` is >=22.12 and both entry points use
# `--env-file-if-exists`, which is 22.9+. Alpine is safe here specifically
# because Prisma 7 has no Rust query engine to match against musl — the client
# talks to Postgres through the `pg` driver adapter (packages/db/prisma.service.ts).
FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1

# corepack reads `packageManager` from package.json, so the version is pinned by
# the repository rather than by this file — there is no second place to bump.
RUN corepack enable

WORKDIR /app

# ── manifests ────────────────────────────────────────────────────────────────
# Only the files that decide the dependency graph, so editing a source file does
# not invalidate the install layer. Enumerated rather than globbed: a glob that
# silently stops matching a new package produces an install that is missing it,
# and the error surfaces hundreds of lines later as a module resolution failure.
FROM base AS manifests

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/admin/package.json        apps/admin/
COPY apps/api/package.json          apps/api/
COPY apps/miniapp/package.json      apps/miniapp/
COPY apps/worker/package.json       apps/worker/
COPY packages/config/package.json   packages/config/
COPY packages/db/package.json       packages/db/
COPY packages/domain/package.json   packages/domain/
COPY packages/platform/package.json packages/platform/
COPY packages/shared/package.json   packages/shared/
COPY packages/telegram/package.json packages/telegram/

# ── deps ─────────────────────────────────────────────────────────────────────
# Everything, including devDependencies: the build needs typescript, vite and the
# Prisma CLI. The store cache mount survives between builds, which is what keeps a
# rebuild on a small VPS to a minute rather than ten (.npmrc tunes pnpm for a slow
# link — see the comment there).
FROM manifests AS deps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

# `prisma generate` reads the datasource URL through prisma.config.ts even though
# generation never connects. A syntactically valid placeholder satisfies it; this
# stage is discarded and the value never reaches a runtime image.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public

# `db:generate` first, and not optional: the Prisma client is generated into
# packages/db/src/generated and is not committed, so every file importing
# @payetam/db fails to type-check without it. `build` is `tsc -b` over the project
# references plus both Vite builds (see the root package.json).
RUN pnpm db:generate && pnpm build

# ── runtime-deps ─────────────────────────────────────────────────────────────
# The production dependency tree, resolved inside the image so that platform
# specific packages match. `@node-rs/argon2` is the one that cares: it ships
# per-platform prebuilt binaries as optional dependencies, and the musl build is
# chosen here rather than inherited from whatever machine ran the last install.
FROM manifests AS runtime-deps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── Dropping the Prisma CLI, which `--prod` does not ─────────────────────────
#
# `prisma` is a devDependency of packages/db, so `--prod` should exclude it — and
# does not, because `@prisma/client` declares it as a **peer** and .npmrc sets
# `auto-install-peers=true`. What arrives with it is the entire authoring
# toolchain: Prisma Studio, the dev server, pglite, React, TypeScript and the
# Rust engines. 220 MB, in an image that never generates a client or runs a
# migration — those happen in the `tools` stage, which keeps the full tree.
#
# `--config.auto-install-peers=false` is not an option here: it changes a setting
# recorded in the lockfile, which `--frozen-lockfile` then refuses.
#
# The removal is verified in `app-base` below rather than trusted. If a future
# Prisma version does need one of these at runtime, the *build* fails on a
# `require` — not production, at 3 a.m., on a module nobody expected to be missing.
RUN set -eu; \
    cd /app/node_modules/.pnpm; \
    rm -rf \
        prisma@* \
        '@prisma+studio-core@'* \
        '@prisma+dev@'* \
        '@prisma+engines@'* \
        '@electric-sql+pglite@'* \
        typescript@* \
        effect@* \
        react@* \
        react-dom@* \
        elkjs@*

# ── app-base ─────────────────────────────────────────────────────────────────
# What the API and the worker have in common: the production tree, the compiled
# packages, and nothing that can write to its own code.
FROM base AS app-base

ENV NODE_ENV=production

# uid/gid 1000, already present in the image. A container that runs as root can
# rewrite its own application code the moment anything else goes wrong, and there
# is nothing in either process that needs privilege — neither binds a low port.
COPY --from=runtime-deps --chown=node:node /app /app

# The compiled workspace, one package at a time. Copying `packages/` wholesale
# would drag the TypeScript sources and the generated Prisma sources in with it.
COPY --from=build --chown=node:node /app/packages/config/dist   ./packages/config/dist
COPY --from=build --chown=node:node /app/packages/shared/dist   ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/db/dist       ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/platform/dist ./packages/platform/dist
COPY --from=build --chown=node:node /app/packages/telegram/dist ./packages/telegram/dist
COPY --from=build --chown=node:node /app/packages/domain/dist   ./packages/domain/dist

# Proof that the prune in `runtime-deps` removed only build-time packages. Every
# module the API and the worker load at startup is required here, so a missing
# dependency is a failed build rather than a container that crash-loops in
# production. `prisma.service.js` specifically, because that is the file that
# pulls in `@prisma/client` and the `pg` driver adapter.
# Absolute paths, and `--eval` run from `apps/api` so bare specifiers resolve the
# way they will at runtime — `/app` itself has no `reflect-metadata`, because the
# root package.json does not depend on it and pnpm does not hoist.
RUN cd /app/apps/api && node -e "\
    require('reflect-metadata'); \
    require('/app/packages/db/dist/prisma.service.js'); \
    require('/app/packages/platform/dist/index.js'); \
    require('/app/packages/domain/dist/index.js'); \
    require('/app/packages/telegram/dist/index.js'); \
    require('/app/packages/config/dist/index.js'); \
    console.log('runtime module graph resolves'); \
    "

USER node

# ── api ──────────────────────────────────────────────────────────────────────
FROM app-base AS api

COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api

EXPOSE 3000

# busybox `wget`, because it is already in the image. Adding curl for one probe
# means one more package to track advisories for on an image that otherwise has
# no HTTP client at all.
#
# `/health` and not `/ready` — deliberately. Liveness is what decides whether to
# *restart* this process, and a database blip must not do that; readiness is a
# different question with a different consequence and is answered by /ready
# (apps/api/src/health/health.controller.ts).
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${API_PORT:-3000}/health" || exit 1

# `--env-file-if-exists` rather than `--env-file`, so one image works both ways:
# with the environment injected by Compose (the default, see
# docker/docker-compose.prod.yml) and with a `.env` bind-mounted at /app/.env for
# a deployment that would rather keep its secrets out of `docker inspect`.
CMD ["node", "--env-file-if-exists=/app/.env", "dist/main.js"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM app-base AS worker

COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist

WORKDIR /app/apps/worker

# The worker serves no HTTP — it is a Nest application *context* (ADR-0005), so
# there is no endpoint to probe. This checks only that the process is still there,
# which is all a liveness probe can honestly claim here. Whether the queues are
# actually draining is a question for the metrics and the alerting, not for Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD pgrep -f 'dist/main.js' > /dev/null || exit 1

CMD ["node", "--env-file-if-exists=/app/.env", "dist/main.js"]

# ── tools ────────────────────────────────────────────────────────────────────
# Migrations and seeds. The full build tree, because `prisma migrate deploy` needs
# the Prisma CLI and the migration files, and every seed runs through `tsx` — all
# of them devDependencies that the runtime images deliberately do not carry.
#
# Running these from a container rather than from the host is what keeps the
# server's only requirement to Docker: no Node, no pnpm, no version drift between
# the machine that built the image and the machine that migrates the database.
FROM build AS tools

ENV NODE_ENV=production

# Root, unlike the runtime images: `tsx` compiles into a cache directory, and the
# container exists for the seconds a migration takes. Nothing long-lived listens here.
CMD ["pnpm", "db:migrate:deploy"]

# ── web ──────────────────────────────────────────────────────────────────────
# nginx with both bundles baked in.
#
# The alternative — plain `nginx:alpine` with `apps/*/dist` bind-mounted from the
# host — needs Node and pnpm installed on the server to produce those directories,
# and makes a rollback only half a rollback: `git checkout` of the previous tag
# does not rebuild the frontend, so the old API would be served alongside the new
# bundle. Baking them in makes the image the unit of deployment for all three.
#
# The nginx *configuration* is still bind-mounted, so a proxy tweak is a restart
# rather than a rebuild.
FROM nginx:alpine AS web

COPY docker/nginx.conf              /etc/nginx/nginx.conf
COPY docker/sites-available/        /etc/nginx/sites-available/
COPY docker/sites-enabled/          /etc/nginx/sites-enabled/

COPY --from=build /app/apps/miniapp/dist /srv/www/miniapp
COPY --from=build /app/apps/admin/dist   /srv/www/admin

# The ACME webroot. Created here so nginx can serve it before certbot has ever
# run — the first certificate request needs the location to exist already.
RUN mkdir -p /var/www/html/.well-known/acme-challenge

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/nginx-health || exit 1
