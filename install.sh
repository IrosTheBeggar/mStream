#!/bin/sh
# Installs mStream on Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
#
# Picks the release bundle for this machine, checks its sha256 against the
# release's manifest.json, extracts it into a versioned folder, and points a
# `current` link + a `mstream-server` command at it. Configuration, all
# optional, via environment variables (the pipe-to-sh form takes no args):
#
#   MSTREAM_VERSION       a tag like v6.20.0 (default: latest)
#   MSTREAM_INSTALL_DIR   root for the app folders (default: per-OS user data
#                         home, next to where the server keeps its own data)
#   MSTREAM_BIN_DIR       where the `mstream-server` command goes
#                         (default: ~/.local/bin)
#   MSTREAM_NO_DESKTOP    set to 1 to skip the app-menu entry (Linux) /
#                         ~/Applications link (macOS)
#   MSTREAM_RELEASE_BASE  URL serving manifest.json + the zips (default: the
#                         GitHub release) - for internal mirrors and testing
#   MSTREAM_KEY           force a bundle key (linux-x64, linux-x64-musl,
#                         linux-arm64, linux-arm64-musl, darwin-x64,
#                         darwin-arm64) when auto-detection gets it wrong
#   MSTREAM_FORCE         set to 1 to replace an already-installed copy of
#                         the same version (the old one is moved aside)
#
# The bundle is a folder, not one binary: mstream-server + webapp/ + bin/
# sidecars, plus the desktop launcher (mstream-desktop / mStream.app) on the
# targets that ship one. Data (config, db, caches) lives OUTSIDE the install
# folder in the server's data home, so re-running this to upgrade never
# touches your library.
#
# POSIX sh on purpose: NAS boxes and minimal images do not all carry bash.
set -eu

REPO="IrosTheBeggar/mStream"
VERSION="${MSTREAM_VERSION:-latest}"
BIN_DIR="${MSTREAM_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *)
        echo "unsupported OS: $os - on Windows, use install.ps1" >&2
        exit 1
        ;;
esac

# Linux: glibc or musl? The glibc bundles cannot exec on Alpine/musl; the
# static musl bundles run anywhere but ship no desktop launcher and no
# server-audio sidecar, so they are only picked when they are the ones that
# will actually run. Decide POSITIVELY for glibc first: a glibc box that has
# the `musl` package installed (musl-tools for Rust/Go cross builds, Arch's
# musl) carries /lib/ld-musl-*.so.1 too, and picking musl there installs a
# server-only bundle whose libstdc++ the musl loader can't even find.
libc=""
if [ "$platform" = linux ]; then
    if [ -e /lib64/ld-linux-x86-64.so.2 ] || [ -e /lib/ld-linux-aarch64.so.1 ] \
        || ldd --version 2>&1 | grep -qiE 'glibc|GNU libc'; then
        libc=""
    elif ldd --version 2>&1 | grep -qi musl \
        || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
        libc="-musl"
    fi
fi

# 64-bit kernel, 32-bit userland: uname -m says aarch64 on a Pi 4/400/CM4
# running 32-bit Raspberry Pi OS (the default kernel there is 64-bit), but
# no 64-bit binary can run. Ask the userland, not the kernel.
if [ "$platform" = linux ] && [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then
    arch="32bit-userland"
fi

case "$platform-$arch" in
    darwin-x86_64) key="darwin-x64" ;;
    darwin-arm64) key="darwin-arm64" ;;
    linux-x86_64 | linux-amd64) key="linux-x64$libc" ;;
    linux-aarch64 | linux-arm64) key="linux-arm64$libc" ;;
    linux-armv7l | linux-armv6l | linux-32bit-userland)
        echo "no 32-bit build - mStream needs a 64-bit OS (on a Pi: the 64-bit Raspberry Pi OS image), or run from source with Node" >&2
        exit 1
        ;;
    *)
        echo "no prebuilt bundle for $os/$arch - run from source: https://github.com/$REPO/blob/master/docs/install.md" >&2
        exit 1
        ;;
esac
# Escape hatch for exotic setups: name the bundle key yourself.
key="${MSTREAM_KEY:-$key}"

