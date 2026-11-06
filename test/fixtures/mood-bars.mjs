// Child-process fixture for test/db/mood-bars.test.mjs. Runs under Node OR
// Bun and goes through the runtime-switched driver — node:sqlite on Node,
// the bun:sqlite adapter on Bun — so the mood filters' SQL (moodPredicate,
// the bars spliced in as number literals) is evaluated by the SQLite a
// shipped build really carries.
//
// It stores every 4-place score from 0 to 1 the way the worker writes one
// (Math.round(mean * 1e4) / 1e4), then, at every bar a filter may ask for
// (0.10 to 0.90), compares what the SQL keeps with the two-place byte a
// client puts on a card: min(100, max(0, floor(score * 100 + 1e-9))), held
// against the bar in percent (b) or its mirror (100 - b). Plain floor is
// counted beside it, to show the comparison can tell the two apart.
//
// Prints ONE JSON line: the counts, the wrong ones by kind, and the SQLite
// version.
import { DatabaseSync } from '../../src/db/sqlite-driver.js';
import { SCHEMA_V80 } from '../../src/db/schema.js';
import { moodPredicate, MOOD_THRESHOLD_MIN, MOOD_THRESHOLD_MAX } from '../../src/api/mood-filter.js';

const STEPS = 10_000;
const twoPlace = (x) => Math.min(100, Math.max(0, Math.floor(x * 100 + 1e-9)));
const plainFloor = (x) => Math.min(100, Math.max(0, Math.floor(x * 100)));

// Every head that must hold carries the score; the head it is weighed
// against (sad, aggressive) is 0, so each scale's condition is its bar.
const HELD = ['danceable', 'happy', 'relaxed', 'party', 'acoustic', 'instrumental'];
const on = (v, b) => v >= b;
const underMirror = (v, b) => v < 100 - b;
const KINDS = {
  happy: [{ valence: 'happy' }, on],
  relaxed: [{ energy: 'relaxed' }, on],
  instrumental: [{ voice: 'instrumental' }, on],
  acoustic: [{ tags: ['acoustic'] }, on],
  party: [{ tags: ['party'] }, on],
  danceable: [{ tags: ['danceable'] }, on],
  vocals: [{ voice: 'vocals' }, underMirror],
  neutralValence: [{ valence: 'neutral' }, underMirror],
  neutralEnergy: [{ energy: 'neutral' }, underMirror],
};

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE tracks (id INTEGER PRIMARY KEY)');
db.exec(SCHEMA_V80);

const scores = [];
const insTrack = db.prepare('INSERT INTO tracks (id) VALUES (?)');
const insMoods = db.prepare(`INSERT INTO track_moods (track_id, sad, aggressive, ${HELD.join(', ')})
  VALUES (?, 0, 0, ${HELD.map(() => '?').join(', ')})`);
db.exec('BEGIN');
for (let i = 0; i <= STEPS; i++) {
  const score = Math.round((i / STEPS) * 1e4) / 1e4;
  scores.push(score);
  insTrack.run(i + 1);
  insMoods.run(i + 1, ...HELD.map(() => score));
}
db.exec('COMMIT');

// The doubles must come back exactly as written, or the route could not
// hand them on unrounded.
let readBack = 0;
for (const row of db.prepare(`SELECT track_id, ${HELD.join(', ')} FROM track_moods ORDER BY track_id`).all()) {
  const want = scores[Number(row.track_id) - 1];
  if (HELD.some((k) => row[k] !== want)) { readBack++; }
}

const lo = Math.round(MOOD_THRESHOLD_MIN * 100);
const hi = Math.round(MOOD_THRESHOLD_MAX * 100);
let checks = 0;
let wrong = 0;
let plainWrong = 0;
const wrongBy = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
const firstWrong = [];
for (let b = lo; b <= hi; b++) {
  const threshold = b / 100;
  for (const [kind, [moods, holds]] of Object.entries(KINDS)) {
    const kept = new Set(db.prepare(`SELECT tm.track_id AS id FROM track_moods tm WHERE ${moodPredicate({ ...moods, threshold })}`)
      .all().map((r) => Number(r.id)));
    for (let i = 0; i < scores.length; i++) {
      const sql = kept.has(i + 1);
      checks++;
      if (holds(twoPlace(scores[i]), b) !== sql) {
        wrong++;
        wrongBy[kind]++;
        if (firstWrong.length < 5) { firstWrong.push({ kind, bar: b, score: scores[i], sql }); }
      }
      if (holds(plainFloor(scores[i]), b) !== sql) { plainWrong++; }
    }
  }
}

const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
db.close();
process.stdout.write(`${JSON.stringify({
  scores: scores.length, bars: hi - lo + 1, kinds: Object.keys(KINDS),
  checks, wrong, wrongBy, firstWrong, plainWrong, readBack, sqlite,
})}\n`);
