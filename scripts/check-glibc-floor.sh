#!/bin/bash
# Fails when an ELF needs a glibc symbol version above the floor.
#
#   scripts/check-glibc-floor.sh <floor> <file>...      assert
#   scripts/check-glibc-floor.sh --report <file>...     print only
#
# Prints every file's highest versioned glibc symbol (what the dynamic
# loader checks at exec/dlopen: "version `GLIBC_2.34' not found" is this
# number against the host's). A file with no such versions is static, or
# not an ELF. Used by build-rust-parser.yml on each Linux gnu scanner and by
# build-bun.yml on the Linux gnu bundles (docs/install.md states the floor).
set -euo pipefail
floor="$1"; shift
fail=0
for f in "$@"; do
  [ -f "$f" ] || { echo "  $f: missing"; fail=1; continue; }
  need=$(readelf -V "$f" 2>/dev/null | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/^GLIBC_//' | sort -uV | tail -1 || true)
  if [ -z "$need" ]; then echo "  $f: no glibc symbol versions (static or not an ELF)"; continue; fi
  if [ "$floor" = --report ]; then echo "  $f: glibc $need"; continue; fi
  if [ "$(printf '%s\n%s\n' "$need" "$floor" | sort -V | tail -1)" != "$floor" ]; then
    echo "::error::$f needs glibc $need, above the floor $floor"; fail=1
  else
    echo "  $f: glibc $need (floor $floor)"
  fi
done
exit $fail
