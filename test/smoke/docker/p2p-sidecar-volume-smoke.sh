#!/bin/bash
# p2p-sidecar volume acceptance smoke — the Docker story for the
# fetch-on-first-use model (docs/p2p-sidecar-distribution.md):
#
#   phase A  fresh source container + empty persistent data volume:
#            the sidecar is FETCHED once (sha256-verified against the
#            manifest), lands ON the volume, and reaches ready through the
#            server's own spawn path.
#   phase B  destroy the container, recreate it on the same volume:
#            ZERO re-fetches — the receipted install is honored — and the
#            sidecar still reaches ready.
#   phase C  bump the manifest to a new sidecar build:
#            EXACTLY ONE refresh download; the receipt moves to the new
#            sha; ready again.
#
# The data volume is mapped over the server's data root for real: the
# checkout lives at /opt/mstream (a system prefix, so src/util/esm-helpers'
# dataRoot logic diverges from appRoot exactly like a packaged install) and
# XDG_DATA_HOME=/data puts dataRoot — and therefore the managed sidecar
# install + its .fetched.json receipt — on the named volume.
#
# Hermetic: the asset store is a loopback server INSIDE each container
# (MSTREAM_SIDECAR_BASE, the documented mirror override; the sha256 pins
# still apply), reading from a read-only bind mount and appending one line
# per download to /data/fetch.log — the volume-persisted hit counter the
# phases assert on. No egress, no real releases touched.
#
# Usage:
#   ASSETS_DIR=<dir> bash test/smoke/docker/p2p-sidecar-volume-smoke.sh
#
# ASSETS_DIR must contain this smoke's platform binary,
# `p2p-sidecar-linux-x64` (glibc — the smoke runs node:22-bookworm). Get one
# from a published mstream-p2p-sidecar release:
#   gh release download vX.Y.Z --repo IrosTheBeggar/mstream-p2p-sidecar \
#     --pattern p2p-sidecar-linux-x64 --dir <dir>
#
# Runs from anywhere inside the mStream checkout; uses `git archive HEAD`
# as the container source, so commit (or stash) what you want smoked.
set -euo pipefail

