#!/usr/bin/env bash
# Builds the signed apt + dnf repositories for mStream's deb/rpm packages.
#
#   REPO_URL=https://repo.mstream.io \
#   LINUX_REPO_GPG_PRIVATE_KEY="$(cat key.asc)" [LINUX_REPO_GPG_PASSPHRASE=...] \
#     bash scripts/linux-repo/build.sh <packages-dir> <out-dir>
#
# <packages-dir>  a flat folder of release packages under the names the
#                 release job attaches them: mstream_<ver>_{amd64,arm64}.deb
#                 and mstream-<ver>-1.{x86_64,aarch64}.rpm, for every version
#                 to serve (collect.sh fills it).
# <out-dir>       created; the tree to publish verbatim:
#     mstream.asc                    the public key (apt signed-by, dnf gpgkey)
#     apt/dists/stable/...           apt repository: suite "stable", component "main"
#     apt/pool/main/m/mstream/*.deb
#     rpm/repodata/...               dnf repository, both arches in one
#     rpm/packages/*.rpm
#     rpm/mstream.repo               drop-in for /etc/yum.repos.d
#
# ONE script for the publish workflow AND its rehearsal
# (.github/workflows/linux-repo.yml): the rehearsal feeds a throwaway key
# through the very same import/sign path, so the path that signs the real
# repository is the path every PR exercised.
#
# What is signed, and what that buys:
#   - apt: dists/stable/Release, inline (InRelease) and detached
#     (Release.gpg). Release pins the hash of every index, each index pins
#     the hash of every .deb - so the one signature covers the packages.
#   - dnf: repodata/repomd.xml, detached (repomd.xml.asc). The same chain:
#     repomd.xml -> primary.xml -> package checksums. The rpms themselves
#     are NOT signed (they are the release assets, byte for byte), which is
#     why mstream.repo says repo_gpgcheck=1 / gpgcheck=0: the metadata
#     signature is the integrity anchor, and clients must check it.
#
# Needs: apt-ftparchive (apt-utils), createrepo_c (createrepo-c, plus rpm for
# the rpmrc it reads), gpg + gpgv (gnupg), xz (xz-utils), gzip.
set -euo pipefail

die() { echo "linux-repo build: $*" >&2; exit 1; }
warn() {
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$*"; else echo "warning: $*" >&2; fi
}

pkgs="${1:?usage: build.sh <packages-dir> <out-dir>}"
out="${2:?usage: build.sh <packages-dir> <out-dir>}"
: "${REPO_URL:?REPO_URL (the public base URL of the repository) is required}"
: "${LINUX_REPO_GPG_PRIVATE_KEY:?LINUX_REPO_GPG_PRIVATE_KEY (the armored signing key) is required}"
REPO_URL="${REPO_URL%/}"
case "$REPO_URL" in
    http://*|https://*) ;;
    *) die "REPO_URL must be an http(s) URL, got '$REPO_URL'" ;;
esac

for tool in apt-ftparchive createrepo_c gpg gpgv xz gzip; do
    command -v "$tool" >/dev/null 2>&1 \
        || die "missing tool '$tool' (apt-get install apt-utils createrepo-c rpm gnupg xz-utils)"
done

[ -d "$pkgs" ] || die "no such packages dir: $pkgs"
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then die "$out exists and is not empty"; fi
mkdir -p "$out"
pkgs=$(cd "$pkgs" && pwd)
out=$(cd "$out" && pwd)

# ── Inventory ───────────────────────────────────────────────────────────────
# Every version must be complete (both arches, both formats) and nothing
# else may ride along: a half-uploaded release or a stray prerelease package
# would otherwise be published as if it were whole.
DEB_ARCHES=(amd64 arm64)
RPM_ARCHES=(x86_64 aarch64)

