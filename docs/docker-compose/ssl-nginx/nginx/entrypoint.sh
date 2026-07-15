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

# Issue on first boot only — the cert-out volume persists the cert and
# acme.sh's daily cron handles renewals.
if [ ! -s /etc/ssl/certs/fullchain.pem ]; then
  # Park instead of exiting on failure: with `restart: always`, exiting
  # would loop issuance attempts into Cloudflare + LE rate limits.
  # To retry: fix .env, then `docker compose restart nginx`.
  if ! "$ACME" --issue --dns dns_cf \
       -d "*.${DOMAIN}" -d "${DOMAIN}" --keylength ec-256; then
    echo "[entrypoint] acme.sh --issue failed."
    echo "[entrypoint] Fix credentials in .env, then: docker compose restart nginx"
    echo "[entrypoint] Parking to avoid hammering Cloudflare + LE rate limits."
    exec sleep infinity
  fi

  install -d -m 0755 /etc/ssl/certs /etc/ssl/private
  # acme.sh records reloadcmd and reuses it on cron renewals. The PID guard
  # no-ops on first boot (nginx isn't running yet; `exec nginx` below picks
  # up the fresh cert) and reloads normally on renewals.
  "$ACME" --install-cert -d "*.${DOMAIN}" --ecc \
    --key-file       /etc/ssl/private/privkey.pem \
    --fullchain-file /etc/ssl/certs/fullchain.pem \
    --reloadcmd      "[ -f /run/nginx.pid ] && nginx -s reload || true"
fi

# Optional renewal notifications. Idempotent — --set-notify rewrites
# account.conf each call. `|| true`: a broken notify channel must not
# take TLS termination down.
if [ -n "${ACME_NOTIFY_HOOK:-}" ]; then
  "$ACME" --set-notify \
    --notify-hook "${ACME_NOTIFY_HOOK}" \
    --notify-level "${ACME_NOTIFY_LEVEL:-2}" \
    || true
fi

# Startup renewal check, covering restarts that miss cron's window.
# --cron no-ops unless a cert is within 30 days of expiry; `|| true` keeps
# a transient API failure from killing nginx.
"$ACME" --cron --home /root/.acme.sh || true

service cron start
exec "$@"
