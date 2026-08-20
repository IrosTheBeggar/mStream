#!/bin/sh
# Writes manifest.json for a release directory of mStream bundle zips.
#
#   scripts/release-manifest.sh <version> <dir-with-zips>
#
# The release's own inventory: {name, version, apiVersion, assets:[{file,
# sha256}]} - the same shape mstream-terminal-player publishes, so tooling
# that understands one understands both. install.sh / install.ps1 read it
# FIRST (to learn the exact asset name for their platform, then to verify
# the download); the launcher auto-updater will read the same file.
#
# ONE script for the release job AND the PR-time check (build-bun.yml), so
# the generator and the installers' parser can never drift apart unnoticed:
# the check runs install.sh against exactly what this emits.
#
# Contract the installers rely on (keep it, or bump apiVersion AND update
# both installers together):
#   - one asset per line, exactly:  {"file": "<name>", "sha256": "<hex64>"}
#     (install.sh greps that shape; it has no jq)
#   - "version" is the bare tag version (no leading v)
#   - assets are named mStream-<version>-<key>.zip
#   - native-installer assets (the win-x64 setup.exe and the darwin .pkgs)
#     appear as EXTRA lines of the same shape when present in the dir. The
#     install scripts grep by their own exact zip name, so extra lines are
#     invisible to them; the in-app updater (src/util/update-check.js) reads
#     these to verify the installer it downloads for Inno/pkg installs.
#
# Refuses (exit 1) when a zip's name does not carry EXACTLY this version
# followed by a known bundle key: the installers derive filenames from
# manifest.version, so a bundle built from a lagging or prerelease
# package.json would be un-installable - and 'prefix' matching would let
# mStream-6.21.0-beta.1-win-x64.zip pass for version 6.21.0.
set -eu
version="${1:?usage: release-manifest.sh <version> <dir>}"
dir="${2:?usage: release-manifest.sh <version> <dir>}"
case "$version" in
    *[!0-9A-Za-z.-]*|"") echo "release-manifest: bad version '$version'" >&2; exit 1 ;;
esac
cd "$dir"
keys="win-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl darwin-x64 darwin-arm64"
# Native installers whose hashes the in-app updater verifies. Exact names
# only, same version-strictness as the zips; absent files are simply not
# listed (releases build them independently of the bundles).
installers="mStream-$version-win-x64-setup.exe mStream-$version-darwin-x64.pkg mStream-$version-darwin-arm64.pkg"
found=0
for f in mStream-*.zip; do
    [ -e "$f" ] || { echo "release-manifest: no mStream-*.zip in $dir" >&2; exit 1; }
    ok=""
    for k in $keys; do
        [ "$f" = "mStream-$version-$k.zip" ] && ok=1
    done
    if [ -z "$ok" ]; then
        echo "release-manifest: $f is not mStream-$version-<key>.zip for a known key - package.json and the tag disagree, or an unknown bundle" >&2
        exit 1
    fi
done
# A setup.exe / .pkg for the WRONG version in the release dir is the same
# class of bug as a mismatched zip: refuse rather than list or skip it.
for f in mStream-*-setup.exe mStream-*.pkg; do
    [ -e "$f" ] || continue
    ok=""
    for i in $installers; do
        [ "$f" = "$i" ] && ok=1
    done
    if [ -z "$ok" ]; then
        echo "release-manifest: $f does not match mStream-$version-<target> for a known installer - refusing" >&2
        exit 1
    fi
done
{
    echo '{'
    echo '  "name": "mstream",'
    echo "  \"version\": \"$version\","
    echo '  "apiVersion": 1,'
    echo '  "assets": ['
    first=true
    for f in mStream-*.zip $installers; do
        [ -e "$f" ] || continue
        if command -v sha256sum >/dev/null 2>&1; then
            sum=$(sha256sum "$f" | cut -d' ' -f1)
        else
            sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
        fi
        $first || echo ','
        first=false
        found=$((found + 1))
        printf '    {"file": "%s", "sha256": "%s"}' "$f" "$sum"
    done
    echo ''
    echo '  ]'
    echo '}'
} > manifest.json
echo "release-manifest: $found assets -> $dir/manifest.json" >&2
