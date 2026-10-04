#!/bin/sh
# postinstall for the macOS .pkg (staged into the pkg by build-bun.yml):
# an install ends with mStream running from the copy it just laid down, as
# the console user, wherever a session of theirs can hold it (the four
# stand-downs are below). A RUNNING mStream is restarted into the new version
# — without that the pkg is a pure payload swap and the old version keeps
# serving its already-loaded code until a manual Quit + reopen (field
# report, 2026-08-25). One that was NOT running is started: a first
# install, or an upgrade installed while mStream was quit, used to end with
# nothing running at all (owner report, 2026-10-03).
#
# Approach: terminate the LAUNCHER by exact path and let the supervision
# contract do the graceful part — the launcher's death drops the server's
# stdin pipe, and a --supervised server exits cleanly on that EOF
# (src/util/supervision.js; the same guarantee that makes force-killed
# launchers leak-proof). No AppleEvents, so no TCC automation prompts from
# an installer context. GUI app only: a bare mstream-server someone runs
# from this tree (a launchd unit, a terminal) is deliberately left alone,
# because an installer never kills a server it does not manage. Nor does it
# start the app while something already listens on the port the app's
# server would take, because that server would lose the bind and the user
# would get an error dialog nobody asked for. The port is read the way the
# launcher reads it (paths.rs resolve_config_path and read_endpoint: the
# data-home config's `port`, 3000 when it has none), and the usual holder
# is a bare mstream-server on that same config. A server on a config and
# port of its own (a -j scratch server, an MSTREAM_CONFIG run) is no
# obstacle, so it does not hold the start back.
#
# The nothing-running launch takes its flags from the launcher's own
# contract (LauncherArgs in rust-launcher/src/main.rs). A console user whose
# data home holds launcher.json (paths.rs state_file, which only a launcher
# session writes: autostart::ensure_default_on, on its first run that was
# not itself --autostarted) has run the app before, so this is an upgrade of a
# copy they quit and it comes back the way a login brings it back:
# --autostarted, the tray alone, no wizard and no browser tab. The data
# home folder by itself proves nothing, because install.sh creates it and
# so does any standalone mstream-server run in the desktop profile, for
# people who have never opened the app. No marker means the app's first
# run, which gets a plain launch: the login item on by default, and the
# setup wizard while nothing is set up yet (a server that already is boots
# quietly even then). Never --takeover there, because nothing is handing
# over.
#
# Runs as root; every launch drops to the CONSOLE user (an app opened as
# root would run the tray in the wrong session). Starting from nothing also
# needs that user's GUI session to exist. At the login window the console
# belongs to root and the user falls back to $SUDO_USER, so an admin's
# `sudo installer` over SSH would otherwise start a menu-bar app in a
# session with no window server; a user with no GUI session (that SSH
# install, an MDM push with nobody logged in) gets nothing started, and
# mStream waits for its login item or for them to open it. Every path is
# best-effort: a postinstall must never fail the install — exit 0 always.
set -u

# The pkg's second component, io.mstream.console, laid a bundled Ghostty at
# this system path for the setup wizard and Quick Connect to draw their
# artwork in. Since player v0.12.0 those pages open in the player's own
# window (Terminal.app is the fallback when no window can open), so the
# component is gone; it shipped from the pkg's first release through the one
# before this, and an upgrade clears what it left. On every install, before
# the launcher guard and the console-user exit below, so a copy that is not
# running and a session that cannot hold a launch still get cleaned up. The
# literal path the component owned, never a user's data home; the parent
# goes only when the console was all it held; and the receipt goes with it,
# so the installed-packages list stops naming a component the pkg no longer
# carries. Best-effort, like everything here.
rm -rf "/Library/Application Support/mStream/console" 2>/dev/null || true
rmdir "/Library/Application Support/mStream" 2>/dev/null || true
pkgutil --forget io.mstream.console >/dev/null 2>&1 || true

DEST="${2:-/Applications}"
APP="$DEST/mStream.app"
LAUNCHER="$APP/Contents/MacOS/mStream"
[ -x "$LAUNCHER" ] || exit 0

# pgrep -f matches the whole command line; the path is specific enough that
# its regex metacharacters (the .app dot) over-matching is not a concern.
running_pids=$(pgrep -f "^$LAUNCHER" 2>/dev/null || true)

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

