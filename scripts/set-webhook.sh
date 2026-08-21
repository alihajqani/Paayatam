#!/usr/bin/env bash
#
# Point Telegram at this deployment's webhook (M20).
#
#   scripts/set-webhook.sh            # register, then read back what Telegram has
#   scripts/set-webhook.sh --info     # read only, change nothing
#   scripts/set-webhook.sh --delete   # make the bot deaf, deliberately
#
# ── Two things that will bite you ────────────────────────────────────────────
#
# **A failed `setWebhook` deletes the previous one.** Telegram resolves the
# hostname itself at registration time, and if it cannot reach the URL the bot is
# left with no webhook at all rather than with the one it had. So this script
# proves the endpoint is reachable from the public internet *before* it calls
# Telegram — which is the same order `tools/devstack.sh` uses for tunnels, for
# the same reason.
#
# **The secret path is a credential.** It is in the URL, so it lands in shell
# history, in `ps`, and in any log that records a request line. Nothing here puts
# it on a command line, and nginx has `access_log off` on that location.
#
# ⛔ `make webhook` is the development command. It reads `.dev/state/tunnel-api.url`,
# which does not exist on a server.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APP_HOST="${PAYETAM_APP_HOST:-app.paayatam.ir}"
MODE='set'

while [[ $# -gt 0 ]]; do
    case "$1" in
        --info)    MODE='info'; shift ;;
        --delete)  MODE='delete'; shift ;;
        --host)    APP_HOST="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
        *)         die "unknown argument: $1" ;;
    esac
done

require_env_file

TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"
SECRET_PATH="$(env_value TELEGRAM_WEBHOOK_SECRET_PATH)"
SECRET_TOKEN="$(env_value TELEGRAM_WEBHOOK_SECRET_TOKEN)"

[[ -n "$TOKEN" ]] || die "TELEGRAM_BOT_TOKEN is not set in .env"

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# The token goes into a mode-600 config file rather than onto the command line,
# because `ps` is world-readable.
write_curlrc() {
    printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TOKEN" "$1" > "${WORK}/curlrc"
    chmod 600 "${WORK}/curlrc"
}

show_info() {
    write_curlrc getWebhookInfo
    local response
    response="$(curl --silent --show-error --max-time 20 --config "${WORK}/curlrc")"

    # The URL contains the secret path, so it is reported by shape rather than
    # printed. Everything else is safe to show and is what you actually need.
    local url pending last_error
    url="$(grep -o '"url":"[^"]*"' <<< "$response" | head -1 | cut -d'"' -f4)"
    pending="$(grep -o '"pending_update_count":[0-9]*' <<< "$response" | head -1 | cut -d: -f2)"
    last_error="$(grep -o '"last_error_message":"[^"]*"' <<< "$response" | head -1 | cut -d'"' -f4)"

    if [[ -z "$url" ]]; then
        warn "Telegram has no webhook registered for this bot."
        return
    fi

    # Host only. Printing the path would write the secret to the terminal, and
    # from there to a scrollback buffer somebody screenshots.
    local host="${url#https://}"
    host="${host%%/*}"
    log "Registered host      : ${host}"
    log "Path                 : $([[ "$url" == *"$SECRET_PATH" ]] && echo 'matches .env ✓' || echo 'DOES NOT match .env ✗')"
    log "Pending updates      : ${pending:-0}"
    if [[ -n "$last_error" ]]; then
        err "Last error           : ${last_error}"
    else
        ok "No delivery errors reported"
    fi
}

case "$MODE" in
    info)
        show_info
        exit 0
        ;;

    delete)
        warn "This makes the bot deaf: no update will reach the API until it is set again."
        confirm "Delete the webhook?" || die "Aborted."
        write_curlrc deleteWebhook
        curl --silent --show-error --max-time 20 --config "${WORK}/curlrc" \
            --data-urlencode 'drop_pending_updates=false' > /dev/null
        ok "Webhook deleted. Pending updates are kept and will be delivered when it is set again."
        exit 0
        ;;
esac

[[ -n "$SECRET_PATH" ]] || die "TELEGRAM_WEBHOOK_SECRET_PATH is not set in .env"
[[ -n "$SECRET_TOKEN" ]] || die "TELEGRAM_WEBHOOK_SECRET_TOKEN is not set in .env"

# ── Prove the endpoint is reachable first ────────────────────────────────────
#
# From the public internet, not from inside the compose network: what matters is
# what Telegram can reach, and a request that never leaves the host proves
# nothing about DNS, the firewall or the certificate.
log "Checking that https://${APP_HOST}/health is reachable from outside"
code="$(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' "https://${APP_HOST}/health" 2>&1 || echo 000)"
if [[ "$code" != '200' ]]; then
    cat >&2 <<HINT
  https://${APP_HOST}/health returned ${code}.

  Not registering. A setWebhook that Telegram cannot validate deletes whatever
  webhook the bot has now, so a broken deploy would also make the bot deaf.

  Check, in this order:
    dig +short ${APP_HOST}          # points at this server?
    sudo ufw status                 # 443 open?
    scripts/compose.sh ps           # nginx and api up?
    curl -v https://${APP_HOST}/health
HINT
    die "endpoint not reachable"
fi
ok "Reachable"

log "Registering the webhook"

# `allowed_updates` is exactly what packages/telegram parses. Anything else is
# discarded on arrival, so not subscribing to it is one round trip fewer.
write_curlrc setWebhook
response="$(curl --silent --show-error --max-time 20 --config "${WORK}/curlrc" \
    --data-urlencode "url=https://${APP_HOST}/telegram/webhook/${SECRET_PATH}" \
    --data-urlencode "secret_token=${SECRET_TOKEN}" \
    --data-urlencode 'allowed_updates=["message","edited_message","callback_query","my_chat_member"]' \
    --data-urlencode 'max_connections=40')"

if [[ "$response" != *'"ok":true'* ]]; then
    # The response can echo the URL back, secret path and all.
    err "Telegram refused the registration: $(grep -o '"description":"[^"]*"' <<< "$response" | cut -d'"' -f4)"
    notify error 'setWebhook failed' "host: ${APP_HOST}"
    die "the bot may now have no webhook at all — fix the cause and run this again"
fi
ok "Registered"

echo
show_info
