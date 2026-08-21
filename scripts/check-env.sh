#!/usr/bin/env bash
#
# Pre-flight on `.env`, before anything is started (M20).
#
#   scripts/check-env.sh
#
# `packages/config/src/env.ts` already refuses to boot on a bad environment, and
# refuses completely — it reports every problem at once. So why this?
#
# Because three classes of mistake are invisible to it and each one costs an
# outage:
#
#  1. **A placeholder that parses.** `CHANGE_ME_openssl_rand_base64_32` is a
#     perfectly good 32-character string. `JWT_ACCESS_SECRET` accepts it, and the
#     product ships with a signing key that is written in a public template.
#  2. **Two copies of one password disagreeing.** `DATABASE_URL` embeds
#     `POSTGRES_PASSWORD`, and neither Compose's `env_file` nor Node's
#     `--env-file` expands `${…}`, so they are written out twice. When they drift,
#     Postgres starts fine and the API fails authentication — which reads like a
#     network problem.
#  3. **Things that are only wrong in *this* deployment.** A `localhost` in
#     DATABASE_URL is correct on a laptop and unreachable from inside a
#     container. `TRUST_PROXY` unset is correct on a laptop and quietly breaks
#     the rate limiter behind nginx.
#
# Every one of those boots successfully. That is what makes them worth a script.
#
# Exit 0 means "safe to deploy". Warnings do not fail the run; errors do.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_env_file

errors=0
warnings=0
fail() { err "$*"; errors=$(( errors + 1 )); }
note() { warn "$*"; warnings=$(( warnings + 1 )); }

log "Checking ${PAYETAM_ENV_FILE}"

# ── Nothing left from the template ───────────────────────────────────────────
#
# Matched on the value rather than by comparing against the template, so a
# variable the template does not have yet is still caught.
while IFS= read -r line; do
    fail "still a placeholder: ${line%%=*}"
done < <(grep -E '^[A-Z_]+=.*(CHANGE_ME|REPLACE_WITH)' "$PAYETAM_ENV_FILE" || true)

# ── Required in production ───────────────────────────────────────────────────
required=(
    NODE_ENV DATABASE_URL REDIS_URL POSTGRES_PASSWORD REDIS_PASSWORD
    TELEGRAM_BOT_TOKEN TELEGRAM_MODE TELEGRAM_WEBHOOK_SECRET_PATH
    TELEGRAM_WEBHOOK_SECRET_TOKEN CHAT_ENCRYPTION_KEY PII_HASH_PEPPER
    JWT_ACCESS_SECRET JWT_REFRESH_SECRET QUEUE_PREFIX
)
for key in "${required[@]}"; do
    [[ -n "$(env_value "$key")" ]] || fail "${key} is empty or missing"
done

# ── Values the environment schema cannot check ───────────────────────────────
node_env="$(env_value NODE_ENV)"
[[ "$node_env" == 'production' ]] || fail "NODE_ENV is '${node_env}', expected 'production'"

[[ "$(env_value TELEGRAM_MODE)" == 'webhook' ]] \
    || fail "TELEGRAM_MODE must be 'webhook' — polling is refused in production (ADR-0004)"

# The API refuses to start with this on in production. Catching it here turns a
# crash loop into a line of output.
allow_seed="$(env_value ALLOW_PROD_SEED)"
[[ "$allow_seed" == '0' || -z "$allow_seed" ]] \
    || fail "ALLOW_PROD_SEED=${allow_seed} — the API will refuse to start"

# The suite TRUNCATEs every table it can reach. It has no business being here.
[[ -z "$(env_value TEST_DATABASE_URL)" ]] \
    || fail "TEST_DATABASE_URL is set — the integration suite TRUNCATEs every table"

# ── Key material actually being key material ─────────────────────────────────
#
# Length in *decoded bytes*, matching what env.ts requires, because a base64
# string of the right character count can still decode to the wrong size.
check_base64_bytes() {
    local key="$1" want="$2" value bytes
    value="$(env_value "$key")"
    [[ -n "$value" ]] || return 0
    bytes="$(printf '%s' "$value" | base64 -d 2> /dev/null | wc -c)"
    [[ "$bytes" == "$want" ]] \
        || fail "${key} decodes to ${bytes} bytes, expected ${want} (openssl rand -base64 ${want})"
}
check_base64_bytes CHAT_ENCRYPTION_KEY 32
check_base64_bytes PII_HASH_PEPPER 32

