ffmpeg + ffprobe are downloaded on first boot (unless
`transcode.ffmpegDirectory` points somewhere else), verified against the
**pinned manifest committed here** (`manifest.json`): per-platform
`{file/path, sha256, size}` from a dated BtbN autobuild release
(Linux/Windows) and versioned ffmpeg.martin-riedl.de paths (macOS). A
download that doesn't hash to its pin is deleted and refused.

Updating the pins is a small text PR:

    node scripts/update-ffmpeg-manifest.mjs [autobuild-YYYY-MM-DD-HH-MM]

(no argument = newest dated BtbN autobuild; the rolling `latest` tag is
refused — pins exist so Windows users keep a stable binary hash that can
accrue SmartScreen / Smart App Control reputation, and so the build we ship
is a reviewed choice, not whatever upstream published that week). Run it a
few times a year: BtbN retains dated releases in bulk but not forever, and a
pruned tag would 404 for fresh installs.

Installs made by mStream record a `.fetched.json` receipt and are refreshed
when the committed pins change (checked locally — no network polling). Set
`transcode.autoUpdate: false` to freeze the current build even across pin
changes. Binaries you place in a custom `ffmpegDirectory` yourself are never
touched — mStream only updates builds it installed itself.

Air-gapped hosts: `MSTREAM_FFMPEG_MIRROR` replaces the download base with a
flat namespace (the BtbN archive under its pinned file name; the macOS
binaries as `ffmpeg.zip` / `ffprobe.zip`). The sha256 pins are enforced
regardless of the source.
