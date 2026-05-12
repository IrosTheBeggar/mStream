// POST /api/v1/db/random-songs — the Auto-DJ picker.
//
// Two operating modes selected per-request from the body:
//
//   • Simple mode (no BPM/key params, no body) — behaviour identical to
//     the pre-V32 random-songs route: load all rows that match the
//     library filter + minRating, pick a random index, return it.
//
//   • Continuity mode (any of bpmRanges / bpmRangesWide / musicalKeys /
//     requireBpm / requireMusicalKey set) — runs a fallback waterfall
//     that progressively relaxes the BPM/key constraints until at least
//     one track matches, then applies a tier filter so an in-range pick
//     wins over an unknown-tag pick wins over a known-wrong pick.
//
// This is step B of the Auto-DJ velvet port. Similar-artists support
// (the `artists` / `ignoreArtists` filters) is step D and lands in a
// separate PR — there's no library-aware Last.fm proxy yet, so wiring
// it here would only test the SQL path.

import Joi from 'joi';
import * as db from '../db/manager.js';
import { renderMetadataObj, libraryFilter, trackQuery } from './db.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// ── Camelot → raw-key name expansion ────────────────────────────────────────
//
// Clients send Camelot codes (1A, 8B, etc.) because that's what the
// velvet UI sends and what most DJ-tagged libraries use as the user-
// facing key notation. The DB stores whatever the scanner found
// verbatim — TKEY frames in the wild are a mix of Camelot codes and
// raw key names ("A minor", "C major"), with enharmonic spellings
// ("Ab" vs "G#") thrown in. This map covers all three forms so a
// `musicalKeys: ['8A']` filter matches "A minor" / "Am" / "Amin" /
// raw "8A" alike.
//
// Mirrors velvet's _CAMELOT_TO_KEYS in src/db/sqlite-backend.js — keep
// in sync if either tree updates the table.
export const CAMELOT_TO_KEYS = Object.freeze({
  '1A':  ['1A', 'Ab minor', 'Abmin', 'G# minor', 'G#min', 'Abm', 'G#m'],
  '1B':  ['1B', 'B major',  'Bmaj',  'B'],
  '2A':  ['2A', 'Eb minor', 'Ebmin', 'D# minor', 'D#min', 'Ebm', 'D#m'],
  '2B':  ['2B', 'F# major', 'F#maj', 'Gb major', 'Gbmaj', 'F#', 'Gb'],
  '3A':  ['3A', 'Bb minor', 'Bbmin', 'A# minor', 'A#min', 'Bbm', 'A#m'],
  '3B':  ['3B', 'Db major', 'Dbmaj', 'C# major', 'C#maj', 'Db', 'C#'],
  '4A':  ['4A', 'F minor',  'Fmin',  'Fm'],
  '4B':  ['4B', 'Ab major', 'Abmaj', 'G# major', 'G#maj', 'Ab', 'G#'],
  '5A':  ['5A', 'C minor',  'Cmin',  'Cm'],
  '5B':  ['5B', 'Eb major', 'Ebmaj', 'D# major', 'D#maj', 'Eb', 'D#'],
  '6A':  ['6A', 'G minor',  'Gmin',  'Gm'],
  '6B':  ['6B', 'Bb major', 'Bbmaj', 'A# major', 'A#maj', 'Bb', 'A#'],
  '7A':  ['7A', 'D minor',  'Dmin',  'Dm'],
  '7B':  ['7B', 'F major',  'Fmaj',  'F'],
  '8A':  ['8A', 'A minor',  'Amin',  'Am'],
  '8B':  ['8B', 'C major',  'Cmaj',  'C'],
  '9A':  ['9A', 'E minor',  'Emin',  'Em'],
  '9B':  ['9B', 'G major',  'Gmaj',  'G'],
  '10A': ['10A', 'B minor', 'Bmin',  'Bm'],
  '10B': ['10B', 'D major', 'Dmaj',  'D'],
  '11A': ['11A', 'F# minor','F#min', 'Gb minor', 'Gbmin', 'F#m', 'Gbm'],
  '11B': ['11B', 'A major', 'Amaj',  'A'],
  '12A': ['12A', 'C# minor','C#min', 'Db minor', 'Dbmin', 'C#m', 'Dbm'],
  '12B': ['12B', 'E major', 'Emaj',  'E'],
});

