#!/bin/bash
# yt-dlp fetch-on-first-use + keep-current smoke — the Docker story for
# src/util/yt-dlp-bootstrap.js on a Linux container that has NO yt-dlp,
# with REAL yt-dlp release binaries (two versions) served by a loopback
# store inside each container (MSTREAM_YTDLP_BASE, the documented mirror
# override — the committed-manifest pin and the store's SHA2-256SUMS gate
# what gets installed exactly as they would against GitHub).
#
#   phase A  fresh checkout + empty persistent data volume, the youtube
#            plug-in enabled, the manifest pinning the OLDER release: the
#            probe FETCHES the pin (sha256-verified against the manifest),
#            then moves straight on to the store's newest release (verified
#            against its SHA2-256SUMS): two downloads, the plug-in reports
#            the NEWER version with source "managed", and the real binary
#            on the volume answers --version with it.
#   phase B  destroy the container, recreate it on the same volume: ZERO
#            downloads — the receipted install runs; the post-boot check
#            (pulled in by MSTREAM_YTDLP_CHECK_DELAY_MS) reads the checksum
#            file, finds nothing newer, fetches nothing.
#   phase C  tamper: the store's checksum file promises a build the asset
#            does not hash to → refused, the installed build kept, logged.
#   phase D  the store is down: the check warns, the installed build runs.
#   phase E  a yt-dlp on PATH that is far behind (a stand-in answering an
#            old version), on a fresh volume: passed over — mStream's own
#            is fetched and runs; then a stand-in answering a current
#            version: it runs, nothing is fetched.
#   phase F  (REAL=1, needs egress) no mirror at all: the pin comes from
#            GitHub's release assets and the update from releases/latest +
#            that release's SHA2-256SUMS. Asserts the plug-in ends on a
#            version at or past the newest release this smoke knows.
#
# The data volume is mapped over the server's data root for real: the
# checkout lives at /opt/mstream (a system prefix, so src/util/esm-helpers'
# dataRoot diverges from appRoot like a packaged install) and
# XDG_DATA_HOME=/data puts the managed copy + its .fetched.json receipt on
# the named volume.
#
# Usage:
#   bash test/smoke/docker/yt-dlp-fetch-smoke.sh            # phases A–E
#   REAL=1 bash test/smoke/docker/yt-dlp-fetch-smoke.sh     # + phase F
#
# ASSETS_DIR (default: a cache under $TMPDIR) receives the two real
# yt-dlp_linux builds (OLD_TAG, NEW_TAG below) and NEW_TAG's SHA2-256SUMS,
# downloaded from the yt-dlp releases when missing (~80 MB once).
#
# Smokes the WORKING TREE (tracked + untracked, unignored files), not HEAD.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
OLD_TAG="${OLD_TAG:-2026.07.04}"
NEW_TAG="${NEW_TAG:-2026.08.19}"
FILE=yt-dlp_linux
KEY=yt-dlp-linux-x64
IMAGE_BASE="${IMAGE_BASE:-node:22-bookworm}"
IMAGE=mstream-ytdlp-smoke:bookworm
APP_VOL=ytdlpsmoke-app
DATA_VOL=ytdlpsmoke-data
ASSETS_DIR="${ASSETS_DIR:-${TMPDIR:-/tmp}/mstream-ytdlp-smoke-assets}"
WORK="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
# MSYS_NO_PATHCONV: keep Git Bash on Windows from rewriting container paths.
dockerq() { MSYS_NO_PATHCONV=1 docker "$@"; }
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cleanup() {
  dockerq volume rm -f "$APP_VOL" "$DATA_VOL" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
dockerq volume rm -f "$APP_VOL" "$DATA_VOL" >/dev/null 2>&1 || true

# ── Real release assets (cached) ────────────────────────────────────────────
mkdir -p "$ASSETS_DIR"
fetch_asset() { # $1=tag $2=name $3=dest
  [ -s "$3" ] && return 0
  echo "  downloading $2 ($1)..."
  curl -fsSL --retry 3 -o "$3.part" "https://github.com/yt-dlp/yt-dlp/releases/download/$1/$2" && mv "$3.part" "$3"
}
fetch_asset "$OLD_TAG" "$FILE" "$ASSETS_DIR/$FILE@$OLD_TAG"
fetch_asset "$NEW_TAG" "$FILE" "$ASSETS_DIR/$FILE@$NEW_TAG"
fetch_asset "$NEW_TAG" SHA2-256SUMS "$ASSETS_DIR/SHA2-256SUMS@$NEW_TAG"
NEW_SHA=$(grep -E "  \*?$FILE\$" "$ASSETS_DIR/SHA2-256SUMS@$NEW_TAG" | awk '{print $1}')
[ -n "$NEW_SHA" ] || { echo "SHA2-256SUMS@$NEW_TAG lists no $FILE"; exit 2; }

# ── Stores: the pin under its release file name + a latest/ namespace ───────
#   store-pin     pin = OLD; latest = NEW with NEW's real checksum file
#   store-tamper  latest checksum file promises a hash the served asset lacks
mkdir -p "$WORK/store-pin/latest" "$WORK/store-tamper/latest"
cp "$ASSETS_DIR/$FILE@$OLD_TAG" "$WORK/store-pin/$FILE"
cp "$ASSETS_DIR/$FILE@$NEW_TAG" "$WORK/store-pin/latest/$FILE"
cp "$ASSETS_DIR/SHA2-256SUMS@$NEW_TAG" "$WORK/store-pin/latest/SHA2-256SUMS"
cp "$ASSETS_DIR/$FILE@$OLD_TAG" "$WORK/store-tamper/$FILE"
cp "$ASSETS_DIR/$FILE@$NEW_TAG" "$WORK/store-tamper/latest/$FILE"
printf '%s  %s\n' "$(printf 'f%.0s' $(seq 1 64))" "$FILE" > "$WORK/store-tamper/latest/SHA2-256SUMS"

# The manifest pinning the OLD release (real sha256 + size of the real file).
node - "$WORK" "$ASSETS_DIR/$FILE@$OLD_TAG" "$OLD_TAG" "$KEY" "$FILE" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [work, file, tag, key, name] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const manifest = {
  family: 'yt-dlp', schema: 2, repo: 'yt-dlp/yt-dlp', tag,
  assets: { [key]: { file: name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length } },
};
fs.writeFileSync(path.join(work, 'manifest-old.json'), JSON.stringify(manifest, null, 2));
console.log(`pin: ${tag} ${manifest.assets[key].sha256.slice(0, 16)}… (${buf.length} bytes)`);
NODE

# The working tree (tracked + untracked unignored files) as the container source.
( cd "$REPO_ROOT" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf "$WORK/src.tar" )

# Loopback store: serves the bind-mounted store dir; every asset download
# and every checksum-file read is one line in a volume-persisted log.
cat > "$WORK/store-server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [dir, port] = process.argv.slice(2);
http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
  const file = path.join(dir, name);
  if (!name || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  fs.appendFileSync(name.endsWith('SHA2-256SUMS') ? '/data/sums.log' : '/data/fetch.log', `${new Date().toISOString()} ${name}\n`);
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), '127.0.0.1', () => console.log(`[store] ${dir} on ${port}`));
EOF

