// Smart Playlists — dynamic playlists with filter-based queries
// Stores filter definitions in smart_playlists table, executes them
// as SQL queries against the tracks/artists/albums/genres tables.

import * as db from '../db/manager.js';
import { renderMetadataObj, libraryFilter, trackQuery, enrichRowsWithGenres } from './db.js';

const d = () => db.getDB();

// ── Build SQL WHERE clauses from a filters object ─────────────
function buildFilterQuery(filters, userId, user) {
  const conditions = [];
  const params = [];

  // Library access control
  const f = libraryFilter(user);
  conditions.push(f.clause);
  params.push(...f.params);

  // Selected vpaths (subset of user's accessible libraries)
  if (filters.selectedVpaths && filters.selectedVpaths.length > 0) {
    const vpathIds = filters.selectedVpaths
      .map(name => db.getLibraryByName(name))
      .filter(Boolean)
      .map(lib => lib.id);
    if (vpathIds.length > 0) {
      conditions.push(`t.library_id IN (${vpathIds.map(() => '?').join(',')})`);
      params.push(...vpathIds);
    }
  }

  // Genres filter
  let joinGenres = false;
  if (filters.genres && filters.genres.length > 0) {
    joinGenres = true;
    conditions.push(`g.name IN (${filters.genres.map(() => '?').join(',')})`);
    params.push(...filters.genres);
  }

  // Year range
  if (filters.yearFrom != null) {
    conditions.push('t.year >= ?');
    params.push(filters.yearFrom);
  }
  if (filters.yearTo != null) {
    conditions.push('t.year <= ?');
    params.push(filters.yearTo);
  }

  // Minimum rating
  if (filters.minRating && filters.minRating > 0) {
    conditions.push('um.rating >= ?');
    params.push(filters.minRating);
  }

  // Starred only (any rating > 0)
  if (filters.starred) {
    conditions.push('um.rating > 0');
  }

  // Play status
  if (filters.playedStatus === 'never') {
    conditions.push('(um.play_count IS NULL OR um.play_count = 0)');
  } else if (filters.playedStatus === 'played') {
    const minPlays = filters.minPlayCount || 1;
    conditions.push('um.play_count >= ?');
    params.push(minPlays);
  }

  // Artist search
  if (filters.artistSearch && filters.artistSearch.trim()) {
    conditions.push('a.name LIKE ?');
    params.push(`%${filters.artistSearch.trim()}%`);
  }

  return { conditions, params, joinGenres };
}

function buildSortClause(sort) {
  switch (sort) {
    case 'artist':      return 'a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number';
    case 'album':       return 'al.name COLLATE NOCASE, t.track_number';
    case 'year_asc':    return 'COALESCE(t.year, 9999), a.name COLLATE NOCASE';
    case 'year_desc':   return 'COALESCE(t.year, 0) DESC, a.name COLLATE NOCASE';
    case 'rating':      return 'COALESCE(um.rating, 0) DESC, a.name COLLATE NOCASE';
    case 'play_count':  return 'COALESCE(um.play_count, 0) DESC, a.name COLLATE NOCASE';
    case 'last_played': return 'um.last_played DESC, a.name COLLATE NOCASE';
    case 'random':      return 'RANDOM()';
    default:            return 'a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number';
  }
}

function runSmartQuery(filters, sort, limit, userId, user) {
  const { conditions, params, joinGenres } = buildFilterQuery(filters, userId, user);

  const userIdParams = userId ? [userId] : [];
  const genreJoin = joinGenres
    ? 'JOIN track_genres tg ON tg.track_id = t.id JOIN genres g ON g.id = tg.genre_id'
    : '';

  // includeGenres:false: the default tg_agg join materialises the WHOLE
  // track_genres table per query (cost scales with the library, not this
  // playlist) — genres are batch-enriched onto just the returned rows
  // below. `genreJoin` is unrelated: it joins the M2M for FILTERING.
  const sql = `
    ${trackQuery(userId, { includeGenres: false })}
    ${genreJoin}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${buildSortClause(sort)}
    LIMIT ?
  `;

  const allParams = [...userIdParams, ...params, Math.min(limit || 50, 1000)];
  return enrichRowsWithGenres(d(), d().prepare(sql).all(...allParams));
}