// Convert Camelot codes to the flat list of raw-key names the DB
// might contain. Unknown codes (anything not in the map) are dropped
// silently — clients sending a typo just get a no-match for that
// code, not a 400.
export function expandCamelotCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) { return []; }
  const out = new Set();
  for (const c of codes) {
    const expansion = CAMELOT_TO_KEYS[String(c).trim()];
    if (!expansion) { continue; }
    for (const k of expansion) { out.add(k); }
  }
  return [...out];
}

// ── BPM / key SQL fragment builder ──────────────────────────────────────────
//
// Returns a {clauses, params} pair the caller AND's onto the base
// random-songs WHERE. Each opts field can be `undefined` / `null` /
// empty-array, which short-circuits its branch.
//
// Mirrors velvet's filter shape in src/db/sqlite-backend.js's
// _buildRandomWhere — same column references (t.bpm, t.musical_key),
// same NULL-exclusion rule (any filter implicitly requires the column
// to be non-null), same `bpmRanges` OR-fanout. The only structural
// difference is t.* vs files.* because of the normalised schema.
export function buildBpmKeyFilter(opts) {
  const clauses = [];
  const params = [];

  if (Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0) {
    const inner = opts.bpmRanges.map(() => '(t.bpm >= ? AND t.bpm <= ?)').join(' OR ');
    clauses.push(`t.bpm IS NOT NULL AND (${inner})`);
    for (const r of opts.bpmRanges) { params.push(Number(r.min), Number(r.max)); }
  } else {
    if (opts.requireBpm) {
      clauses.push('t.bpm IS NOT NULL');
    }
    if (opts.bpmMin != null) {
      clauses.push('t.bpm IS NOT NULL AND t.bpm >= ?');
      params.push(Number(opts.bpmMin));
    }
    if (opts.bpmMax != null) {
      clauses.push('t.bpm IS NOT NULL AND t.bpm <= ?');
      params.push(Number(opts.bpmMax));
    }
  }

  if (opts.requireMusicalKey) {
    clauses.push('t.musical_key IS NOT NULL');
  }
  if (Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0) {
    const rawKeys = expandCamelotCodes(opts.musicalKeys);
    if (rawKeys.length > 0) {
      const placeholders = rawKeys.map(() => '?').join(',');
      clauses.push(`t.musical_key IS NOT NULL AND t.musical_key IN (${placeholders})`);
      params.push(...rawKeys);
    }
  }

  return { clauses, params };
}

// ── Predicates for the post-fallback tier classification ────────────────────
//
// "Known-good" = the row's value is present AND inside the requested set.
// "Known-wrong" = the row's value is present BUT outside the requested set.
// "Unknown" = the row's value is NULL.
//
// A row that's known-good on at least one dimension and not known-wrong
// on the other is Tier 0. A row that's unknown on at least one dimension
// and not known-wrong on the other is Tier 1. Everything else is Tier 2.
//
// This matters because the waterfall may have dropped the BPM/key
// constraint at the SQL layer — the returned rows can still be filtered
// in JS so an in-range row wins over an unknown row wins over a wrong
// row. Without this, "drop constraint" steps would feed garbage picks
// to the client.
function classifyRow(row, opts) {
  const bpmRanges = opts.bpmRanges;
  const keySet    = opts.keySet;

  const bpmStatus = (() => {
    if (!bpmRanges || bpmRanges.length === 0) { return 'na'; }
    if (row.bpm == null) { return 'unknown'; }
    const inRange = bpmRanges.some(r => row.bpm >= r.min && row.bpm <= r.max);
    return inRange ? 'good' : 'wrong';
  })();

  const keyStatus = (() => {
    if (!keySet || keySet.size === 0) { return 'na'; }
    if (row.musical_key == null) { return 'unknown'; }
    return keySet.has(row.musical_key) ? 'good' : 'wrong';
  })();

  // Tier 0: at least one dimension is good, neither is wrong.
  if ((bpmStatus === 'good' && keyStatus !== 'wrong') ||
      (keyStatus === 'good' && bpmStatus !== 'wrong')) {
    return 0;
  }
  // Tier 1: neither is wrong (so at most unknown / na).
  if (bpmStatus !== 'wrong' && keyStatus !== 'wrong') {
    return 1;
  }
  // Tier 2: at least one is wrong.
  return 2;
}

