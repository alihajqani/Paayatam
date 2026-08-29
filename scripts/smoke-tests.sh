#!/usr/bin/env bash
#
# Post-deploy smoke tests (M20).
#
#   scripts/smoke-tests.sh                 # against the live hostnames
#   scripts/smoke-tests.sh --local         # against the containers, no DNS or TLS
#   scripts/smoke-tests.sh --skip-backup   # leave the backup path alone
#
# Not a test suite — `pnpm test` is that, and it runs in CI against a real
# Postgres and Redis. This asks a narrower question: **is the thing that is
# running right now wired up correctly?** Every check here is one that passes in
# CI and can still fail in production, because what it exercises is the
# deployment rather than the code.
#
# Each check is one assertion, prints one line, and does not stop the run when it
# fails — a deploy that broke two things should say so once rather than twice.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APP_HOST="${PAYETAM_APP_HOST:-app.paayatam.online}"
ADMIN_HOST="${PAYETAM_ADMIN_HOST:-admin.paayatam.online}"
LOCAL=0
SKIP_BACKUP=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --local)       LOCAL=1; shift ;;
        --skip-backup) SKIP_BACKUP=1; shift ;;
        -h|--help)     sed -n '2,18p' "$0"; exit 0 ;;
        *)             die "unknown argument: $1" ;;
    esac
done

require_docker

passed=0
failed=0
pass() { ok "$*"; passed=$(( passed + 1 )); }
bad()  { err "$*"; failed=$(( failed + 1 )); }

# Requests go out from *inside* the nginx container, resolving the public
# hostname through Docker's DNS onto nginx itself. That means the tests exercise
# the real server block, the real TLS certificate and the real proxy rules,
# without needing the deploy host to have working public DNS for its own name —
# which it usually does not, since the record points at its public address and
# the request would leave and come back.
#
# `--resolve` pins the name to 127.0.0.1 so the certificate is still validated
# against the hostname. `-k` is added only in --local mode, where the certificate
# is the self-signed placeholder.
fetch() {
    local host="$1" path="$2" extra=("${@:3}")
    local insecure=()
    (( LOCAL )) && insecure=(-k)
    compose exec -T nginx \
        curl --silent --show-error --max-time 10 \
        --resolve "${host}:443:127.0.0.1" --resolve "${host}:80:127.0.0.1" \
        "${insecure[@]}" "${extra[@]}" "https://${host}${path}"
}

status_of() {
    fetch "$1" "$2" -o /dev/null -w '%{http_code}' 2> /dev/null || echo 000
}

log "Infrastructure"

# ── Containers ───────────────────────────────────────────────────────────────
for service in postgres redis api worker nginx; do
    if compose ps --status running --services 2> /dev/null | grep -qx "$service"; then
        pass "${service} is running"
    else
        bad "${service} is NOT running"
    fi
done

# ── Dependencies, from the API's own point of view ───────────────────────────
#
# `/ready` is refused by nginx from outside — it names which dependency is down,
# which is the fact an attacker most wants during an outage. Read here from
# inside the network, which is the only place it is meant to be read from.
ready="$(compose exec -T api wget -qO- "http://127.0.0.1:${PAYETAM_API_PORT:-3000}/ready" 2> /dev/null || echo '')"
if [[ "$ready" == *'"ready":true'* ]]; then
    pass "API readiness: database and Redis both reachable"
else
    bad "API readiness failed: ${ready:-no response}"
fi

log "Mini App origin (${APP_HOST})"

code="$(status_of "$APP_HOST" /health)"
[[ "$code" == '200' ]] && pass "GET /health → 200" || bad "GET /health → ${code} (expected 200)"

body="$(fetch "$APP_HOST" /health 2> /dev/null || echo '')"
[[ "$body" == *'"status":"ok"'* ]] && pass "/health reports ok" || bad "/health body was: ${body:-empty}"

# The check that tells you *which* release answered, not just that something did
# (M22 phase 10). `PAYETAM_VERSION` is exported by deploy.sh before it builds, so
# the tag being deployed, the image tag and this answer are the same string — and
# a mismatch here is the one symptom of a container that was never replaced.
body="$(fetch "$APP_HOST" /api/v1/version 2> /dev/null || echo '')"
if [[ "$body" == *"\"version\":\"${PAYETAM_VERSION:-local}\""* ]]; then
    pass "/api/v1/version reports ${PAYETAM_VERSION:-local}"