cat > "$WORK/config.json" <<'EOF'
{
  "port": 3556,
  "address": "127.0.0.1",
  "folders": { "music": { "root": "/music" } },
  "storage": {
    "dbDirectory": "/data/mstream-state/db",
    "albumArtDirectory": "/data/mstream-state/art",
    "logsDirectory": "/data/mstream-state/logs",
    "waveformCacheDirectory": "/data/mstream-state/wf"
  },
  "transcode": { "ffmpegDirectory": "/usr/bin" },
  "scanOptions": { "autoAlbumArt": false, "collectDiscoveryData": false, "analyzeBpm": false },
  "discoveryPlugins": { "youtube": { "enabled": true } }
}
EOF

# Per-phase container body. Env: MANIFEST (file under /work), STORE
# (1 = start the loopback store on /store, 0 = leave it down), FAKE_VERSION
# (put a yt-dlp stand-in on PATH answering it), REAL (1 = no mirror override),
# SETTLE (seconds to wait after the row answers, for the post-boot check).
cat > "$WORK/phase.sh" <<'EOF'
#!/bin/sh
set -eu
cp "/work/$MANIFEST" /opt/mstream/bin/yt-dlp/manifest.json
if [ "${STORE:-1}" = "1" ]; then node /work/store-server.mjs /store 8766 & sleep 1; fi
if [ -n "${FAKE_VERSION:-}" ]; then
  printf '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo %s; exit 0; fi\necho "stand-in yt-dlp: not a real one" >&2; exit 1\n' "$FAKE_VERSION" > /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