export function applyTierFilter(rows, opts) {
  const haveBpm = Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0;
  const haveKey = Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0;
  // No active constraint → no filtering needed.
  if (!haveBpm && !haveKey) { return rows; }

  const keySet = haveKey ? new Set(expandCamelotCodes(opts.musicalKeys)) : null;
  const classifyOpts = { bpmRanges: opts.bpmRanges, keySet };

  const tier0 = [];
  const tier1 = [];
  const tier2 = [];
  for (const row of rows) {
    const t = classifyRow(row, classifyOpts);
    if (t === 0) { tier0.push(row); }
    else if (t === 1) { tier1.push(row); }
    else { tier2.push(row); }
  }
  if (tier0.length > 0) { return tier0; }
  if (tier1.length > 0) { return tier1; }
  return tier2;
}

// ── Waterfall ───────────────────────────────────────────────────────────────
//
// Returns the first non-empty result-set encountered while progressively
// relaxing BPM/key constraints. Throws WebError(400) if every step is
// empty (no songs at all, even with no filter).
//
// Step order (no similar-artists — PR D adds those):
//   1. BPM tight + Key
//   2. BPM wide + Key
//   3. BPM tight only (drop key)
//   4. BPM wide only (drop key)
//   5. No BPM/key constraint
//
// Each step only fires if its inputs are present — e.g. step 2 only
// runs when bpmRangesWide is set; step 3 only runs when bpmRanges is
// set; step 5 always runs as a final guarantee that SOMETHING comes
// back if any rows exist in scope.
function runWaterfallQuery(d, baseSql, baseParams, filterOpts) {
  const { clauses, params } = buildBpmKeyFilter(filterOpts);
  const sql = clauses.length > 0
    ? `${baseSql} AND ${clauses.join(' AND ')}`
    : baseSql;
  return d.prepare(sql).all(...baseParams, ...params);
}

function pickRandomNonIgnored(rowCount, ignoreList) {
  // Trim ignoreList when it grows too large — pre-V32 behaviour.
  const trimmed = [...ignoreList];
  while (trimmed.length > rowCount * 0.5) { trimmed.shift(); }
  if (trimmed.length >= rowCount) {
    // Every slot is ignored — reset, pick freely.
    trimmed.length = 0;
  }
  let idx;
  let attempts = 0;
  do {
    idx = Math.floor(Math.random() * rowCount);
    attempts++;
  } while (trimmed.indexOf(idx) > -1 && attempts < rowCount * 2);
  return { idx, trimmedIgnore: trimmed };
}

