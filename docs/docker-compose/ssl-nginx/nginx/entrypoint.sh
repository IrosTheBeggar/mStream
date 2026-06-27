#!/bin/bash
set -e
ACME=/root/.acme.sh/acme.sh

: "${DOMAIN:?DOMAIN env var required (e.g. example.com)}"
: "${MSTREAM_HOSTNAME:?MSTREAM_HOSTNAME env var required (e.g. music.example.com)}"
: "${CF_Token:?CF_Token env var required (Cloudflare API token, Zone:Read + Zone.DNS:Edit)}"
export CF_Token

# Render the nginx config from the template
sed -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__MSTREAM_HOSTNAME__|${MSTREAM_HOSTNAME}|g" \
    /etc/nginx/conf.d/default.conf.template \
    > /etc/nginx/conf.d/default.conf

# Issue cert on first boot. Subsequent boots find the cert in the cert-out
# volume and skip — renewals are driven by the cron job acme.sh installs at
# install time (fires daily, only rotates within 30 days of expiry).
if [ ! -s /etc/ssl/certs/fullchain.pem ]; then
  # If issuance fails (bad token, DNS misconfig) DO NOT exit — `restart:
  # always` would loop us against Cloudflare + LE rate limits. Park instead
  # so the container stays up but inert. To retry: fix .env, then
  # `docker compose restart nginx`.
  if ! "$ACME" --issue --dns dns_cf \
       -d "*.${DOMAIN}" -d "${DOMAIN}" --keylength ec-256; then
    echo "[entrypoint] acme.sh --issue failed."
    echo "[entrypoint] Fix credentials in .env, then: docker compose restart nginx"
    echo "[entrypoint] Parking to avoid hammering Cloudflare + LE rate limits."
    exec sleep infinity
  fi

  install -d -m 0755 /etc/ssl/certs /etc/ssl/private
  # reloadcmd is recorded by acme.sh and reused by the daily renewal cron.
  # The PID guard makes first-boot install a no-op (nginx not running yet);
  # the `exec nginx` below picks up the freshly-installed cert. On renewals
  # nginx is already running, the guard passes, reload fires normally.
  "$ACME" --install-cert -d "*.${DOMAIN}" --ecc \
    --key-file       /etc/ssl/private/privkey.pem \
    --fullchain-file /etc/ssl/certs/fullchain.pem \
    --reloadcmd      "[ -f /run/nginx.pid ] && nginx -s reload || true"
fi

# Register a notify hook with acme.sh if configured in .env. Idempotent:
# --set-notify just rewrites the relevant lines in account.conf each call,
# so this handles both first boot and later credential rotations. `|| true`
# guards against a misconfigured hook taking nginx down — a broken notify
# channel shouldn't break TLS termination.
if [ -n "${ACME_NOTIFY_HOOK:-}" ]; then
  "$ACME" --set-notify \
    --notify-hook "${ACME_NOTIFY_HOOK}" \
    --notify-level "${ACME_NOTIFY_LEVEL:-2}" \
    || true
fi

# Renewal check on every startup, not just the daily cron — covers the case
# where the container restarts at a time that misses cron's window (host
# reboots, image updates, etc.). Idempotent: --cron only acts on certs
# within 30 days of expiry, no-ops otherwise. `|| true` keeps a transient
# API failure from taking nginx down; the existing cert serves until
# actual expiry.
"$ACME" --cron --home /root/.acme.sh || true

service cron start
exec "$@"
