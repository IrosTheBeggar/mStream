# Dev-everything recipe

Like [`dev/`](../dev/) but with every server-side audio feature pre-enabled: DLNA, Subsonic, the bundled rust-server-audio binary, and ALSA passthrough. For exercising the full feature surface against live source.

## What's enabled

- **DLNA** — `same-port` mode on port 3000 with directory-style browse layout. SSDP discovery requires multicast, hence `network_mode: host` below.
- **Subsonic API** — `same-port` mode. Reachable at `http://<host>:3000/rest/...` or via any Subsonic client.
- **Rust server-audio binary** — `autoBootServerAudio: true`. mStream spawns `bin/rust-server-audio/rust-server-audio-linux-x64` at startup; the binary's HTTP control plane listens on 3333 internally.
- **ALSA passthrough** — `/dev/snd` mapped, `audio` group added, `libasound2` baked into the image. The rust binary plays through the host's default ALSA device.
- **mpv installed** — `src/api/cli-audio/mpv.js` can take over if the rust binary fails to spawn.

## Constraints

- **Linux host only.** `devices: /dev/snd` doesn't exist on Docker Desktop for Windows/macOS, and `network_mode: host` behaves very differently outside Linux.
- **Public-mode auth.** `users: {}` → no login required. Don't expose this recipe past localhost or a trusted LAN.

## Usage

From the repo root:

    mkdir -p docs/docker-compose/dev-everything/music
    docker compose -f docs/docker-compose/dev-everything/compose.yml up

Drop test tracks into `docs/docker-compose/dev-everything/music/` and trigger a scan from the mStream UI.

## Config persistence

`mstream.json` is bind-mounted RW. On first boot mStream adds two derived fields in place:

- `secret` — base64-encoded JWT signing key.
- `dlna.uuid` — stable renderer identifier across restarts.

To reset state, `docker compose down`, then either `git checkout mstream.json` or delete and restore from this repo.

## Gotchas inherited from `dev/`

- Anonymous `node_modules` volume persists across up/down — after `package.json` changes, `docker compose down -v` to force a clean reinstall.
- `node --watch` reloads on any source change under `/app`, which is the entire bind-mounted repo.
