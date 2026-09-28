#!/bin/sh
# Desktop-player smoke — `mstream-desktop --player` (the tray's "Open mStream
# Player" item, scripted). Once the server answers, the launcher opens the
# bundled player's GUI face in a terminal window, pointed at this server as
# its BUNDLED server (`gui --bundled-server <url>`, never `--server`); when
# the install's player predates the GUI it opens the web player instead —
# and under --no-open, nothing at all, with the log saying why.
#
# Layout (update-apply-smoke.sh's recipe): a fake versioned bundle whose
# server is a python http.server answering the launcher's identity probe,
# with a stub mstream-player beside it at bin/mstream-player/<key> — the
# first place paths::find_player_bin looks. The stub answers --version with
# the version its leg wants and, asked for `gui`, records its argv next to
# the server binary and lingers long enough for the terminal chain to count
# the window as opened.
#
# Two legs, each with its own HOME (= its own data home, lock and log) and
# port:
#   1. player 9.9.9 (has the GUI): the recorded argv is exactly
#      `gui --bundled-server http://localhost:<port>`, and launcher.log
#      says which terminal opened it.
#   2. player 0.7.0 (predates it): no argv file; the log names the version
#      gate at boot and the suppressed browser fallback at ServerUp.
#
# Needs: a built launcher (or MSTREAM_LAUNCHER_BIN), python3, and on Linux a
# display plus a terminal emulator the launcher's chain knows (xterm is
# enough) — CI runs it under xvfb-run with xterm installed; with no emulator
# on PATH it skips. macOS opens Terminal.app through a .command file, which
# pops a real window, so run it there by hand only. MSTREAM_SMOKE_CONSOLE=
# <path to a Ghostty.app> stages that console beside the fake bundle so a
# hand run on macOS exercises the bundled-console path instead.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
LAUNCHER="${MSTREAM_LAUNCHER_BIN:-$REPO/rust-launcher/target/release/mstream-launcher}"
if [ ! -x "$LAUNCHER" ]; then
    echo "no launcher at $LAUNCHER - build it (cd rust-launcher && cargo build --release) or set MSTREAM_LAUNCHER_BIN" >&2
    exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 required (serving stub)" >&2; exit 1; }

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
    if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        echo "SKIP: no display (run under xvfb-run)"; exit 0
    fi
    found=""
    for t in xdg-terminal-exec kitty ghostty wezterm foot x-terminal-emulator ptyxis kgx gnome-terminal konsole xfce4-terminal mate-terminal alacritty xterm; do
        if command -v "$t" >/dev/null 2>&1; then found="$t"; break; fi
    done
    if [ -z "$found" ]; then
        echo "SKIP: no terminal emulator on PATH (install xterm)"; exit 0
    fi
    echo "terminal chain will find: $found"
fi
PLAYER_KEY="mstream-player-$KEY"
SERVER_DIR_REL=$(dirname "$SERVER_REL")

