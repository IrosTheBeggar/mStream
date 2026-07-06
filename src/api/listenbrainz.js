// ListenBrainz scrobbling integration
// Submits "now playing" and "single listen" events to ListenBrainz API.
// Per-user tokens stored in users.listenbrainz_token DB column.

import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';

const LB_API = 'https://api.listenbrainz.org';

const d = () => db.getDB();

async function lbFetch(path, token, body) {
  const res = await fetch(`${LB_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ListenBrainz ${res.status}: ${text}`);
  }
  return res.json();
}

function getTrackByFilepath(filepath, user) {
  let info;
  try { info = getVPathInfo(filepath, user); } catch (_) { return null; }

  const lib = db.getLibraryByName(info.vpath);
  if (!lib) return null;

  return d().prepare(`
    SELECT t.title, a.name AS artist, al.name AS album, t.file_hash,
           t.track_number, t.duration, a.mbz_artist_id, al.mbz_album_id,
           t.mbz_recording_id
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.filepath = ? AND t.library_id = ?
  `).get(info.relativePath, lib.id);
}

function buildListenPayload(track, listenType, listenedAt) {
  const payload = {
    listen_type: listenType,
    payload: [{
      track_metadata: {
        artist_name: track.artist || 'Unknown Artist',
        track_name: track.title || 'Unknown Track',
        release_name: track.album || undefined,
        additional_info: {}
      }
    }]
  };

  if (listenedAt) {
    payload.payload[0].listened_at = listenedAt;
  }

  // Add MusicBrainz IDs if available
  const info = payload.payload[0].track_metadata.additional_info;
  if (track.mbz_artist_id) {
    info.artist_mbids = [track.mbz_artist_id];
  }
  if (track.mbz_album_id) {
    info.release_mbid = track.mbz_album_id;
  }
  // V55: the recording MBID is the single most valuable id for ListenBrainz —
  // it pins the exact recording rather than relying on artist+title matching.
  if (track.mbz_recording_id) {
    info.recording_mbid = track.mbz_recording_id;
  }
  if (track.track_number) {
    info.tracknumber = track.track_number;
  }
  if (track.duration) {
    info.duration_ms = Math.round(track.duration * 1000);
  }

  return payload;
}

export function setup(mstream) {

  // ── Status ─────────────────────────────────────────────────
  // In public/no-users mode the token comes off the V25 anonymous
  // sentinel — the operator's persistent identity. The status, scrobble,
  // and now-playing handlers below are all sentinel-aware via
  // auth.js's no-users branch (which spreads the sentinel's row onto
  // req.user). Same model the rest of mStream uses for per-user state
  // (playlists, ratings, cue points, …) under V25.
  mstream.get('/api/v1/listenbrainz/status', (req, res) => {
    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    res.json({
      serverEnabled: true,
      linked: !!(user?.listenbrainz_token)
    });
  });

  // ── Connect (save token) ───────────────────────────────────
  // Admin-gated: in public mode `req.user.admin` is true when the
  // adminLocked config flag is false (the single-operator pattern), and
  // false when the admin API is locked (read-only public deployment).
  // Real-user accounts go through the normal admin check on their
  // is_admin column. Either way, only admins can write credentials —
  // a viewer in adminLocked public mode can't overwrite the operator's
  // ListenBrainz token.
  mstream.post('/api/v1/listenbrainz/connect', async (req, res) => {
    const token = req.body.lbToken;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }
    if (!req.user?.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Validate token by calling LB API
    try {
      const r = await fetch(`${LB_API}/1/validate-token`, {
        headers: { 'Authorization': `Token ${token}` }
      });
      const data = await r.json();
      if (!data.valid) {
        return res.status(400).json({ error: 'Invalid token' });
      }
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach ListenBrainz API' });
    }

    d().prepare('UPDATE users SET listenbrainz_token = ? WHERE id = ?').run(token, req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // ── Disconnect (remove token) ──────────────────────────────
  // Same admin gate as /connect — adminLocked public deployments must
  // not let viewers wipe the operator's stored token.
  mstream.post('/api/v1/listenbrainz/disconnect', (req, res) => {
    if (!req.user?.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    d().prepare('UPDATE users SET listenbrainz_token = NULL WHERE id = ?').run(req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // ── Now Playing ────────────────────────────────────────────
  mstream.post('/api/v1/listenbrainz/playing-now', async (req, res) => {
    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    if (!user?.listenbrainz_token) return res.json({ ok: true });

    const track = getTrackByFilepath(req.body.filePath, req.user);
    if (!track) return res.json({ ok: true });

    try {
      await lbFetch('/1/submit-listens', user.listenbrainz_token,
        buildListenPayload(track, 'playing_now'));
    } catch (e) {
      // Don't fail the request if LB is down
    }
    res.json({ ok: true });
  });

  // ── Scrobble ───────────────────────────────────────────────
  mstream.post('/api/v1/listenbrainz/scrobble-by-filepath', async (req, res) => {
    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    if (!user?.listenbrainz_token) return res.json({ ok: true });

    const track = getTrackByFilepath(req.body.filePath, req.user);
    if (!track) return res.json({ ok: true });

    try {
      await lbFetch('/1/submit-listens', user.listenbrainz_token,
        buildListenPayload(track, 'single', Math.floor(Date.now() / 1000)));
    } catch (e) {
      // Don't fail the request if LB is down
    }
    res.json({ ok: true });
  });
}
