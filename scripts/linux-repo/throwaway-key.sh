#!/usr/bin/env bash
# Prints an armored, passphrase-protected throwaway signing key for the
# repository rehearsal.
#
#   key=$(bash scripts/linux-repo/throwaway-key.sh <passphrase>)
#
# Shaped like the real key (docs/deploy.md): a certify-only RSA-4096 primary
# whose secret half is NOT exported, plus an RSA-4096 signing subkey. So the
# rehearsal signs with a subkey, behind a passphrase, from a subkey-only
# export - the three things that differ from the naive "one key, no
# passphrase" case and that apt (gpgv, sqv) and dnf (gpgme, rpm-sequoia)
# each have to accept.
set -euo pipefail

pass="${1:?usage: throwaway-key.sh <passphrase>}"
home=$(mktemp -d)
trap 'gpgconf --homedir "$home" --kill all >/dev/null 2>&1 || true; rm -rf "$home"' EXIT

g() { gpg --homedir "$home" --batch --no-tty --quiet --no-auto-check-trustdb --pinentry-mode loopback --passphrase "$pass" "$@"; }

# A year, not days: build.sh warns about a key within 90 days of expiry, and
# a rehearsal must not cry wolf on every run. The key is worthless to anyone
# - nothing ever trusts it - so its lifetime protects nothing.
g --quick-generate-key "mStream repository rehearsal <rehearsal@invalid>" rsa4096 cert 1y
fpr=$(g --list-keys --with-colons | awk -F: '$1 == "fpr" { print $10; exit }')
g --quick-add-key "$fpr" rsa4096 sign 1y
g --armor --export-secret-subkeys "$fpr"