if [ -z "$running_pids" ]; then
    # $3 is the target volume. A pkg aimed at another one (an external
    # disk, a system image being prepared) installed nothing this session
    # can run.
    [ "${3:-/}" = "/" ] || exit 0
    # A live GUI session for the user, or no start at all (the head
    # comment). The restart path below is left as it was: a launcher was
    # already running there, so a session was there to hold it.
    if ! launchctl print "gui/$uid" >/dev/null 2>&1; then
        echo "$user has no GUI session - not starting mStream"
        exit 0
    fi
    # The home comes from Directory Services, never an assumed /Users/<name>
    # (a home on another volume, a renamed home folder). dscl prints a value
    # holding a space on its own indented line, hence the join. The tilde
    # fallback only runs for a name eval cannot misread. A home that stays
    # unknown reads as a first install on the default port, which costs
    # little when wrong: a configured copy boots quietly from a plain launch
    # anyway, and a wrong port guess only leaves the clash to the
    # launcher's own dialog.
    home=$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null \
        | sed -e '1s/^NFSHomeDirectory:[[:space:]]*//' -e 's/^[[:space:]]*//' | tr -d '\n')
    case "$home" in
        /*) ;;
        *)
            case "$user" in
                *[!A-Za-z0-9._-]*) home="" ;;
                *) home=$(eval echo "~$user" 2>/dev/null || true) ;;
            esac
            ;;
    esac
    # An unknown home must not leave a bare "/Library/..." behind: that is
    # the machine-wide support folder, nobody's data home.
    support=""
    case "$home" in /*) support="$home/Library/Application Support/mStream" ;; esac
    # The config the app's server will read, in resolve_config_path's order
    # for a launch with no arguments (an MSTREAM_CONFIG in this root
    # context never reaches a LaunchServices launch): a legacy save/ beside
    # the server binary, else the data home's. plutil reads JSON, a BOM,
    # nulls and Joi's quoted and integral-float ports included; anything
    # that is not a whole port falls back to 3000, as read_endpoint does.
    cfg="$APP/Contents/MacOS/save/conf/default.json"
    [ -f "$cfg" ] || cfg="${support:+$support/conf/default.json}"
    port=""
    [ -n "$cfg" ] && [ -f "$cfg" ] && \
        port=$(plutil -extract port raw -o - "$cfg" 2>/dev/null | tr -d '[:space:]' || true)
    case "$port" in *.*[!0]*) port="" ;; *.*) port=${port%%.*} ;; esac
    case "$port" in ""|*[!0-9]*) port=3000 ;; esac
    [ "$port" -le 65535 ] 2>/dev/null || port=3000
    listeners=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)
    if [ -n "$listeners" ]; then
        echo "port $port is already in use (pid ${listeners% }) - not starting mStream beside it"
        exit 0
    fi
    set --
    [ -n "$support" ] && [ -f "$support/launcher.json" ] && set -- --autostarted
    if [ $# -gt 0 ]; then
        echo "mStream was not running - starting the new version quietly (it has run here before)"
    else
        echo "mStream was not running - starting it for the first time"
    fi
    # `open` first, the detached spawn as the fallback, as the restart path
    # below does. The fallback also passes --tray and a /dev/null stdin: the
    # spawn inherits this script's stdio, and the launcher reads a tty on
    # either end as "run from a terminal" (the console face, a bare server
    # with no tray). `open` sees none, so it needs neither.
    if ! run_as_console_user /usr/bin/open -a "$APP" ${1+--args} "$@" 2>/dev/null; then
        run_as_console_user /usr/bin/nohup "$LAUNCHER" --tray "$@" </dev/null >/dev/null 2>&1 &
    fi
    exit 0
fi

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
# contract. Give that a beat, then reap any straggler of ITS OWN: the
# launcher spawns `mstream-server --supervised` (rust-launcher/src/server.rs),
# so only a supervised server under the app path is one it left behind. A
# bare mstream-server someone runs from this tree on a config of its own
# carries no --supervised and is not matched, as the head comment promises.
sleep 2
straggler=$(pgrep -f "^$APP/Contents/MacOS/mstream-server .*--supervised" 2>/dev/null || true)
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