fi
mkdir -p /music /data/mstream-state
cp /work/config.json /tmp/config.json
cd /opt/mstream
if [ "${REAL:-0}" = "1" ]; then unset MSTREAM_YTDLP_BASE; else export MSTREAM_YTDLP_BASE=http://127.0.0.1:8766; fi
MSTREAM_YTDLP_CHECK_DELAY_MS=3000 node cli-boot-wrapper.js -j /tmp/config.json >/tmp/boot.log 2>&1 &
i=0
until curl -fsS http://127.0.0.1:3556/api/v1/ping >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 120 ] && { echo PHASE-BOOT-TIMEOUT; tail -30 /tmp/boot.log; exit 1; }
  sleep 1
done
# The youtube row, once its probe has settled: available, or failed for a
# reason other than ffmpeg still initialising (a failing probe is retried
# by the registry, so the first answer can be that wait).
row() {
  curl -fsS http://127.0.0.1:3556/api/v1/admin/discovery-plugins/status 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ try { const p=JSON.parse(s).plugins.find(x=>x.name==="youtube"); if (p && (p.available === true || (p.reason && !/ffmpeg is not available yet/.test(p.reason)))) console.log(JSON.stringify({available:p.available,reason:p.reason,detail:p.detail})); } catch(e){} })' || true
}
i=0
while :; do
  ROW=$(row)
  [ -n "$ROW" ] && break
  i=$((i+1)); [ "$i" -gt 240 ] && { echo PHASE-PROBE-TIMEOUT; tail -40 /tmp/boot.log; exit 1; }
  sleep 1
done
sleep "${SETTLE:-6}"
FRESH=$(row); [ -n "$FRESH" ] && ROW="$FRESH"
echo "PHASE-READY"
echo "ROW $ROW"
echo "fetches: $(wc -l < /data/fetch.log 2>/dev/null || echo 0)"
echo "sums-reads: $(wc -l < /data/sums.log 2>/dev/null || echo 0)"
echo "receipt: $(cat /data/mstream/bin/yt-dlp/.fetched.json 2>/dev/null || echo none)"
if [ -x /data/mstream/bin/yt-dlp/yt-dlp-linux-x64 ]; then echo "binary-version: $(/data/mstream/bin/yt-dlp/yt-dlp-linux-x64 --version 2>/dev/null || echo failed)"; fi
grep -E "\[yt-dlp\]" /tmp/boot.log | sed 's/^/  log: /' | head -12
EOF

HWORK="$(hostpath "$WORK")"

# ── One-time prep: an image with ffmpeg (the plug-in's other tool) and the
# checkout + npm ci on the app volume.
echo "== prep: image with ffmpeg, checkout + npm ci onto the app volume =="
printf 'FROM %s\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*\n' "$IMAGE_BASE" > "$WORK/Dockerfile"
dockerq build -q -t "$IMAGE" "$HWORK" >/dev/null
dockerq run --rm -v "$APP_VOL:/opt/mstream" -v "$HWORK:/work:ro" "$IMAGE" sh -ec '
  tar xf /work/src.tar -C /opt/mstream
  cd /opt/mstream && npm ci --omit=optional --no-audit --no-fund --loglevel=error
  ls bin/yt-dlp/; ffmpeg -version | head -1; command -v yt-dlp || echo "no yt-dlp on PATH (as intended)"' | tail -5

