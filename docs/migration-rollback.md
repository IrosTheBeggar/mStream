# Migration rollback

mStream's migration runner (`src/db/manager.js` → `runMigrations()`) is **one-way up-only by design**. Each migration applies in order, bumps `PRAGMA user_version`, and never has a paired "down" path. This document covers the one targeted exception we currently ship and how to use it safely.

## What ships with a rollback path

| Migration | Down SQL | Standalone runner |
|---|---|---|
| **V31** — FTS5 search (`fts_tracks`, `fts_artists`, `fts_albums` + nine sync triggers) | `SCHEMA_V31_DOWN` in `src/db/schema.js` | `scripts/rollback-v31.js` |

No other migration has a rollback. If you need to undo something pre-V31, restore from a backup of the SQLite database file — the migration runner is not equipped to walk backwards.

## When you'd reach for the V31 rollback

- A trigger correctness bug is suspected and you want to A/B compare search behaviour with and without FTS5 attached, against the same DB file.
- A future SQLite upgrade exposes a bug in FTS5 segment merging on your specific dataset (extremely rare — mostly a worst-case scenario).
- You're carrying out a planned roll-back of the mStream binary to a pre-V31 build and need the DB to match.

For "FTS5 is misbehaving on a particular query" without a planned downgrade, the **`algorithm` request param on `/api/v1/db/search` is the right escape hatch** — pass `"basic"` to force the LIKE path for one request without altering the schema. The rollback script is for the case where you also want to ship a code revert.

## How to run it

```sh
# Stop the server first — running this against a live DB is undefined.
systemctl stop mstream    # or however you supervise the service

# Run the rollback. Pass the path to mstream.db.
node scripts/rollback-v31.js /var/lib/mstream/mstream.db
```

The script:
1. Opens the DB at the given path.
2. Snapshots and logs the FTS5 objects it's about to drop.
3. Runs `SCHEMA_V31_DOWN` inside a single transaction (drops 3 virtual tables, drops 9 triggers, sets `PRAGMA user_version = 30`).
4. Verifies post-state (`user_version = 30`, zero `fts_*` objects remain).
5. Closes the DB.
6. Prints a **boomerang warning** to stderr.

Output goes to stderr so piping stdout (e.g. for scripting) doesn't hide it.

## ⚠️ The boomerang caveat

**The migration runner re-applies V31 on every boot when `user_version < 31`.** That means if you run this script and then start a v31-aware mStream binary, the next boot detects `user_version = 30` and re-applies V31 automatically — your rollback is undone before the first request lands.

The supported sequence is:

1. Stop the mStream service.
2. **Either** check out a pre-V31 build of the source (`git checkout <commit-before-V31>` + reinstall) **or** otherwise prevent the next boot from auto-migrating (e.g. a wrapper script that exits if `user_version < SCHEMA_VERSION`).
3. Run `node scripts/rollback-v31.js <db-path>`.
4. Start the pre-V31 build.

If you only do steps 1 + 3, you've effectively done nothing: the boot in step 4 will silently re-migrate.

## What about general-purpose down migrations?

There isn't a general "rollback to V_n" framework, and there are no plans to add one. The cost of maintaining tested down-SQL for every migration (especially ones that drop columns or rewrite data) is large, and the operator workflow that needs it — "I want to permanently downgrade my running mStream by N schema versions" — is rare enough that point-in-time DB backups are the better tool.

This V31-specific rollback exists because FTS5's surface (three virtual tables + nine triggers) is unusually self-contained — no source-row data is touched by V31 up, and dropping the FTS objects fully reverses the migration without losing anything. Future migrations that share that property may grow their own targeted rollback; most won't.