# Where the app folders live: beside the server's own data home so one
# `du` shows all of mStream, and so a future in-app updater and this script
# agree on the layout ($ROOT/<bundle>/ + $ROOT/current -> <bundle>).
if [ -n "${MSTREAM_INSTALL_DIR:-}" ]; then
    ROOT="$MSTREAM_INSTALL_DIR"
elif [ "$platform" = darwin ]; then
    ROOT="$HOME/Library/Application Support/mStream/app"
else
    ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/mstream/app"
fi
# Both dirs become symlink TARGETS below; a relative value would be stored
# literally and dangle from wherever the link lives. Canonicalize.
mkdir -p "$ROOT" "$BIN_DIR"
ROOT=$(cd "$ROOT" && pwd -P)
BIN_DIR=$(cd "$BIN_DIR" && pwd -P)

if [ -n "${MSTREAM_RELEASE_BASE:-}" ]; then
    base="${MSTREAM_RELEASE_BASE%/}"
elif [ "$VERSION" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
else
    base="https://github.com/$REPO/releases/download/$VERSION"
fi

# fetch URL DEST: curl or wget, never silent on failure. `wget -q` swallows
# its own "ERROR 404" so a missing asset used to die with no clue; -nv keeps
# errors and drops the progress noise. Callers add the WHY on failure.
fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -nv -O "$2" "$1"
    else
        echo "this installer needs curl or wget" >&2
        exit 1
    fi
}
command -v unzip >/dev/null 2>&1 || {
    echo "this installer needs unzip (debian/ubuntu: sudo apt install unzip; alpine: apk add unzip)" >&2
    exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# The manifest first: it names the exact zip for this version, so the
# script never has to guess the version number embedded in the filename.
echo "fetching manifest ($VERSION)..."
if ! fetch "$base/manifest.json" "$tmp/manifest.json"; then
    echo "could not fetch $base/manifest.json" >&2
    echo "  Releases published before the installer existed have no manifest.json." >&2
    echo "  Pick a newer MSTREAM_VERSION, or download a bundle by hand from" >&2
    echo "  https://github.com/$REPO/releases and see docs/install.md." >&2
    exit 1
fi
version=$(grep -o '"version": *"[^"]*"' "$tmp/manifest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$version" ] || { echo "manifest.json is missing a version - refusing to install" >&2; exit 1; }
# The version becomes a path component below: keep it to what a release
# tag can contain, so a bad manifest can't steer rm/mv anywhere.
case "$version" in
    *[!0-9A-Za-z.-]*|"") echo "manifest.json version '$version' is not a plain version string - refusing" >&2; exit 1 ;;
esac
asset="mStream-$version-$key.zip"

# The hash for this asset, out of the manifest published beside it. No jq
# on a fresh box, so the line is picked apart with the tools sh always has.
expected=$(grep -o "\"file\": *\"$asset\", *\"sha256\": *\"[0-9a-f]*\"" "$tmp/manifest.json" \
    | grep -o '[0-9a-f]\{64\}' || true)
if [ -z "$expected" ]; then
    echo "manifest.json has no entry for $asset - this release has no bundle for $key" >&2
    exit 1
fi

