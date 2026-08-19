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
