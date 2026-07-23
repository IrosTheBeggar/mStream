// Cue Points API — track markers ("chapters") on audio files.
//
// Two kinds of rows share the cue_points table:
//   - SHARED rows (user_id IS NULL): chapter/tracklist data derived from a
//     `.cue` sidecar, lazily ingested below on first read. Read-only via
//     this API; refreshed automatically when the sidecar's mtime moves.
//   - USER rows (user_id set): personal markers created via POST. Only
//     visible to and editable by their owner.
//
// Response shape is the one the Velvet frontend established (plus the
// additive `shared` flag):
//   { cuepoints: [{ id, no, title, t, color, shared }, ...] }
// (`t` = position in seconds, `no` = 1-based position-ordered index).
// Keep it stable — the velvet UI and desktop fork consume it too; the
// default UI expands shared rows into per-chapter queue entries.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import Joi from 'joi';
import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';
import { parseCueSheet, tracksForAudioFile } from '../util/cue-parser.js';

const d = () => db.getDB();

// Sanity ceilings for sidecar ingestion. A cue sheet is a small text
// file; anything bigger is not one.
const MAX_CUE_BYTES = 1024 * 1024;
const MAX_CUE_TRACKS = 512;

// `position` is seconds into the track. Joi.number() coerces numeric
// strings ("120" → 120) and rejects everything unbindable (objects,
// booleans, "abc", and 1e999→Infinity — non-finite fails by default in
// Joi 17) — without this, junk types either land as TEXT in the REAL
// column or crash the insert into a 500.
const positionSchema = Joi.number().min(0);
const labelSchema = Joi.string().max(200).allow(null, '');
const colorSchema = Joi.string().max(32).allow(null, '');
const idParamSchema = Joi.object({ id: Joi.number().integer().positive().required() });

const createSchema = Joi.object({
  filepath: Joi.string().max(4096).required(),
  position: positionSchema.required(),
  label: labelSchema,
  color: colorSchema,
});

// All fields optional; explicit null means "leave position alone" /
// "clear label|color" — matching the pre-Joi semantics.
const updateSchema = Joi.object({
  position: positionSchema.allow(null),
  label: labelSchema,
  color: colorSchema,
});

// Parse filepath and validate library access. Returns null if invalid.
function parsePath(fp, user) {
  if (!fp) return null;
  try {
    const info = getVPathInfo(fp, user);
    const lib = db.getLibraryByName(info.vpath);
    if (!lib) return null;
    return { relPath: info.relativePath, lib, fullPath: info.fullPath };
  } catch (err) {
    // Rejected vpaths are a probing signal — always log the cause.
    winston.warn(`[cuepoints] vpath rejected for user '${user?.username}': '${fp}' (${err.message})`);
    return null;
  }
}

// Locate the sidecar for an audio file: `album.flac` → `album.cue`
// (the dominant EAC/XLD layout), falling back to the rarer appended
// form `album.flac.cue`. Returns { cuePath, stat } or null.
function findCueSidecar(audioFullPath) {
  const parsed = path.parse(audioFullPath);
  const candidates = [
    path.join(parsed.dir, parsed.name + '.cue'),
    audioFullPath + '.cue',
  ];
  for (const cuePath of candidates) {
    try {
      const stat = fs.statSync(cuePath);
      if (stat.isFile()) { return { cuePath, stat }; }
    } catch (_err) { /* ENOENT — try the next layout */ }
  }
  return null;
}