SMOKE="${TMPDIR:-/tmp}/mstream-player-smoke-$$"
ROOT="$SMOKE/root"
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd -P)
# Status-pinning cleanup, not an inline trap (dash applies set -e inside
# EXIT traps — see update-watchdog-smoke.sh). Everything spawned carries a
# path under ROOT in its argv: the launcher, the python server (its
# --directory), the terminal (the stub's path in its sh -c program).
HOLDER=""
cleanup() {
    status=$?
    if [ -n "$HOLDER" ]; then kill "$HOLDER" 2>/dev/null || true; fi
    pkill -f "$ROOT/" 2>/dev/null || true
    sleep 1
    pkill -9 -f "$ROOT/" 2>/dev/null || true
    rm -rf "$SMOKE" 2>/dev/null || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' INT TERM

# mk_bundle <leg> <player-version> <port>: a bundle of its own per leg (two
# legs must never share a bundle: the argv file, the console link and the
# stub are per bundle); sets B to the bundle dir.
mk_bundle() {
    B="$ROOT/$1/mStream-0.0.1-$KEY"
    mkdir -p "$B/$SERVER_DIR_REL/bin/mstream-player" "$B/serve"
    cp "$LAUNCHER" "$B/$FACE_REL"
    : > "$B/serve/mStream-marker.txt"   # the directory listing carries the identity
    printf '#!/bin/sh\nif [ "${1:-}" = -V ]; then echo 0.0.1; exit 0; fi\nexec python3 -m http.server %s --bind 127.0.0.1 --directory '\''%s/serve'\''\n' \
        "$3" "$B" > "$B/$SERVER_REL"
    chmod +x "$B/$SERVER_REL"
    stub="$B/$SERVER_DIR_REL/bin/mstream-player/$PLAYER_KEY"
    cat > "$stub" <<STUB
#!/bin/sh
if [ "\${1:-}" = --version ]; then echo "mstream-player $2"; exit 0; fi
printf '%s\n' "\$*" > "\$(dirname "\$0")/../../player-argv.txt"
sleep 20
STUB
    chmod +x "$stub"
    if [ -n "${MSTREAM_SMOKE_CONSOLE:-}" ]; then
        mkdir -p "$B/console"
        ln -s "$MSTREAM_SMOKE_CONSOLE" "$B/console/Ghostty.app"
    fi
}

# prepare_leg <leg> <player-version> <port>: the bundle and a HOME of its
# own (its own data home, lock and log), set up already (on a fresh install
# --player defers to the wizard); sets B, HOME_DIR, DATA, LOG, ARGV.
prepare_leg() {
    mk_bundle "$1" "$2" "$3"
    HOME_DIR="$SMOKE/home-$1"
    DATA="$HOME_DIR/$DATA_REL"
    LOG="$DATA/logs/launcher.log"
    ARGV="$B/$SERVER_DIR_REL/player-argv.txt"
    mkdir -p "$DATA/conf"
    echo '{"port":'"$3"',"setupComplete":true}' > "$DATA/conf/default.json"
}

# launch_leg: boots the prepared leg's launcher with --player --no-open;
# sets LPID.
launch_leg() {
    HOME="$HOME_DIR" \
    XDG_DATA_HOME="$HOME_DIR/.local/share" \
    MSTREAM_LAUNCHER_SKIP_AUTOSTART=1 \
    "$B/$FACE_REL" --player --no-open &
    LPID=$!
}

run_leg() { prepare_leg "$1" "$2" "$3"; launch_leg; }

wait_for_log() { # <pattern> <seconds>
    i=0
    while [ $i -lt "$2" ]; do
        grep -q "$1" "$LOG" 2>/dev/null && return 0
        i=$((i + 1)); sleep 1
    done
    return 1
}

stop_leg() {
    kill "$LPID" 2>/dev/null || true
    pkill -f "$B/" 2>/dev/null || true
    sleep 1
    pkill -9 -f "$B/" 2>/dev/null || true
}

fail=0

echo "== leg 1: player 9.9.9 has the GUI - the desktop player opens =="
run_leg gui 9.9.9 3874
wait_for_log "server is up" 45 || { echo "FAIL leg 1: server never came up"; tail -20 "$LOG" 2>/dev/null; exit 1; }
i=0; while [ $i -lt 30 ] && [ ! -s "$ARGV" ]; do i=$((i + 1)); sleep 1; done
if [ -s "$ARGV" ] && [ "$(cat "$ARGV")" = "gui --instance-lock $DATA/desktop-player.lock --bundled-server http://localhost:3874" ]; then
    echo "PASS the player was started as: $(cat "$ARGV")"
else
    echo "FAIL player argv: '$(cat "$ARGV" 2>/dev/null)'"; tail -20 "$LOG" 2>/dev/null; fail=1
fi
if grep -q "player opened via" "$LOG"; then
    echo "PASS $(grep "player opened via" "$LOG" | tail -1 | sed 's/^\[[0-9]*\] //')"
else
    echo "FAIL launcher.log never reported the player opening"; tail -20 "$LOG"; fail=1
fi
if grep -Eq "predates the GUI|did not answer --version" "$LOG"; then
    echo "FAIL the version gate refused a 9.9.9 player"; fail=1
fi
stop_leg

echo "== leg 2: player 0.7.0 predates the GUI - the web player is the fallback, --no-open keeps it shut =="
run_leg old 0.7.0 3875
wait_for_log "server is up" 45 || { echo "FAIL leg 2: server never came up"; tail -20 "$LOG" 2>/dev/null; exit 1; }
if wait_for_log "web player fallback suppressed (--no-open)" 15; then
    echo "PASS the fallback ran and stayed out of the browser"
else
    echo "FAIL no fallback line after ServerUp"; tail -20 "$LOG"; fail=1
fi
if grep -q "player 0.7.0 predates the GUI (needs 0.8.0)" "$LOG"; then
    echo "PASS the version gate named the pinned floor"
else
    echo "FAIL the version gate line is missing or changed"; grep -i "player" "$LOG" || true; fail=1
fi
sleep 2
if [ -e "$ARGV" ]; then
    echo "FAIL a 0.7.0 player was launched anyway: $(cat "$ARGV")"; fail=1
else
    echo "PASS no player process was started"
fi
stop_leg

echo "== leg 3: a player already holds its instance lock - the ask brings it forward and opens nothing =="
prepare_leg held 9.9.9 3876
mkdir -p "$DATA"
# Stand in for the open player: hold the lock the launcher will try (flock —
# what the player's fslock takes on unix) and write the sidecar beside it.
python3 - "$DATA/desktop-player.lock" <<'PY' &
import fcntl, json, os, sys, time
lock = sys.argv[1]
f = open(lock, "w")
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
with open(lock[:-5] + ".json", "w") as side:
    json.dump({"schema": 1, "pid": os.getpid(), "face": "gui", "host": "smoke-stub", "startedAt": int(time.time())}, side)
time.sleep(60)
PY
HOLDER=$!
sleep 1
launch_leg
wait_for_log "server is up" 45 || { echo "FAIL leg 3: server never came up"; tail -20 "$LOG" 2>/dev/null; exit 1; }
if wait_for_log "player already open (pid $HOLDER, under smoke-stub)" 15; then
    echo "PASS the launcher saw the open player: $(grep "player already open" "$LOG" | tail -1 | sed 's/^\[[0-9]*\] //')"
else
    echo "FAIL no 'player already open' line for pid $HOLDER"; tail -20 "$LOG" 2>/dev/null; fail=1
fi
sleep 2
if [ -e "$ARGV" ] || grep -q "player opened via" "$LOG"; then
    echo "FAIL a second player was opened beside the held lock"; fail=1
else
    echo "PASS nothing was opened beside it"
fi
kill "$HOLDER" 2>/dev/null || true
HOLDER=""
stop_leg

[ "$fail" -eq 0 ] && echo "player-open smoke: all assertions passed" || echo "player-open smoke: FAILED"
exit "$fail"
