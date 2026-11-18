#!/usr/bin/env bash
# Drives real package-manager clients against a served copy of the
# repository: each image below adds the repository and installs mStream
# from it (client-apt.sh / client-dnf.sh run inside the container).
#
#   bash scripts/linux-repo/test-install.sh <base-url> <newest-version> [<older-version>]
#
# With <older-version>, each client installs that one first and then
# upgrades - the path the repository exists for.
#
# Env:
#   EXPECT=accept|reject      reject: every client must REFUSE the repository
#                             over its signature (gate.sh's tamper test)
#   APT_IMAGES / DNF_IMAGES   space-separated image lists (defaults below;
#                             set one empty to skip that family)
#   LINUX_REPO_DOCKER_ARGS    extra `docker run` arguments, e.g. the network
#                             a local test server lives on
#   REQUIRE_PUBLIC_URLS=1     the served mstream.repo must already point at
#                             <base-url> (set for the live check)
#
# The default images bracket what users run rather than follow it: Debian 11
# is the oldest glibc the server supports and Debian 13 the strictest
# signature checker (apt 3 verifies with sqv, not gpgv); Ubuntu 24.04 sits
# between. Fedora is dnf5 on rpm 6, AlmaLinux 9 the dnf4 the whole EL family
# shares. Pinned tags: a rehearsal must not go red because a distro shipped.
set -euo pipefail

base="${1:?usage: test-install.sh <base-url> <newest-version> [<older-version>]}"
new="${2:?usage: test-install.sh <base-url> <newest-version> [<older-version>]}"
old="${3:-}"
base="${base%/}"
here=$(cd "$(dirname "$0")" && pwd)

: "${EXPECT:=accept}"
# `=`, not `:=`: an EMPTY list switches that family off (a quick local run).
: "${APT_IMAGES=debian:11 debian:13 ubuntu:24.04}"
: "${DNF_IMAGES=fedora:44 almalinux:9}"
[ -n "$APT_IMAGES$DNF_IMAGES" ] || { echo "linux-repo test: no client images to run" >&2; exit 1; }
read -r -a extra <<<"${LINUX_REPO_DOCKER_ARGS:-}"

args=(--rm -i -e "BASE_URL=$base" -e "NEW_VERSION=$new" -e "OLD_VERSION=$old" -e "EXPECT=$EXPECT"
    -e "REQUIRE_PUBLIC_URLS=${REQUIRE_PUBLIC_URLS:-}")
# The Debian-family base images ship no CA bundle. Lend them the host's
# instead of installing ca-certificates from a distro mirror (see
# client-apt.sh on why no mirror is ever contacted).
ca=/etc/ssl/certs/ca-certificates.crt
case "$base" in
    https://*) if [ -s "$ca" ]; then args+=(-v "$ca:$ca:ro"); fi ;;
esac

group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "=== $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

failed=""
run_client() { # <image> <client script>
    group "$1 ($EXPECT)"
    # The script goes in on stdin: no bind mount, so this works against any
    # docker host.
    if docker run "${args[@]}" "${extra[@]}" "$1" bash -s < "$here/$2"; then
        endgroup
    else
        endgroup
        echo "linux-repo test: $1 FAILED" >&2
        failed="$failed $1"
    fi
}

for image in $APT_IMAGES; do run_client "$image" client-apt.sh; done
for image in $DNF_IMAGES; do run_client "$image" client-dnf.sh; done

if [ -n "$failed" ]; then
    echo "linux-repo test: failed on:$failed" >&2
    exit 1
fi
echo "linux-repo test: every client passed ($EXPECT) against $base"
