#!/usr/bin/env bash
#
# First certificates for app.paayatam.online and admin.paayatam.online (M20).
#
#   scripts/init-letsencrypt.sh --email you@example.com [--staging] [--force]
#
# Run this once, after DNS resolves both names to this server and before the
# first real deploy. `certbot-renew` handles everything afterwards.
#
# ── The problem this solves ──────────────────────────────────────────────────
#
# nginx refuses to start when an `ssl_certificate` file is missing, and the
# certificate cannot be issued until nginx is running to answer the ACME
# challenge. That circle is why "just run certbot" does not work on a fresh host,
# and why the user's original sketch — nginx waiting for certbot, certbot waiting
# for nginx — is a dependency cycle Compose refuses outright.
#
# The way out is a self-signed placeholder. nginx starts on it, serves
# `/.well-known/acme-challenge/` over plain HTTP, certbot replaces the
# placeholder with the real certificate, nginx reloads. From then on there is no
# circle: a renewal replaces a file that already exists.
#
# ── --staging ────────────────────────────────────────────────────────────────
#
# Let's Encrypt allows **5 failed validations per account per hostname per hour**
# and 5 duplicate certificates per week. A misconfigured DNS record or a closed
# port 80 burns through that in one sitting, and then the real attempt has to
# wait. Rehearse against staging first; the certificate it issues is untrusted by
# browsers, which is the point — it proves the plumbing without spending quota.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DOMAINS=(app.paayatam.online admin.paayatam.online)
EMAIL=''
STAGING=0
FORCE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --email)   EMAIL="${2:-}"; shift 2 ;;
        --staging) STAGING=1; shift ;;
        --force)   FORCE=1; shift ;;
        --domain)  DOMAINS=("${2:-}"); shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_docker
require_env_file

# Not optional, and not defaulted to anything. This address is where the expiry
# warnings go, and a certificate that silently expires takes both origins down —
# including the Mini App inside Telegram, where a TLS error is not something a
# user can click through.
[[ -n "$EMAIL" ]] || die "--email is required (Let's Encrypt sends expiry warnings there)"

if (( STAGING )); then
    warn "Staging mode: the certificates issued will NOT be trusted by browsers."
fi

# ── 0. The certbot image ─────────────────────────────────────────────────────
#
# Pulled explicitly, with a line saying so. Left implicit it happens inside the
# first `run --rm`, where a slow link looks exactly like a hung script — and this
# is the step people run on a fresh VPS whose network they have not tested yet.
log "Pulling the certbot image (a few hundred MB; this can be slow on a new host)"
compose --profile certbot pull certbot

# ── 1. Placeholders, so nginx can start ──────────────────────────────────────
#
# Written into the same volume certbot writes to, at the paths the site files
# name. `chain.pem` is included because `ssl_trusted_certificate` points at it
# and nginx will not start without the file existing either — OCSP stapling is
# simply inert until a real chain replaces it.
#
# A function rather than a loop body, because step 3 has to put a placeholder
# back when issuance fails — see the comment there.
write_placeholder() {
    compose --profile certbot run --rm --entrypoint sh certbot -c "
        set -e
        mkdir -p /etc/letsencrypt/live/${1}
        openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
            -keyout /etc/letsencrypt/live/${1}/privkey.pem \
            -out    /etc/letsencrypt/live/${1}/fullchain.pem \
            -subj '/CN=${1}' 2>/dev/null
        cp /etc/letsencrypt/live/${1}/fullchain.pem \
           /etc/letsencrypt/live/${1}/chain.pem
    "
}

# True when live/<domain> holds a real certbot lineage rather than a placeholder.
#
# The test is the symlink, not the directory: certbot links
# `live/<domain>/fullchain.pem` into `../../archive/<domain>`, while
# `write_placeholder` leaves a regular file there. Everything below turns on
# telling those two apart, and getting it backwards deletes a working
# certificate — so it asks for the symlink and treats anything else as disposable.
is_real_lineage() {
    compose --profile certbot run --rm --entrypoint sh certbot -c \
        "[ -L /etc/letsencrypt/live/${1}/fullchain.pem ]" 2> /dev/null
}

