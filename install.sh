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
# will actually run. ldd's own banner is the most portable tell.
libc=""
if [ "$platform" = linux ]; then
    if ldd --version 2>&1 | grep -qi musl; then
        libc="-musl"
    elif [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
        libc="-musl"
    fi
fi

case "$platform-$arch" in
    darwin-x86_64) key="darwin-x64" ;;
    darwin-arm64) key="darwin-arm64" ;;
    linux-x86_64 | linux-amd64) key="linux-x64$libc" ;;
    linux-aarch64 | linux-arm64) key="linux-arm64$libc" ;;
    linux-armv7l | linux-armv6l)
        echo "no 32-bit ARM build - mStream needs a 64-bit OS on this Pi (or run from source with Node)" >&2
        exit 1
        ;;
    *)
        echo "no prebuilt bundle for $os/$arch - run from source: https://github.com/$REPO/blob/master/docs/install.md" >&2
        exit 1
        ;;
esac

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

if [ -n "${MSTREAM_RELEASE_BASE:-}" ]; then
    base="${MSTREAM_RELEASE_BASE%/}"
elif [ "$VERSION" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
else
    base="https://github.com/$REPO/releases/download/$VERSION"
fi

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
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
fetch "$base/manifest.json" "$tmp/manifest.json"
version=$(grep -o '"version": *"[^"]*"' "$tmp/manifest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$version" ] || { echo "manifest.json is missing a version - refusing to install" >&2; exit 1; }
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
fetch "$base/$asset" "$tmp/$asset"
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

# Extract beside the final location, then rename into place: a killed
# install leaves a stray .partial folder, never a half-written `current`.
bundle="mStream-$version-$key"
mkdir -p "$ROOT"
rm -rf "$ROOT/$bundle.partial"
unzip -q "$tmp/$asset" -d "$ROOT/$bundle.partial"
rm -rf "$ROOT/$bundle"
mv "$ROOT/$bundle.partial/$bundle" "$ROOT/$bundle"
rmdir "$ROOT/$bundle.partial"
# Zip mode bits are usually preserved (Info-ZIP records them), but a bundle
# that went through a mode-stripping hop must still run.
chmod 755 "$ROOT/$bundle/mstream-server" 2>/dev/null || true
chmod 755 "$ROOT/$bundle/mstream-desktop" 2>/dev/null || true
chmod 755 "$ROOT/$bundle/mStream.app/Contents/MacOS/"* 2>/dev/null || true
chmod 755 "$ROOT/$bundle"/bin/*/* 2>/dev/null || true
ln -sfn "$ROOT/$bundle" "$ROOT/current"

# The command: a symlink, so `mstream-server` on PATH always means `current`
# and an upgrade is one link flip. Data lives in the server's data home,
# never here.
if [ "$platform" = darwin ]; then
    server="$ROOT/current/mStream.app/Contents/MacOS/mstream-server"
else
    server="$ROOT/current/mstream-server"
fi
mkdir -p "$BIN_DIR"
ln -sfn "$server" "$BIN_DIR/mstream-server"

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
        ln -sfn "$ROOT/current/mStream.app" "$HOME/Applications/mStream.app"
        desktop_note="app: ~/Applications/mStream.app (menu-bar icon; Quick Connect on)"
    fi
fi

echo "installed mStream $version to $ROOT/$bundle"
[ -n "$desktop_note" ] && echo "  $desktop_note"

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
count=$(ls -d "$ROOT"/mStream-*-"$key" 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -gt 1 ]; then
    echo "  older versions kept under $ROOT - safe to delete any that aren't 'current'"
fi