run_phase() { # $1=label $2=store-dir(or -) then env assignments
  local label="$1" store="$2"; shift 2
  local envs=()
  for kv in "$@"; do envs+=(-e "$kv"); done
  local mounts=(-v "$APP_VOL:/opt/mstream" -v "$DATA_VOL:/data" -v "$HWORK:/work:ro")
  [ "$store" != "-" ] && mounts+=(-v "$HWORK/$store:/store:ro")
  dockerq run --rm "${mounts[@]}" -e XDG_DATA_HOME=/data -e MANIFEST=manifest-old.json "${envs[@]}" \
    "$IMAGE" sh /work/phase.sh > "$WORK/$label.out" 2>&1
}
row() { grep '^ROW ' "$WORK/$1.out" | head -1 | cut -c5-; }
field() { node -pe "const r=JSON.parse(process.argv[1]); const v=$2; v===undefined?'':String(v)" "$(row "$1")" 2>/dev/null || echo ''; }
count() { grep "^$2: " "$WORK/$1.out" | head -1 | awk '{print $2}'; }
show() { sed -n '1,60p' "$WORK/$1.out"; }
wipe_data() { dockerq volume rm -f "$DATA_VOL" >/dev/null 2>&1 || true; }

echo "== phase A: fresh volume, no yt-dlp anywhere -> the pin ($OLD_TAG), then the newest ($NEW_TAG) =="
if run_phase A store-pin; then ok "phase A container succeeded"; else bad "phase A failed"; show A; fi
grep -q PHASE-READY "$WORK/A.out" && ok "the plug-in's probe answered (A)" || bad "no probe answer (A)"
[ "$(field A 'r.available')" = "true" ] && ok "youtube is available" || bad "youtube not available: $(row A)"
[ "$(field A 'r.detail.ytdlp')" = "$NEW_TAG" ] && ok "runs the newest release ($NEW_TAG)" || bad "version: $(field A 'r.detail.ytdlp')"
[ "$(field A 'r.detail.source')" = "managed" ] && ok "source: managed" || bad "source: $(field A 'r.detail.source')"
[ "$(count A fetches)" = "2" ] && ok "exactly two downloads: the pin, then the newest" || bad "fetches after A: $(count A fetches)"
grep -q "binary-version: $NEW_TAG" "$WORK/A.out" && ok "the real binary on the volume answers --version $NEW_TAG" || bad "binary-version: $(grep binary-version "$WORK/A.out")"
grep -qE "\"version\": ?\"$NEW_TAG\"" "$WORK/A.out" && grep -qE '"source": ?"mirror-latest"' "$WORK/A.out" && ok "receipt: $NEW_TAG from the store's latest" || bad "receipt: $(grep -A4 receipt: "$WORK/A.out" | tr -d '\n')"
grep -q "yt-dlp is not installed on this server — fetching mStream's own copy" "$WORK/A.out" && ok "logged why it fetched" || bad "no 'fetching' line"
grep -q "now at $NEW_TAG (was $OLD_TAG)" "$WORK/A.out" && ok "logged the move $OLD_TAG -> $NEW_TAG" || bad "no 'now at' line"

echo "== phase B: same volume, brand-new container -> ZERO downloads; the boot check reads the checksum file and stops =="
if run_phase B store-pin SETTLE=8; then ok "phase B container succeeded"; else bad "phase B failed"; show B; fi
[ "$(field B 'r.detail.ytdlp')" = "$NEW_TAG" ] && [ "$(field B 'r.detail.source')" = "managed" ] && ok "still $NEW_TAG, managed" || bad "row B: $(row B)"
[ "$(count B fetches)" = "2" ] && ok "no download on recreate" || bad "fetches after B: $(count B fetches)"
[ "$(count B sums-reads)" -ge 1 ] && ok "the post-boot check read the checksum file ($(count B sums-reads) reads so far)" || bad "sums-reads after B: $(count B sums-reads)"
grep -q "downloading" "$WORK/B.out" && bad "B logged a download" || ok "B logged no download"

echo "== phase C: the checksum file promises a build the asset does not hash to -> refused, $NEW_TAG kept =="
if run_phase C store-tamper SETTLE=8; then ok "phase C container succeeded"; else bad "phase C failed"; show C; fi
[ "$(field C 'r.detail.ytdlp')" = "$NEW_TAG" ] && ok "still $NEW_TAG" || bad "row C: $(row C)"
grep -q "checksum mismatch for $FILE" "$WORK/C.out" && ok "the mismatch was refused and logged" || bad "no mismatch line: $(grep 'log:' "$WORK/C.out" | tail -3)"
[ "$(count C fetches)" = "3" ] && ok "one download attempted, none installed" || bad "fetches after C: $(count C fetches)"
grep -qE "\"version\": ?\"$NEW_TAG\"" "$WORK/C.out" && ok "receipt untouched" || bad "receipt after C: $(grep -A4 receipt: "$WORK/C.out" | tr -d '\n')"

