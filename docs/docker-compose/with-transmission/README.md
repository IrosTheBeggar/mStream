# mStream + Transmission recipe

mStream alongside a Transmission daemon, with completed downloads served straight back into the mStream library.

## Why Transmission

mStream also supports qBittorrent and Deluge. Transmission is the recommended backend:

- **Verified path auto-detection.** Transmission's `free-space` RPC lets mStream probe candidate paths and confirm the daemon actually sees them, even on an empty daemon. qBittorrent and Deluge have no equivalent — they fall back to content-matching (needs an existing torrent overlapping the library) and then prefix guessing.
- **Smallest resource footprint** of the three — noticeable on NAS/SBC hardware.
- **Simplest RPC** — stable protocol, single auth model (Basic + CSRF). qBittorrent's cookie-session WebAPI has more moving parts; Deluge's WebUI JSON-RPC is single-user by design.

The path-mapping shape in `compose.yml` carries over to the other two clients; only the daemon service and whitelist handling change.

## Setup

```bash
cp -r docs/docker-compose/with-transmission ~/mstream-torrents
cd ~/mstream-torrents
cp .env.example .env
# edit .env: rotate TRANSMISSION_PASS to something real
mkdir downloads mstream-config transmission-config
docker compose up -d
```

## Connecting mStream to Transmission

Credentials are entered in the admin UI rather than a config file — the same flow probes the daemon for its download paths:

1. Open `http://localhost:3000`, log in as admin.
2. Admin → Torrents → **Client: Transmission**.
3. Connection form: host `transmission` (the compose service name), port `9091`, username/password from `.env`, RPC path `/transmission/rpc`, HTTPS off.
4. Save. If mStream reports `/downloads/...` with a "verified" badge, the mapping is wired up — everything torrented from here on becomes browsable in the library.

## The WHITELIST env vars

A fresh Transmission whitelists only `127.0.0.1,::1` and rejects unknown Host headers (its DNS-rebinding guard). mStream calls RPC from another container — a private-range Docker IP, with Host header `transmission` — so both defaults would `403` it. The recipe sets:

- `WHITELIST=127.0.0.1,10.*.*.*,172.*.*.*,192.168.*.*` — widens the IP whitelist to private ranges only.
- `HOST_WHITELIST=transmission` — allows the service-name Host header. Update it if you rename the service.

`USER`/`PASS` auth is the real security boundary; the whitelist is defense-in-depth.

## Layout

| Path on host | Mount in transmission | Mount in mstream | Why |
|---|---|---|---|
| `./downloads/` | `/downloads` (rw) | `/music` (ro) | Daemon writes, mStream reads. The `/downloads/X → /music/X` mapping is auto-detected. |
| `./transmission-config/` | `/config` | — | Transmission's config tree (settings.json, resume files) |
| `./mstream-config/` | — | `/config` | mStream's config tree (DB, album art, logs) |

`PUID`/`PGID` are `1000` in both services so mStream can read what Transmission writes. Match them to the owner of your host dirs (`id -u` / `id -g`).

## Exposed ports

| Port | Service | Bound to | Notes |
|---|---|---|---|
| 3000 | mStream WebUI | `0.0.0.0` | |
| 9091 | Transmission WebUI | `127.0.0.1` | Loopback-only while the placeholder password stands |
| 51413 (tcp+udp) | Transmission peer | `0.0.0.0` | Must be internet-reachable for peering |

## Adding torrents

- **mStream's admin UI** — Admin → Torrents has an "Add torrent" panel.
- **Transmission's WebUI** at `http://localhost:9091`.
- **Watch dir** — drop `.torrent` files into `./transmission-config/watch/` (enabled by default in the linuxserver image).

All three land in `./downloads/` and show up in the library on the next scan.

## Gotchas

- **Rotate `PASS=changeme`.** The WebUI is bound to `127.0.0.1` because of the placeholder password. After rotating it, drop the `127.0.0.1:` prefix in `compose.yml` if you want the WebUI on the LAN.
- **Peer port 51413** must be reachable from the internet — port-forward behind NAT. Behind CGNAT, downloads stall; that's peer discovery, not mStream.
- **Completed torrents appear on mStream's next scan** (`scanOptions.scanInterval`, default 24h). Kick off a manual rescan from the admin UI when testing.
- **Streaming-only.** Stack with [`with-mpd/`](../with-mpd/) for server-side audio.
