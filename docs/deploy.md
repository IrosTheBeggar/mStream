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
downstream jobs (npm publish, demo deploy, website version stamp, the
apt/dnf repository — see [The Linux package repository](#the-linux-package-repository)).

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
   jobs (npm publish, demo deploy, website version stamp, the apt/dnf
   repository).

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

## The Linux package repository

Publishing a release also runs `Linux Package Repository`
(`.github/workflows/linux-repo.yml`): it takes the deb/rpm assets of the
three newest published stable releases, builds an apt and a dnf repository
from them, signs both, and uploads the result to the Bunny storage zone
behind `https://repo.mstream.io`. That is what lets a package install update
with `apt upgrade` / `dnf upgrade` ([install.md](install.md)). The scripts
are in `scripts/linux-repo/`; each one's header says what it does.

Nothing is uploaded until real clients have used the built repository:
Debian 11, Debian 13, Ubuntu 24.04, Fedora and AlmaLinux containers each
install the oldest served version from it, upgrade to the newest, and then
refuse a copy whose signed index was altered. A release whose packages
cannot be installed or upgraded through a package manager therefore stops
there, and the live repository stays on the previous release. After the
upload, the job waits until the CDN serves the new index and installs from
the live URL once more.

A pull request that touches the scripts or the workflow runs the same build
and gate with a throwaway key and no upload.

**When the run goes red**, the live repository is still whole — the upload
moves the index files last, and only once everything they name is in
storage. Fix the cause and run it again; every run rebuilds from the
published releases, so there is nothing to clean up first:

```shell
gh workflow run linux-repo.yml                  # rebuild + publish
gh workflow run linux-repo.yml -f dry_run=true  # build, gate, print the upload plan; change nothing
```

A dispatch from any branch but master is always a dry run.

The repository follows the published releases, one run behind any change
you make by hand: a release deleted from GitHub stays in it until the
workflow next runs (dispatch it to make that now). As with every other
install method, that only stops new installs — a machine that already
upgraded stays on the version it has until a newer one is published.

### One-time setup

Until the four required settings below exist the workflow only rehearses
(with a warning); with some but not all of them it fails.

1. **Bunny storage zone**, used for nothing else — a publish deletes files
   it does not recognise. Its name is the repository *variable*
   `LINUX_REPO_BUNNY_STORAGE_ZONE`; its password (FTP & API Access) is the
   *secret* `LINUX_REPO_BUNNY_STORAGE_PASSWORD`. If its main region is not
   Frankfurt, set the variable `LINUX_REPO_BUNNY_STORAGE_HOST` to the
   region's endpoint (`ny.storage.bunnycdn.com`, `uk.…`, `la.…`, `sg.…`,
   `se.…`, `br.…`, `jh.…`, `syd.…`).
2. **Pull zone** with that storage zone as its origin and the hostname
   `repo.mstream.io` (a CNAME to the pull zone, with its free certificate).
   The public address is the variable `LINUX_REPO_URL`
   (`https://repo.mstream.io`, no trailing slash). It is written into the
   `mstream.repo` file dnf users download, so it cannot move later without
   every one of them editing that file.
3. **CDN cache.** Bunny does not notice a file changing in storage, and a
   repository's index files change in place on every release. Either set
   the secret `LINUX_REPO_BUNNY_API_KEY` (the account API key, the one the
   website deploy uses) and the publish purges exactly the files it
   replaced — or give the pull zone an edge rule that does not cache
   `InRelease`, `Release`, `Release.gpg`, `Packages*`, `repomd.xml*`,
   `mstream.asc` and `mstream.repo`. The job's last step fails if the CDN is
   still serving the old index five minutes after the upload.
4. **Signing key** — below. The secrets are `LINUX_REPO_GPG_PRIVATE_KEY`
   and `LINUX_REPO_GPG_PASSPHRASE`.

Then run it once by hand, dry first:

```shell
gh workflow run linux-repo.yml -f dry_run=true
gh workflow run linux-repo.yml
```

### The signing key

One RSA-4096 key that certifies only, kept offline, plus an RSA-4096
signing subkey — the only secret CI ever holds. RSA because every client
verifies it, including the oldest rpm and apt the packages still run on.

```shell
export GNUPGHOME=$(mktemp -d)        # a scratch keyring, not your own
gpg --quick-generate-key "mStream package repository <paul@mstream.io>" rsa4096 cert never
FPR=$(gpg --list-keys --with-colons | awk -F: '$1 == "fpr" { print $10; exit }')
gpg --quick-add-key "$FPR" rsa4096 sign never
gpg --armor --export-secret-keys "$FPR"    > repo-key-MASTER.asc    # offline, with the other signing material
gpg --armor --export-secret-subkeys "$FPR" > repo-key-signing.asc   # -> LINUX_REPO_GPG_PRIVATE_KEY
gpg --show-keys --with-subkey-fingerprint repo-key-signing.asc      # note the fingerprints
```

gpg asks for a passphrase while generating; that passphrase is
`LINUX_REPO_GPG_PASSPHRASE`. The public key needs no handling — every
publish exports it to `https://repo.mstream.io/mstream.asc`.

`never`, because an expiry date is a deadline for every install rather than
for us: the day the key lapses, apt rejects the signatures that are already
published, and `apt update` fails everywhere until the expiry is extended,
republished and re-downloaded by each user. If the key does carry an
expiry, the build warns from 90 days out.

**The key is the repository's identity.** Installs trust the copy of
`mstream.asc` they downloaded once, so signing with anything else — a
regenerated key, a new subkey — breaks updates on all of them until their
owners fetch the file again. The workflow compares its key with the live
one before uploading and refuses a mismatch. If the signing subkey ever has
to be replaced (it leaked): revoke it and add a new one with the offline
master key, update the secret, run the workflow by hand with
`-f allow_key_change=true`, and tell users to repeat the `curl … mstream.asc`
line from [install.md](install.md) — put it in the release notes.