echo "== phase D: the store is down -> the check warns, the installed build runs =="
if run_phase D - STORE=0 SETTLE=8; then ok "phase D container succeeded"; else bad "phase D failed"; show D; fi
[ "$(field D 'r.available')" = "true" ] && [ "$(field D 'r.detail.ytdlp')" = "$NEW_TAG" ] && ok "available on $NEW_TAG without the store" || bad "row D: $(row D)"
grep -q "update check failed" "$WORK/D.out" && ok "the failed check was logged as a warning" || bad "no 'update check failed' line: $(grep 'log:' "$WORK/D.out" | tail -3)"

echo "== phase E: a yt-dlp on PATH far behind -> passed over; one that is current -> used =="
wipe_data
if run_phase E1 store-pin FAKE_VERSION=2025.01.15; then ok "phase E1 container succeeded"; else bad "phase E1 failed"; show E1; fi
[ "$(field E1 'r.detail.source')" = "managed" ] && [ "$(field E1 'r.detail.ytdlp')" = "$NEW_TAG" ] && ok "the old server copy was passed over for mStream's own ($NEW_TAG)" || bad "row E1: $(row E1)"
grep -q "yt-dlp on this server (2025.01.15) is .* days behind $OLD_TAG — fetching mStream's own copy" "$WORK/E1.out" && ok "logged how far behind it was" || bad "no 'days behind' line: $(grep 'log:' "$WORK/E1.out" | head -3)"
wipe_data
if run_phase E2 store-pin FAKE_VERSION="$NEW_TAG"; then ok "phase E2 container succeeded"; else bad "phase E2 failed"; show E2; fi
[ "$(field E2 'r.detail.source')" = "system" ] && [ "$(field E2 'r.detail.ytdlp')" = "$NEW_TAG" ] && ok "a current server copy runs (source: system)" || bad "row E2: $(row E2)"
[ "$(count E2 fetches)" = "0" ] && ok "and nothing was fetched" || bad "fetches after E2: $(count E2 fetches)"
[ "$(field E2 'r.detail.binary')" = "yt-dlp" ] && ok "named by its command" || bad "binary: $(field E2 'r.detail.binary')"

if [ "${REAL:-0}" = "1" ]; then
  echo "== phase F: no mirror — the pin from GitHub's release assets, the update through releases/latest =="
  wipe_data
  if run_phase F - STORE=0 REAL=1 SETTLE=4; then ok "phase F container succeeded"; else bad "phase F failed"; show F; fi
  [ "$(field F 'r.available')" = "true" ] && ok "youtube is available (F)" || bad "row F: $(row F)"
  [ "$(field F 'r.detail.source')" = "managed" ] && ok "source: managed (F)" || bad "source F: $(field F 'r.detail.source')"
  GOT=$(field F 'r.detail.ytdlp')
  [ -n "$GOT" ] && [ "$(printf '%s\n%s\n' "$NEW_TAG" "$GOT" | sort | tail -1)" = "$GOT" ] && ok "ends on $GOT (at or past $NEW_TAG)" || bad "version F: $GOT"
  grep -q "downloading $FILE (38.1 MB) from yt-dlp/yt-dlp@$OLD_TAG release assets" "$WORK/F.out" && ok "the pin came from the real release assets" || bad "no pin download line: $(grep 'log:' "$WORK/F.out" | head -3)"
  grep -q "downloading $FILE (release $GOT) from yt-dlp/yt-dlp release assets" "$WORK/F.out" && ok "the update came from the real newest release ($GOT)" || bad "no update download line: $(grep 'log:' "$WORK/F.out" | head -6)"
  grep -q "binary-version: $GOT" "$WORK/F.out" && ok "the real binary answers --version $GOT" || bad "binary-version F: $(grep binary-version "$WORK/F.out")"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
