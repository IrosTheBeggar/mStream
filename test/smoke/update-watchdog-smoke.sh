#!/bin/sh
# Boot-watchdog rollback smoke (manual, posix): proves the launcher rolls a
# managed install back when the version behind `current` crashes at boot.
#
#   1. Fabricates a managed root: `current` -> a bundle whose mstream-server
#      answers -V (it "passed" the installers' exec probe) but exits 1 on a
#      real boot, beside a previous version whose server idles forever.
#      The REAL launcher binary rides in both bundles.
#   2. Pre-writes the stale armed update-status.json a real bad apply leaves.
#   3. Starts the launcher behind `current` under a scratch HOME and expects:
#      one retry, then rollback — `current` re-pointed at the previous
#      version, the failed version recorded in update-hold.json, the stale
#      status file deleted, a takeover launcher running from `current`, and
#      the failed-version launcher gone.
#
# Needs: a built launcher (cargo build --release in rust-launcher/, or
# MSTREAM_LAUNCHER_BIN pointing at one). On Linux the desktop face needs a
# display — run under xvfb-run on a headless box. macOS runs as-is. The
# scratch HOME plus MSTREAM_LAUNCHER_SKIP_AUTOSTART keep real login items
# and data untouched.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LAUNCHER="${MSTREAM_LAUNCHER_BIN:-$REPO/rust-launcher/target/release/mstream-launcher}"
[ -x "$LAUNCHER" ] || {
    echo "no launcher at $LAUNCHER - build it (cd rust-launcher && cargo build --release) or set MSTREAM_LAUNCHER_BIN" >&2
    exit 1
}
# The version baked into the launcher (build.rs reads package.json) — the
# fabricated `current` bundle must carry it or the watchdog rightly declines.
PKGVER=$(node -p "require('$REPO/package.json').version" 2>/dev/null \
    || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)

case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) KEY="darwin-arm64" ;;
    Darwin-*) KEY="darwin-x64" ;;
    Linux-aarch64 | Linux-arm64) KEY="linux-arm64" ;;
    *) KEY="linux-x64" ;;
esac
if [ "$(uname -s)" = Darwin ]; then
    FACE_REL="mStream.app/Contents/MacOS/mStream"
    SERVER_REL="mStream.app/Contents/MacOS/mstream-server"
    DATA_REL="Library/Application Support/mStream"
else
    FACE_REL="mstream-desktop"
    SERVER_REL="mstream-server"
    DATA_REL=".local/share/mstream"
fi

SMOKE="${TMPDIR:-/tmp}/mstream-watchdog-smoke-$$"
FAKEHOME="$SMOKE/home"
ROOT="$SMOKE/root"
DATA="$FAKEHOME/$DATA_REL"
trap 'pkill -f "^$ROOT/" 2>/dev/null; sleep 1; pkill -9 -f "^$ROOT/" 2>/dev/null; rm -rf "$SMOKE"' EXIT INT TERM
mkdir -p "$FAKEHOME" "$ROOT" "$DATA"
# The watchdog resolves its own exe path, so everything it writes is in
# CANONICAL form (macOS: /var -> /private/var). Compare in the same form.
ROOT=$(cd "$ROOT" && pwd -P)

mk_bundle() { # version server-body
    b="$ROOT/mStream-$1-$KEY"
    mkdir -p "$b/$(dirname "$SERVER_REL")" "$b/$(dirname "$FACE_REL")"
    cp "$LAUNCHER" "$b/$FACE_REL"
    printf '%s\n' "$2" > "$b/$SERVER_REL"
    chmod +x "$b/$SERVER_REL"
}

mk_bundle "$PKGVER" "#!/bin/sh
if [ \"\${1:-}\" = -V ]; then echo $PKGVER; exit 0; fi
echo 'boom: simulated boot crash' >&2
exit 1"
mk_bundle "0.0.1" '#!/bin/sh
if [ "${1:-}" = -V ]; then echo 0.0.1; exit 0; fi
while true; do sleep 3600; done'
ln -s "$ROOT/mStream-$PKGVER-$KEY" "$ROOT/current"
printf '{"applyRequested":true,"applyRequestedAt":"2026-01-01T00:00:00.000Z","staged":true,"stagedVersion":"%s","method":"managed"}\n' "$PKGVER" \
    > "$DATA/update-status.json"

echo "starting launcher (bad current: $PKGVER, previous: 0.0.1)..."
HOME="$FAKEHOME" \
MSTREAM_LAUNCHER_SKIP_AUTOSTART=1 \
MSTREAM_LAUNCHER_DIRECT_RELAUNCH=1 \
"$ROOT/current/$FACE_REL" --no-open &
BAD_PID=$!

# Two instant crashes + the rollback land within a few seconds; poll up to 30.
i=0
while [ $i -lt 30 ]; do
    [ "$(readlink "$ROOT/current")" = "$ROOT/mStream-0.0.1-$KEY" ] && break
    i=$((i + 1)); sleep 1
done

echo "== launcher.log =="
cat "$DATA/logs/launcher.log" 2>/dev/null || true
echo "== assertions =="
fail=0
if [ "$(readlink "$ROOT/current")" = "$ROOT/mStream-0.0.1-$KEY" ]; then
    echo "PASS current re-pointed at 0.0.1"
else
    echo "FAIL current -> $(readlink "$ROOT/current")"; fail=1
fi
if grep -q "\"version\": \"$PKGVER\"" "$DATA/update-hold.json" 2>/dev/null; then
    echo "PASS hold recorded for $PKGVER"
else
    echo "FAIL no hold for $PKGVER"; fail=1
fi
if [ -e "$DATA/update-status.json" ]; then
    echo "FAIL stale update-status.json survived"; fail=1
else
    echo "PASS stale update-status.json deleted"
fi
sleep 2 # give the takeover a beat past its lock retry
if pgrep -f "^$ROOT/current/" >/dev/null 2>&1; then
    echo "PASS a takeover launcher is running from current"
else
    echo "FAIL no launcher running from current"; fail=1
fi
if kill -0 "$BAD_PID" 2>/dev/null; then
    echo "FAIL the failed-version launcher is still alive"; fail=1
else
    echo "PASS the failed-version launcher exited"
fi
exit $fail
