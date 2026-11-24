#!/usr/bin/env bash
# Downloads the deb/rpm packages of the newest stable server releases - the
# set of versions the apt/dnf repository serves.
#
#   GH_TOKEN=... bash scripts/linux-repo/collect.sh <dest-dir> [keep]
#
# <dest-dir>  filled with mstream_<ver>_{amd64,arm64}.deb and
#             mstream-<ver>-1.{x86_64,aarch64}.rpm for each kept version,
#             plus a VERSIONS file (newest first, one per line).
# keep        how many releases to serve (default 3). Older versions stay
#             installable by pinning (apt install mstream=X) and give a bad
#             release somewhere to roll back to.
#
# Only PUBLISHED stable server releases count (vX.Y.Z; no drafts, no
# prereleases, none of the repo's other release channels - sidecars, models,
# the legacy desktop player). The repository is rebuilt from scratch from
# this set on every run, so it holds nothing a GitHub release does not.
set -euo pipefail

die() { echo "linux-repo collect: $*" >&2; exit 1; }

dest="${1:?usage: collect.sh <dest-dir> [keep]}"
keep="${2:-3}"
repo="${GITHUB_REPOSITORY:-IrosTheBeggar/mStream}"
case "$keep" in ''|*[!0-9]*|0) die "keep must be a positive integer, got '$keep'" ;; esac
command -v gh >/dev/null 2>&1 || die "the gh CLI is required"
mkdir -p "$dest"

# By VERSION, not by date: a patch for an older line published later must
# not push a newer release out of the set.
tags=$(gh release list --repo "$repo" --exclude-drafts --exclude-pre-releases --limit 200 \
        --json tagName --jq '.[].tagName' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -rV) \
    || die "no stable vX.Y.Z release found in $repo"

got=0
: > "$dest/VERSIONS"
for tag in $tags; do
    [ "$got" -lt "$keep" ] || break
    ver="${tag#v}"
    want=("mstream_${ver}_amd64.deb" "mstream_${ver}_arm64.deb" "mstream-${ver}-1.x86_64.rpm" "mstream-${ver}-1.aarch64.rpm")
    have=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name')
    missing=""
    for f in "${want[@]}"; do
        grep -qxF "$f" <<<"$have" || missing="$missing $f"
    done
    if [ -n "$missing" ]; then
        # The newest release without its packages means the repository would
        # silently stop at the previous version - that is a failure, not a
        # skip. An OLDER incomplete release just is not served.
        [ "$got" -gt 0 ] || die "the newest stable release $tag is missing:$missing"
        echo "linux-repo collect: skipping $tag (no complete package set:$missing)"
        continue
    fi
    patterns=()
    for f in "${want[@]}"; do patterns+=(--pattern "$f"); done
    gh release download "$tag" --repo "$repo" --dir "$dest" --clobber "${patterns[@]}"
    for f in "${want[@]}"; do
        [ -s "$dest/$f" ] || die "$tag: $f did not download"
    done
    echo "$ver" >> "$dest/VERSIONS"
    got=$((got + 1))
    echo "linux-repo collect: $tag"
done
[ "$got" -gt 0 ] || die "nothing collected"
echo "linux-repo collect: $got version(s) in $dest: $(tr '\n' ' ' < "$dest/VERSIONS")"
