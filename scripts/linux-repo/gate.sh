#!/usr/bin/env bash
# The gate a built repository must pass before anything is uploaded - and
# the whole of the PR-time rehearsal. Serves the tree on a private docker
# network and has real apt and dnf clients use it:
#
#   1. every client installs mStream from it (and, given an older version,
#      installs that first and upgrades);
#   2. at least one apt client fetched its index by hash - the property the
#      publish order relies on (build.sh);
#   3. the same clients REFUSE a copy whose signed metadata was altered.
#      Without (3) a green (1) proves nothing about the signatures: a client
#      that silently skipped the check would pass it just the same.
#
#   bash scripts/linux-repo/gate.sh <out-dir> <newest-version> [<older-version>]
#
# <out-dir> is build.sh's output. It may have been built for any REPO_URL:
# the clients aim the served mstream.repo at the test server themselves.
set -euo pipefail

die() { echo "linux-repo gate: $*" >&2; exit 1; }

out="${1:?usage: gate.sh <out-dir> <newest-version> [<older-version>]}"
new="${2:?usage: gate.sh <out-dir> <newest-version> [<older-version>]}"
old="${3:-}"
here=$(cd "$(dirname "$0")" && pwd)
# Git Bash on Windows (where this gets run by hand): give docker a path it
# can mount (C:/..., not Git Bash's own /tmp or /c view) and keep MSYS from
# rewriting the container side of -v. Neither does anything elsewhere.
export MSYS_NO_PATHCONV=1
out=$(cd "$out" && { pwd -W 2>/dev/null || pwd; })
[ -f "$out/apt/dists/stable/InRelease" ] && [ -f "$out/rpm/repodata/repomd.xml" ] \
    || die "$out is not a built repository"

net="mstream-repo-gate-$$"
good="$net-good"
bad="$net-altered"
port=8099
# Beside the tree, not in $TMPDIR: docker must be able to mount it, and on
# some hosts only certain paths are shared with the engine.
altered="${out%/}.altered"
log=$(mktemp)

cleanup() {
    docker rm -f "$good" "$bad" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf "$altered" "$log"
}
trap cleanup EXIT

docker network create "$net" >/dev/null

serve() { # <container name> <directory>
    docker run -d --name "$1" --network "$net" -v "$2:/srv:ro" python:3.13-alpine \
        python -u -m http.server "$port" --directory /srv >/dev/null
    for _ in $(seq 1 30); do
        if docker exec "$1" python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$port/mstream.asc')" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    docker logs "$1" >&2 || true
    die "the test server for $2 never answered"
}

# ── 1. The real tree ────────────────────────────────────────────────────────
serve "$good" "$out"
LINUX_REPO_DOCKER_ARGS="--network $net" EXPECT=accept \
    bash "$here/test-install.sh" "http://$good:$port" "$new" "$old"

# ── 2. by-hash is in use ────────────────────────────────────────────────────
docker logs "$good" > "$log" 2>&1
grep -Eq '"GET /apt/dists/stable/main/binary-[a-z0-9]+/by-hash/[A-Za-z0-9]+/[0-9a-f]+ HTTP/[0-9.]+" 200' "$log" \
    || die "no apt client fetched an index by hash - Acquire-By-Hash is not taking effect"
if grep -E '" 404 ' "$log"; then
    echo "linux-repo gate: note - the clients asked for the path(s) above and got 404"
fi

# ── 3. An altered copy must be refused ──────────────────────────────────────
# Metadata only: a client that honours the signature never gets as far as a
# package. One word changes in what apt's signature covers, one line is
# added to what dnf's covers; the signatures are the originals.
rm -rf "$altered"
mkdir -p "$altered/apt" "$altered/rpm"
cp "$out/mstream.asc" "$altered/"
cp -R "$out/apt/dists" "$altered/apt/"
cp "$out/rpm/mstream.repo" "$altered/rpm/"
cp -R "$out/rpm/repodata" "$altered/rpm/"
sed -i 's/^Origin: mStream$/Origin: mStream-altered/' "$altered/apt/dists/stable/Release" "$altered/apt/dists/stable/InRelease"
grep -qx 'Origin: mStream-altered' "$altered/apt/dists/stable/InRelease" || die "could not alter InRelease for the tamper test"
echo '<!-- altered -->' >> "$altered/rpm/repodata/repomd.xml"

serve "$bad" "$altered"
LINUX_REPO_DOCKER_ARGS="--network $net" EXPECT=reject \
    bash "$here/test-install.sh" "http://$bad:$port" "$new"

echo "linux-repo gate: passed - clients install $new${old:+ (upgrading from $old)} and refuse an altered copy"