log "Writing self-signed placeholders so nginx can start"
for domain in "${DOMAINS[@]}"; do
    if is_real_lineage "$domain"; then
        ok "${domain}: a certificate is already in place"
        continue
    fi

    write_placeholder "$domain"
    ok "${domain}: placeholder written"
done

# ── 2. nginx, serving the challenge path ─────────────────────────────────────
log "Starting nginx"
compose up -d nginx

# Waited for rather than slept on: a fixed sleep is either too short on a slow
# host or wasted time on a fast one, and this is the step whose failure mode is
# "certbot cannot reach the challenge".
for _ in $(seq 1 30); do
    if compose exec -T nginx wget --quiet --tries=1 --spider http://127.0.0.1/nginx-health; then
        ok "nginx is answering"
        break
    fi
    sleep 2
done

# ── 3. The real certificates ─────────────────────────────────────────────────
#
# One certificate per hostname rather than one covering both. They are served by
# different server blocks with different security headers, and separate
# certificates mean a failure to renew one does not take the other down with it.
staging_flag=()
(( STAGING )) && staging_flag=(--staging)
force_flag=()
(( FORCE )) && force_flag=(--force-renewal)

failed=()
for domain in "${DOMAINS[@]}"; do
    log "Requesting a certificate for ${domain}"

    # certbot refuses outright — "live directory exists for <domain>" — when
    # `live/<domain>` is present but is not one of its own lineages, and the
    # placeholder from step 1 is exactly that: three regular files with nothing in
    # `archive/` behind them. So the placeholder has to be cleared *before* the
    # request; certbot will not overwrite it and does not offer a flag that says
    # otherwise.
    #
    # nginx read the placeholder into memory when it started and does not look at
    # the files again until the reload in step 4, so it keeps serving TLS across
    # the gap where these paths do not exist.
    if ! is_real_lineage "$domain"; then
        compose --profile certbot run --rm --entrypoint sh certbot -c "
            rm -rf /etc/letsencrypt/live/${domain} \
                   /etc/letsencrypt/archive/${domain} \
                   /etc/letsencrypt/renewal/${domain}.conf
        " > /dev/null
    fi

    # `--cert-name` pins the directory to the bare hostname. Without it certbot
    # appends `-0001` when a certificate already exists under that name — and the
    # nginx config points at the un-suffixed path, so the renewal would succeed
    # and nginx would go on serving the placeholder for another ninety days.
    if compose --profile certbot run --rm certbot certonly \
        --webroot --webroot-path=/var/www/html \
        --cert-name "$domain" \
        -d "$domain" \
        --email "$EMAIL" \
        --agree-tos --no-eff-email \
        --non-interactive \
        --keep-until-expiring \
        "${staging_flag[@]}" "${force_flag[@]}"; then
        ok "${domain}: issued"
    else
        err "${domain}: certbot failed"
        failed+=("$domain")

        # The placeholder was cleared moments ago, so without this the files the
        # site config names would not exist at all. nginx survives on what it holds
        # in memory, but would refuse to start on the next reboot — turning one
        # failed certificate into a failed boot, discovered much later. Putting the
        # placeholder back keeps "nginx can always start" true no matter how this
        # script exits.
        is_real_lineage "$domain" || write_placeholder "$domain"
    fi
done

# ── 4. Serve them ────────────────────────────────────────────────────────────
log "Reloading nginx"
compose exec -T nginx nginx -s reload

if (( ${#failed[@]} > 0 )); then
    echo
    err "Failed for: ${failed[*]}"
    cat >&2 <<'HINT'

  The three things that cause this, in the order they actually happen:

    1. DNS does not point here yet. Check with:  dig +short app.paayatam.online
       It must be this server's public address, with no Cloudflare proxy in
       front (the deployment is DNS-only by decision).
    2. Port 80 is closed. Check with:  sudo ufw status
       Let's Encrypt validates over plain HTTP; 443 alone is not enough.
    3. Quota. Five failed validations per hostname per hour. If you have been
       retrying, wait an hour and rehearse with --staging next time.
HINT
    notify error 'TLS issuance failed' "domains: ${failed[*]}"
    exit 1
fi

echo
ok "Certificates are in place. certbot-renew keeps them valid from here."
log "Start the rest of the stack with: scripts/deploy.sh"
