// User Settings — persist UI preferences per user.
// Stores key-value pairs in user_settings table.
// Also handles queue save/restore for session continuity.

import winston from 'winston';
import * as db from '../db/manager.js';

const d = () => db.getDB();

export function setup(mstream) {

  // ── Get settings ───────────────────────────────────────────
  // In public/no-users mode the row is keyed to the V25 anonymous
  // sentinel — every anon session shares it, which is intentional:
  // dark mode and the saved play queue should survive page reloads
  // for the operator running a single-user public deployment. If the
  // user object is genuinely missing (no auth.js public-mode branch
  // ran), we return empty rather than crash.
  mstream.get('/api/v1/user/settings', (req, res) => {
    if (!req.user?.id) return res.json({ prefs: {} });

    const rows = d().prepare(
      'SELECT key, value FROM user_settings WHERE user_id = ?'
    ).all(req.user.id);

    const prefs = {};
    let queue = null;
    for (const row of rows) {
      if (row.key === '__queue__') {
        try { queue = JSON.parse(row.value); } catch (_) { /* corrupt queue JSON — ignore */ }
      } else {
        prefs[row.key] = row.value;
      }
    }

    const result = { prefs };
    if (queue) result.queue = queue;
    res.json(result);
  });

  // ── Save settings ──────────────────────────────────────────
  mstream.post('/api/v1/user/settings', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });

    const { prefs, queue } = req.body;

    try {
      const upsert = d().prepare(`
        INSERT INTO user_settings (user_id, key, value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
      `);

      // Save preferences (individual upserts — no explicit transaction needed)
      if (prefs && typeof prefs === 'object') {
        for (const [key, value] of Object.entries(prefs)) {
          if (key === '__queue__') continue; // reserved key
          upsert.run(req.user.id, key, value != null ? String(value) : null);
        }
      }

      // Save queue state
      if (queue && typeof queue === 'object') {
        upsert.run(req.user.id, '__queue__', JSON.stringify(queue));
      }

      res.json({ ok: true });
    } catch (err) {
      // node:sqlite writes are synchronous and serialise against the
      // scanner's single SQLite writer. Under sustained scan load a write
      // can exceed busy_timeout (5s) and throw SQLITE_BUSY. This endpoint
      // is best-effort — the velvet client re-syncs the queue on its next
      // tick — so degrade to a soft 503 instead of letting the throw
      // bubble up to a 500. SQLITE_BUSY / "database is locked" is the
      // expected transient and is not logged; anything else is surfaced.
      const msg = String(err?.message || err);
      if (!/SQLITE_BUSY|database is locked/i.test(msg)) {
        winston.warn(`Failed to save user settings for user ${req.user.id}: ${msg}`);
      }
      res.status(503).json({ ok: false, error: 'settings store busy' });
    }
  });
}