function countSmartQuery(filters, userId, user) {
  const { conditions, params, joinGenres } = buildFilterQuery(filters, userId, user);

  const userIdParams = userId ? [userId] : [];
  const genreJoin = joinGenres
    ? 'JOIN track_genres tg ON tg.track_id = t.id JOIN genres g ON g.id = tg.genre_id'
    : '';

  const sql = `
    SELECT COUNT(DISTINCT t.id) AS cnt
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN libraries l ON t.library_id = l.id
    LEFT JOIN user_metadata um ON COALESCE(t.audio_hash, t.file_hash) = um.track_hash AND um.user_id = ${userId ? '?' : 'NULL'}
    ${genreJoin}
    WHERE ${conditions.join(' AND ')}
  `;

  const allParams = [...userIdParams, ...params];
  return d().prepare(sql).get(...allParams)?.cnt || 0;
}

export function setup(mstream) {

  // ── List all smart playlists ───────────────────────────────
  // In public/no-users mode the rows are scoped to the V25 anonymous
  // sentinel — the operator's persistent identity. Same model as
  // playlists, cue points, and user_metadata.
  mstream.get('/api/v1/smart-playlists', (req, res) => {
    if (!req.user?.id) return res.json({ playlists: [] });
    const rows = d().prepare(
      'SELECT id, name, filters_json, sort, limit_n FROM smart_playlists WHERE user_id = ? ORDER BY name COLLATE NOCASE'
    ).all(req.user.id);

    const playlists = rows.map(r => ({
      id: r.id,
      name: r.name,
      filters: JSON.parse(r.filters_json),
      sort: r.sort,
      limit_n: r.limit_n,
      limit: r.limit_n  // alias — frontend reads both `limit` and `limit_n`
    }));
    res.json({ playlists });
  });

  // ── Create smart playlist ─────────────────────────────────
  mstream.post('/api/v1/smart-playlists', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const { name, filters, sort, limit } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const result = d().prepare(`
      INSERT INTO smart_playlists (name, user_id, filters_json, sort, limit_n)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, req.user.id, JSON.stringify(filters || {}), sort || 'artist', limit || 50);

    res.json({ id: Number(result.lastInsertRowid) });
  });

  // ── Update smart playlist ─────────────────────────────────
  mstream.put('/api/v1/smart-playlists/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const { name, filters, sort, limit } = req.body;

    d().prepare(`
      UPDATE smart_playlists SET name = ?, filters_json = ?, sort = ?, limit_n = ?
      WHERE id = ? AND user_id = ?
    `).run(name, JSON.stringify(filters || {}), sort || 'artist', limit || 50, req.params.id, req.user.id);

    res.json({});
  });

  // ── Delete smart playlist ─────────────────────────────────
  mstream.delete('/api/v1/smart-playlists/:id', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    d().prepare('DELETE FROM smart_playlists WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({});
  });

  // ── Run / preview smart playlist ──────────────────────────
  mstream.post('/api/v1/smart-playlists/run', (req, res) => {
    const { filters, sort, limit } = req.body;
    if (!filters) return res.json([]);

    const rows = runSmartQuery(filters, sort, limit, req.user?.id, req.user);
    res.json({ songs: rows.map(renderMetadataObj) });
  });

  // ── Count matching tracks ─────────────────────────────────
  mstream.post('/api/v1/smart-playlists/count', (req, res) => {
    const { filters } = req.body;
    if (!filters) return res.json({ count: 0 });

    const count = countSmartQuery(filters, req.user?.id, req.user);
    res.json({ count });
  });
}
