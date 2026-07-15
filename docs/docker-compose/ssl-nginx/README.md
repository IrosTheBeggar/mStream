# SSL nginx recipe

mStream behind an nginx reverse proxy with a Let's Encrypt wildcard cert, issued and auto-renewed by [acme.sh](https://github.com/acmesh-official/acme.sh) via the Cloudflare DNS-01 challenge.

## What you get

- **mStream** with no published port — reachable only inside the compose network.
- **nginx** (built from `nginx/Dockerfile`) terminating TLS on 443, redirecting 80 → 443, proxying `${MSTREAM_HOSTNAME}` to `mstream:3000`.
- **Wildcard cert** for `${DOMAIN}` and `*.${DOMAIN}` via DNS challenge — no port-80 round-trip, so issuance works even if the host isn't publicly reachable yet.
- **Auto-renewal** via acme.sh's daily cron (rotates within 30 days of expiry, reloads nginx in place).

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

First boot issues the cert; watch with `docker compose logs -f nginx` — usually 30–60 seconds (DNS propagation).

## Failure modes

- **Bad Cloudflare token / wrong zone.** The entrypoint parks the container (`sleep infinity`) instead of exiting — with `restart: always`, exiting would loop issuance attempts into Let's Encrypt and Cloudflare rate limits. Fix `.env`, then `docker compose restart nginx`.
- **Renewal fails.** Inspect with `docker exec mstream-nginx cat /root/.acme.sh/acme.sh.log`. The old cert keeps serving until it actually expires.
- **502 from nginx.** Usually the music bind-mount — mStream exits at boot if `./music` isn't a real directory. Check `docker compose ps`.

## Customization

- **`ACME_EMAIL`** is baked in at image build time — changing it requires `docker compose build`.
- **Cert paths.** acme.sh installs to `/etc/ssl/certs/fullchain.pem` + `/etc/ssl/private/privkey.pem` in the `cert-out` volume; nginx reads the same paths — change one, change both. The volume is the source of truth: `docker compose down -v` forces re-issuance on next boot (mind the LE rate caps if testing repeatedly).
- **More proxied services.** Add `server { listen 443 ssl; ... }` blocks to `nginx/default.conf.template` — the wildcard cert already covers any subdomain.
- **HTTP-01 instead of DNS-01.** Swap `--dns dns_cf` for `--standalone` (or `--webroot`) and expose port 80 to the internet. Out of scope for this recipe.
