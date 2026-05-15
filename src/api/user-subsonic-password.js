/**
 * User-side endpoints for managing the opt-in Subsonic-specific
 * password (V35 column users.subsonic_password_encrypted).
 *
 * Mounted after the auth wall: req.user is already populated. Each
 * user manages their own — admin auth not required for these.
 *
 *   GET    /api/v1/user/subsonic-password   →  { set: boolean }
 *                                              (never returns the password itself)
 *   PUT    /api/v1/user/subsonic-password   ←  { password: string }
 *                                              encrypts + stores
 *   DELETE /api/v1/user/subsonic-password   →  clears the column (NULL),
 *                                              reverting the user to no-token-auth
 *
 * Min-length is 1 — Subsonic clients are often used on local networks
 * where users want a short / memorable password and explicitly accept
 * the trade-off. Empty strings are rejected (they'd be ambiguous with
 * "not set").
 */

import Joi from 'joi';
import { joiValidate } from '../util/validation.js';
import { encryptSubsonicPassword } from '../util/subsonic-password.js';
import * as db from '../db/manager.js';

export function setup(mstream) {
  // GET — check whether a Subsonic password is set for the current user.
  // Never returns the actual password; the encrypted form is server-only.
  mstream.get('/api/v1/user/subsonic-password', (req, res) => {
    const row = db.getDB().prepare(
      'SELECT subsonic_password_encrypted FROM users WHERE id = ?'
    ).get(req.user.id);
    res.json({ set: row?.subsonic_password_encrypted != null });
  });

  // PUT — set or update. Encrypts under the current subsonicSecret and
  // writes to the column. Cache invalidated so the next Subsonic auth
  // sees the new value.
  mstream.put('/api/v1/user/subsonic-password', (req, res) => {
    const schema = Joi.object({
      password: Joi.string().min(1).required(),
    });
    const { value } = joiValidate(schema, req.body);
    const encrypted = encryptSubsonicPassword(value.password);
    db.getDB().prepare(
      'UPDATE users SET subsonic_password_encrypted = ? WHERE id = ?'
    ).run(encrypted, req.user.id);
    db.invalidateCache();
    res.json({ set: true });
  });

  // DELETE — clear the column. Reverts the user to no-Subsonic-password
  // state; subsequent token-auth attempts get the friendly "set one in
  // the mobile-clients panel" error.
  mstream.delete('/api/v1/user/subsonic-password', (req, res) => {
    db.getDB().prepare(
      'UPDATE users SET subsonic_password_encrypted = NULL WHERE id = ?'
    ).run(req.user.id);
    db.invalidateCache();
    res.json({ set: false });
  });
}