[ -n "${ASSETS_DIR:-}" ] || { echo "ASSETS_DIR is required (see the header)"; exit 2; }
[ -s "$ASSETS_DIR/p2p-sidecar-linux-x64" ] || { echo "ASSETS_DIR lacks p2p-sidecar-linux-x64"; exit 2; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE="${IMAGE:-node:22-bookworm}"
KEY=p2p-sidecar-linux-x64
APP_VOL=p2psmoke-app
DATA_VOL=p2psmoke-data
WORK="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
# MSYS_NO_PATHCONV: keep Git Bash on Windows from rewriting container paths.
dockerq() { MSYS_NO_PATHCONV=1 docker "$@"; }
# With conversion off, bind-mount HOST paths must be explicitly
# Windows-form on a Git Bash host (an MSYS /tmp/... path means nothing to
# Docker Desktop and silently mounts an empty directory).
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cleanup() {
  dockerq volume rm -f "$APP_VOL" "$DATA_VOL" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
dockerq volume rm -f "$APP_VOL" "$DATA_VOL" >/dev/null 2>&1 || true

# ── Store contents: v1 = the real binary; v2 = same binary + one trailing
# byte (still executes — ELF ignores trailing junk) so the phase-C bump is a
# genuinely different, genuinely runnable build.
mkdir -p "$WORK/store-v1" "$WORK/store-v2"
cp "$ASSETS_DIR/$KEY" "$WORK/store-v1/$KEY"
cp "$ASSETS_DIR/$KEY" "$WORK/store-v2/$KEY"
printf '\0' >> "$WORK/store-v2/$KEY"

# Schema-2 manifests pinning each version (tag differs; the mirror override
# serves whatever release the store dir mirrors, like a real mirror would).
node - "$WORK" "$KEY" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [work, key] = process.argv.slice(2);
for (const [dir, tag] of [['store-v1', 'v1.0.0-smoke'], ['store-v2', 'v1.0.1-smoke']]) {
  const buf = fs.readFileSync(path.join(work, dir, key));
  const manifest = {
    family: 'p2p-sidecar', schema: 2,
    repo: 'IrosTheBeggar/mstream-p2p-sidecar', tag,
    assets: { [key]: { file: key, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length } },
  };
  fs.writeFileSync(path.join(work, `manifest-${dir}.json`), JSON.stringify(manifest, null, 2));
  console.log(`${dir}: ${manifest.assets[key].sha256.slice(0, 16)}… (${buf.length} bytes, ${tag})`);
}
NODE

git -C "$REPO_ROOT" archive HEAD -o "$WORK/src.tar"

# Loopback store: serves the bind-mounted store dir, appends one line per
# binary download to /data/fetch.log (the volume-persisted hit counter).
cat > "$WORK/store-server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [dir, port] = process.argv.slice(2);
http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
  const file = path.join(dir, name);
  if (!name || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  fs.appendFileSync('/data/fetch.log', `${new Date().toISOString()} ${name}\n`);
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), '127.0.0.1', () => console.log(`[store] ${dir} on ${port}`));
EOF

# Server config: seed guards are LOAD-BEARING (dead seedListUrl +
# useCommunitySeeds:false + MSTREAM_TEST_BAKED_SEEDS='[]' below) — without
# them an enabled discoveryP2p container would join the REAL public network.
cat > "$WORK/config.json" <<'EOF'
{
  "port": 3555,
  "address": "127.0.0.1",
  "folders": { "music": { "root": "/music" } },
  "storage": {
    "dbDirectory": "/data/mstream-state/db",
    "albumArtDirectory": "/data/mstream-state/art",
    "logsDirectory": "/data/mstream-state/logs",
    "waveformCacheDirectory": "/data/mstream-state/wf"
  },
  "scanOptions": { "autoAlbumArt": false, "collectDiscoveryData": false, "analyzeBpm": false },
  "discoveryP2p": {
    "enabled": true,
    "seedListUrl": "http://127.0.0.1:9/discovery-seeds.json",
    "useCommunitySeeds": false
  }
}
EOF

# Per-phase container body: start the store, boot the server, wait for the
# sidecar to reach running:true, report state the host asserts on.
cat > "$WORK/phase.sh" <<'EOF'
#!/bin/sh
set -eu
MANIFEST="$1"
cp "/work/$MANIFEST" /opt/mstream/bin/p2p-sidecar/manifest.json
node /work/store-server.mjs /store 8765 & sleep 1
mkdir -p /music /data/mstream-state
cp /work/config.json /tmp/config.json
cd /opt/mstream
MSTREAM_SIDECAR_BASE=http://127.0.0.1:8765 MSTREAM_TEST_BAKED_SEEDS='[]' \
  node cli-boot-wrapper.js -j /tmp/config.json >/tmp/boot.log 2>&1 &
i=0
until curl -fsS http://127.0.0.1:3555/api/v1/ping >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 120 ] && { echo PHASE-BOOT-TIMEOUT; tail -30 /tmp/boot.log; exit 1; }
  sleep 1
done
i=0
until curl -fsS http://127.0.0.1:3555/api/v1/admin/discovery/p2p/status 2>/dev/null | grep -q '"running":true'; do
  i=$((i+1)); [ "$i" -gt 90 ] && { echo PHASE-SIDECAR-TIMEOUT; tail -30 /tmp/boot.log; exit 1; }
  sleep 1
done
echo "PHASE-RUNNING"
echo "fetch.log lines: $(wc -l < /data/fetch.log 2>/dev/null || echo 0)"
echo "receipt: $(cat /data/mstream/bin/p2p-sidecar/.fetched.json 2>/dev/null || echo none)"
ls /data/mstream/bin/p2p-sidecar/ 2>/dev/null | sed 's/^/  on-volume: /'
grep -E "p2p-sidecar\] (downloading|checksum|ready)" /tmp/boot.log | sed 's/^/  log: /' | head -5
EOF

# ── One-time prep: extract the checkout + npm ci onto the app volume.
HWORK="$(hostpath "$WORK")"
echo "== prep: checkout + npm ci onto the app volume (once) =="
dockerq run --rm -v "$APP_VOL:/opt/mstream" -v "$HWORK:/work:ro" "$IMAGE" sh -ec '
  tar xf /work/src.tar -C /opt/mstream
  cd /opt/mstream && npm ci --omit=optional --no-audit --no-fund --loglevel=error
  ls bin/p2p-sidecar/' | tail -4

run_phase() { # $1=label $2=manifest $3=store-dir
  dockerq run --rm \
    -v "$APP_VOL:/opt/mstream" -v "$DATA_VOL:/data" \
    -v "$HWORK:/work:ro" -v "$HWORK/$3:/store:ro" \
    -e XDG_DATA_HOME=/data \
    "$IMAGE" sh /work/phase.sh "$2" > "$WORK/$1.out" 2>&1
}
hits() { dockerq run --rm -v "$DATA_VOL:/data" "$IMAGE" sh -c 'wc -l < /data/fetch.log 2>/dev/null || echo 0' | tr -d '[:space:]'; }
receipt_sha() { dockerq run --rm -v "$DATA_VOL:/data" "$IMAGE" sh -c "node -pe \"JSON.parse(require('fs').readFileSync('/data/mstream/bin/p2p-sidecar/.fetched.json','utf8'))['$KEY']\"" | tr -d '[:space:]'; }

echo "== phase A: fresh container + empty volume -> one fetch, ready =="
if run_phase A manifest-store-v1.json store-v1; then ok "phase A container succeeded"; else bad "phase A failed"; sed -n '1,40p' "$WORK/A.out"; fi
grep -q "PHASE-RUNNING" "$WORK/A.out" && ok "sidecar running (A)" || bad "not running (A)"
[ "$(hits)" = "1" ] && ok "exactly one fetch hit the store" || bad "hits after A: $(hits)"
# Path via argv, not embedded in the -pe string: MSYS argv conversion makes
# it Windows-safe on a Git Bash host.
V1_SHA=$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).assets['$KEY'].sha256" "$WORK/manifest-store-v1.json")
[ "$(receipt_sha)" = "$V1_SHA" ] && ok "receipt on the volume pins v1" || bad "receipt: $(receipt_sha)"

