#!/bin/bash
# SQLite on a Docker Desktop bind mount — the lost-writes repro (2026-10-28).
#
# Docker Desktop (macOS host: the `fakeowner` filesystem over virtiofs)
# hides a POSIX lock taken through the descriptor that CREATED a file from
# every other process; locks through later opens work. SQLite's WAL holds
# -shm (and, on a fresh install, the database) exactly that way, so the
# server's writes were lost: other processes never saw them, and they were
# gone after `docker stop`. src/db/journal-mode.js has the details.
#
#   phase 0  the filesystem: is a lock held through the creating descriptor
#            visible to another process? (through a reopened one?)
#   phase 1  mStream on a fresh bind-mounted /config: the boot scan runs in
#            its own process, then the server writes through the API (a
#            playlist, a rating). A second process in the container must see
#            those writes, and so must a reader after `docker stop`.
#
# Usage (Docker Desktop host):
#   bash test/smoke/docker/sqlite-bind-mount-smoke.sh [<git ref>]
#
# <git ref> defaults to HEAD; a ref without the fix fails phase 1. The app is
# `git archive <ref>` with its rust-parser built from the same ref (the
# committed binaries can trail the source), so commit what you want smoked.
# The app and the cargo caches stay in named volumes (sqlsmoke-*) for fast
# re-runs; `docker volume ls -q -f name=sqlsmoke-` lists them for cleanup.
set -euo pipefail

REF="${1:-HEAD}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short "$REF")"
IMAGE="${IMAGE:-node:24-bookworm}"
RUST_IMAGE="${RUST_IMAGE:-rust:1-slim-bookworm}"
NAME="sqlsmoke-server-$SHA"
APP_VOL="sqlsmoke-app-$SHA"
# Under $TMPDIR, which Docker Desktop shares with the VM by default.
WORK="$(mktemp -d)"
PASS=0; FAIL=0

