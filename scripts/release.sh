#!/bin/sh
# The release ritual, encoded (docs/deploy.md is the narrative version):
#
#   sh scripts/release.sh X.Y.Z [--watch] [--dry-run] [--yes]
#
# Steps it performs, with every ordering rule and failure mode from the
# v6.24.0 retro (mStream#919) baked in:
#   1. preflight: clean master, up to date with origin, gh authed, version
#      sane and unreleased
#   2. bump package.json (npm version --no-git-tag-version), commit "vX.Y.Z",
#      push — this TRIGGERS Build Rust Launcher (its path filter includes
#      package.json) because the launcher binaries stamp the version
#   3. wait for that run and for its "ci: update pre-built mstream-launcher
#      binaries" commit; if the push event was eaten (GitHub outage —
#      it happens), dispatch the workflow instead
#   4. tag THAT commit (never the bump: the tag build's provenance assert
#      fails otherwise, by design) and push the tag
#   5. verify the tag build actually started; dispatch on the tag ref if the
#      tag event was eaten (identical semantics — ref_type is still "tag")
#   6. --watch: ride the tag build and summarize the DRAFT release
#
# Publishing the draft stays a human decision — publishing is what makes the
# release visible to every install's next update check.
#
# Dash-safe POSIX sh, same dialect as install.sh.

set -eu

VERSION=""
WATCH=0
DRY=0
YES=0
for a in "$@"; do
  case "$a" in
    --watch) WATCH=1 ;;
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    -*) echo "release.sh: unknown flag $a" >&2; exit 2 ;;
    *) VERSION="$a" ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: sh scripts/release.sh X.Y.Z [--watch] [--dry-run] [--yes]" >&2; exit 2; }

say()  { printf '\n== %s\n' "$1"; }
fail() { printf 'release.sh: %s\n' "$1" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
REPO="IrosTheBeggar/mStream"
LAUNCHER_WF="Build Rust Launcher"
BUNDLE_WF="Build Bun Server"
BINARIES_SUBJECT="ci: update pre-built mstream-launcher binaries"

# ── 1. Preflight ─────────────────────────────────────────────────────────────
say "preflight"
case "$VERSION" in
  *[!0-9.]*|.*|*.|*..*) fail "version must be X.Y.Z (got '$VERSION')" ;;
  *.*.*) : ;;
  *) fail "version must be X.Y.Z (got '$VERSION')" ;;
esac
command -v gh >/dev/null || fail "gh CLI is required"
command -v node >/dev/null || fail "node is required"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated (gh auth login)"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "master" ] || fail "run from master (currently on '$BRANCH')"
# -uno: untracked files are harmless to a release; TRACKED changes are not.
[ -z "$(git status --porcelain -uno)" ] || fail "working tree has uncommitted tracked changes"
git fetch -q origin master
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] \
  || fail "local master != origin/master (pull or push first)"

CURRENT=$(node -pe "require('./package.json').version")
[ "$VERSION" != "$CURRENT" ] || fail "package.json is already $CURRENT"
HIGHEST=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)
[ "$HIGHEST" = "$VERSION" ] || fail "$VERSION is not newer than current $CURRENT"
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
   || [ -n "$(git ls-remote --tags origin "v$VERSION")" ]; then
  fail "tag v$VERSION already exists"
fi
# A launcher run already in flight on master commits onto the tip it sees;
# start from a settled baseline rather than racing it (docs/deploy.md).
INFLIGHT=$(gh run list --repo "$REPO" --branch master -w "$LAUNCHER_WF" \
  --json status --jq '[.[] | select(.status != "completed")] | length')
[ "${INFLIGHT:-0}" = "0" ] || fail "a '$LAUNCHER_WF' run is in flight on master - let it finish first"

echo "current: $CURRENT -> releasing: $VERSION"
if [ "$DRY" = "1" ]; then
  echo "(dry run: preflight passed; stopping before any mutation)"
  exit 0
fi
if [ "$YES" != "1" ]; then
  printf 'proceed? [y/N] '
  read -r ANSWER
  case "$ANSWER" in y|Y|yes) : ;; *) echo "aborted"; exit 1 ;; esac
fi

# ── 2. Bump + push ───────────────────────────────────────────────────────────
say "bump $CURRENT -> $VERSION"
npm version "$VERSION" --no-git-tag-version >/dev/null
CHANGED=$(git status --porcelain -uno | awk '{print $2}' | sort | tr '\n' ' ')
[ "$CHANGED" = "package-lock.json package.json " ] \
  || fail "bump touched unexpected files: $CHANGED"
git add package.json package-lock.json
git commit -q -m "v$VERSION"
BUMP_SHA=$(git rev-parse HEAD)
git push -q origin master
echo "bump commit: $BUMP_SHA"