echo "== phase B: same volume, brand-new container -> ZERO re-fetches, still ready =="
if run_phase B manifest-store-v1.json store-v1; then ok "phase B container succeeded"; else bad "phase B failed"; sed -n '1,40p' "$WORK/B.out"; fi
grep -q "PHASE-RUNNING" "$WORK/B.out" && ok "sidecar running (B)" || bad "not running (B)"
[ "$(hits)" = "1" ] && ok "no re-fetch on recreate (receipt honored)" || bad "hits after B: $(hits)"
grep -q "downloading" "$WORK/B.out" && bad "B logged a download" || ok "B logged no download"

echo "== phase C: manifest bumped to v2 -> exactly one refresh =="
if run_phase C manifest-store-v2.json store-v2; then ok "phase C container succeeded"; else bad "phase C failed"; sed -n '1,40p' "$WORK/C.out"; fi
grep -q "PHASE-RUNNING" "$WORK/C.out" && ok "sidecar running (C, refreshed build)" || bad "not running (C)"
[ "$(hits)" = "2" ] && ok "exactly one refresh download" || bad "hits after C: $(hits)"
V2_SHA=$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).assets['$KEY'].sha256" "$WORK/manifest-store-v2.json")
[ "$(receipt_sha)" = "$V2_SHA" ] && ok "receipt moved to v2" || bad "receipt after C: $(receipt_sha)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