// Lazy `.cue` ingestion: on read, if a sidecar exists and the shared rows
// for this file are missing or older than the sidecar, (re)build them.
// This keeps BOTH scanners out of the chapter business entirely — the
// cost is one stat() per cuepoint read (fired once per song change), and
// the parse only runs when the sidecar is new or edited.
function maybeIngestCueSidecar(parsed) {
  const sidecar = findCueSidecar(parsed.fullPath);
  if (!sidecar) { return; }

  try {
    if (sidecar.stat.size > MAX_CUE_BYTES) {
      winston.warn(`[cuepoints] ignoring oversized cue sheet (${sidecar.stat.size}B): ${sidecar.cuePath}`);
      return;
    }

    // Freshness: shared rows store the SIDECAR'S OWN mtime as their
    // created_at (ISO, ms precision) — see the INSERT below. Rows whose
    // stamp is >= the current mtime are up to date; comparing mtime to
    // mtime is exact, immune to wall-clock skew and to created_at's
    // default second-granularity. (Legacy space-separated stamps from
    // the datetime('now') default parse via the T-normalization.)
    const newest = d().prepare(`
      SELECT MAX(created_at) AS newest FROM cue_points
      WHERE filepath = ? AND library_id = ? AND user_id IS NULL
    `).get(parsed.relPath, parsed.lib.id);
    if (newest?.newest) {
      const s = String(newest.newest);
      const stamp = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
      // Floor: NTFS mtimes carry sub-ms fractions that toISOString truncated.
      if (Number.isFinite(stamp) && stamp >= Math.floor(sidecar.stat.mtimeMs)) { return; }
    }

    // Cue sheets predate UTF-8 conventions; try UTF-8 and fall back to
    // latin1 when the decode produced replacement characters.
    let text = fs.readFileSync(sidecar.cuePath, 'utf8');
    if (text.includes('�')) {
      text = fs.readFileSync(sidecar.cuePath, 'latin1');
    }

    const tracks = tracksForAudioFile(parseCueSheet(text), path.basename(parsed.fullPath))
      .slice(0, MAX_CUE_TRACKS);
    if (tracks.length === 0) { return; }

    const conn = d();
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.prepare(
        'DELETE FROM cue_points WHERE filepath = ? AND library_id = ? AND user_id IS NULL'
      ).run(parsed.relPath, parsed.lib.id);
      const ins = conn.prepare(`
        INSERT INTO cue_points (filepath, library_id, user_id, position, label, color, created_at)
        VALUES (?, ?, NULL, ?, ?, NULL, ?)
      `);
      const mtimeIso = new Date(sidecar.stat.mtimeMs).toISOString();
      for (const t of tracks) {
        ins.run(parsed.relPath, parsed.lib.id, t.startSec, t.title || null, mtimeIso);
      }
      conn.exec('COMMIT');
      winston.info(`[cuepoints] ingested ${tracks.length} chapter(s) from ${path.basename(sidecar.cuePath)} for '${parsed.relPath}'`);
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    // Ingestion is best-effort: a broken sidecar must never break the
    // read path. Existing rows (if any) are still returned.
    winston.warn(`[cuepoints] cue ingestion failed for ${sidecar.cuePath}: ${err.message}`);
  }
}

export function setup(mstream) {

  // ── Get cue points for a file ──────────────────────────────
  mstream.get('/api/v1/db/cuepoints', (req, res) => {
    const parsed = parsePath(req.query.fp, req.user);
    if (!parsed) return res.json({ cuepoints: [] });

    maybeIngestCueSidecar(parsed);

    const rows = d().prepare(`
      SELECT id, position, label, color, user_id
      FROM cue_points
      WHERE filepath = ? AND library_id = ? AND (user_id IS NULL OR user_id = ?)
      ORDER BY position ASC
    `).all(parsed.relPath, parsed.lib.id, req.user?.id || -1);

    // Map to the format the Velvet frontend expects (`shared` is additive)
    const cuepoints = rows.map((row, i) => ({
      id: row.id,
      no: i + 1,
      title: row.label || null,
      t: row.position,
      color: row.color || null,
      shared: row.user_id === null,
    }));

    res.json({ cuepoints });
  });

  // ── Create a cue point ─────────────────────────────────────
  // In public/no-users mode the FK target is the V25 anonymous sentinel
  // — multiple anon sessions effectively share one persistent identity,
  // which is the whole point of the sentinel. The `req.user.id` write
  // below works either way; the unauthorized branch just guards against
  // truly missing user objects (e.g. an unauthenticated request that
  // never hit auth.js's no-users branch).
  mstream.post('/api/v1/db/cuepoints', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { value } = joiValidate(createSchema, req.body);
    const { filepath, position, label, color } = value;

    const parsed = parsePath(filepath, req.user);
    if (!parsed) return res.status(403).json({ error: 'access denied' });

    const result = d().prepare(`
      INSERT INTO cue_points (filepath, library_id, user_id, position, label, color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parsed.relPath, parsed.lib.id, req.user.id, position, label || null, color || null);

    res.json({ id: Number(result.lastInsertRowid) });
  });

  // ── Update a cue point ─────────────────────────────────────
  mstream.put('/api/v1/db/cuepoints/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { value: params_ } = joiValidate(idParamSchema, req.params);
    const { value } = joiValidate(updateSchema, req.body);
    const { position, label, color } = value;
    const id = params_.id;

    // Only allow updating own cue points
    const existing = d().prepare(
      'SELECT id FROM cue_points WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);

    if (!existing) return res.status(404).json({ error: 'cue point not found' });

    const sets = [];
    const params = [];
    if (position != null) { sets.push('position = ?'); params.push(position); }
    if (label !== undefined) { sets.push('label = ?'); params.push(label); }
    if (color !== undefined) { sets.push('color = ?'); params.push(color); }

    if (sets.length === 0) return res.json({ ok: true });

    params.push(id, req.user.id);
    d().prepare(`UPDATE cue_points SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

    res.json({ ok: true });
  });

  // ── Delete a cue point ─────────────────────────────────────
  mstream.delete('/api/v1/db/cuepoints/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { value: params_ } = joiValidate(idParamSchema, req.params);
    d().prepare('DELETE FROM cue_points WHERE id = ? AND user_id = ?').run(params_.id, req.user.id);
    res.json({ ok: true });
  });
}