check() {  # label got want
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 — got '$2', want '$3'"; FAIL=$((FAIL + 1)); fi
}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== phase 0: lock visibility on a bind mount ($WORK)"
mkdir -p "$WORK/fs"
QUIRK="$(docker run --rm -v "$WORK/fs:/fs" "$IMAGE" node --no-warnings --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  import { spawnSync } from "node:child_process";
  import fs from "node:fs";
  const created = "/fs/created.db", reopened = "/fs/reopened.db";
  const a = new DatabaseSync(created); a.exec("BEGIN EXCLUSIVE");
  fs.closeSync(fs.openSync(reopened, "w"));
  const b = new DatabaseSync(reopened); b.exec("BEGIN EXCLUSIVE");
  const seen = (p) => spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    try { new DatabaseSync(${JSON.stringify(p)}).prepare("SELECT 1 FROM sqlite_master").all(); console.log("invisible"); }
    catch (e) { console.log(e.errcode === 5 ? "visible" : e.message); }`], { encoding: "utf8" }).stdout.trim();
  console.log(`${seen(created)} ${seen(reopened)}`);
')"
read -r CREATED_LOCK REOPENED_LOCK <<<"$QUIRK"
echo "  lock through the creating descriptor: $CREATED_LOCK; through a reopened one: $REOPENED_LOCK"
check "a lock through a reopened descriptor is visible" "$REOPENED_LOCK" visible
if [ "$CREATED_LOCK" = invisible ]; then WANT_MODE=delete; else WANT_MODE=wal; fi

echo "== phase 1: mStream @ $SHA"
if ! docker run --rm -v "$APP_VOL:/app" "$IMAGE" test -e /app/.smoke-ready; then
  echo "  preparing the app volume (npm ci, rust-parser build) …"
  git -C "$REPO_ROOT" archive "$REF" | docker run --rm -i -v "$APP_VOL:/app" "$IMAGE" sh -c \
    'tar -x -C /app && cd /app && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error'
  docker run --rm -v "$APP_VOL:/app" -v sqlsmoke-cargo-target:/target \
    -v sqlsmoke-cargo-registry:/usr/local/cargo/registry "$RUST_IMAGE" sh -c \
    'cd /app/rust-parser && CARGO_TARGET_DIR=/target cargo build --release --locked -q \
       && mkdir -p target/release && cp /target/release/rust-parser target/release/ \
       && touch /app/.smoke-ready'
fi

# Three tiny MP3s, no ffmpeg needed: an ID3v2.3 tag + ~1 s of silent
# MPEG-1 Layer III frames, a different filler byte per file so each has its
# own audio hash.
mkdir -p "$WORK/music" "$WORK/config"
docker run --rm -v "$WORK/music:/music" "$IMAGE" node -e '
  const fs = require("fs");
  const frame = (id, text) => { const b = Buffer.from("\0" + text, "latin1"); const h = Buffer.alloc(10);
    h.write(id, 0, "latin1"); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  ["one", "two", "three"].forEach((title, i) => {
    const frames = Buffer.concat([frame("TIT2", title), frame("TPE1", "Smoke"), frame("TALB", "Bind Mount")]);
    const size = frames.length, tag = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
      (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    const audio = Buffer.concat(Array.from({ length: 40 }, () => {
      const f = Buffer.alloc(417, i + 1); f.set([0xff, 0xfb, 0x90, 0x00], 0); f.fill(0, 4, 36); return f; }));
    fs.writeFileSync(`/music/${title}.mp3`, Buffer.concat([tag, frames, audio]));
  });'

cat > "$WORK/config/config.json" <<'JSON'
{
  "port": 3000,
  "folders": { "music": { "root": "/music" } },
  "storage": {
    "dbDirectory": "/config/db",
    "albumArtDirectory": "/config/art",
    "logsDirectory": "/config/logs",
    "waveformCacheDirectory": "/config/waveform-cache"
  },
  "scanOptions": {
    "bootScanDelay": 1, "autoAlbumArt": false, "collectDiscoveryData": false, "analyzeBpm": false
  }
}
JSON

docker run -d --name "$NAME" -v "$APP_VOL:/app" -v "$WORK/config:/config" \
  -v "$WORK/music:/music:ro" -p 127.0.0.1::3000 "$IMAGE" \
  node /app/cli-boot-wrapper.js -j /config/config.json >/dev/null
BASE="http://$(docker port "$NAME" 3000/tcp | head -1)"

STATUS=""
for _ in $(seq 1 120); do
  STATUS="$(curl -s -m 2 "$BASE/api/v1/db/status" || true)"
  case "$STATUS" in *'"totalFileCount":3'*'"locked":false'*) break ;; esac
  sleep 1
done
check "boot scan indexed the library" "$(echo "$STATUS" | grep -o '"totalFileCount":[0-9]*')" '"totalFileCount":3'
sleep 2   # let the scanner process exit: its close is what unlinked the WAL

post() { curl -s -m 5 -H 'Content-Type: application/json' -d "$2" "$BASE$1" >/dev/null; }
post /api/v1/playlist/new '{"title":"smoke"}'
post /api/v1/playlist/add-song '{"song":"music/one.mp3","playlist":"smoke"}'
post /api/v1/playlist/add-song '{"song":"music/two.mp3","playlist":"smoke"}'
post /api/v1/db/rate-song '{"filepath":"music/three.mp3","rating":8}'

READ='
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/config/db/mstream.db", { readOnly: true });
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  console.log([one("PRAGMA journal_mode"),
    one("SELECT count(*) FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.name = '"'smoke'"'"),
    one("SELECT count(*) FROM user_metadata WHERE rating = 8")].join(" "));'
read -r MODE SONGS RATED <<<"$(docker exec "$NAME" node --no-warnings -e "$READ")"
check "journal_mode" "$MODE" "$WANT_MODE"
check "a second process sees the playlist songs" "$SONGS" 2
check "a second process sees the rating" "$RATED" 1
if [ "$WANT_MODE" = delete ]; then
  check "boot logged the DELETE fallback" \
    "$(docker logs "$NAME" 2>&1 | grep -c 'uses journal_mode=DELETE' || true)" 1
fi
echo "  server descriptors on deleted files: $(docker exec "$NAME" sh -c 'ls -l /proc/1/fd | grep -c "(deleted)"' || true)"

docker stop "$NAME" >/dev/null
read -r _ SONGS RATED <<<"$(docker run --rm -v "$WORK/config:/config" "$IMAGE" node --no-warnings -e "$READ")"
check "after docker stop: the playlist songs are on disk" "$SONGS" 2
check "after docker stop: the rating is on disk" "$RATED" 1

echo "== $PASS passed, $FAIL failed (work dir: $WORK)"
[ "$FAIL" -eq 0 ]
