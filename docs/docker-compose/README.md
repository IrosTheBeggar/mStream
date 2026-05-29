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
