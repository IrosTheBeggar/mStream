# Release Instructions

Cutting a release is one command:

```shell
sh scripts/release.sh X.Y.Z --watch
```

It runs the whole ritual below — preflight (clean up-to-date master, gh
authed, version sane and untagged), bump + push, wait for the launcher
binaries commit, tag the right SHA, confirm the tag build started — and
with `--watch` rides the build and summarizes the draft. If GitHub drops a
push or tag event (it happens — v6.24.0 shipped through an Actions outage),
the script falls back to `gh workflow run` on the same ref, which is
semantically identical. `--dry-run` stops after preflight; the script is
safe to re-run after any failure — it refuses or skips whatever already
happened.

The one thing it never does is publish: the tag build leaves a **draft**
release. Review it, then publish by hand — publishing is what makes the
version visible to every install's next update check, and it fires the
downstream jobs (npm publish, demo deploy, website version stamp).

## The ritual the script encodes (by hand, if you ever need it)

The order matters: the release tag must land on a commit whose committed
launcher binaries were built for THAT version — the tag build asserts it
and fails otherwise.

1. Bump the version **without tagging**:

   ```shell
   npm version X.X.X --no-git-tag-version
   git commit -am "vX.X.X"
   git push
   ```

2. **Wait for the `Build Rust Launcher` workflow to finish and push its
   `ci: update pre-built mstream-launcher binaries` commit** to master (the
   package.json bump triggers it; ~5 min). That commit carries launcher
   binaries whose Windows VersionInfo says X.X.X, and a provenance stamp
   (`bin/rust-launcher/.source-tree`) recording the launcher source tree,
   the version, and the two embedded icons they were built from.

   If that workflow goes red, fix and re-run it with **"Re-run all jobs"**
   (or `workflow_dispatch`), never "Re-run failed jobs": the commit job
   refuses to commit unless all four binaries came out of the same run.

3. Tag **that commit, by its SHA** — not the bump commit, and not "whatever
   master is now" (anything merged after the binaries commit would ride
   under the tag, and if it touched an input the launcher embeds — its
   icons, for one — the tag build fails on the stamp):

   ```shell
   git fetch origin
   git log --oneline -3 origin/master        # find "ci: update pre-built mstream-launcher binaries"
   git tag -a vX.X.X -m "vX.X.X" <that-sha>
   git push origin vX.X.X
   ```

4. The tag build (`Build Bun Server`) asserts the stamp matches the tag's
   launcher tree, version and icons — a tag cut on the bump commit itself
   fails with instructions instead of shipping an mStream.exe that reports
   the previous version — then attaches the bundles + `manifest.json` to a
   **draft** release. Review, then publish. Publishing fires the downstream
   jobs (npm publish, demo deploy, website version stamp).

Why not `npm version` alone: it tags the bump commit in the same breath, and
at that instant the committed launcher binaries are still the previous
version's (v6.20.1 shipped that way — its `mStream.exe` reported 6.20.0).

Why the bump must not race a launcher change: `Build Rust Launcher` runs
serialize, and a queued run commits onto the CURRENT master tip — it stands
down if newer launcher inputs already landed there (that push's own run owns
the binaries). So a bump pushed right after a launcher PR merges is fine;
just wait for the LAST binaries commit before tagging.

## When a release goes bad

Auto-update is the default, so a bad release reaches installs fast — and
the recovery ladder means the fix does too. There is exactly one move:

**Tag and publish the fixed patch immediately.** Every recovery path below
converges on "a newer release supersedes the bad one on its own." Speed of
the fix is the whole game; nothing else you can do from the repo side
reaches installs faster.

What the fleet handles without you:

- **Detectable before the switch** (corrupt asset, missing platform
  bundle, a binary that cannot exec, a config the new schema refuses, a
  database from the build's future): staging refuses — the installers
  verify sha256 and run both `-V` and `--boot-probe` before `current`
  moves. Nothing changed on the install; the daily check picks up your
  patch normally.
- **Crashes at first boot anyway**: the boot watchdogs (the tray app on
  desktops; the server binary itself on headless installs) roll `current`
  back to the previous version, record the bad version in
  `update-hold.json`, and keep serving. Held versions are never re-staged;
  the hold clears by itself once a version newer than it boots — i.e. when
  your patch lands.
- **Runs but misbehaves**: the daily check stages and applies your patch.

What does NOT work — the two classic mistakes:

- **Deleting the release from GitHub does not protect anyone who already
  staged it.** Their `current` already points at it, the launcher still
  applies it, and recently-checked installs won't look again for a day.
  Yank it to stop NEW downloads if you like, but the yank is cosmetic —
  the patch tag is the fix.
- **Never modify a published release's assets** (the release job refuses
  anyway): builds aren't byte-reproducible, so a re-upload gives mid-flight
  installers sha256 mismatches. A re-ship is always a new patch version.

Per-install brakes, for operators (all on the admin panel's About page):
the **skip** link (`updates.skipVersion`) holds one version back and
un-stages it on the spot; **clear hold & retry** (`clearHold`) overrides a
boot-failure hold after an environmental cause is fixed; a manual rollback
is `MSTREAM_VERSION=<old tag>` through the installer plus a skip of the bad
version — noting that after a database schema bump, an older binary serves
fine but scans refuse until re-upgraded (fix-forward is always the primary
story).

Reading the field when something went wrong: the admin panel shows held
versions; `update-hold.json` and `boot-attempts.json` sit in the data home
beside `update-status.json`; the tray's `launcher.log` narrates a rollback
("update watchdog: ... rolling back to ...").

Pre-release checklist, beyond green CI (which already covers the installer
contracts, the launcher's rollback/apply smokes, and a real pkg install
over a running instance):

- **One manual Windows inno auto-update dry run** before the first tag of
  a release cycle: stage an update on an inno install in auto mode and let
  the tray run the silent installer end to end. The pieces have CI and
  unit coverage, but the machine-driven silent-install relaunch is the one
  path no runner exercises.
- **On a database schema bump**, say so in the release notes: rolling back
  across it leaves scans refusing until re-upgrade, and the watchdogs may
  legitimately park someone on the previous version with that caveat until
  the next patch.
