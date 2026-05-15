# SSL nginx recipe

mStream behind an nginx reverse proxy with a Let's Encrypt wildcard cert, issued and auto-renewed by [acme.sh](https://github.com/acmesh-official/acme.sh) using the Cloudflare DNS-01 challenge.

## What you get

- **mStream container** — `lscr.io/linuxserver/mstream`, no published port. Only reachable inside the compose network.
- **nginx container** — built from `nginx/Dockerfile`. Terminates TLS on 443, redirects 80 → 443, and proxies `${MSTREAM_HOSTNAME}` to `mstream:3000` over the internal network.
- **Wildcard cert** for `${DOMAIN}` and `*.${DOMAIN}`, issued via Cloudflare DNS challenge — no port-80 round-trip needed during issuance, so this works even if the host isn't directly reachable from the public internet at issuance time.
- **Auto-renewal** via the cron job acme.sh installs in the container (fires daily; rotates within 30 days of expiry; reloads nginx in place).

## Prerequisites

- A domain managed by Cloudflare DNS.
- A Cloudflare API token with **Zone:Read** + **Zone.DNS:Edit** on the zone, created at <https://dash.cloudflare.com/profile/api-tokens>.
- Ports **80** and **443** reachable on the host.

## Setup

    cp -r docs/docker-compose/ssl-nginx ~/mstream-ssl
    cd ~/mstream-ssl
    cp .env.example .env
    # edit .env: CF_Token, DOMAIN, MSTREAM_HOSTNAME, ACME_EMAIL
    mkdir music mstream-config
    docker compose up -d --build

First boot: nginx container runs `acme.sh --issue` and pulls a fresh cert. Watch with `docker compose logs -f nginx` — should land in 30–60 seconds (DNS propagation).

## Failure modes

- **Bad Cloudflare token / wrong zone.** Entrypoint sees the issuance failure and *parks the container* (`exec sleep infinity`) rather than restart-looping. Without this, `restart: always` would hammer the Let's Encrypt and Cloudflare APIs until you got rate-limited (LE caps validation failures at 5/account/hour; CF locks the account aggressively). Fix `.env`, then `docker compose restart nginx`.
- **Cert renewal fails silently.** acme.sh's cron writes to its own log inside the container; `docker exec mstream-nginx cat /root/.acme.sh/acme.sh.log` to inspect. The previous cert keeps serving traffic until it actually expires.
- **mStream not reachable.** Check `docker compose ps`; if mstream is up but nginx returns 502, the issue is usually the music dir bind-mount (mStream errors out at boot if `./music` doesn't exist as a real directory).

## Customization knobs

- **`ACME_EMAIL` change** requires `docker compose build` — it's baked into the image at acme.sh install time.
- **Different cert paths.** acme.sh writes to `/etc/ssl/certs/fullchain.pem` and `/etc/ssl/private/privkey.pem` inside the container (the `cert-out` volume). Both nginx and acme.sh agree on these paths — change one, change both.
- **Adding more proxied services.** Add another `server { listen 443 ssl; ... }` block in `nginx/default.conf.template`. The wildcard cert already covers any subdomain under `${DOMAIN}`, so no cert re-issuance is needed.
- **HTTP-01 challenge instead of DNS-01.** Useful if you don't want a Cloudflare API token. Means exposing port 80 to the public internet for the challenge handshake; swap `--dns dns_cf` for `--standalone` (or `--webroot /usr/share/nginx/html` if you want acme.sh to share the running nginx). Out of scope for this recipe.

## Notes for the curious

The `ssl_certificate` paths point at `/etc/ssl/certs/fullchain.pem` and `/etc/ssl/private/privkey.pem` — both inside the `cert-out` named volume. The volume is the source of truth: blow away the volume (`docker compose down -v`) to force re-issuance on next boot. Useful for testing the issuance path; expensive against the Let's Encrypt staging cap if you do it repeatedly.