else
    bad "/api/v1/version said ${body:-nothing}, expected ${PAYETAM_VERSION:-local}"
fi

code="$(status_of "$APP_HOST" /)"
[[ "$code" == '200' ]] && pass "the Mini App bundle is served" || bad "GET / → ${code} (expected 200)"

# The one assertion that catches a broken frontend build: `index.html` exists but
# references an `/assets/…` file that was never copied into the image.
asset="$(fetch "$APP_HOST" / 2> /dev/null | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1 || true)"
if [[ -n "$asset" ]]; then
    code="$(status_of "$APP_HOST" "$asset")"
    [[ "$code" == '200' ]] && pass "hashed assets resolve (${asset})" || bad "${asset} → ${code}"
else
    bad "index.html references no /assets/*.js — the bundle did not build"
fi

# History-mode routing: an unknown path must return the SPA, not a 404.
code="$(status_of "$APP_HOST" /some/client/route)"
[[ "$code" == '200' ]] && pass "history-mode routing falls back to index.html" || bad "an unknown path → ${code} (expected 200)"

# ── The legal documents (v0.3.1, report 1) ───────────────────────────────────
#
# `/api/v1/policies/current` is the one authenticated-product endpoint that is
# deliberately `@Public()`: the terms have to be readable before anybody has a
# reason to sign in. It is checked here because it is the endpoint the *whole of
# report 1* rests on — a user refused with POLICY_VERSION_STALE is sent to a
# screen that renders whatever this returns, so a 500 or a proxy rule that never
# reached it turns the gate into the dead end this release exists to close.
#
# It is **not** asserted to be non-empty. A deployment whose legal text is still
# in draft correctly returns `{"policies":[]}`, nothing is gated in that state,
# and failing the deploy over it would be this check inventing a requirement.
# What the count is, is *reported*, because "how many current policies does
# production have?" is the question the deploy runbook asks first.
body="$(fetch "$APP_HOST" /api/v1/policies/current 2> /dev/null || echo '')"
if grep -q '"policies"' <<< "$body"; then
    count="$(grep -o '"type"' <<< "$body" | wc -l | tr -d ' ')"
    pass "/api/v1/policies/current answers — ${count} current document(s)"
    [[ "$count" == '0' ]] && log "  note: no published policy. Nothing is gated; the terms screen says so."
else
    bad "/api/v1/policies/current returned ${body:-nothing} — the terms screen has nothing to render"
fi

# ── The closed endpoints ─────────────────────────────────────────────────────
#
# The single most valuable check here. `/metrics` publishes traffic volumes and
# queue depths, and the *application's* own guard allows private addresses —
# which behind a proxy is every request. If this returns 200, the endpoint is
# world-readable while the code reads as though it were closed.
code="$(status_of "$APP_HOST" /metrics)"
[[ "$code" == '404' ]] && pass "/metrics is closed from outside (404)" || bad "/metrics → ${code} — EXPECTED 404. Traffic volumes and queue depths are public."

code="$(status_of "$APP_HOST" /ready)"
[[ "$code" == '404' ]] && pass "/ready is closed from outside (404)" || bad "/ready → ${code} (expected 404)"

# ── The webhook ──────────────────────────────────────────────────────────────
#
# Always 200, whatever it decides internally: a 401 here would let an attacker
# probe for valid secrets and a 500 would make Telegram retry an update already
# rejected. So a *wrong* secret returning 200 is the correct behaviour, and that
# is what this asserts — that the route exists and answers, without sending the
# real secret anywhere.
code="$(fetch "$APP_HOST" /telegram/webhook/definitely-not-the-secret \
    -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' 2> /dev/null || echo 000)"
[[ "$code" == '200' ]] && pass "the webhook route answers 200 to a bad secret (as designed)" \
    || bad "POST /telegram/webhook/<wrong> → ${code} (expected 200 — see webhook.controller.ts)"

log "Admin origin (${ADMIN_HOST})"

code="$(status_of "$ADMIN_HOST" /)"
[[ "$code" == '200' ]] && pass "the admin bundle is served" || bad "GET / → ${code} (expected 200)"

