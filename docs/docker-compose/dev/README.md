# Dev recipe

Runs mStream from this repo's source with Node's built-in `--watch` for hot reload. Unlike the other recipes, this one is **tied to its position inside the repo** — `compose.yml` uses `../../..` to reach the repo root, so don't copy this directory elsewhere.

## Usage

From anywhere in the repo:

    docker compose -f docs/docker-compose/dev/compose.yml up

Edit any file under `src/` and `node --watch` restarts the process within a second.

## Config

mStream reads `save/conf/default.json` at the repo root by default (see `cli-boot-wrapper.js`). That file is inside the bind-mounted source tree, so edits are picked up without rebuilding the container. To point at a different file:

    docker compose -f docs/docker-compose/dev/compose.yml run --rm \
      mstream node --watch cli-boot-wrapper.js -j /app/path/to/your.json

## Gotchas

- **No audio support baked in.** No `libasound2`, no `/dev/snd` passthrough. For dev work that needs server-side audio, either layer `apt-get install libasound2 mpv` into a child Dockerfile, or run the `with-mpd/` recipe in parallel and point this dev container at its MPD socket via `MSTREAM_MPD_HOST`.
- **No `/music` mount.** Mount your library by adding a volume to `compose.yml` and pointing `save/conf/default.json` at the in-container path.
- **Bumping deps requires resetting `node_modules`.** The anonymous volume persists across `docker compose up`/`down`; after a `package.json` change run `docker compose -f docs/docker-compose/dev/compose.yml down -v` so the next boot reinstalls cleanly.
- **`node --watch` over a bind mount from Windows/macOS** can occasionally miss events (the host's filesystem-change events have to traverse the Docker Desktop VM). If a save doesn't trigger a restart, touching the file again usually does.