export function runRandomSongs(req, body) {
  const d = db.getDB();
  if (!d) { throw new WebError('Database not ready', 400); }

  const filter = libraryFilter(req.user, body.ignoreVPaths);
  const baseConditions = [filter.clause];
  const baseParams = [...(req.user?.id ? [req.user.id] : []), ...filter.params];

  if (body.minRating && Number(body.minRating) > 0) {
    baseConditions.push('um.rating >= ?');
    baseParams.push(Number(body.minRating));
  }

  const baseSql = `${trackQuery(req.user?.id)} WHERE ${baseConditions.join(' AND ')}`;

  // Decide which waterfall steps fire.
  const hasBpm = (Array.isArray(body.bpmRanges) && body.bpmRanges.length > 0)
               || body.requireBpm === true
               || body.bpmMin != null
               || body.bpmMax != null;
  const hasBpmWide = Array.isArray(body.bpmRangesWide) && body.bpmRangesWide.length > 0;
  const hasKey = (Array.isArray(body.musicalKeys) && body.musicalKeys.length > 0)
               || body.requireMusicalKey === true;

  // Simple mode — no BPM/key filters at all. Skip the waterfall.
  if (!hasBpm && !hasBpmWide && !hasKey) {
    const rows = d.prepare(baseSql).all(...baseParams);
    if (rows.length === 0) {
      throw new WebError('No songs that match criteria', 400);
    }
    return finalisePick(rows, body);
  }

  // Step 1: tight BPM + Key.
  let rows = (hasBpm || hasKey)
    ? runWaterfallQuery(d, baseSql, baseParams, {
        bpmRanges: body.bpmRanges,
        requireBpm: body.requireBpm,
        bpmMin: body.bpmMin,
        bpmMax: body.bpmMax,
        musicalKeys: body.musicalKeys,
        requireMusicalKey: body.requireMusicalKey,
      })
    : [];

  // Step 2: wide BPM + Key.
  if (rows.length === 0 && hasBpmWide && hasKey) {
    rows = runWaterfallQuery(d, baseSql, baseParams, {
      bpmRanges: body.bpmRangesWide,
      musicalKeys: body.musicalKeys,
      requireMusicalKey: body.requireMusicalKey,
    });
  }

  // Step 3: tight BPM only (drop key).
  if (rows.length === 0 && hasBpm) {
    rows = runWaterfallQuery(d, baseSql, baseParams, {
      bpmRanges: body.bpmRanges,
      requireBpm: body.requireBpm,
      bpmMin: body.bpmMin,
      bpmMax: body.bpmMax,
    });
  }

  // Step 4: wide BPM only.
  if (rows.length === 0 && hasBpmWide) {
    rows = runWaterfallQuery(d, baseSql, baseParams, {
      bpmRanges: body.bpmRangesWide,
    });
  }

  // Step 5: no BPM/key constraint at all.
  if (rows.length === 0) {
    rows = d.prepare(baseSql).all(...baseParams);
  }

  if (rows.length === 0) {
    throw new WebError('No songs that match criteria', 400);
  }

  // Apply tier filter against the ORIGINAL request constraints so that
  // even after step 5 drops the SQL filter, in-range rows still win.
  rows = applyTierFilter(rows, {
    bpmRanges: body.bpmRanges,
    musicalKeys: body.musicalKeys,
  });

  return finalisePick(rows, body);
}

function finalisePick(rows, body) {
  const count = rows.length;
  const ignoreList = Array.isArray(body.ignoreList) ? body.ignoreList : [];
  const { idx, trimmedIgnore } = pickRandomNonIgnored(count, ignoreList);
  trimmedIgnore.push(idx);
  return {
    songs: [renderMetadataObj(rows[idx])],
    ignoreList: trimmedIgnore,
  };
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  mstream.post('/api/v1/db/random-songs', (req, res) => {
    const bpmRangeItem = Joi.object({
      min: Joi.number().required(),
      max: Joi.number().required(),
    });
    const schema = Joi.object({
      ignoreList: Joi.array().items(Joi.number().integer().min(0)).optional(),
      ignorePercentage: Joi.number().min(0).max(1).optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      minRating: Joi.number().integer().min(1).max(10).optional(),
      // BPM filters — bpmRanges takes precedence over bpmMin/bpmMax
      // (which exist only for legacy callers).
      bpmRanges: Joi.array().items(bpmRangeItem).optional(),
      bpmRangesWide: Joi.array().items(bpmRangeItem).optional(),
      requireBpm: Joi.boolean().optional(),
      bpmMin: Joi.number().optional(),
      bpmMax: Joi.number().optional(),
      // Key filters — musicalKeys are Camelot codes ('1A'..'12B').
      // Anything outside the canonical 24 is silently dropped per
      // expandCamelotCodes; we don't enforce a `valid(...)` here so
      // future code-set expansions (sharp/flat variants) don't need
      // a Joi update.
      musicalKeys: Joi.array().items(Joi.string()).optional(),
      requireMusicalKey: Joi.boolean().optional(),
    });
    const { value } = joiValidate(schema, req.body || {});

    res.json(runRandomSongs(req, value));
  });
}
