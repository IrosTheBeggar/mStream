#!/bin/sh
# postinstall for the macOS .pkg (staged into the pkg by build-bun.yml):
# restart a RUNNING mStream into the copy this install just replaced.
# Without it, the pkg is a pure payload swap and the old version keeps
# serving its already-loaded code until a manual Quit + reopen (field
# report, 2026-08-25).
#
# Approach: terminate the LAUNCHER by exact path and let the supervision
# contract do the graceful part — the launcher's death drops the server's
# stdin pipe, and a --supervised server exits cleanly on that EOF
# (src/util/supervision.js; the same guarantee that makes force-killed
# launchers leak-proof). No AppleEvents, so no TCC automation prompts from
# an installer context. GUI app only: a bare mstream-server someone runs
# from this tree (a launchd unit, a terminal) is deliberately left alone —
# an installer never kills a server it does not manage.
#
# Runs as root; the relaunch drops to the CONSOLE user (an app opened as
# root would run the tray in the wrong session). Every path is best-effort:
# a postinstall must never fail the install — exit 0 always.
set -u

DEST="${2:-/Applications}"
APP="$DEST/mStream.app"
LAUNCHER="$APP/Contents/MacOS/mStream"
[ -x "$LAUNCHER" ] || exit 0

# pgrep -f matches the whole command line; the path is specific enough that
# its regex metacharacters (the .app dot) over-matching is not a concern.
running_pids=$(pgrep -f "^$LAUNCHER" 2>/dev/null || true)
[ -n "$running_pids" ] || exit 0

user=$(stat -f%Su /dev/console 2>/dev/null || true)
# A sudo-driven install (CI's `sudo installer`, an admin's terminal) can
# show root or a system account at the console; the invoking user is the
# better answer there.
case "$user" in ""|root|_*) user="${SUDO_USER:-}" ;; esac
uid=$(id -u "$user" 2>/dev/null || true)
[ -n "$user" ] && [ "$user" != "root" ] && [ -n "$uid" ] || exit 0

# Run a command as the console user. In the installer this process is root
# (launchctl asuser targets the user's GUI session); run standalone as that
# user — the test harness's shape — the wrappers are unnecessary AND sudo
# would prompt, so call directly.
run_as_console_user() {
    if [ "$(id -u)" = "$uid" ]; then
        "$@"
    else
        launchctl asuser "$uid" sudo -u "$user" "$@"
    fi
}

echo "mStream is running from $APP - restarting it into the new version"
kill -TERM $running_pids 2>/dev/null || true
i=0
while [ $i -lt 20 ] && pgrep -f "^$LAUNCHER" >/dev/null 2>&1; do
    i=$((i + 1)); sleep 1
done
if pgrep -f "^$LAUNCHER" >/dev/null 2>&1; then
    kill -KILL $(pgrep -f "^$LAUNCHER") 2>/dev/null || true
    sleep 1
fi
# The launcher is gone; its supervised server follows via the stdin-EOF
# contract. Give that a beat, then reap any straggler UNDER THE APP PATH
# only (never a server running from somewhere else).
sleep 2
straggler=$(pgrep -f "^$APP/Contents/MacOS/mstream-server" 2>/dev/null || true)
[ -n "$straggler" ] && kill -TERM $straggler 2>/dev/null

# Relaunch as the console user. --takeover: this is an update handoff, not
# a first run — no browser announce, and the single-instance lock is
# retried briefly if the old process is still tearing down. `open` goes
# through LaunchServices (the shape a real user launch has); if it refuses
# (test harnesses with a bare fake .app; an exotic Gatekeeper state), fall
# back to spawning the binary directly, detached.
if ! run_as_console_user /usr/bin/open -a "$APP" --args --takeover 2>/dev/null; then
    run_as_console_user /usr/bin/nohup "$LAUNCHER" --takeover >/dev/null 2>&1 &
fi
exit 0
