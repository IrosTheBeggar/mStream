# mStream + MPD recipe

mStream with server-side audio playback through a sidecar [MPD](https://www.musicpd.org/) daemon: streams to browsers as usual *and* plays out of a sound device attached to the host. Useful for a headless box wired to an amp.

**Linux host only.** Audio passthrough mounts `/dev/snd`, which doesn't exist on Docker Desktop for Windows/macOS.

## How it works

- MPD runs as a sidecar with `/dev/snd` passed through and the `audio` group added, playing to the host's ALSA device.
- Both containers mount the `mpd-socket` volume at `/run/mpd`; MPD listens on a Unix socket there and `MSTREAM_MPD_HOST=/run/mpd/socket` points mStream at it. It must be a Unix socket, not TCP — MPD 0.22+ only honours `file://` playback URIs from local socket clients.
- No config override needed: with `autoBootServerAudio` at its default (`false`), mStream probes `MSTREAM_MPD_HOST` and prefers MPD as its server-audio backend (`src/api/server-playback.js`, `src/api/cli-audio/`).

## Setup

```bash
cp -r docs/docker-compose/with-mpd ~/mstream-mpd
cd ~/mstream-mpd
mkdir config music
# drop some audio into ./music
docker compose up -d
```

Trigger server playback from the mStream UI, then confirm the backend:

```bash
docker compose logs mstream | grep -i "cli-audio\|server-audio\|mpd"
```

`started MPD as fallback audio player` means it connected.

## Gotchas

- **Socket permissions** — the most common failure. mStream (`PUID=1000`) must be able to connect to the socket MPD creates in the shared volume. If the MPD probe logs a permission error, run MPD with the same `PUID`/`PGID` as mStream, or loosen the socket mode in `mpd.conf`.
- **Startup race.** `depends_on` waits for the MPD *container*, not the daemon. If mStream probes before MPD is listening, server audio shows unavailable until you re-trigger detection (Admin → Server Audio) or restart mStream. Self-healing, not permanent.
- **ALSA access is exclusive.** If anything else holds the PCM device, MPD's output fails to open — stop the other consumer or point `mpd.conf` at a different device.
- **`auto_update no` is intentional.** mStream sends absolute `file://` URIs at play time, so MPD never indexes the library and its database stays empty. Browsing happens in mStream.
