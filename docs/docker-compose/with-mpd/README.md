# mStream + MPD recipe

mStream with server-side audio playback through a sidecar [MPD](https://www.musicpd.org/) daemon. mStream streams to browsers as usual *and* can play out of a sound device physically attached to the host — useful for a headless box wired to an amp.

**Linux host only.** Audio passthrough mounts `/dev/snd`, which doesn't exist on Docker Desktop for Windows/macOS (containers run inside a VM with no host sound device).

## How it works

- MPD runs as a sidecar with `/dev/snd` passed through and the `audio` group added, playing to the host's ALSA device.
- mStream and MPD share a named volume (`mpd-socket`) mounted at `/run/mpd` in both containers. MPD listens on a Unix socket there; mStream connects to it.
- `MSTREAM_MPD_HOST=/run/mpd/socket` tells mStream where the socket is. A Unix socket (not TCP) is required because MPD 0.22+ only honours `file://` playback URIs from local socket clients.
- **No config override is needed to make mStream prefer MPD.** With `autoBootServerAudio` at its default (`false`), mStream deliberately prefers MPD as its server-audio backend — it detects the daemon by probing `MSTREAM_MPD_HOST` and boots it automatically. (See `src/api/server-playback.js` and `src/api/cli-audio/`.)

## Setup

```bash
cp -r docs/docker-compose/with-mpd ~/mstream-mpd
cd ~/mstream-mpd
mkdir config music
# drop some audio into ./music
docker compose up -d
```

Then trigger server playback from the mStream UI. Confirm the backend came up with:

```bash
docker compose logs mstream | grep -i "cli-audio\|server-audio\|mpd"
```

A line like `started MPD as fallback audio player` means it connected.

## Gotchas

- **Socket permissions across containers.** MPD creates the socket in the shared volume; mStream (running as `PUID=1000`) has to be able to connect to it. If logs show the MPD probe failing with a permission error, the socket's owner/mode doesn't line up with mStream's UID. The simplest fix is to run MPD with the same `PUID`/`PGID` as mStream so the socket is owned consistently, or set MPD's socket permissions permissively in `mpd.conf`. This is the most common failure mode for this recipe — check it first if server audio never appears.
- **Startup race.** `depends_on` only waits for the MPD *container* to start, not for MPD to be *listening*. If mStream probes the socket before MPD is ready, server audio shows unavailable until the next probe — re-trigger detection from Admin → Server Audio (or just restart mStream) once MPD is up. It self-heals; it isn't a permanent failure.
- **One process owns the sound device.** ALSA gives exclusive access to a PCM device. If something else on the host (or another container) holds `/dev/snd`, MPD's output will fail to open. Stop the other consumer or point MPD at a different ALSA device in `mpd.conf`.
- **`auto_update no` is intentional.** mStream feeds MPD absolute `file://` URIs at play time, so MPD doesn't index the library itself — its own database stays empty by design. Your library browsing happens in mStream, not MPD.
