// Per-user key/value settings (user_settings, V74).
//
// One table for every feature that keeps something per user — a plug-in's
// token, a preference — instead of a column per service on `users`
// (lastfm_user / lastfm_password are the pattern this replaces going
// forward; V69 dropped listenbrainz_token). Namespaced so features cannot
// collide: a plug-in uses `discovery-plugin:<name>`.
//
// Values are JSON. `secret` rows (tokens, passwords) are stored like any
// other but describeUserSettings() — the client-facing view — never returns
// their value, only that one is set. Server-side callers that need the
// value use getUserSetting().

import * as manager from './manager.js';

const d = () => manager.getDB();

function ns(namespace) {
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(namespace)) {
    throw new Error(`user settings: invalid namespace ${JSON.stringify(namespace)}`);
  }
  return namespace;
}
function k(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) {
    throw new Error(`user settings: invalid key ${JSON.stringify(key)}`);
  }
  return key;
}

export function getUserSetting(userId, namespace, key) {
  const row = d().prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND namespace = ? AND key = ?'
  ).get(userId, ns(namespace), k(key));
  if (!row) { return undefined; }
  try { return JSON.parse(row.value); } catch (_e) { return undefined; }
}

// Every value in a namespace, secrets included — for the server's own use.
export function getUserSettings(userId, namespace) {
  const out = {};
  for (const row of d().prepare(
    'SELECT key, value FROM user_settings WHERE user_id = ? AND namespace = ?'
  ).all(userId, ns(namespace))) {
    try { out[row.key] = JSON.parse(row.value); } catch (_e) { /* skip unreadable */ }
  }
  return out;
}

export function setUserSetting(userId, namespace, key, value, { secret = false } = {}) {
  if (value === undefined) { return deleteUserSetting(userId, namespace, key); }
  d().prepare(`
    INSERT INTO user_settings (user_id, namespace, key, value, secret, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, namespace, key) DO UPDATE SET
      value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at
  `).run(userId, ns(namespace), k(key), JSON.stringify(value), secret ? 1 : 0, Date.now());
  return true;
}

export function deleteUserSetting(userId, namespace, key) {
  return d().prepare(
    'DELETE FROM user_settings WHERE user_id = ? AND namespace = ? AND key = ?'
  ).run(userId, ns(namespace), k(key)).changes > 0;
}

// The client-facing view: secrets show as set, never as their value.
export function describeUserSettings(userId, namespace) {
  return d().prepare(
    'SELECT key, value, secret, updated_at FROM user_settings WHERE user_id = ? AND namespace = ? ORDER BY key'
  ).all(userId, ns(namespace)).map((row) => {
    const secret = row.secret === 1;
    let value;
    if (!secret) { try { value = JSON.parse(row.value); } catch (_e) { value = null; } }
    return { key: row.key, secret, set: true, ...(secret ? {} : { value }), updatedAt: row.updated_at };
  });
}
