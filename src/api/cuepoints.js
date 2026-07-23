// Cue Points API — per-user bookmarks/markers on audio tracks.
// Displayed as tick marks on the player seek bar (default + Velvet UIs).
// Response shape is the one the Velvet frontend established:
//   { cuepoints: [{ id, no, title, t, color }, ...] }
// (`t` = position in seconds, `no` = 1-based position-ordered index).
// Keep it stable — the velvet desktop fork consumes it too.

import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';

const d = () => db.getDB();

// Parse filepath and validate library access. Returns null if invalid.
function parsePath(fp, user) {
  if (!fp) return null;
  try {
    const info = getVPathInfo(fp, user);
    const lib = db.getLibraryByName(info.vpath);
    if (!lib) return null;
    return { relPath: info.relativePath, lib };
  } catch (_) {
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

    const { filepath, position, label, color } = req.body;
    if (!filepath || position == null) {
      return res.status(400).json({ error: 'filepath and position required' });
    }

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

    const { position, label, color } = req.body;
    const id = req.params.id;

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

    d().prepare('DELETE FROM cue_points WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });
}
