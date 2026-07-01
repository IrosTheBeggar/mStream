// Wrapped / Your Stats — listening statistics with full event tracking.
// Play events are stored in play_events table and used to derive
// accurate listening time, skip rates, session data, and more.

import crypto from 'crypto';
import * as db from '../db/manager.js';
import { libraryFilter } from './db.js';
import { getVPathInfo } from '../util/vpath.js';

const d = () => db.getDB();

function genEventId() {
  return crypto.randomBytes(12).toString('hex');
}

// Exported for the regression test (wrapped-period-range.test.mjs).
export function getPeriodRange(period, offset) {
  const now = new Date();
  let start, end, label;

  switch (period) {
    case 'weekly': {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1 + (offset * 7));
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      start = weekStart;
      end = weekEnd;
      label = offset === 0 ? 'This Week' : offset === -1 ? 'Last Week' : `${Math.abs(offset)} weeks ago`;
      break;
    }
    case 'monthly': {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      start = d;
      end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      break;
    }
    case 'quarterly': {
      const curQ = Math.floor(now.getMonth() / 3);
      const qStart = new Date(now.getFullYear(), (curQ + offset) * 3, 1);
      start = qStart;
      end = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 1);
      const qNum = Math.floor(qStart.getMonth() / 3) + 1;
      label = `Q${qNum} ${qStart.getFullYear()}`;
      break;
    }
    case 'half-yearly': {
      const curH = Math.floor(now.getMonth() / 6);
      const hStart = new Date(now.getFullYear(), (curH + offset) * 6, 1);
      start = hStart;
      end = new Date(hStart.getFullYear(), hStart.getMonth() + 6, 1);
      const half = hStart.getMonth() < 6 ? 'H1' : 'H2';
      label = `${half} ${hStart.getFullYear()}`;
      break;
    }
    case 'yearly': {
      const year = now.getFullYear() + offset;
      start = new Date(year, 0, 1);
      end = new Date(year + 1, 0, 1);
      label = String(year);
      break;
    }
    default: {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      label = 'This Month';
    }
  }

  // The bounds are compared as TEXT against play_events.started_at, which
  // SQLite writes as 'YYYY-MM-DD HH:MM:SS' (datetime('now') — UTC, space
  // separator, no milliseconds). They MUST use that exact format: TEXT
  // comparison is lexicographic, and toISOString()'s 'T' separator sorts
  // AFTER ' ', so any event whose date equals the window's start date
  // compared as before-the-window — silently dropping every play made on
  // the first day of the period (and, mirrored at the exclusive end bound,
  // leaking end-date plays into the previous period). Surfaced 2026-07-01,
  // when "This Month" lost all of that day's plays.
  const toSqliteUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: toSqliteUtc(start), end: toSqliteUtc(end), label };
}

// Parse "vpath/rel/path.mp3" with access validation
function parseFilepath(filepath, user) {
  if (!filepath) return null;
  try {
    const info = getVPathInfo(filepath, user);
    const lib = db.getLibraryByName(info.vpath);
    if (!lib) return null;
    return { libId: lib.id, relPath: info.relativePath };
  } catch (_) {
    return null;
  }
}

