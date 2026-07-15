# Docker Compose Cookbook

Drop-in `compose.yml` recipes for running mStream under Docker Compose. Most recipes are self-contained directories you can `cp -r` next to your music library and bring up with `docker compose up -d`. The `dev/` recipe is the exception — it stays in the repo.

## Recipes

- **[default/](default/)** — Streaming-only deployment. Single linuxserver/mstream container, no server-side audio.
- **[with-mpd/](with-mpd/)** — Streaming plus server-side audio playback via a sidecar MPD container. Requires a Linux host with a real audio device; Docker Desktop on Windows/macOS cannot pass `/dev/snd` through. See [with-mpd/README.md](with-mpd/README.md).
- **[with-transmission/](with-transmission/)** — mStream + a Transmission daemon, with completed downloads served back into the library automatically. mStream supports three torrent clients (Transmission, qBittorrent, Deluge) — see [with-transmission/README.md](with-transmission/README.md) for why we recommend Transmission.
- **[ssl-nginx/](ssl-nginx/)** — mStream behind an nginx reverse proxy with a Let's Encrypt wildcard cert, issued and auto-renewed via `acme.sh` + Cloudflare DNS-01. Requires a Cloudflare-managed domain.
- **[dev/](dev/)** — Runs mStream from this repo's source with `node --watch` for hot reload. Used in-place; see [dev/README.md](dev/README.md).
- **[dev-everything/](dev-everything/)** — Like `dev/` but with DLNA, Subsonic, the rust-server-audio binary, and ALSA passthrough all preconfigured. Linux host only; see [dev-everything/README.md](dev-everything/README.md).

For the deployable recipes, edit `PUID`/`PGID`, `TZ`, and the music/config volume paths in each `compose.yml` to match your host before bringing it up. `PUID`/`PGID` should match the owner of the mounted directories (`id -u` / `id -g` on the host).

The recipes track `:latest` for the linuxserver images (their conventional tag — they publish updates frequently). For a reproducible production deploy, pin to a specific image digest or version tag and bump it deliberately.

## LAN discovery (mDNS / DLNA)

mStream advertises itself for zero-config discovery: `_mstream._tcp` over mDNS (how the mStream apps find servers without an IP), and SSDP when DLNA is enabled. Both ride link-local multicast (`224.0.0.251:5353` and `239.255.255.250:1900`), and **multicast does not cross a Docker bridge network** — port publishing only forwards traffic addressed to the host, which multicast never is. As written, every recipe here except `dev-everything/` uses bridge networking, so announcements never leave the bridge, discovery queries from your LAN never reach the container, and the address mStream advertises is its container IP, unreachable from other machines. Streaming is unaffected — clients that know the address connect fine; they just can't *discover* the server. (`dev-everything/` already runs `network_mode: host` for exactly this reason — its DLNA/SSDP needs the same multicast.)

The tell-tale sign in the logs:

```
[mdns] Advertising _mstream._tcp on 172.23.0.3:3000
```

A `172.x` address means the announcements are trapped inside the bridge.

### Option 1 — host networking (recommended)

Put the container on the host's network stack. This fixes mDNS and DLNA in one move, at the cost of the container isolation bridge mode gives you:

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

Caveats:

- **Linux hosts only.** On Docker Desktop (Windows/macOS) the "host" is a hidden VM, so host mode still doesn't reach your real LAN.
- **Container-name DNS stops working.** Recipes with sidecars need their hostnames swapped for published host ports — e.g. `with-transmission/` sets mStream's torrent host to `transmission`, which becomes `localhost` (port 9091) under host networking.
- mStream binds its ports (3000 by default) directly on the host, so collisions with other services are yours to manage.

### Option 2 — keep bridge networking, advertise from the host

An mDNS announcement is just metadata; nothing requires the mStream process to send it. If the host runs Avahi (most desktop Linux does; `apt install avahi-daemon` otherwise), a static service file makes the *host* advertise the service while your existing port mapping carries the traffic:

```xml
<!-- /etc/avahi/services/mstream.service -->
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

Avahi picks the file up automatically — no restart needed. Set the `id=` record to the `discovery.mdns.instanceId` value mStream persisted into your `config.json` on first boot, so clients recognize it as the same server across IP changes.

Caveats: this covers mDNS only (DLNA/SSDP still needs host networking), and the records are static — they won't reflect config changes like a custom server name unless you edit the file. Optionally set `"discovery": { "mdns": { "enabled": false } }` in `config.json` to silence the container's own (unreachable) announcements.
