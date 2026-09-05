ffmpeg + ffprobe are downloaded on first boot (unless
`transcode.ffmpegDirectory` points somewhere else), verified against the
**pinned manifest committed here** (`manifest.json`): per-platform
`{file/path, sha256, size}` from a dated BtbN autobuild release
(Linux/Windows) and versioned ffmpeg.martin-riedl.de paths (macOS). A
download that doesn't hash to its pin is deleted and refused.

Updating the pins is a small text PR:

    node scripts/update-ffmpeg-manifest.mjs [autobuild-YYYY-MM-DD-HH-MM]

(no argument = the final BtbN autobuild of the last completed month; the
rolling `latest` tag is refused — pins exist so Windows users keep a stable
binary hash that can accrue SmartScreen / Smart App Control reputation, and
so the build we ship is a reviewed choice, not whatever upstream published
that week). Why month-end builds: BtbN's prune (`util/prunetags.sh`) keeps
only the 14 newest dailies plus each month's last build for 24 months, so a
daily pin 404s for fresh installs about two weeks after it is committed —
the 2026-08-19 pin died on 2026-09-02 — while a month-end pin outlives any
mStream release. The monthly workflow (`update-ffmpeg-manifest.yml`, the 3rd
of each month) pins the previous month's final build; a hand-picked daily
tag is accepted with a warning.

If a pinned BtbN asset has been pruned anyway (an old mStream build being
installed fresh), the bootstrap falls back to the same-platform stable-branch
build from BtbN's rolling `latest` release (`ffmpeg-n9.0-latest-…`, or the
master snapshot if no branch build is listed), verified against that
release's `checksums.sha256` — an integrity check, not a reviewed pin, and
logged as a warning. The receipt marks such an install as a fallback, so the
next manifest with a live pin converges it back onto a reviewed build.
macOS pins (martin-riedl versioned paths) are not pruned and have no
fallback.

Installs made by mStream record a `.fetched.json` receipt and are refreshed
when the committed pins change (checked locally — no network polling). Set
`transcode.autoUpdate: false` to freeze the current build even across pin
changes. Binaries you place in a custom `ffmpegDirectory` yourself are never
touched — mStream only updates builds it installed itself.

Air-gapped hosts: `MSTREAM_FFMPEG_MIRROR` replaces the download base with a
flat namespace (the BtbN archive under its pinned file name; the macOS
binaries as `ffmpeg.zip` / `ffprobe.zip`; the pruned-pin fallback under
`latest/checksums.sha256` + `latest/<asset name>`). The sha256 pins are
enforced regardless of the source.
