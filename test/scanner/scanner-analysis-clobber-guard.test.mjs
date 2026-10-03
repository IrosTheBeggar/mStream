/**
 * Scanner clobber-guard for analysed BPM/key and AcoustID-derived MBIDs (the
 * enrichment preserve CASEs in the tracks UPSERT), plus the essentia pass's
 * no-decode refill from audio_analysis_lookups (V78) that repairs what the
 * CASE cannot tell apart.
 *
 * A re-parse (tag edit, touch, force rescan, a rescanRequired epoch) used to
 * write the file's tags over every one of these columns, so values the
 * post-scan passes had derived from the AUDIO went NULL — and the 'analyzed'
 * ledger row then kept the track off the analysis work list for 90 days.
 *
 * The UPSERT text is extracted from BOTH scanners' sources at runtime
 * (src/db/scanner.mjs and rust-parser/src/main.rs — the Rust literal runs
 * as-is under node:sqlite) and every case runs against each, so neither can
 * drift from the rules here. The worker statements come from
 * src/db/audio-analysis-lib.js, the module the worker itself prepares them
 * from. A real scan of both engines is in scanner-analysis-survival.test.mjs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import {
  REFILL_FROM_LEDGER_SQL, FILL_ANALYSIS_SQL, RECORD_ANALYZED_SQL, selectEligibleSql,
} from '../../src/db/audio-analysis-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const UPSERT_RE = /INSERT INTO tracks \(filepath[\s\S]*?RETURNING id/;
const ENGINES = {
  js: fs.readFileSync(path.join(REPO, 'src/db/scanner.mjs'), 'utf8').match(UPSERT_RE)[0],
  rust: fs.readFileSync(path.join(REPO, 'rust-parser/src/main.rs'), 'utf8').match(UPSERT_RE)[0],
};

// The scanners' FULL column order — same list (and the same positional-drift
// caveat) as scanner-lyrics-clobber-guard.test.mjs.
const COLS = [
  'filepath', 'library_id', 'title', 'artist_id', 'album_id', 'track_number',
  'disc_number', 'year', 'duration', 'format', 'file_hash', 'audio_hash',
  'album_art_file', 'album_art_source', 'replaygain_track_db', 'sample_rate',
  'channels', 'bit_depth', 'bitrate', 'file_size', 'track_total', 'disc_total',
  'lyrics_embedded', 'lyrics_synced_lrc', 'lyrics_lang', 'lyrics_sidecar_mtime',
  'lyrics_source', 'lyrics_search_text', 'bpm', 'musical_key', 'bpm_source',
  'modified', 'scan_id', 'source',
  'mbz_recording_id', 'mbz_release_track_id', 'isrc', 'mbz_id_source', 'hash_v',
  'tag_album', 'tag_album_artist', 'tag_compilation',
  'artist_display',
];
const REQUIRED = { library_id: 1, hash_v: 1, tag_compilation: 0 };

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', '/m')").run(); // id 1
  return db;
}

// One parse of a file, as the scanners bind it: bpm_source is 'tag' when the
// file supplied either value, mbz_id_source when it supplied any track id
// (scanner.mjs / main.rs derive both that way).
function parsed({ bpm = null, key = null, mbz = null, isrc = null, ...rest } = {}) {
  return {
    title: 'T', duration: 200, file_hash: 'f1', audio_hash: 'a1', hash_v: 1,
    bpm, musical_key: key, bpm_source: (bpm != null || key != null) ? 'tag' : null,
    mbz_recording_id: mbz, isrc, mbz_id_source: (mbz != null || isrc != null) ? 'tag' : null,
    ...rest,
  };
}
const bind = (over) => COLS.map((c) => (c in over ? over[c] : (c in REQUIRED ? REQUIRED[c] : null)));
const scan = (db, sql, filepath, file) => db.prepare(sql).get(...bind({ filepath, ...file })).id;
const state = (db, id) => {
  const r = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE id = ?').get(id);
  return [r.bpm, r.musical_key, r.bpm_source];
};
const identity = (db, id) => {
  const r = db.prepare('SELECT mbz_recording_id, mbz_id_source, acoustid_id, isrc FROM tracks WHERE id = ?').get(id);
  return { ...r };
};
const refill = (db) => Number(db.prepare(REFILL_FROM_LEDGER_SQL).run().changes);
function ledger(db, hash, { bpm = null, key = null, outcome = 'analyzed', at = Math.floor(Date.now() / 1000) } = {}) {
  db.prepare(`INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome, attempts, bpm, musical_key)
              VALUES (?, ?, ?, 1, ?, ?)`).run(hash, at, outcome, bpm, key);
}
// The worker's own selection with its default cooldowns.
function eligible(db) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(selectEligibleSql(0)).all(30, 1800, now - 86400, now - 90 * 86400, 200)
    .map((r) => r.canon_hash);
}

// [stored bpm/key/src, file parse, ledger values or null, after scan, after refill]
// Hashes: a1 is the stored audio; a scan of a1 is "the same audio".
const E = 'essentia';
const ANALYSIS_CASES = [
  ['touch: analysed values survive', [93, 'E major', E], {}, { bpm: 93, key: 'E major' },
    [93, 'E major', E], [93, 'E major', E]],
  ['a new BPM tag wins; the analysed key stays', [93, 'E major', E], { bpm: 128 }, { bpm: 93, key: 'E major' },
    [128, 'E major', 'tag'], [128, 'E major', 'tag']],
  ['a new key tag wins; the analysed BPM stays', [93, 'E major', E], { key: 'Am' }, { bpm: 93, key: 'E major' },
    [93, 'Am', 'tag'], [93, 'Am', 'tag']],
  ['tags win on both values', [93, 'E major', E], { bpm: 100, key: 'C' }, { bpm: 93, key: 'E major' },
    [100, 'C', 'tag'], [100, 'C', 'tag']],
  ['a half-analysed row keeps its half', [93, null, E], {}, { bpm: 93 },
    [93, null, E], [93, null, E]],
  ['mixed row (tag BPM, analysed key): the refill restores the key', [128, 'C minor', 'tag'], { bpm: 128 }, { bpm: 126, key: 'C minor' },
    [128, null, 'tag'], [128, 'C minor', 'tag']],
  ['BPM tag removed: the measurement replaces it', [128, 'C minor', 'tag'], {}, { bpm: 126, key: 'C minor' },
    [null, null, null], [126, 'C minor', E]],
  ['mixed row the other way: the refill restores the BPM', [97, 'Am', 'tag'], { key: 'Am' }, { bpm: 97, key: 'A minor' },
    [null, 'Am', 'tag'], [97, 'Am', 'tag']],
  ['a changed BPM tag wins over both', [128, 'C minor', 'tag'], { bpm: 140 }, { bpm: 126, key: 'C minor' },
    [140, null, 'tag'], [140, 'C minor', 'tag']],
  ['tags unchanged', [100, 'C', 'tag'], { bpm: 100, key: 'C' }, null,
    [100, 'C', 'tag'], [100, 'C', 'tag']],
  ['both tags removed, never analysed: cleared', [100, 'C', 'tag'], {}, null,
    [null, null, null], [null, null, null]],
  ['nothing anywhere', [null, null, null], {}, null,
    [null, null, null], [null, null, null]],
];

for (const [engine, UPSERT] of Object.entries(ENGINES)) {
  describe(`analysed BPM/key survive a re-parse [${engine} UPSERT]`, () => {
    for (const [name, stored, file, values, afterScan, afterRefill] of ANALYSIS_CASES) {
      test(name, () => {
        const db = freshDb();
        const id = scan(db, UPSERT, 'a.mp3', parsed());
        db.prepare('UPDATE tracks SET bpm = ?, musical_key = ?, bpm_source = ? WHERE id = ?').run(...stored, id);
        if (values) { ledger(db, 'a1', values); }
        assert.equal(scan(db, UPSERT, 'a.mp3', parsed(file)), id, 'same row (DO UPDATE)');
        assert.deepEqual(state(db, id), afterScan, 'straight after the scan');
        refill(db);
        assert.deepEqual(state(db, id), afterRefill, 'after the refill');
        db.close();
      });
    }

    test('a legacy value-less analyzed row does not hide a cleared track; one commit ends it', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed({ bpm: 100, key: 'C' }));
      ledger(db, 'a1');                                          // pre-V78 'analyzed', no values
      scan(db, UPSERT, 'a.mp3', parsed());                       // both tags removed
      assert.deepEqual(state(db, id), [null, null, null]);
      assert.deepEqual(eligible(db), ['a1'], 'selected despite the 90-day cooldown');
      // The worker's commit for that pass (the key came out low-confidence):
      // fill + record with values.
      db.prepare(FILL_ANALYSIS_SQL).run(99, null, 'a1');
      db.prepare(RECORD_ANALYZED_SQL).run('a1', Math.floor(Date.now() / 1000), 99, null);
      assert.deepEqual(state(db, id), [99, null, E]);
      assert.deepEqual(eligible(db), [], 'the ledger row now carries a value: the cooldown applies again');
      scan(db, UPSERT, 'a.mp3', parsed({ key: 'Am' }));          // a key tag appears: mixed row
      assert.deepEqual(state(db, id), [99, 'Am', 'tag']);
      scan(db, UPSERT, 'a.mp3', parsed({ key: 'Bm' }));          // now provenance is 'tag': BPM goes…
      assert.deepEqual(state(db, id), [null, 'Bm', 'tag']);
      assert.equal(refill(db), 1);                               // …and comes back from the ledger
      assert.deepEqual(state(db, id), [99, 'Bm', 'tag']);
      db.close();
    });

    test('a ledger row with values keeps the cooldown when it lacks the missing half', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      db.prepare("UPDATE tracks SET bpm = 93, bpm_source = 'essentia' WHERE id = ?").run(id);
      ledger(db, 'a1', { bpm: 93 });                            // key was low-confidence
      scan(db, UPSERT, 'a.mp3', parsed());
      assert.equal(refill(db), 0, 'nothing to restore');
      assert.deepEqual(state(db, id), [93, null, E]);
      assert.deepEqual(eligible(db), [], 'not re-decoded inside the cooldown');
      db.close();
    });

    test('replaced audio (same hash generation) drops the old estimate', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      db.prepare("UPDATE tracks SET bpm = 93, musical_key = 'E major', bpm_source = 'essentia' WHERE id = ?").run(id);
      ledger(db, 'a1', { bpm: 93, key: 'E major' });
      scan(db, UPSERT, 'a.mp3', parsed({ file_hash: 'f2', audio_hash: 'a2' }));
      assert.deepEqual(state(db, id), [null, null, null]);
      assert.equal(refill(db), 0, 'the old audio\'s ledger row stays behind');
      assert.deepEqual(state(db, id), [null, null, null]);
      assert.deepEqual(eligible(db), ['a2'], 'the new audio is analysed');
      db.close();
    });

    test('a hashing-scheme re-key (hash_v behind) keeps the values', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      db.prepare("UPDATE tracks SET bpm = 93, musical_key = 'E major', bpm_source = 'essentia' WHERE id = ?").run(id);
      scan(db, UPSERT, 'a.mp3', parsed({ audio_hash: 'a1-gen2', hash_v: 2 }));
      assert.deepEqual(state(db, id), [93, 'E major', E]);
      db.close();
    });

    test('canonical hash = file_hash: a touch keeps, a byte change clears', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.ape', parsed({ audio_hash: null }));
      db.prepare("UPDATE tracks SET bpm = 93, musical_key = 'E major', bpm_source = 'essentia' WHERE id = ?").run(id);
      ledger(db, 'f1', { bpm: 93, key: 'E major' });
      scan(db, UPSERT, 'a.ape', parsed({ audio_hash: null }));
      assert.deepEqual(state(db, id), [93, 'E major', E], 'same bytes');
      scan(db, UPSERT, 'a.ape', parsed({ audio_hash: null, file_hash: 'f2' }));
      assert.deepEqual(state(db, id), [null, null, null], 'a tag edit changes the only hash there is');
      db.close();
    });

    test('a moved file and a late duplicate get the measurement back from the ledger', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'old/a.mp3', parsed());
      db.prepare("UPDATE tracks SET bpm = 93, musical_key = 'E major', bpm_source = 'essentia' WHERE id = ?").run(id);
      // A pre-V78 'lowconf' retry row that the V78 seed filled.
      ledger(db, 'a1', { bpm: 93, key: 'E major', outcome: 'lowconf' });
      db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
      const moved = scan(db, UPSERT, 'new/a.mp3', parsed());
      const copy = scan(db, UPSERT, 'copy/a.mp3', parsed());
      assert.deepEqual(state(db, moved), [null, null, null], 'the INSERT path never sees the old row');
      assert.equal(refill(db), 2);
      assert.deepEqual(state(db, moved), [93, 'E major', E]);
      assert.deepEqual(state(db, copy), [93, 'E major', E]);
      db.close();
    });
  });

  describe(`AcoustID-derived MBIDs survive a re-parse [${engine} UPSERT]`, () => {
    const acoustid = (db, id) => db.prepare(
      "UPDATE tracks SET mbz_recording_id = 'mbid-acx', acoustid_id = 'aid', mbz_id_source = 'acoustid' WHERE id = ?").run(id);

    test('touch: kept with its provenance', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      acoustid(db, id);
      scan(db, UPSERT, 'a.mp3', parsed());
      assert.deepEqual(identity(db, id), { mbz_recording_id: 'mbid-acx', mbz_id_source: 'acoustid', acoustid_id: 'aid', isrc: null });
      db.close();
    });

    test('a file that gains only an ISRC keeps the AcoustID identity', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      acoustid(db, id);
      scan(db, UPSERT, 'a.mp3', parsed({ isrc: 'USRC17607839' }));
      assert.deepEqual(identity(db, id), { mbz_recording_id: 'mbid-acx', mbz_id_source: 'acoustid', acoustid_id: 'aid', isrc: 'USRC17607839' });
      db.close();
    });

    test('a recording MBID tag wins', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      acoustid(db, id);
      scan(db, UPSERT, 'a.mp3', parsed({ mbz: 'mbid-tag' }));
      assert.deepEqual(identity(db, id), { mbz_recording_id: 'mbid-tag', mbz_id_source: 'tag', acoustid_id: 'aid', isrc: null });
      db.close();
    });

    test('a removed MBID tag clears', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed({ mbz: 'mbid-tag' }));
      scan(db, UPSERT, 'a.mp3', parsed());
      assert.deepEqual(identity(db, id), { mbz_recording_id: null, mbz_id_source: null, acoustid_id: null, isrc: null });
      db.close();
    });

    test('replaced audio clears the derived MBID; a scheme re-key keeps it', () => {
      const db = freshDb();
      const id = scan(db, UPSERT, 'a.mp3', parsed());
      acoustid(db, id);
      scan(db, UPSERT, 'a.mp3', parsed({ audio_hash: 'a1-gen2', hash_v: 2 }));
      assert.equal(identity(db, id).mbz_recording_id, 'mbid-acx', 'scheme re-key');
      scan(db, UPSERT, 'a.mp3', parsed({ audio_hash: 'a2', file_hash: 'f2', hash_v: 2 }));
      assert.deepEqual(identity(db, id), { mbz_recording_id: null, mbz_id_source: null, acoustid_id: 'aid', isrc: null });
      db.close();
    });
  });
}
