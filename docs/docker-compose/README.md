# Docker Compose Cookbook

Drop-in `compose.yml` recipes for running mStream under Docker Compose. Most are self-contained directories you can `cp -r` next to your music library and bring up with `docker compose up -d`. The `dev/` recipes are the exception — they stay in the repo.

## Recipes

- **[default/](default/)** — Streaming-only. Single linuxserver/mstream container.
- **[with-mpd/](with-mpd/)** — Adds server-side audio playback via a sidecar MPD container. Linux host with a real audio device; see [with-mpd/README.md](with-mpd/README.md).
- **[with-transmission/](with-transmission/)** — mStream + a Transmission daemon, with completed downloads served back into the library. See [with-transmission/README.md](with-transmission/README.md) for why Transmission over qBittorrent/Deluge.
- **[ssl-nginx/](ssl-nginx/)** — nginx reverse proxy with a Let's Encrypt wildcard cert, auto-renewed via `acme.sh` + Cloudflare DNS-01. Requires a Cloudflare-managed domain.
- **[dev/](dev/)** — Runs mStream from this repo's source with `node --watch` hot reload. See [dev/README.md](dev/README.md).
- **[dev-everything/](dev-everything/)** — `dev/` plus DLNA, Subsonic, rust-server-audio, and ALSA passthrough. Linux only; see [dev-everything/README.md](dev-everything/README.md).

Before bringing a recipe up, set `PUID`/`PGID` (owner of the mounted dirs — `id -u` / `id -g` on the host), `TZ`, and the volume paths in `compose.yml`.

Recipes track `:latest` for the linuxserver images (their conventional tag). Pin a digest or version tag for reproducible production deploys.

## LAN discovery (mDNS / DLNA)

mStream advertises itself over mDNS (`_mstream._tcp` — how the mStream apps find servers without an IP) and over SSDP when DLNA is enabled. Both use link-local multicast, which **does not cross a Docker bridge network** — port publishing only forwards traffic addressed to the host. So under bridge networking (every recipe here except `dev-everything/`), announcements never reach the LAN, queries never reach the container, and the advertised address is the container's own unreachable IP. Streaming is unaffected; clients just can't *discover* the server. The tell-tale log line:

```
[mdns] Advertising _mstream._tcp on 172.23.0.3:3000
```

A `172.x` address means the announcements are stuck inside the bridge.

### Option 1 — host networking (recommended)

Fixes mDNS and DLNA in one move:

```yaml
services:
  mstream:
    image: lscr.io/linuxserver/mstream:latest
    network_mode: host   # replaces the `ports:` mapping entirely
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    volumes:
      - ./config:/config
      - ./music:/music:ro
    restart: unless-stopped
```

Caveats: Linux hosts only (Docker Desktop's "host" is a hidden VM, not your LAN); container-name DNS stops working, so sidecar hostnames become published host ports (`with-transmission/`'s `transmission` → `localhost:9091`); and mStream's ports bind directly on the host, so collisions are yours to manage.

### Option 2 — bridge networking + host-side Avahi

Covers mDNS only (DLNA/SSDP still needs host mode). The announcement is just metadata — let the host's Avahi (`apt install avahi-daemon`) send it while the published port carries the traffic. Drop this into `/etc/avahi/services/mstream.service`; Avahi picks it up automatically:

```xml
<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service>
    <type>_mstream._tcp</type>
    <port>3000</port>
    <txt-record>name=%h</txt-record>
    <txt-record>id=REPLACE-WITH-discovery.mdns.instanceId-FROM-config.json</txt-record>
    <txt-record>scheme=http</txt-record>
    <txt-record>port=3000</txt-record>
    <txt-record>path=/</txt-record>
    <txt-record>api=v1</txt-record>
    <txt-record>auth=apikey,jwt</txt-record>
  </service>
</service-group>
```

Set `id=` to the `discovery.mdns.instanceId` mStream wrote into `config.json` on first boot, so clients recognize the server across IP changes. The records are static — they won't track config changes like a custom server name. Optionally set `"discovery": { "mdns": { "enabled": false } }` in `config.json` to silence the container's own unreachable announcements.
