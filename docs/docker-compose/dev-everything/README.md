# Dev-everything recipe

Like [`dev/`](../dev/) but with every server-side audio feature pre-enabled: DLNA, Subsonic, the bundled rust-server-audio binary, and ALSA passthrough. For exercising the full feature surface against live source.

## What's enabled

- **DLNA** — `same-port` mode with directory-style browse. SSDP discovery needs multicast, hence `network_mode: host`.
- **Subsonic API** — `same-port` mode; `http://<host>:3000/rest/...` or any Subsonic client.
- **Rust server-audio binary** — `autoBootServerAudio: true`; mStream spawns it at startup, control plane on 3333.
- **ALSA passthrough** — `/dev/snd` mapped, `audio` group added, `libasound2` in the image.
- **mpv** — CLI fallback if the rust binary fails to spawn (`src/api/cli-audio/mpv.js`).

## Constraints

- **Linux host only.** `/dev/snd` doesn't exist on Docker Desktop, and `network_mode: host` doesn't reach the real LAN there either.
- **Public-mode auth.** `users: {}` → no login. Don't expose past localhost or a trusted LAN.

## Usage

From the repo root:

    mkdir -p docs/docker-compose/dev-everything/music
    docker compose -f docs/docker-compose/dev-everything/compose.yml up

Drop test tracks into `docs/docker-compose/dev-everything/music/` and trigger a scan from the mStream UI.

## Config persistence

`mstream.json` is bind-mounted RW; mStream writes `secret` (JWT signing key) and `dlna.uuid` (stable renderer id) into it on first boot. To reset, `docker compose down` then `git checkout mstream.json`.

## Gotchas inherited from `dev/`

- After `package.json` changes, `docker compose down -v` to reset the anonymous `node_modules` volume.
- `node --watch` reloads on any change under the bind-mounted repo, not just `src/`.
