#!/usr/bin/env bash
#
# Post one line to the monitoring group (M20).
#
#   scripts/notify-telegram.sh <level> <title> [detail…]
#
#   level   info | warn | error   — chooses the marker, nothing else
#   title   one short line
#   detail  optional extra lines
#
# The shell-side counterpart to the worker's TelegramLoggerService: the worker
# alerts on things it observes from inside the process (an exhausted job), and
# this alerts on things only a script can see — a failed backup, a deploy that
# did not come back healthy, a rollback.
#
# **Three rules it must not break.**
#
#  1. *The token never appears in a process argument.* `ps` is world-readable on
#     a shared host, so the URL is written to curl's stdin as a config file
#     rather than passed on the command line.
#  2. *It never fails the caller.* Exit 0 whatever happens; a backup that ran and
#     could not announce itself still ran. `lib.sh`'s `notify` also swallows the
#     status, so this is belt and braces.
#  3. *It sends text, never HTML or Markdown.* An error message that happens to
#     contain `<` would otherwise be rejected by Telegram's parser, which is
#     precisely when an alert must not be the thing that fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

level="${1:-info}"
title="${2:-}"
shift 2 2> /dev/null || true
detail="$*"

[[ -n "$title" ]] || { echo "usage: notify-telegram.sh <level> <title> [detail…]" >&2; exit 0; }
[[ -r "$ENV_FILE" ]] || exit 0

read_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
CHAT="$(read_env MONITORING_CHAT_ID)"

# Both absent is the ordinary case for a deployment that has not set up a
# monitoring group. Silence, not a warning: this runs from cron.
[[ -n "$TOKEN" && -n "$CHAT" ]] || exit 0

case "$level" in
    error) marker='🔴 ERROR' ;;
    warn)  marker='🟡 WARN' ;;
    *)     marker='🟢 INFO' ;;
esac

host="$(hostname -s 2> /dev/null || echo unknown)"
stamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

text="${marker} · ${title}
host: ${host}
time: ${stamp}"
[[ -n "$detail" ]] && text="${text}

${detail}"

# Telegram refuses a message over 4096 characters, and a truncated alert beats
# no alert — a stack trace pasted into `detail` is exactly how that limit gets hit.
if (( ${#text} > 3900 )); then
    text="${text:0:3900}
…(truncated)"
fi

# The URL goes into a mode-600 config file rather than onto the command line,
# because `ps` is world-readable and the URL contains the bot token. The message
# body goes into a file too and is read with `@` — a config file unescapes `\n`
# in a quoted value, so a multi-line alert written inline would either be
# mangled or silently truncated at the first newline.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

printf '%s' "$text" > "${tmp}/text"
printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" > "${tmp}/curlrc"
chmod 600 "${tmp}/curlrc"

# `--max-time` because an alert must never be the thing that hangs a deploy.
curl --silent --show-error --max-time 15 \
    --config "${tmp}/curlrc" \
    --data-urlencode "chat_id=${CHAT}" \
    --data-urlencode "text@${tmp}/text" \
    --data-urlencode 'disable_web_page_preview=true' \
    > /dev/null 2>&1 || true

exit 0