shopt -s nullglob
debs=("$pkgs"/*.deb)
rpms=("$pkgs"/*.rpm)
shopt -u nullglob
[ "${#debs[@]}" -gt 0 ] || die "no .deb packages in $pkgs"

versions=$(for f in "${debs[@]}"; do b=${f##*/}; b=${b#mstream_}; echo "${b%%_*}"; done | sort -uV)
nver=0
for v in $versions; do
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected package version '$v' (stable X.Y.Z only)"
    for a in "${DEB_ARCHES[@]}"; do
        [ -f "$pkgs/mstream_${v}_$a.deb" ] || die "version $v is incomplete: no mstream_${v}_$a.deb"
    done
    for a in "${RPM_ARCHES[@]}"; do
        [ -f "$pkgs/mstream-$v-1.$a.rpm" ] || die "version $v is incomplete: no mstream-$v-1.$a.rpm"
    done
    nver=$((nver + 1))
done
[ "${#debs[@]}" -eq $((nver * ${#DEB_ARCHES[@]})) ] || die "$pkgs holds .deb files beyond the $nver complete version(s)"
[ "${#rpms[@]}" -eq $((nver * ${#RPM_ARCHES[@]})) ] || die "$pkgs holds .rpm files beyond the $nver complete version(s)"

# ── Signing key ─────────────────────────────────────────────────────────────
# A private keyring that exists only for this run. The key arrives in the
# environment (a GitHub secret in the publish job, a throwaway in the
# rehearsal) and is never written anywhere but this temp dir.
work=$(mktemp -d)
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
cleanup() {
    gpgconf --kill all >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

# gpg, non-interactive, with the passphrase (when the key has one) on fd 3 -
# never on a command line, where any `ps` on the runner would show it.
gpg_batch() {
    if [ -n "${LINUX_REPO_GPG_PASSPHRASE:-}" ]; then
        gpg --batch --no-tty --pinentry-mode loopback --passphrase-fd 3 "$@" 3<<<"$LINUX_REPO_GPG_PASSPHRASE"
    else
        gpg --batch --no-tty --pinentry-mode loopback --passphrase '' "$@"
    fi
}

printf '%s\n' "$LINUX_REPO_GPG_PRIVATE_KEY" | gpg_batch --quiet --import 2>"$work/import.log" \
    || { cat "$work/import.log" >&2; die "could not import LINUX_REPO_GPG_PRIVATE_KEY"; }

mapfile -t secret_keys < <(gpg --batch --list-secret-keys --with-colons \
    | awk -F: '$1 == "sec" { want = 1 } $1 == "fpr" && want { print $10; want = 0 }')
[ "${#secret_keys[@]}" -eq 1 ] \
    || die "LINUX_REPO_GPG_PRIVATE_KEY must hold exactly one key, found ${#secret_keys[@]}"
fpr="${secret_keys[0]}"

# An expired key does not just stop the next publish: apt rejects the
# signatures ALREADY published the moment the key lapses, so every install's
# `apt update` starts failing. Shout well before that.
soon=$(( $(date +%s) + 90 * 86400 ))
while IFS=: read -r rec _ _ _ keyid _ expires _ _ _ _ caps _; do
    case "$rec" in pub|sub) ;; *) continue ;; esac
    [ -n "$expires" ] || continue
    case "$rec:$caps" in pub:*|sub:*s*) ;; *) continue ;; esac
    if [ "$expires" -lt "$soon" ]; then
        warn "repository signing key $keyid ($rec) expires $(date -u -d "@$expires" +%Y-%m-%d) - extend it and republish mstream.asc before then (docs/deploy.md)"
    fi
done < <(gpg --batch --list-keys --with-colons "$fpr")

sign() { gpg_batch --yes --local-user "$fpr" --digest-algo SHA512 "$@"; }

gpg --batch --armor --export-options export-minimal --export "$fpr" > "$out/mstream.asc"
[ -s "$out/mstream.asc" ] || die "public key export came out empty"
# Every signature below is verified against THIS file alone - the same bytes
# a user downloads - not against the keyring that made it.
gpg --batch --yes --dearmor --output "$work/pub.gpg" "$out/mstream.asc"
verify() { gpgv --quiet --keyring "$work/pub.gpg" "$@" 2>"$work/verify.log" || { cat "$work/verify.log" >&2; die "signature check failed: $*"; }; }

# Hardlink when the filesystem allows it (a gigabyte of packages), copy
# otherwise.
place() { ln "$1" "$2" 2>/dev/null || cp "$1" "$2"; }

# ── apt ─────────────────────────────────────────────────────────────────────
apt_root="$out/apt"
pool="$apt_root/pool/main/m/mstream"
suite="dists/stable"
mkdir -p "$pool"
for f in "${debs[@]}"; do place "$f" "$pool/${f##*/}"; done

(
    cd "$apt_root"
    for arch in "${DEB_ARCHES[@]}"; do
        d="$suite/main/binary-$arch"
        mkdir -p "$d"
        # Run from the archive root: Filename: must read pool/main/m/...
        apt-ftparchive --arch "$arch" packages pool > "$d/Packages" 2>"$work/ftparchive.log" \
            || { cat "$work/ftparchive.log" >&2; die "apt-ftparchive packages failed for $arch"; }
        n=$(grep -c '^Package: mstream$' "$d/Packages" || true)
        [ "$n" -eq "$nver" ] || die "apt index for $arch lists $n package(s), expected $nver"
        gzip -9n < "$d/Packages" > "$d/Packages.gz"
        xz -9 < "$d/Packages" > "$d/Packages.xz"
    done

    # Never change Origin/Label/Suite/Codename once published: apt refuses a
    # repository whose identity moved until the user confirms it by hand.
    apt-ftparchive \
        -o APT::FTPArchive::Release::Origin=mStream \
        -o APT::FTPArchive::Release::Label=mStream \
        -o APT::FTPArchive::Release::Suite=stable \
        -o APT::FTPArchive::Release::Codename=stable \
        -o APT::FTPArchive::Release::Architectures="${DEB_ARCHES[*]}" \
        -o APT::FTPArchive::Release::Components=main \
        -o APT::FTPArchive::Release::Description="mStream music server" \
        -o APT::FTPArchive::Release::Acquire-By-Hash=yes \
        release "$suite" > "$work/Release" 2>"$work/ftparchive.log" \
        || { cat "$work/ftparchive.log" >&2; die "apt-ftparchive release failed"; }
    grep -qx 'Acquire-By-Hash: yes' "$work/Release" \
        || die "this apt-ftparchive did not emit Acquire-By-Hash - the by-hash copies below would be dead weight"
    mv "$work/Release" "$suite/Release"

    # by-hash: apt asks for each index under its own hash
    # (binary-<arch>/by-hash/<Algo>/<hash>), so an index can never be read
    # against the wrong Release - the publish keeps the previous generation's
    # copies, and a client holding the old InRelease still finds its
    # indexes. apt picks the STRONGEST algorithm Release lists, so every
    # algorithm listed gets its directory. Made after Release, which must not
    # list them.
    for arch in "${DEB_ARCHES[@]}"; do
        d="$suite/main/binary-$arch"
        for f in Packages Packages.gz Packages.xz; do
            for pair in MD5Sum:md5sum SHA1:sha1sum SHA256:sha256sum SHA512:sha512sum; do
                algo=${pair%%:*}
                grep -qx "$algo:" "$suite/Release" || continue
                h=$("${pair##*:}" "$d/$f" | cut -d' ' -f1)
                mkdir -p "$d/by-hash/$algo"
                cp "$d/$f" "$d/by-hash/$algo/$h"
            done
        done
    done
    grep -qx 'SHA256:' "$suite/Release" || die "Release lists no SHA256 section"
)

sign --clearsign --output "$apt_root/$suite/InRelease" "$apt_root/$suite/Release"
sign --armor --detach-sign --output "$apt_root/$suite/Release.gpg" "$apt_root/$suite/Release"
verify "$apt_root/$suite/InRelease"
verify "$apt_root/$suite/Release.gpg" "$apt_root/$suite/Release"

# ── dnf ─────────────────────────────────────────────────────────────────────
rpm_root="$out/rpm"
mkdir -p "$rpm_root/packages"
for f in "${rpms[@]}"; do place "$f" "$rpm_root/packages/${f##*/}"; done

# gz and no sqlite: createrepo_c 1.x defaults to zstd, which older dnf/yum
# cannot read; every client reads gz. The metadata files carry their own
# checksum in their names (the default), so a publish never overwrites one
# - repomd.xml is the only pointer that moves.
createrepo_c --quiet --no-database --general-compress-type=gz --checksum=sha256 "$rpm_root" \
    || die "createrepo_c failed"
primary=("$rpm_root"/repodata/*-primary.xml.gz)
[ "${#primary[@]}" -eq 1 ] && [ -f "${primary[0]}" ] || die "createrepo_c left no primary.xml.gz"
n=$(gzip -dc "${primary[0]}" | grep -c '<package type="rpm">' || true)
[ "$n" -eq "${#rpms[@]}" ] || die "dnf metadata lists $n package(s), expected ${#rpms[@]}"

sign --armor --detach-sign --output "$rpm_root/repodata/repomd.xml.asc" "$rpm_root/repodata/repomd.xml"
verify "$rpm_root/repodata/repomd.xml.asc" "$rpm_root/repodata/repomd.xml"
# zypper looks for the key beside the metadata it signs.
cp "$out/mstream.asc" "$rpm_root/repodata/repomd.xml.key"

# metadata_expire: dnf's default is 48 hours, long enough that a release
# announced today is "not there" tomorrow. The check is one small file.
cat > "$rpm_root/mstream.repo" <<EOF
[mstream]
name=mStream
baseurl=$REPO_URL/rpm
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=$REPO_URL/mstream.asc
metadata_expire=1h
EOF

echo "linux-repo build: $nver version(s): $(echo "$versions" | paste -sd' ' -)"
echo "linux-repo build: signing key $fpr"
echo "linux-repo build: $(find "$out" -type f | wc -l) files, $(du -sh "$out" | cut -f1) in $out"