export function setup(mstream) {

  // ══════════════════════════════════════════════════════════════
  // EVENT TRACKING ENDPOINTS
  // ══════════════════════════════════════════════════════════════

  // In public/no-users mode events are attributed to the V25 anonymous
  // sentinel. The /api/v1/user/wrapped view then reflects "this server's"
  // listening — exactly right for the single-operator docker pattern,
  // and consistent with how playlists, ratings, and queue state are
  // backed by the sentinel. If req.user is missing entirely (auth.js
  // never ran the no-users branch), we fall back to a synthetic OK
  // response so the velvet client doesn't toast.
  mstream.post('/api/v1/wrapped/play-start', (req, res) => {
    if (!req.user?.id) return res.json({ eventId: null });
    const { filePath, sessionId, source } = req.body;
    const eventId = genEventId();
    const parsed = parseFilepath(filePath, req.user);

    // Look up track duration if possible
    let durationMs = null;
    if (parsed) {
      const track = d().prepare('SELECT duration FROM tracks WHERE filepath = ? AND library_id = ?').get(parsed.relPath, parsed.libId);
      if (track?.duration) durationMs = Math.round(track.duration * 1000);
    }

    // Store the relative path (without vpath prefix) for reliable JOINs with tracks table
    d().prepare(`
      INSERT INTO play_events (event_id, user_id, filepath, library_id, session_id, source, track_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, req.user.id, parsed?.relPath || '', parsed?.libId || null, sessionId || null, source || null, durationMs);

    res.json({ eventId });
  });

  mstream.post('/api/v1/wrapped/play-stop', (req, res) => {
    if (!req.user?.id || !req.body.eventId) return res.json({ ok: true });
    d().prepare(`
      UPDATE play_events SET outcome = 'stopped', played_ms = ?, ended_at = datetime('now')
      WHERE event_id = ? AND user_id = ?
    `).run(req.body.playedMs || 0, req.body.eventId, req.user.id);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/wrapped/play-end', (req, res) => {
    if (!req.user?.id || !req.body.eventId) return res.json({ ok: true });
    d().prepare(`
      UPDATE play_events SET outcome = 'completed', played_ms = ?, ended_at = datetime('now')
      WHERE event_id = ? AND user_id = ?
    `).run(req.body.playedMs || 0, req.body.eventId, req.user.id);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/wrapped/play-skip', (req, res) => {
    if (!req.user?.id || !req.body.eventId) return res.json({ ok: true });
    d().prepare(`
      UPDATE play_events SET outcome = 'skipped', played_ms = ?, ended_at = datetime('now')
      WHERE event_id = ? AND user_id = ?
    `).run(req.body.playedMs || 0, req.body.eventId, req.user.id);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/wrapped/pause', (req, res) => {
    if (!req.user?.id || !req.body.eventId) return res.json({ ok: true });
    d().prepare(`
      UPDATE play_events SET pause_count = pause_count + 1
      WHERE event_id = ? AND user_id = ?
    `).run(req.body.eventId, req.user.id);
    res.json({ ok: true });
  });

  // Radio/podcast tracking stubs (we don't have radio/podcasts, but accept the calls)
  mstream.post('/api/v1/wrapped/radio-start', (req, res) => res.json({ eventId: genEventId() }));
  mstream.post('/api/v1/wrapped/radio-stop', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/podcast-start', (req, res) => res.json({ eventId: genEventId() }));
  mstream.post('/api/v1/wrapped/podcast-end', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/session-end', (req, res) => res.json({ ok: true }));

  // ══════════════════════════════════════════════════════════════
  // STATS QUERIES
  // ══════════════════════════════════════════════════════════════

  mstream.get('/api/v1/user/wrapped', (req, res) => {
    if (!req.user?.id) return res.json({ period_label: 'Unknown', total_plays: 0 });

    const period = req.query.period || 'monthly';
    const offset = parseInt(req.query.offset) || 0;
    const { start, end, label } = getPeriodRange(period, offset);
    const f = libraryFilter(req.user);
    const uid = req.user.id;

    // ── Core stats from play_events ────────────────────────────
    const core = d().prepare(`
      SELECT
        COUNT(*) AS total_plays,
        COUNT(DISTINCT filepath) AS unique_songs,
        COALESCE(SUM(played_ms), 0) AS total_listening_ms,
        COALESCE(SUM(pause_count), 0) AS pause_count,
        SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skip_count,
        SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed_count
      FROM play_events
      WHERE user_id = ? AND started_at >= ? AND started_at < ?
    `).get(uid, start, end);

    const totalPlays = core?.total_plays || 0;
    const skipRate = totalPlays > 0 ? (core.skip_count || 0) / totalPlays : 0;
    const completionRate = totalPlays > 0 ? (core.completed_count || 0) / totalPlays : 0;

    // ── New discoveries (first play ever is within this period) ──
    const discoveries = d().prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT filepath, MIN(started_at) AS first_play
        FROM play_events WHERE user_id = ?
        GROUP BY filepath
        HAVING first_play >= ? AND first_play < ?
      )
    `).get(uid, start, end)?.cnt || 0;

    // ── Top songs (from play_events for accurate per-period data) ──
    const topSongs = d().prepare(`
      SELECT pe.filepath, COUNT(*) AS play_count,
             COALESCE(SUM(pe.played_ms), 0) AS total_ms,
             t.title, a.name AS artist, t.file_hash AS hash, t.album_art_file AS aaFile
      FROM play_events pe
      LEFT JOIN tracks t ON t.filepath = pe.filepath AND t.library_id = pe.library_id
      LEFT JOIN artists a ON t.artist_id = a.id
      WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
      GROUP BY pe.filepath
      ORDER BY play_count DESC
      LIMIT 10
    `).all(uid, start, end);

    // ── Top artists ────────────────────────────────────────────
    const topArtists = d().prepare(`
      SELECT a.name AS artist, COUNT(*) AS play_count,
             COALESCE(SUM(pe.played_ms), 0) AS total_played_ms
      FROM play_events pe
      LEFT JOIN tracks t ON t.filepath = pe.filepath AND t.library_id = pe.library_id
      LEFT JOIN artists a ON t.artist_id = a.id
      WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
        AND a.name IS NOT NULL
      GROUP BY a.name
      ORDER BY play_count DESC
      LIMIT 10
    `).all(uid, start, end);

    // ── Library coverage ───────────────────────────────────────
    const totalTracks = d().prepare(
      `SELECT COUNT(*) AS cnt FROM tracks t WHERE ${f.clause}`
    ).get(...f.params)?.cnt || 1;

    const allTimePlayed = d().prepare(
      'SELECT COUNT(DISTINCT filepath) AS cnt FROM play_events WHERE user_id = ?'
    ).get(uid)?.cnt || 0;

    const coverage = Math.min(100, (allTimePlayed / totalTracks) * 100);

    // ── Listening by hour and weekday ──────────────────────────
    const hourData = new Array(24).fill(0);
    const weekdayData = new Array(7).fill(0);
    const timeRows = d().prepare(`
      SELECT started_at FROM play_events
      WHERE user_id = ? AND started_at >= ? AND started_at < ?
    `).all(uid, start, end);

    let earliestPlay = null;
    for (const row of timeRows) {
      try {
        const dt = new Date(row.started_at);
        hourData[dt.getHours()]++;
        weekdayData[dt.getDay()]++;
        const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        if (!earliestPlay || dt.getHours() < new Date('2000-01-01T' + earliestPlay).getHours()) {
          earliestPlay = timeStr;
        }
      } catch (_) {}
    }

    // ── Top listening day ──────────────────────────────────────
    const topDay = d().prepare(`
      SELECT DATE(started_at) AS day, SUM(played_ms) AS total_ms
      FROM play_events
      WHERE user_id = ? AND started_at >= ? AND started_at < ?
      GROUP BY day
      ORDER BY total_ms DESC
      LIMIT 1
    `).get(uid, start, end);

    // ── Session analysis ───────────────────────────────────────
    const sessions = d().prepare(`
      SELECT session_id, MIN(started_at) AS sess_start,
             MAX(COALESCE(ended_at, started_at)) AS sess_end,
             COUNT(*) AS total_tracks,
             SUM(played_ms) AS total_ms
      FROM play_events
      WHERE user_id = ? AND started_at >= ? AND started_at < ?
        AND session_id IS NOT NULL
      GROUP BY session_id
    `).all(uid, start, end);

    let longestSession = null;
    let totalSessionMs = 0;
    for (const s of sessions) {
      const durMs = s.total_ms || 0;
      totalSessionMs += durMs;
      if (!longestSession || durMs > (longestSession.total_ms || 0)) {
        longestSession = s;
      }
    }
    const avgSessionMs = sessions.length > 0 ? Math.round(totalSessionMs / sessions.length) : null;

    // ── Most skipped artist ────────────────────────────────────
    const skippedArtist = d().prepare(`
      SELECT a.name AS artist,
             SUM(CASE WHEN pe.outcome = 'skipped' THEN 1 ELSE 0 END) AS skips,
             COUNT(*) AS total,
             CAST(SUM(CASE WHEN pe.outcome = 'skipped' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS skip_rate
      FROM play_events pe
      LEFT JOIN tracks t ON t.filepath = pe.filepath AND t.library_id = pe.library_id
      LEFT JOIN artists a ON t.artist_id = a.id
      WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
        AND a.name IS NOT NULL
      GROUP BY a.name
      HAVING total >= 3
      ORDER BY skip_rate DESC
      LIMIT 1
    `).get(uid, start, end);

    // ── Most replayed (consecutive plays of same track) ────────
    // Simplified: track with highest play count in period
    const mostReplayed = topSongs[0] && topSongs[0].play_count > 2
      ? { title: topSongs[0].title || 'Unknown', replay_count: topSongs[0].play_count }
      : null;

    // ── Personality ────────────────────────────────────────────
    let personality = { type: 'Explorer', desc: 'You listen to a wide variety of music.' };
    const peakHour = hourData.indexOf(Math.max(...hourData));
    if (peakHour >= 22 || peakHour <= 4) {
      personality = { type: 'Night Owl', desc: 'You do most of your listening late at night.' };
    } else if (peakHour >= 5 && peakHour <= 8) {
      personality = { type: 'Early Bird', desc: 'You start your day with music.' };
    } else if (skipRate > 0.5) {
      personality = { type: 'Skipper', desc: 'You skip more songs than you finish — always hunting for the right track.' };
    } else if (completionRate > 0.85 && totalPlays > 10) {
      personality = { type: 'Completionist', desc: 'You almost always listen to songs all the way through.' };
    } else if (topArtists.length > 0 && topArtists[0].play_count > totalPlays * 0.3) {
      personality = { type: 'Devotee', desc: `You really love ${topArtists[0].artist}.` };
    } else if ((core?.unique_songs || 0) > 30) {
      personality = { type: 'Explorer', desc: 'You listen to a wide variety of music.' };
    }

    res.json({
      period_label: label,
      total_plays: totalPlays,
      total_listening_ms: core?.total_listening_ms || 0,
      unique_songs: core?.unique_songs || 0,
      pause_count: core?.pause_count || 0,
      skip_rate: Math.round(skipRate * 100) / 100,
      library_coverage_pct: Math.round(coverage * 10) / 10,
      completion_rate: Math.round(completionRate * 100) / 100,
      new_discoveries: discoveries,
      top_songs: topSongs.map(s => ({
        title: s.title || s.filepath?.split('/').pop() || 'Unknown',
        artist: s.artist || null,
        hash: s.hash || null,
        play_count: s.play_count,
        aaFile: s.aaFile || null,
      })),
      top_artists: topArtists.map(a => ({
        artist: a.artist,
        play_count: a.play_count,
        total_played_ms: a.total_played_ms || 0,
      })),
      listening_by_hour: hourData,
      listening_by_weekday: weekdayData,
      top_listening_day: topDay ? { date: topDay.day, total_listening_ms: topDay.total_ms || 0 } : null,
      personality,
      longest_session: longestSession ? {
        started_at: new Date(longestSession.sess_start).getTime(),
        ended_at: new Date(longestSession.sess_end).getTime(),
        total_tracks: longestSession.total_tracks,
      } : null,
      avg_session_length_ms: avgSessionMs,
      fun_facts: {
        top_song_hours: topSongs[0] ? {
          song: `${topSongs[0].artist || 'Unknown'} — ${topSongs[0].title || 'Unknown'}`,
          hours: Math.round((topSongs[0].total_ms || 0) / 3600000 * 10) / 10
        } : null,
        most_loyal_song: topSongs[0] ? { title: topSongs[0].title || 'Unknown', artist: topSongs[0].artist || 'Unknown' } : null,
        most_skipped_artist: skippedArtist ? { artist: skippedArtist.artist, skip_rate: skippedArtist.skip_rate } : null,
        most_replayed_song: mostReplayed,
        earliest_play: earliestPlay,
      },
      radio: { total_sessions: 0, total_ms: 0, top_stations: [] },
      podcast: { episodes_played: 0, episodes_completed: 0, shows_heard: 0, total_ms: 0, top_shows: [] }
    });
  });

  // ── Available periods ──────────────────────────────────────
  mstream.get('/api/v1/user/wrapped/periods', (req, res) => {
    if (!req.user?.id) return res.json([]);

    // Check both user_metadata and play_events for earliest date
    const fromMeta = d().prepare(
      'SELECT MIN(last_played) AS earliest FROM user_metadata WHERE user_id = ? AND last_played IS NOT NULL'
    ).get(req.user.id)?.earliest;

    const fromEvents = d().prepare(
      'SELECT MIN(started_at) AS earliest FROM play_events WHERE user_id = ?'
    ).get(req.user.id)?.earliest;

    const candidates = [fromMeta, fromEvents].filter(Boolean);
    if (!candidates.length) return res.json([]);

    const earlyDate = new Date(candidates.sort()[0]);
    const now = new Date();
    const periods = [];

    const configs = [
      { period: 'weekly', maxBack: 12 },
      { period: 'monthly', maxBack: 12 },
      { period: 'quarterly', maxBack: 8 },
      { period: 'yearly', maxBack: 5 }
    ];

    for (const cfg of configs) {
      for (let offset = 0; offset >= -cfg.maxBack; offset--) {
        const { start, label } = getPeriodRange(cfg.period, offset);
        if (new Date(start) < earlyDate) break;
        periods.push({ period: cfg.period, offset, label });
      }
    }

    res.json(periods);
  });
}