# ── 3. The launcher rebuild (version-stamped binaries) ───────────────────────
say "waiting for '$LAUNCHER_WF' (the bump triggers it; binaries stamp the version)"
RUN_ID=""
i=0
while [ $i -lt 24 ]; do
  RUN_ID=$(gh run list --repo "$REPO" --branch master -w "$LAUNCHER_WF" \
    --json databaseId,headSha --jq ".[] | select(.headSha == \"$BUMP_SHA\") | .databaseId" | head -1)
  [ -n "$RUN_ID" ] && break
  i=$((i + 1)); sleep 5
done
if [ -z "$RUN_ID" ]; then
  echo "no run appeared for the push after 2m - the event was likely eaten; dispatching instead"
  gh workflow run "$LAUNCHER_WF" --repo "$REPO" --ref master >/dev/null
  i=0
  while [ $i -lt 12 ]; do
    RUN_ID=$(gh run list --repo "$REPO" --branch master -w "$LAUNCHER_WF" \
      --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' | head -1)
    [ -n "$RUN_ID" ] && break
    i=$((i + 1)); sleep 5
  done
  [ -n "$RUN_ID" ] || fail "could not get a '$LAUNCHER_WF' run started (push AND dispatch both silent)"
fi
echo "launcher run: $RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status >/dev/null 2>&1 \
  || fail "'$LAUNCHER_WF' run $RUN_ID failed - fix it, then re-run it with 'Re-run ALL jobs' (never failed-only: the commit job refuses partial runs), and re-run this script; the bump commit is already on master, so re-running skips straight past it once package.json already says $VERSION"

say "waiting for its '$BINARIES_SUBJECT' commit"
TAG_SHA=""
i=0
while [ $i -lt 36 ]; do
  git fetch -q origin master
  CANDIDATE=$(git rev-parse origin/master)
  if [ "$CANDIDATE" != "$BUMP_SHA" ] \
     && git merge-base --is-ancestor "$BUMP_SHA" "$CANDIDATE" \
     && [ "$(git log --format=%s -1 "$CANDIDATE")" = "$BINARIES_SUBJECT" ] \
     && [ "$(git show "$CANDIDATE:bin/rust-launcher/.source-tree" | sed -n 2p)" = "$VERSION" ]; then
    TAG_SHA=$CANDIDATE
    break
  fi
  i=$((i + 1)); sleep 5
done
[ -n "$TAG_SHA" ] || fail "the binaries commit (stamped $VERSION) never appeared on master - check the '$LAUNCHER_WF' run, then re-run this script"
echo "binaries commit: $TAG_SHA (stamp verified: version $VERSION)"

# ── 4. Tag ───────────────────────────────────────────────────────────────────
say "tagging v$VERSION at $TAG_SHA"
git tag -a "v$VERSION" -m "v$VERSION" "$TAG_SHA"
git push -q origin "v$VERSION"

# ── 5. The tag build ─────────────────────────────────────────────────────────
say "verifying the tag build started"
TAG_RUN=""
i=0
while [ $i -lt 24 ]; do
  TAG_RUN=$(gh run list --repo "$REPO" -w "$BUNDLE_WF" \
    --json databaseId,headBranch,status --jq ".[] | select(.headBranch == \"v$VERSION\") | .databaseId" | head -1)
  [ -n "$TAG_RUN" ] && break
  i=$((i + 1)); sleep 5
done
if [ -z "$TAG_RUN" ]; then
  echo "no run for the tag after 2m - dispatching on the tag ref (identical semantics: ref_type stays 'tag')"
  gh workflow run "$BUNDLE_WF" --repo "$REPO" --ref "v$VERSION" >/dev/null
  sleep 20
  TAG_RUN=$(gh run list --repo "$REPO" -w "$BUNDLE_WF" \
    --json databaseId,headBranch --jq ".[] | select(.headBranch == \"v$VERSION\") | .databaseId" | head -1)
  [ -n "$TAG_RUN" ] || fail "could not get the tag build started (push AND dispatch both silent)"
fi
echo "tag build: https://github.com/$REPO/actions/runs/$TAG_RUN"

if [ "$WATCH" != "1" ]; then
  say "done (not watching)"
  echo "when the run is green it leaves a DRAFT release: review it, then publish -"
  echo "publishing is what makes v$VERSION visible to every install's next update check."
  exit 0
fi

# ── 6. Watch ─────────────────────────────────────────────────────────────────
say "watching the tag build (signing + notarization make this the long pole)"
if gh run watch "$TAG_RUN" --repo "$REPO" --exit-status >/dev/null 2>&1; then
  echo "tag build: green"
else
  gh run view "$TAG_RUN" --repo "$REPO" --json jobs \
    --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.conclusion)  \(.name)"'
  fail "tag build failed - see above; the tag itself is fine, re-run the workflow after fixing"
fi
say "draft release"
gh release view "v$VERSION" --repo "$REPO" \
  --json isDraft,assets --jq '"draft: \(.isDraft) - \(.assets | length) assets", (.assets[] | "  \(.name)")'
echo ""
echo "review the draft, then PUBLISH it - that is the ship moment."
