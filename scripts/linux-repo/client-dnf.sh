#!/usr/bin/env bash
# Runs INSIDE a Fedora/EL-family container (test-install.sh pipes it to
# bash): adds the mStream dnf repository from the .repo file the repository
# itself serves, then installs from it.
#
#   BASE_URL      the repository's base URL (the docs' https://repo.mstream.io)
#   NEW_VERSION   the newest version the repository serves
#   OLD_VERSION   optional: install this one first, then upgrade to NEW_VERSION
#   EXPECT        accept (default) | reject - reject: dnf must REFUSE the
#                 repository's metadata over its signature (tamper test)
#
# Only the mStream repository is enabled (--repo), so no distro mirror is
# contacted and the image's own release may be long out of support.
set -euo pipefail

: "${BASE_URL:?}" "${NEW_VERSION:?}"
OLD_VERSION="${OLD_VERSION:-}"
EXPECT="${EXPECT:-accept}"

fail() { echo "FAIL (dnf): $*" >&2; exit 1; }

repo=/etc/yum.repos.d/mstream.repo
curl -fsSL "$BASE_URL/rpm/mstream.repo" -o "$repo" || fail "could not download $BASE_URL/rpm/mstream.repo"

# The rpms are not signed, so the metadata signature is the whole integrity
# story: a .repo file without the check would install anything the server
# (or a CDN in between) hands out.
grep -qx 'repo_gpgcheck=1' "$repo" || fail "the served mstream.repo does not set repo_gpgcheck=1"
grep -q '^gpgkey=' "$repo" || fail "the served mstream.repo names no gpgkey"

# Aim the file at the server under test. Against the live host this changes
# nothing - and there the served file must already say so.
if [ "${REQUIRE_PUBLIC_URLS:-}" = 1 ]; then
    grep -qxF "baseurl=$BASE_URL/rpm" "$repo" || fail "the served mstream.repo does not point at $BASE_URL/rpm"
    grep -qxF "gpgkey=$BASE_URL/mstream.asc" "$repo" || fail "the served mstream.repo does not name $BASE_URL/mstream.asc"
fi
sed -i -e "s#^baseurl=.*#baseurl=$BASE_URL/rpm#" -e "s#^gpgkey=.*#gpgkey=$BASE_URL/mstream.asc#" "$repo"

# Weak deps (the tray's GTK stack) would need the distro's repositories.
dnf=(dnf -y --repo=mstream --setopt=install_weak_deps=False)

if [ "$EXPECT" = reject ]; then
    if "${dnf[@]}" install mstream > /tmp/install.log 2>&1; then
        cat /tmp/install.log
        fail "dnf accepted a repository whose signed metadata was altered"
    fi
    cat /tmp/install.log
    grep -Eiq 'signature|gpg|pgp' /tmp/install.log \
        || fail "dnf refused the repository, but not over its signature"
    echo "OK (dnf): refused the altered repository"
    exit 0
fi

expect_version() {
    local v
    v=$(rpm -q --qf '%{VERSION}-%{RELEASE}' mstream)
    [ "$v" = "$1-1" ] || fail "rpm reports mstream $v, expected $1-1"
    v=$(/usr/bin/mstream-server -V)
    case "$v" in
        *"$1"*) ;;
        *) fail "mstream-server -V says '$v', expected $1" ;;
    esac
    echo "OK (dnf): mstream $1 installed and runs"
}

if [ -n "$OLD_VERSION" ]; then
    "${dnf[@]}" install "mstream-$OLD_VERSION"
    expect_version "$OLD_VERSION"
    "${dnf[@]}" upgrade mstream
else
    "${dnf[@]}" install mstream
fi
expect_version "$NEW_VERSION"

# The other architecture's packages live in the same repository; they cannot
# run here, but the client must see them.
case "$(uname -m)" in
    x86_64) other=aarch64 ;;
    aarch64) other=x86_64 ;;
    *) other="" ;;
esac
if [ -n "$other" ]; then
    "${dnf[@]}" --forcearch="$other" repoquery --qf '%{name}-%{version}-%{release}.%{arch}\n' mstream > /tmp/other.txt
    grep -qxF "mstream-$NEW_VERSION-1.$other" /tmp/other.txt \
        || { cat /tmp/other.txt; fail "the repository does not offer mstream $NEW_VERSION for $other"; }
    echo "OK (dnf): mstream $NEW_VERSION for $other is offered"
fi
