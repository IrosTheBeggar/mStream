// The deep pre-flip probe (`mstream-server --boot-probe`) — the stage-time
// half of the bad-release defense. The installers already exec-probe a
// freshly extracted bundle with `-V` before flipping $ROOT/current; that
// proves the binary RUNS, not that it can BOOT. The crash classes that get
// through — a broken module graph, a config this build refuses, a database
// schema from its future — used to be caught only AFTER the flip, by the
// R1/R2 watchdogs (launcher / headless), which recover by rolling back.
// This probe moves the detection BEFORE the flip, where refusal is the
// cleanest outcome there is: the stage fails loudly, `current` never
// moves, the daily check retries, and the next release heals — the
// oldest, best-tested recovery path in the whole feature.
//
// Contract with the installers (install.sh / install.ps1):
//   - exit 0 = this build would boot here; nonzero = it would not.
//   - EVERY probe run prints a sentinel line starting "boot-probe:". A
//     bundle that predates this flag fails with an unknown-option error
//     and NO sentinel — the installers treat that as a pass (`-V` already
//     vouched), so a new installer can still stage old bundles (the
//     documented manual-rollback flow).
//   - No side effects, ever: nothing is created or written (no config
//     generation, no db open read-write, no attempt counters — the R2
//     boot watchdog is bypassed the same way `-V` bypasses it), so the
//     probe is safe to run while the OLD server is live, which is exactly
//     when managed staging runs it.
//   - Self-bounded: an async hang trips an internal timeout instead of
//     stalling the stage until its 30-minute kill.
//
// What it deliberately does NOT check: music-folder existence (an
// environment problem that would fail the OLD version too — refusing the
// update wouldn't help), and anything network- or port-shaped (the old
// server is still serving).
import fs from 'fs';
import path from 'path';

const PROBE_TIMEOUT_MS = 30_000;

function ok(detail) {
  console.log(`boot-probe: ok (${detail})`);
  process.exit(0);
}

function fail(reason) {
  console.log(`boot-probe: FAIL ${reason}`);
  process.exit(1);
}

// `configPath` is the same path the real boot would use (the wrapper's
// resolved default ladder, or an explicit -j).
export async function runBootProbe(configPath) {
  const timer = setTimeout(() => {
    fail(`timed out after ${PROBE_TIMEOUT_MS / 1000}s`);
  }, PROBE_TIMEOUT_MS);
  if (timer.unref) { timer.unref(); }

  const checked = [];

  // 1. The module graph — the same import the real boot performs before
  // serveIt(). Catches bundling regressions, missing/broken native deps
  // (the sqlite driver, onnx, iroh), and top-level module errors: the
  // single biggest execs-but-cannot-boot class.
  let config;
  try {
    await import('../server.js');
    config = await import('../state/config.js');
    checked.push('module graph');
  } catch (err) {
    clearTimeout(timer);
    return fail(`module graph did not load: ${err.message}`);
  }

  // 2. The config THIS machine already has, through THIS build's schema —
  // read + parse + validate only, never written, never generated (a fresh
  // install has no config yet: nothing to check, the real boot generates
  // its own defaults).
  let parsed = null;
  if (fs.existsSync(configPath)) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      clearTimeout(timer);
      return fail(`config ${configPath} did not parse: ${err.message}`);
    }
    try {
      await config.testValidation(parsed);
      checked.push('config');
    } catch (err) {
      clearTimeout(timer);
      return fail(`config ${configPath} fails this build's schema: ${err.message}`);
    }
  }

  // 3. The database, read-only. Two things worth knowing before a flip:
  // the sqlite driver actually opens a real db here (native-module proof
  // beyond a bare import), and the db's schema is not from this build's
  // FUTURE — user_version above our SCHEMA_VERSION means this build is an
  // older release being staged over a migrated db (a manual rollback
  // across a schema bump), where scans would refuse after the flip.
  // Anything environmental (locked, unreadable) is a note, not a failure:
  // the probe judges THIS BUILD, not this disk.
  try {
    const { DatabaseSync } = await import('../db/sqlite-driver.js');
    const { SCHEMA_VERSION } = await import('../db/schema.js');
    const dbDir = (parsed && parsed.storage && parsed.storage.dbDirectory)
      || config.getDefaults().storage.dbDirectory;
    const dbPath = path.join(dbDir, 'mstream.db');
    if (fs.existsSync(dbPath)) {
      let dbVersion = null;
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        dbVersion = db.prepare('PRAGMA user_version').get().user_version;
        db.close();
      } catch (err) {
        console.log(`boot-probe: note - could not inspect the database read-only (${err.message}) - continuing`);
      }
      if (dbVersion !== null) {
        if (dbVersion > SCHEMA_VERSION) {
          clearTimeout(timer);
          return fail(`this build's database schema (v${SCHEMA_VERSION}) predates the existing database (v${dbVersion}) - after a flip, scans would refuse to run`);
        }
        checked.push(`db schema v${dbVersion}<=v${SCHEMA_VERSION}`);
      }
    }
  } catch (err) {
    clearTimeout(timer);
    return fail(`database driver did not load: ${err.message}`);
  }

  clearTimeout(timer);
  ok(checked.join(', ') || 'nothing to check yet');
}
