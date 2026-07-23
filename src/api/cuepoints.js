// Cue Points API — per-user bookmarks/markers on audio tracks.
// Displayed as tick marks on the player seek bar (default + Velvet UIs).
// Response shape is the one the Velvet frontend established:
//   { cuepoints: [{ id, no, title, t, color }, ...] }
// (`t` = position in seconds, `no` = 1-based position-ordered index).
// Keep it stable — the velvet desktop fork consumes it too.

import winston from 'winston';
import Joi from 'joi';
import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';

const d = () => db.getDB();

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
    return { relPath: info.relativePath, lib };
  } catch (err) {
    // Rejected vpaths are a probing signal — always log the cause.
    winston.warn(`[cuepoints] vpath rejected for user '${user?.username}': '${fp}' (${err.message})`);
    return null;
  }
}

export function setup(mstream) {

  // ── Get cue points for a file ──────────────────────────────
  mstream.get('/api/v1/db/cuepoints', (req, res) => {
    const parsed = parsePath(req.query.fp, req.user);
    if (!parsed) return res.json({ cuepoints: [] });

    const rows = d().prepare(`
      SELECT id, position, label, color
      FROM cue_points
      WHERE filepath = ? AND library_id = ? AND (user_id IS NULL OR user_id = ?)
      ORDER BY position ASC
    `).all(parsed.relPath, parsed.lib.id, req.user?.id || -1);

    // Map to the format the Velvet frontend expects
    const cuepoints = rows.map((row, i) => ({
      id: row.id,
      no: i + 1,
      title: row.label || null,
      t: row.position,
      color: row.color || null,
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
