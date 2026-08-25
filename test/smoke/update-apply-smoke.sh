#!/bin/sh
# Apply-cycle smoke (posix): the POSITIVE half of the launcher's update
# story, with the real launcher binary — the counterpart of
# update-watchdog-smoke.sh's crash half. Proves the armed-status-file
# contract end to end:
#
#   1. Fabricates a mid-update managed root: the launcher+server of the
#      OLD version (0.0.1) about to run, `current` already flipped to the
#      staged NEW version (9.9.9), and update-status.json armed
#      (applyRequested + a fresh applyRequestedAt token) — exactly what
#      the server's auto mode leaves for the launcher.
#   2. Starts the OLD launcher from its versioned dir. Its server stub
#      SERVES an mStream-identifying page (the identity probe must pass:
#      the launcher only ever applies from a live-server phase).
#   3. Expects, within one poll cycle (~60s): the apply — old server
#      stopped, takeover into the NEW launcher behind `current`, the NEW
#      version's server serving. The NEW stub rewrites the status file
#      clean (current 9.9.9, nothing armed) the way a real supervised
#      server does at boot — and the settle window then proves the fresh
#      launcher does NOT re-apply off the old arm (exactly one relaunch
#      in the log).
#
# Needs: a built launcher (cd rust-launcher && cargo build --release, or
# MSTREAM_LAUNCHER_BIN), python3 (the serving stubs), node or sed (version
# parse). Linux headless needs xvfb-run. Scratch HOME; ~2.5 minutes,
# dominated by the launcher's 60s update poll.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LAUNCHER="${MSTREAM_LAUNCHER_BIN:-$REPO/rust-launcher/target/release/mstream-launcher}"
[ -x "$LAUNCHER" ] || {
    echo "no launcher at $LAUNCHER - build it (cd rust-launcher && cargo build --release) or set MSTREAM_LAUNCHER_BIN" >&2
    exit 1
}
command -v python3 >/dev/null 2>&1 || { echo "python3 required (serving stubs)" >&2; exit 1; }
PORT=3873

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

SMOKE="${TMPDIR:-/tmp}/mstream-apply-smoke-$$"
FAKEHOME="$SMOKE/home"
ROOT="$SMOKE/root"
DATA="$FAKEHOME/$DATA_REL"
# Everything the launcher writes is canonical (macOS /var -> /private/var);
# create, then compare in the same form. Cleanup matches the path ANYWHERE
# in the command line: the stubs exec python3, whose argv keeps the serve
# dir (inside ROOT) but not the stub script path.
mkdir -p "$FAKEHOME" "$ROOT" "$DATA/conf"
ROOT=$(cd "$ROOT" && pwd -P)
# Status-pinning cleanup function, not an inline trap: a pkill that finds
# nothing returns 1, and dash applies set -e inside EXIT traps — see
# update-watchdog-smoke.sh for the war story.
cleanup() {
    status=$?
    pkill -f "$ROOT/" 2>/dev/null || true
    sleep 1
    pkill -9 -f "$ROOT/" 2>/dev/null || true
    rm -rf "$SMOKE" 2>/dev/null || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' INT TERM

mk_bundle() { # version marker pre-serve-line
    b="$ROOT/mStream-$1-$KEY"
    mkdir -p "$b/$(dirname "$SERVER_REL")" "$b/serve"
    cp "$LAUNCHER" "$b/$FACE_REL"
    : > "$b/serve/mStream-$2.txt"   # directory listing carries the identity
    printf '#!/bin/sh\nif [ "${1:-}" = -V ]; then echo %s; exit 0; fi\n%s\nexec python3 -m http.server %s --bind 127.0.0.1 --directory '\''%s/serve'\''\n' \
        "$1" "$3" "$PORT" "$b" > "$b/$SERVER_REL"
    chmod +x "$b/$SERVER_REL"
}

# OLD 0.0.1: just serves. NEW 9.9.9: first rewrites the status file clean —
# the contract every real supervised server honors at boot (setup() writes
# its own version and cleared flags) and the reason a stale arm can never
# relaunch-loop a fresh launcher.
mk_bundle "0.0.1" "OLD-marker" ":"
mk_bundle "9.9.9" "NEW-marker" "printf '{\"schema\":1,\"current\":\"9.9.9\",\"staged\":false,\"applyRequested\":false}' > '$DATA/update-status.json'"
ln -s "$ROOT/mStream-9.9.9-$KEY" "$ROOT/current"
echo '{"port":'"$PORT"'}' > "$DATA/conf/default.json"

# The armed file the server's auto mode leaves for the launcher.
printf '{"schema":1,"current":"0.0.1","latest":"9.9.9","available":true,"method":"managed","staged":true,"stagedVersion":"9.9.9","applyRequested":true,"applyRequestedAt":"2026-01-01T00:00:00.000Z"}\n' \
    > "$DATA/update-status.json"

echo "starting the OLD (0.0.1) launcher; current is staged at 9.9.9; apply is armed..."
HOME="$FAKEHOME" \
MSTREAM_LAUNCHER_SKIP_AUTOSTART=1 \
MSTREAM_LAUNCHER_DIRECT_RELAUNCH=1 \
"$ROOT/mStream-0.0.1-$KEY/$FACE_REL" --no-open &
OLD_PID=$!

body() { curl -sf --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || true; }

# Phase 1: old serving (probe must see mStream before any apply may fire).
i=0; while [ $i -lt 30 ]; do body | grep -q "mStream-OLD-marker" && break; i=$((i + 1)); sleep 1; done
body | grep -q "mStream-OLD-marker" || { echo "FAIL old version never served"; exit 1; }
echo "  old version serving; waiting out the launcher's 60s update poll..."

# Phase 2: the apply (one poll cycle + boot slack).
i=0; while [ $i -lt 90 ]; do body | grep -q "mStream-NEW-marker" && break; i=$((i + 1)); sleep 1; done

echo "== assertions =="
fail=0
if body | grep -q "mStream-NEW-marker"; then
    echo "PASS takeover happened - the staged 9.9.9 is serving"
else
    echo "FAIL still serving: $(body | head -c 120)"; fail=1
fi
if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "FAIL the old launcher is still alive"; fail=1
else
    echo "PASS the old launcher exited"
fi
grep -q '"current":"9.9.9"' "$DATA/update-status.json" && ! grep -q '"applyRequested":true' "$DATA/update-status.json" \
    && echo "PASS status file rewritten clean by the new version" \
    || { echo "FAIL status file: $(cat "$DATA/update-status.json")"; fail=1; }

# Phase 3: settle - the NEW launcher's own first poll (60s after ITS start)
# must find the clean file and do NOTHING. A second relaunch line here is
# the stale-arm loop the guards exist to prevent.
echo "  settle window (the new launcher's first poll must be a no-op)..."
sleep 70
relaunches=$(grep -c "update: relaunching via" "$DATA/logs/launcher.log" 2>/dev/null || echo 0)
if [ "$relaunches" = "1" ]; then
    echo "PASS exactly one relaunch in the log - no stale-arm churn"
else
    echo "FAIL relaunch count: $relaunches"; tail -20 "$DATA/logs/launcher.log" 2>/dev/null; fail=1
fi
body | grep -q "mStream-NEW-marker" && echo "PASS 9.9.9 still serving after settle" || { echo "FAIL not serving after settle"; fail=1; }
exit $fail
