# mStream + Transmission recipe

mStream alongside a Transmission daemon, with completed downloads served straight back into mStream as a library. Browse + play your torrented music without copying files around.

## Three clients, one recommendation

mStream supports three torrent backends — **Transmission**, **qBittorrent**, and **Deluge**. This recipe uses Transmission, which is what we recommend for new setups:

- **Path auto-detection is verified, not inferred.** Transmission exposes a `free-space` RPC call that mStream uses to probe candidate paths and confirm the daemon can actually see them — `verified` confidence even on an empty daemon. qBittorrent and Deluge have no equivalent: both fall back to a content-match probe (verified, but only if at least one existing torrent's content lines up with mStream's library) then known-paths prefix matching (`inferred` — usually correct, but a guess rather than a check).
- **Smallest resource footprint** of the three, especially noticeable on low-end NAS / SBC deployments.
- **Stable, well-documented RPC protocol** with a single auth model (Basic + CSRF). qBittorrent's session-cookie WebAPI v2 has more moving parts; Deluge's WebUI JSON-RPC is single-user-by-design.

If you'd rather use qBittorrent or Deluge, the path-mapping shape in `compose.yml` carries over — only the daemon service definition and the RPC-whitelist handling change.

## Setup

```bash
cp -r docs/docker-compose/with-transmission ~/mstream-torrents
cd ~/mstream-torrents
cp .env.example .env
# edit .env: rotate TRANSMISSION_PASS to something real
mkdir downloads mstream-config transmission-config
docker compose up -d
```

First boot pulls both images, populates the linuxserver wrappers' `/config` dirs, and brings everything up. Watch with `docker compose logs -f`.

## Connecting mStream to Transmission

mStream needs the Transmission credentials to talk RPC. They're set in the admin UI rather than baked into a config file, because the same UI flow probes the daemon for its download paths during setup:

1. Open mStream at `http://localhost:3000`, log in as admin (or create the admin account if this is first boot).
2. Admin → Torrents → set **Client: Transmission**.
3. Fill in the connection form:
   - **Host:** `transmission` (the compose service name — Docker DNS resolves it on the internal network)
   - **Port:** `9091`
   - **Username:** value of `TRANSMISSION_USER` from your `.env`
   - **Password:** value of `TRANSMISSION_PASS`
   - **RPC path:** `/transmission/rpc` (default; the linuxserver image doesn't relocate it)
   - **HTTPS:** off (RPC stays inside the compose network)
4. Save. mStream probes Transmission and reports the detected download path. If you see `/downloads/...` with a "verified" badge, the path mapping is wired up correctly — anything torrented from here on becomes browsable + playable in the mStream library.

## Why the WHITELIST env vars matter

This is the one piece that's easy to get wrong, so the recipe handles it for you. A fresh Transmission daemon ships with `rpc-whitelist-enabled: true` and a whitelist of just `127.0.0.1,::1`, plus a DNS-rebinding guard (`rpc-host-whitelist`). mStream runs in a *separate* container and reaches Transmission across the Docker network, so:

- Its client IP is a Docker-subnet address (something in `172.x` / `10.x` / `192.168.x`), **not** `127.0.0.1` → the default IP whitelist would `403` every RPC call.
- It connects using the Host header `transmission` (a DNS name) → the rebinding guard would reject it.

The `compose.yml` sets two linuxserver env vars to fix both:

- `WHITELIST=127.0.0.1,10.*.*.*,172.*.*.*,192.168.*.*` — widens the IP whitelist to the private ranges Docker uses, while still excluding the public internet.
- `HOST_WHITELIST=transmission` — allows the service-name Host header.

The real security boundary is the `USER` / `PASS` RPC authentication; the IP whitelist is defense-in-depth. If you change the mStream service name, update `HOST_WHITELIST` to match.

## Layout

| Path on host | Mount in transmission | Mount in mstream | Why |
|---|---|---|---|
| `./downloads/` | `/downloads` (rw) | `/music` (ro) | Same host source. Daemon writes, mStream reads. Path mapping `/downloads/X → /music/X` is auto-detected. |
| `./transmission-config/` | `/config` | — | linuxserver-style config tree for Transmission (settings.json, resume files, etc.) |
| `./mstream-config/` | — | `/config` | linuxserver-style config tree for mStream (DB, album art, logs) |

`PUID`/`PGID` are `1000` in both services so files Transmission writes to `./downloads` are readable by mStream. Match them to the owner of your host directories (`id -u` / `id -g`).

## Exposed ports

| Port | Service | Bound to | Notes |
|---|---|---|---|
| 3000 | mStream WebUI | `0.0.0.0` | The thing you actually browse |
| 9091 | Transmission WebUI | `127.0.0.1` | Host-loopback only by default — the recipe ships with a placeholder password; rotate before exposing |
| 51413 (tcp+udp) | Transmission peer | `0.0.0.0` | Must be reachable from the public internet for peering. Port-forward at the router if you're behind NAT |

## Adding torrents

Three entry points after setup:

- **mStream's web UI** has an "Add torrent" panel (Admin → Torrents) that talks to Transmission via mStream's API. New downloads land in the shared `./downloads/` dir and become library-visible.
- **Transmission's own WebUI** at `http://localhost:9091` works the same way — anything added here lands in the same dir and becomes visible to mStream on its next library scan.
- **Drop `.torrent` files** into `./transmission-config/watch/` and Transmission picks them up automatically (linuxserver image enables the watch dir by default).

## Gotchas

- **`PASS=changeme` is a placeholder.** The recipe binds Transmission's WebUI to `127.0.0.1` specifically because the default password isn't safe. Rotate it in `.env`, then optionally drop the `127.0.0.1:` prefix in `compose.yml` if you want the WebUI reachable on the LAN.
- **Peer port 51413** needs to be reachable from the public internet for peering to actually work. If you're behind NAT, port-forward it. Behind CGNAT, downloads will stall — that's a peer-discovery problem, not an mStream problem.
- **Library scans are mStream's, not Transmission's.** When a torrent completes, mStream sees the files on its next scan cycle (`scanOptions.scanInterval` in mStream's config; default 24h). For testing, kick off a manual rescan from the admin UI.
- **No `/dev/snd` here.** This recipe is streaming-only — no server-side audio. Stack with the [`with-mpd/`](../with-mpd/) recipe if you want both.
