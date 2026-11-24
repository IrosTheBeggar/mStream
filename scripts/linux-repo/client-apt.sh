#!/usr/bin/env bash
# Runs INSIDE a Debian-family container (test-install.sh pipes it to bash):
# adds the mStream apt repository the way docs/install.md tells users to,
# then installs from it.
#
#   BASE_URL      the repository's base URL (the docs' https://repo.mstream.io)
#   NEW_VERSION   the newest version the repository serves
#   OLD_VERSION   optional: install this one first, then upgrade to NEW_VERSION
#   EXPECT        accept (default) | reject - reject: apt must REFUSE the
#                 repository's metadata over its signature (tamper test)
#
# No distro mirror is ever contacted: `apt-get update` is pointed at the
# mStream list alone and the package needs nothing beyond libc6. That keeps
# the run fast and means an image whose own release has been archived
# (Debian 11 is the oldest glibc the server supports) keeps working here.
set -euo pipefail

: "${BASE_URL:?}" "${NEW_VERSION:?}"
OLD_VERSION="${OLD_VERSION:-}"
EXPECT="${EXPECT:-accept}"
export DEBIAN_FRONTEND=noninteractive

fail() { echo "FAIL (apt): $*" >&2; exit 1; }

arch=$(dpkg --print-architecture)
key=/etc/apt/keyrings/mstream.asc
list=/etc/apt/sources.list.d/mstream.list
ours=(-o "Dir::Etc::sourcelist=$list" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0)

case "$BASE_URL" in
    https://*)
        # The base images carry no CA bundle; test-install.sh lends the
        # host's rather than pulling ca-certificates from a distro mirror.
        [ -s /etc/ssl/certs/ca-certificates.crt ] || fail "no CA bundle in the container for an https repository"
        ;;
esac

install -d -m 0755 /etc/apt/keyrings
# apt's own downloader: the base images have no curl either.
/usr/lib/apt/apt-helper download-file "$BASE_URL/mstream.asc" "$key" >/dev/null \
    || fail "could not download $BASE_URL/mstream.asc"

write_list() { echo "deb [arch=$1 signed-by=$key] $BASE_URL/apt stable main" > "$list"; }
# --error-on=any: a plain `apt-get update` exits 0 after a failed signature
# check ("the previous index files will be used").
update() { apt-get update "${ours[@]}" --error-on=any; }

write_list "$arch"

if [ "$EXPECT" = reject ]; then
    if update > /tmp/update.log 2>&1; then
        cat /tmp/update.log
        fail "apt accepted a repository whose signed metadata was altered"
    fi
    cat /tmp/update.log
    grep -Eiq 'signature|BADSIG|NO_PUBKEY|not signed' /tmp/update.log \
        || fail "apt refused the repository, but not over its signature"
    echo "OK (apt): refused the altered repository"
    exit 0
fi

update

expect_version() {
    local v
    v=$(dpkg-query -W -f='${Version}' mstream)
    [ "$v" = "$1" ] || fail "dpkg reports mstream $v, expected $1"
    v=$(/usr/bin/mstream-server -V)
    case "$v" in
        *"$1"*) ;;
        *) fail "mstream-server -V says '$v', expected $1" ;;
    esac
    echo "OK (apt): mstream $1 installed and runs"
}

# Use-Pty=0: without it dpkg redraws its progress line a hundred times into
# the log. No recommends: the tray's GTK stack would need the distro mirrors.
install=(apt-get install -y -q -o Dpkg::Use-Pty=0 --no-install-recommends)

if [ -n "$OLD_VERSION" ]; then
    # The path the repository exists for: an install on an older release
    # moves to the new one through the package manager.
    "${install[@]}" "mstream=$OLD_VERSION"
    expect_version "$OLD_VERSION"
    "${install[@]}" --only-upgrade mstream
else
    "${install[@]}" mstream
fi
expect_version "$NEW_VERSION"

# The other architecture cannot be executed here, but its half of the
# repository can be exercised: apt resolves it from its own index and
# verifies the download against the hashes there.
case "$arch" in
    amd64) other=arm64 ;;
    arm64) other=amd64 ;;
    *) other="" ;;
esac
if [ -n "$other" ]; then
    dpkg --add-architecture "$other"
    write_list "$other"
    update
    (cd /tmp && apt-get download "mstream:$other" >/dev/null && test -s "mstream_${NEW_VERSION}_${other}.deb") \
        || fail "could not fetch mstream $NEW_VERSION for $other from the repository"
    echo "OK (apt): mstream $NEW_VERSION for $other resolves and downloads"
fi
