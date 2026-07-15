# Dev recipe

Runs mStream from this repo's source with Node's built-in `--watch` for hot reload. Unlike the other recipes, this one is **tied to its position inside the repo** — `compose.yml` uses `../../..` to reach the repo root, so don't copy this directory elsewhere.

## Usage

From anywhere in the repo:

    docker compose -f docs/docker-compose/dev/compose.yml up

Edit any file under `src/` and `node --watch` restarts the process within a second.

## Config

mStream reads `save/conf/default.json` at the repo root by default (see `cli-boot-wrapper.js`). It's inside the bind-mounted source tree, so edits apply without a rebuild. To use a different file:

    docker compose -f docs/docker-compose/dev/compose.yml run --rm \
      mstream node --watch cli-boot-wrapper.js -j /app/path/to/your.json

## Gotchas

- **No audio support.** No `libasound2`, no `/dev/snd`. For server-side audio, layer the packages into a child Dockerfile, or run `with-mpd/` alongside and point this container at its MPD socket via `MSTREAM_MPD_HOST`.
- **No `/music` mount.** Add a volume to `compose.yml` and point `save/conf/default.json` at the in-container path.
- **After changing `package.json`**, run `docker compose -f docs/docker-compose/dev/compose.yml down -v` — the anonymous `node_modules` volume persists across up/down, and `-v` forces a clean reinstall.
- **`node --watch` over a bind mount from Windows/macOS** can miss change events (they cross the Docker Desktop VM). If a save doesn't trigger a restart, save again.