echo "fetching $asset..."
fetch "$base/$asset" "$tmp/$asset" || { echo "download failed: $base/$asset" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
    actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
if [ "$actual" != "$expected" ]; then
    echo "sha256 mismatch for $asset - download corrupted, not installing" >&2
    echo "  expected $expected" >&2
    echo "  got      $actual" >&2
    exit 1
fi

# link TARGET DEST: point DEST at TARGET as a symlink. `ln -sfn` alone is a
# trap here: -n only stops it following an existing SYMLINK; if DEST is a
# real directory, ln happily creates the link INSIDE it (DEST/<basename>)
# and exits 0 - a hand-installed ~/Applications/mStream.app would silently
# keep the old version. So: an existing symlink is replaced; an existing
# real directory is left alone and reported (never delete a user's own
# folder); the result is verified.
link() {
    if [ -e "$2" ] && [ ! -L "$2" ]; then
        echo "  note: $2 exists and is not a link - left alone (remove it and re-run to relink)" >&2
        return 1
    fi
    ln -sfn "$1" "$2" && [ "$(readlink "$2")" = "$1" ]
}

bundle="mStream-$version-$key"
mkdir -p "$ROOT"

# Same version already installed? Leave it ALONE. That folder may be live
# (a running server), and under --portable it holds the user's config and
# database - an unconditional rm -rf here would delete a library to
# "upgrade" it to itself. Re-verify against the manifest so a corrupt or
# tampered copy is still caught, then just re-point the links.
if [ -d "$ROOT/$bundle" ] && [ -z "${MSTREAM_FORCE:-}" ]; then
    echo "mStream $version is already installed at $ROOT/$bundle - keeping it (set MSTREAM_FORCE=1 to replace)"
    installed_fresh=""
else
    # A forced replace of the same version moves the old folder aside
    # (mv, not rm): whatever state it held survives at a findable name.
    if [ -d "$ROOT/$bundle" ]; then
        old="$ROOT/$bundle.replaced-$(date +%Y%m%d%H%M%S)"
        mv "$ROOT/$bundle" "$old"
        echo "  previous copy moved to $old"
    fi
    # Extract beside the final location, then rename into place: a killed
    # install leaves a stray .partial folder, never a half-written `current`.
    rm -rf "$ROOT/$bundle.partial"
    unzip -q "$tmp/$asset" -d "$ROOT/$bundle.partial"
    mv "$ROOT/$bundle.partial/$bundle" "$ROOT/$bundle"
    rmdir "$ROOT/$bundle.partial"
    # Zip mode bits are usually preserved (Info-ZIP records them), but a
    # bundle that went through a mode-stripping hop must still run.
    chmod 755 "$ROOT/$bundle/mstream-server" 2>/dev/null || true
    chmod 755 "$ROOT/$bundle/mstream-desktop" 2>/dev/null || true
    chmod 755 "$ROOT/$bundle/mStream.app/Contents/MacOS/"* 2>/dev/null || true
    chmod 755 "$ROOT/$bundle"/bin/*/* 2>/dev/null || true
    installed_fresh=1
fi

# Which version is running right now, if any? Needed twice below: the
# login item must be re-pointed at the NEW launcher, and the user must be
# told that the running instance stays on the OLD version until they quit
# it - nothing here can (or should) kill their server under them. Detect by
# the launcher's single-instance lock in the data home, then find its exe.
if [ "$platform" = darwin ]; then
    launcher_rel="mStream.app/Contents/MacOS/mStream"; server_rel="mStream.app/Contents/MacOS/mstream-server"
    data_home="$HOME/Library/Application Support/mStream"
else
    launcher_rel="mstream-desktop"; server_rel="mstream-server"
    data_home="${XDG_DATA_HOME:-$HOME/.local/share}/mstream"
fi
running_from=""
if command -v pgrep >/dev/null 2>&1; then
    # -f matches the full command line; the launcher execs from an
    # absolute path under $ROOT (or wherever the user extracted it).
    running_from=$(pgrep -fa "mstream-server|mstream-desktop|MacOS/mStream( |$)" 2>/dev/null \
        | grep -v "$$" | awk '{print $2}' | grep -v "^$ROOT/current/" | head -1 || true)
fi

# `current` -> this version. If a previous manual layout left a REAL
# directory named current, move it aside rather than nest into it.
if [ -e "$ROOT/current" ] && [ ! -L "$ROOT/current" ]; then
    mv "$ROOT/current" "$ROOT/current.was-a-directory-$(date +%Y%m%d%H%M%S)"
fi
link "$ROOT/$bundle" "$ROOT/current"

# The command: a symlink, so `mstream-server` on PATH always means `current`
# and an upgrade is one link flip. Data lives in the server's data home,
# never here.
server="$ROOT/current/$server_rel"
link "$server" "$BIN_DIR/mstream-server" || true

# The launcher registers ITSELF as the login item, by absolute path - which
# is the VERSIONED folder, not `current`. Without this step an upgrade
# never reaches the login item: next boot silently starts the OLD version
# (and once the old folder is deleted, nothing at all, while the tray still
# says "Start at login" is on). --autostart=enable re-registers using the
# new binary's own path; the launcher's CLI face does this with no tray,
# no server, no window. Only when the user has it enabled - never turn it
# on for them here.
launcher="$ROOT/current/$launcher_rel"
if [ -x "$launcher" ] && [ -n "$installed_fresh" ]; then
    if [ "$("$launcher" --autostart=status 2>/dev/null)" = enabled ]; then
        "$launcher" --autostart=enable >/dev/null 2>&1 \
            && echo "  login item re-pointed at $version" \
            || echo "  note: could not re-point the login item - open mStream once to fix it" >&2
    fi
fi

# Desktop integration where a launcher shipped: the app-menu entry (Linux)
# gets the bundle's own .desktop with its %INSTALL_DIR% placeholder filled;
# macOS gets a link in ~/Applications so Spotlight and Launchpad find it.
desktop_note=""
if [ -z "${MSTREAM_NO_DESKTOP:-}" ]; then
    if [ "$platform" = linux ] && [ -f "$ROOT/$bundle/mStream.desktop" ]; then
        apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
        mkdir -p "$apps"
        sed "s|%INSTALL_DIR%|$ROOT/current|g" "$ROOT/$bundle/mStream.desktop" > "$apps/mstream.desktop"
        chmod 644 "$apps/mstream.desktop"
        command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" 2>/dev/null || true
        desktop_note="app menu: mStream (or run: $ROOT/current/mstream-desktop)"
    elif [ "$platform" = darwin ] && [ -d "$ROOT/$bundle/mStream.app" ]; then
        mkdir -p "$HOME/Applications"
        # A REAL mStream.app already there (dragged in by hand) is the
        # user's; link() refuses to touch it and says so.
        if link "$ROOT/current/mStream.app" "$HOME/Applications/mStream.app"; then
            desktop_note="app: ~/Applications/mStream.app (menu-bar icon; Quick Connect on)"
        else
            desktop_note="app: $ROOT/current/mStream.app  (~/Applications/mStream.app is a separate copy - replace it with this one when you're ready)"
        fi
    fi
fi

if [ -n "$installed_fresh" ]; then
    echo "installed mStream $version to $ROOT/$bundle"
fi
[ -n "$desktop_note" ] && echo "  $desktop_note"
# An instance running from somewhere else stays on its own version until
# it is restarted - the script never kills a user's server. Say so, with
# the exact path, instead of letting "installed" imply "upgraded".
if [ -n "$running_from" ]; then
    echo "  NOTE: mStream is currently running from $running_from" >&2
    echo "        it keeps running that version until you Quit it (tray menu) and start" >&2
    echo "        the new one - the app menu / Start Menu entry now points at $version." >&2
fi

# Does the binary actually exec here? `-V` is commander's version print -
# instant, no server boot, no side effects - so it doubles as the proof of
# a working install. Catch a missing runtime library NOW, with the fix,
# instead of at the user's first run. Known case: the musl bundle (Bun's
# musl build) links libstdc++/libgcc dynamically, and a minimal Alpine has
# neither (measured on alpine:3.20 - a wall of "Error relocating" from the
# loader).
if v=$("$server" -V 2>/dev/null) && [ -n "$v" ]; then
    echo "  mstream-server $v runs"
else
    err=$("$server" -V 2>&1 | head -3)
    case "$err" in
        *"libstdc++"*|*"libgcc"*|*"Error relocating"*|*"Error loading shared library"*)
            echo "  NOTE: the server needs the C++ runtime, which this system lacks:" >&2
            if command -v apk >/dev/null 2>&1; then
                echo "        apk add libstdc++ libgcc" >&2
            else
                echo "        install libstdc++ / libgcc via your package manager" >&2
            fi
            ;;
        *)
            echo "  NOTE: the server did not run - see $ROOT/current/README.txt and try: $server" >&2
            ;;
    esac
fi
echo "  headless: mstream-server   (data lives in the mStream data home, not the app folder)"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "  note: $BIN_DIR is not on your PATH" ;;
esac
# Old versions are left in place on purpose (rollback = re-point `current`);
# say so once there is more than one, so they don't accumulate unnoticed.
# The wording matters: a version that is still RUNNING must not be deleted
# (its server would lose its UI mid-flight and Restart would fail), and the
# login item is re-pointed only when this run installed something new.
count=$(ls -d "$ROOT"/mStream-*-"$key" 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -gt 1 ]; then
    echo "  older versions kept under $ROOT - once mStream is not running from one, it is safe to delete"
fi