# Unauthenticated, so 401 is the pass. A 200 here would mean the admin API is
# answering without a session, and a 404 would mean the proxy rule is missing.
code="$(status_of "$ADMIN_HOST" /admin/v1/me)"
[[ "$code" == '401' ]] && pass "/admin/v1/me → 401 without a session" || bad "/admin/v1/me → ${code} (expected 401)"

code="$(status_of "$ADMIN_HOST" /api/v1/events)"
[[ "$code" == '404' ]] && pass "the Mini App API is not exposed on the admin host" || bad "/api/v1/events on the admin host → ${code} (expected 404)"

code="$(status_of "$ADMIN_HOST" /metrics)"
[[ "$code" == '404' ]] && pass "/metrics is closed on the admin host too" || bad "/metrics → ${code} (expected 404)"

headers="$(fetch "$ADMIN_HOST" / -D - -o /dev/null 2> /dev/null || echo '')"
grep -qi 'x-frame-options: *DENY' <<< "$headers" \
    && pass "the admin panel refuses to be framed" \
    || bad "X-Frame-Options: DENY is missing on the admin host"

log "HTTP → HTTPS"
for host in "$APP_HOST" "$ADMIN_HOST"; do
    code="$(compose exec -T nginx curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        --resolve "${host}:80:127.0.0.1" "http://${host}/" 2> /dev/null || echo 000)"
    [[ "$code" == '301' ]] && pass "${host}: plain HTTP redirects" || bad "${host}: HTTP → ${code} (expected 301)"
done

# The one path that must stay reachable over plain HTTP forever: a redirect here
# is what makes a renewal fail ninety days from now, silently.
code="$(compose exec -T nginx curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "${APP_HOST}:80:127.0.0.1" "http://${APP_HOST}/.well-known/acme-challenge/probe" 2> /dev/null || echo 000)"
[[ "$code" == '404' ]] && pass "the ACME challenge path is served over HTTP (404 for a missing token is correct)" \
    || bad "the ACME challenge path → ${code}; a renewal will fail (expected 404, not 301)"

log "Queues"
# A worker that boots and registers nothing looks identical to a healthy one from
# the outside. The startup line is the only evidence either way.
#
# Captured into a variable rather than piped straight into `grep -q`. Under the
# `pipefail` this script inherits from lib.sh, `grep -q` exits at the *first*
# match and closes the pipe, `docker compose logs` dies on SIGPIPE (141), and the
# pipeline reports failure — so the check failed exactly when the line was found
# early enough for compose to still be writing. It passed on a short log and
# failed on a long one, which is the worst way for a health check to be wrong.
worker_log="$(compose logs --tail 200 worker 2> /dev/null || true)"
if grep -q 'Worker started' <<< "$worker_log"; then
    pass "the worker registered its processors"
else
    bad "no 'Worker started' line in the worker's recent logs"
fi

if (( ! SKIP_BACKUP )); then
    log "Backup and restore"
    if "${PAYETAM_ROOT}/scripts/backup.sh" --tag smoke > /tmp/payetam-smoke-backup.log 2>&1; then
        dump="$(grep -o '/[^ ]*\.dump\(\.gpg\)\?' /tmp/payetam-smoke-backup.log | tail -1)"
        pass "backup produced ${dump:-a dump}"

        # The check that matters: a dump nobody has opened is a hope, not a
        # backup. This restores it into a scratch database and counts what
        # arrived, which is the only way to find out that the archive is
        # truncated, or that the append-only ledger triggers did not survive.
        if "${PAYETAM_ROOT}/scripts/restore-rehearsal.sh" > /tmp/payetam-smoke-restore.log 2>&1; then
            pass "the dump restores into a scratch database ($(grep -o 'REHEARSAL_SECONDS=[0-9]*' /tmp/payetam-smoke-restore.log | tail -1))"
        else
            bad "the restore rehearsal failed — see /tmp/payetam-smoke-restore.log"
        fi
    else
        bad "the backup script failed — see /tmp/payetam-smoke-backup.log"
    fi
fi

echo
if (( failed > 0 )); then
    err "${failed} failed, ${passed} passed"
    exit 1
fi
ok "${passed} checks passed"
