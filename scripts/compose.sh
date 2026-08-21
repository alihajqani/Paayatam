#!/usr/bin/env bash
#
# `docker compose` for the production stack, from anywhere.
#
#   scripts/compose.sh ps
#   scripts/compose.sh logs -f api
#   scripts/compose.sh --profile tools run --rm tools pnpm db:migrate:deploy
#
# It exists for one reason: Compose resolves `env_file` and every relative
# volume path against the directory of the *first* `-f` file, so
# `docker compose -f docker/docker-compose.prod.yml …` behaves differently
# depending on where you ran it from. An absolute `-f` removes the question, and
# a wrapper is the only way to make that the default rather than something to
# remember at 3 a.m.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_docker
exec docker compose -f "$PAYETAM_COMPOSE_FILE" "$@"