check_min_length() {
    local key="$1" want="$2" value
    value="$(env_value "$key")"
    [[ -n "$value" ]] || return 0
    (( ${#value} >= want )) || fail "${key} is ${#value} characters, expected at least ${want}"
}
check_min_length JWT_ACCESS_SECRET 32
check_min_length JWT_REFRESH_SECRET 32
check_min_length TELEGRAM_WEBHOOK_SECRET_PATH 16
check_min_length TELEGRAM_WEBHOOK_SECRET_TOKEN 16

# Two secrets that are the same secret. Both sign tokens; sharing a key means a
# refresh token is accepted wherever an access token is, and the 15-minute
# lifetime stops meaning anything.
if [[ -n "$(env_value JWT_ACCESS_SECRET)" ]] \
    && [[ "$(env_value JWT_ACCESS_SECRET)" == "$(env_value JWT_REFRESH_SECRET)" ]]; then
    fail "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical"
fi

# ── The two passwords written out twice ──────────────────────────────────────
#
# This is the check the whole script is worth having for. The symptom of a
# mismatch is `password authentication failed` from a database that is up, on a
# deploy that changed nothing about the database.
db_url="$(env_value DATABASE_URL)"
pg_pass="$(env_value POSTGRES_PASSWORD)"
if [[ -n "$db_url" && -n "$pg_pass" ]]; then
    # postgresql://user:PASSWORD@host…  — the password is between the first colon
    # after the scheme and the last `@`, so a password containing `@` still works.
    embedded="${db_url#*://}"
    embedded="${embedded%@*}"
    embedded="${embedded#*:}"
    [[ "$embedded" == "$pg_pass" ]] \
        || fail "the password in DATABASE_URL does not match POSTGRES_PASSWORD"
fi

redis_url="$(env_value REDIS_URL)"
redis_pass="$(env_value REDIS_PASSWORD)"
if [[ -n "$redis_url" && -n "$redis_pass" ]]; then
    if [[ "$redis_url" != *@* ]]; then
        fail "REDIS_URL carries no password, but REDIS_PASSWORD is set (use redis://:PASSWORD@redis:6379)"
    else
        embedded="${redis_url#*://}"
        embedded="${embedded%@*}"
        embedded="${embedded#*:}"
        [[ "$embedded" == "$redis_pass" ]] \
            || fail "the password in REDIS_URL does not match REDIS_PASSWORD"
    fi
fi

# ── Hostnames that only work outside a container ─────────────────────────────
for pair in "DATABASE_URL:postgres" "REDIS_URL:redis"; do
    key="${pair%%:*}" want="${pair##*:}"
    value="$(env_value "$key")"
    if [[ "$value" == *localhost* || "$value" == *127.0.0.1* ]]; then
        fail "${key} points at localhost — inside the compose network the host is '${want}'"
    fi
done

# ── Topology ─────────────────────────────────────────────────────────────────
trust="$(env_value TRUST_PROXY)"
if [[ -z "$trust" ]]; then
    fail "TRUST_PROXY is empty. Behind nginx the API would see the proxy as every caller: one shared IP rate-limit bucket for the whole internet, and one identical ip_hash on every audit row. Set it to the frontend subnet (172.28.0.0/24)."
elif [[ "${trust,,}" =~ ^(true|yes|on|all|\*)$ ]]; then
    fail "TRUST_PROXY=${trust} trusts every hop — any client could then forge X-Forwarded-For"
fi

queue_prefix="$(env_value QUEUE_PREFIX)"
[[ "$queue_prefix" != 'payetam:dev' ]] \
    || fail "QUEUE_PREFIX is still payetam:dev — a development worker would consume production jobs"

# ── Advisory ─────────────────────────────────────────────────────────────────
[[ -n "$(env_value MONITORING_CHAT_ID)" ]] \
    || note "MONITORING_CHAT_ID is empty — no alerts will be sent anywhere"

[[ -n "$(env_value TELEGRAM_BOT_USERNAME)" ]] \
    || note "TELEGRAM_BOT_USERNAME is empty — deep links in channel posts will use the wrong name"

public_url="$(env_value PUBLIC_API_URL)"
[[ "$public_url" == https://* ]] \
    || note "PUBLIC_API_URL is '${public_url}' — it should be the https origin the Mini App is served from"

echo
if (( errors > 0 )); then
    die "${errors} problem(s) found. Fix them before deploying."
fi
if (( warnings > 0 )); then
    ok "No blocking problems, ${warnings} warning(s)."
else
    ok "Environment looks deployable."
fi
