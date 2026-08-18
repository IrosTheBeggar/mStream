# Release Instructions

Getting github actions to properly work requires a specific set of steps.
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
   (`bin/rust-launcher/.source-tree`) recording the launcher source tree AND
   the version they were built for.

3. Tag **that** commit, not the bump commit:

   ```shell
   git pull
   git tag vX.X.X          # on the "ci: update pre-built..." commit
   git push --tags
   ```

4. The tag build (`Build Bun Server`) asserts the stamp matches the tag's
   launcher tree and version — a tag cut on the bump commit itself fails with
   instructions instead of shipping an mStream.exe that reports the previous
   version — then attaches the bundles + `manifest.json` to a **draft**
   release. Review, then publish. Publishing fires the downstream jobs
   (npm publish, demo deploy, website version stamp).

Why not `npm version` alone: it tags the bump commit in the same breath, and
at that instant the committed launcher binaries are still the previous
version's (v6.20.1 shipped that way — its `mStream.exe` reported 6.20.0).
