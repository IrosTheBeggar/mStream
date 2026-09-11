// The /stats page's pure half: formatting, period options, the two column
// charts, the row markup — everything that can be built from the Stats API's
// answers without a DOM. index.js wires it to the page; the unit test
// (test/unit/webapp-stats-view.test.mjs) drives it on node. Same UMD shape as
// alpha/auto-dj.js and assets/js/mstream.play-session.js.
//
// Chart rules (kept deliberately plain): one series, one hue; columns at most
// 24px thick with a 4px rounded top and a square base; solid hairline grid;
// one selective label per chart (the peak); axis text in the muted ink.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.STATSVIEW = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  const INK = '#F5F7FA';
  const MUTED = '#8c919a';
  const GRID = '#30353e';
  const BAR = '#657ee4';

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── numbers and times ────────────────────────────────────────────────

  // 9h 24m · 44 min · 58 min · 0 min — for totals.
  function fmtDuration(ms) {
    const mins = Math.round((Number(ms) || 0) / 60000);
    if (mins < 60) { return mins + ' min'; }
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + 'h' + (m > 0 ? ' ' + String(m).padStart(2, '0') + 'm' : '');
  }

  // 4:07 · 1:02:15 — for a single play or track.
  function fmtClock(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  }

  function fmtInt(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function fmtPercent(fraction) {
    if (!Number.isFinite(fraction)) { return null; }
    return Math.round(fraction * 100) + '%';
  }

  // "+12% vs August" / "−5% vs last week" / "same as August" / null when there
  // is nothing to compare with.
  function deltaText(current, previous, versus) {
    if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current)) { return null; }
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) { return 'same as ' + versus; }
    return (pct > 0 ? '+' : '−') + Math.abs(pct) + '% vs ' + versus;
  }

  // Durations compare as time, not percent: "+1h 05m vs August".
  function deltaDuration(currentMs, previousMs, versus) {
    if (!Number.isFinite(previousMs) || previousMs <= 0 || !Number.isFinite(currentMs)) { return null; }
    const diff = currentMs - previousMs;
    if (Math.abs(diff) < 60000) { return 'same as ' + versus; }
    return (diff > 0 ? '+' : '−') + fmtDuration(Math.abs(diff)) + ' vs ' + versus;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function localParts(iso, tz) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { return null; }
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const p = {};
    for (const part of fmt.formatToParts(d)) { p[part.type] = part.value; }
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute) };
  }

  // Today · Yesterday · Sep 8 · Sep 8, 2025 — relative to `now`, in `tz`.
  function dayLabel(iso, now, tz) {
    const a = localParts(iso, tz);
    const b = localParts(now, tz);
    if (!a || !b) { return ''; }
    const dayNum = (p) => Date.UTC(p.y, p.m - 1, p.d) / 86400000;
    const diff = dayNum(b) - dayNum(a);
    if (diff === 0) { return 'Today'; }
    if (diff === 1) { return 'Yesterday'; }
    return MONTHS[a.m - 1] + ' ' + a.d + (a.y !== b.y ? ', ' + a.y : '');
  }

  // 21:14 in `tz`.
  function timeLabel(iso, tz) {
    const p = localParts(iso, tz);
    if (!p) { return ''; }
    return String(p.hh).padStart(2, '0') + ':' + String(p.mm).padStart(2, '0');
  }

  // "Wed 3" for a YYYY-MM-DD day key.
  function dayKeyLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    if (!m) { return String(key || ''); }
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return WEEKDAYS[d.getUTCDay()].slice(0, 3) + ' ' + Number(m[3]);
  }

  function hourLabel(h) {
    return String(h).padStart(2, '0') + ':00';
  }

  // ── periods ──────────────────────────────────────────────────────────

  // The options for the period select, from GET stats/periods: the current
  // and previous instance of each preset that has data, then All time.
  // Falls back to a plain set when the log is empty.
  function periodOptions(periods) {
    const list = Array.isArray(periods && periods.periods) ? periods.periods : [];
    const out = [];
    const seen = new Set();
    const push = (period, offset, label) => {
      const key = period + ':' + offset;
      if (seen.has(key)) { return; }
      seen.add(key);
      out.push({ period, offset, label, value: key });
    };
    const names = { week: 'This week', month: 'This month', quarter: 'This quarter', half: 'This half-year', year: 'This year' };
    const prev = { week: 'Last week', month: 'Last month', quarter: 'Last quarter', half: 'Last half-year', year: 'Last year' };
    for (const p of ['week', 'month', 'quarter', 'half', 'year']) {
      const have = list.filter((x) => x.period === p);
      if (have.length === 0) { continue; }
      for (const x of have) {
        if (x.offset === 0) { push(p, 0, names[p] + (x.label ? ' · ' + x.label : '')); }
        else if (x.offset === -1) { push(p, -1, prev[p] + (x.label ? ' · ' + x.label : '')); }
        else if (p === 'month' || p === 'year') { push(p, x.offset, x.label || (p + ' ' + x.offset)); }
      }
    }
    if (out.length === 0) { push('month', 0, 'This month'); }
    push('all', 0, 'All time');
    return out;
  }

  // What "vs" a period compares with, in words: August · last week · 2025.
  function versusLabel(period, prevLabel) {
    if (period === 'all') { return null; }
    if (prevLabel) { return prevLabel; }
    return { week: 'last week', month: 'last month', quarter: 'last quarter', half: 'the last half-year', year: 'last year' }[period] || 'the previous period';
  }

  // ── charts ───────────────────────────────────────────────────────────

  function niceTicks(max) {
    if (!(max > 0)) { return [0, 1]; }
    const raw = max / 4;
    const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(raw))));
    const step = Math.max(1, [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) || 10 * mag);
    const ticks = [];
    for (let t = 0; t <= max + step - 1e-9; t += step) { ticks.push(Math.round(t * 1000) / 1000); }
    if (ticks[ticks.length - 1] < max) { ticks.push(ticks[ticks.length - 1] + step); }
    return ticks;
  }

  function barPath(x, y, w, h, r) {
    if (!(h > 0)) { return ''; }
    r = Math.min(r, w / 2, h);
    return '<path d="M' + x.toFixed(1) + ' ' + (y + h).toFixed(1) + ' v' + (-(h - r)).toFixed(1)
      + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + ' h' + (w - 2 * r).toFixed(1)
      + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' v' + (h - r).toFixed(1) + ' z" fill="' + BAR + '"></path>';
  }

  // A single-series column chart as an SVG string.
  //   values      the bars, in order
  //   labels      [[index, text], ...] — which slots get an x label
  //   peakLabel   text on the tallest bar's cap (null for none)
  //   width/height in px; barMax caps the column thickness
  function columnChart(values, { width = 800, height = 190, labels = [], peakLabel = null, barMax = 24, titles = null } = {}) {
    const n = Math.max(1, values.length);
    const left = 34;
    const right = 8;
    const top = 16;
    const bottom = 22;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const slot = plotW / n;
    const bw = Math.min(barMax, Math.max(3, Math.round(slot * 0.62)));
    const ticks = niceTicks(Math.max(0, ...values));
    const vmax = ticks[ticks.length - 1] || 1;
    const out = ['<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" style="display: block;">'];
    for (const t of ticks) {
      const y = top + plotH - plotH * t / vmax;
      out.push('<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (width - right) + '" y2="' + y.toFixed(1) + '" stroke="' + GRID + '" stroke-width="1"></line>');
      out.push('<text x="' + (left - 8) + '" y="' + y.toFixed(1) + '" font-size="11" fill="' + MUTED + '" text-anchor="end" dominant-baseline="middle" style="font-variant-numeric: tabular-nums;">' + fmtInt(t) + '</text>');
    }
    let peak = -1;
    values.forEach((v, i) => { if (v > 0 && (peak < 0 || v > values[peak])) { peak = i; } });
    values.forEach((v, i) => {
      const x = left + slot * i + (slot - bw) / 2;
      const h = plotH * (v / vmax);
      const title = titles ? '<title>' + escapeHtml(titles[i]) + '</title>' : '';
      if (h > 0) {
        out.push('<g class="stats-bar" data-index="' + i + '">' + barPath(x, top + plotH - h, bw, h, 4).replace('></path>', '>' + title + '</path>') + '</g>');
      } else {
        out.push('<g class="stats-bar" data-index="' + i + '"><rect x="' + x.toFixed(1) + '" y="' + (top + plotH - 1).toFixed(1) + '" width="' + bw + '" height="1" fill="' + GRID + '">' + title + '</rect></g>');
      }
      if (peakLabel && i === peak) {
        out.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (top + plotH - h - 5).toFixed(1) + '" font-size="11" font-weight="600" fill="' + INK + '" text-anchor="middle">' + escapeHtml(peakLabel) + '</text>');
      }
    });
    for (const [i, text] of labels) {
      const x = left + slot * i + slot / 2;
      out.push('<text x="' + x.toFixed(1) + '" y="' + (height - 6) + '" font-size="11" fill="' + MUTED + '" text-anchor="middle">' + escapeHtml(text) + '</text>');
    }
    out.push('</svg>');
    return out.join('');
  }

  // Which day slots get a label: 1, then every 5th, then the last.
  function dayAxisLabels(dayKeys) {
    const n = dayKeys.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const dayOfMonth = Number(String(dayKeys[i]).slice(8, 10));
      if (i === 0 || i === n - 1 || dayOfMonth % 5 === 0) { out.push([i, String(dayOfMonth)]); }
    }
    if (n > 40) { return out.filter(([i]) => i === 0 || i === n - 1 || i % 7 === 0); }
    return out;
  }

  // The daily series for a period: one value per day of the range, zero
  // where the server sent no bucket (it only sends hours with plays).
  // The range's first and last calendar day in `tz` (`to` is exclusive).
  function localSpan(fromIso, toIso, tz) {
    const a = localParts(fromIso, tz);
    const endMs = new Date(toIso).getTime();
    const b = Number.isNaN(endMs) ? null : localParts(new Date(endMs - 1).toISOString(), tz);
    return a && b ? { a, b } : null;
  }

  function dailySeries(items, fromIso, toIso, tz = 'UTC') {
    const byDay = new Map();
    for (const it of items || []) { byDay.set(String(it.bucket).slice(0, 10), Number(it.plays) || 0); }
    const span = localSpan(fromIso, toIso, tz);
    if (!span) {
      const sorted = [...byDay.keys()].sort();
      return { keys: sorted, values: sorted.map((k) => byDay.get(k)) };
    }
    const keys = [];
    const last = Date.UTC(span.b.y, span.b.m - 1, span.b.d);
    for (let d = new Date(Date.UTC(span.a.y, span.a.m - 1, span.a.d)); d.getTime() <= last && keys.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
      keys.push(d.toISOString().slice(0, 10));
    }
    return { keys, values: keys.map((k) => byDay.get(k) || 0) };
  }

  // One value per month of the range (bucket=month), zero where nothing played.
  function monthSeries(items, fromIso, toIso, tz = 'UTC') {
    const byMonth = new Map();
    for (const it of items || []) { byMonth.set(String(it.bucket).slice(0, 7), Number(it.plays) || 0); }
    const span = localSpan(fromIso, toIso, tz);
    if (!span) {
      const sorted = [...byMonth.keys()].sort();
      return { keys: sorted, values: sorted.map((k) => byMonth.get(k)) };
    }
    const keys = [];
    for (let y = span.a.y, m = span.a.m; keys.length < 240 && (y < span.b.y || (y === span.b.y && m <= span.b.m));) {
      keys.push(y + '-' + String(m).padStart(2, '0'));
      m += 1; if (m === 13) { m = 1; y += 1; }
    }
    return { keys, values: keys.map((k) => byMonth.get(k) || 0) };
  }

  // Month labels: every month up to 14 bars, then every third, always the year on January.
  function monthAxisLabels(keys) {
    const step = keys.length > 14 ? 3 : 1;
    const out = [];
    keys.forEach((k, i) => {
      const m = Number(k.slice(5, 7)) - 1;
      if (i % step === 0 || i === keys.length - 1) { out.push([i, m === 0 ? MONTHS[0] + ' ' + k.slice(0, 4) : MONTHS[m]]); }
    });
    return out;
  }

  // "Most around 20:00, mostly Thursdays" from the summary's peaks.
  function hoursNote(summary) {
    const s = summary || {};
    const parts = [];
    if (Number.isInteger(s.peakHour)) { parts.push('Most around ' + hourLabel(s.peakHour)); }
    if (Number.isInteger(s.peakWeekday) && WEEKDAYS[s.peakWeekday]) { parts.push((parts.length ? 'mostly ' : 'Mostly ') + WEEKDAYS[s.peakWeekday] + 's'); }
    return parts.join(', ');
  }

  // "Most on Thu 3 · 19 plays, 1h 12m" from the summary's top day.
  function daysNote(summary) {
    const d = summary && summary.topDay;
    if (!d || !d.date) { return ''; }
    return 'Most on ' + dayKeyLabel(d.date) + ' · ' + fmtInt(d.plays) + (d.plays === 1 ? ' play' : ' plays') + (d.listenedMs ? ', ' + fmtDuration(d.listenedMs) : '');
  }

  // 24 values from the hourOfDay buckets ("0".."23").
  function hourSeries(items) {
    const values = new Array(24).fill(0);
    for (const it of items || []) {
      const h = Number(it.bucket);
      if (Number.isInteger(h) && h >= 0 && h < 24) { values[h] = Number(it.plays) || 0; }
    }
    return values;
  }

  // ── rows ─────────────────────────────────────────────────────────────

  const ART = '<div class="stats-art"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6f7683" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>';

  // A row's track is the SPA's metadata object, `{ filepath, metadata }`
  // (db.js renderMetadataObj); a bare `{ title, artist }` is taken too.
  function metaOf(track) {
    const t = track || {};
    const m = t.metadata && typeof t.metadata === 'object' ? t.metadata : t;
    const filepath = t.filepath || m.filepath || '';
    return {
      title: m.title || (filepath ? String(filepath).split('/').pop() : ''),
      artist: m.artist || '',
      album: m.album || '',
      art: m['album-art'] || '',
      filepath,
    };
  }

  function artFor(meta, artUrl) {
    if (meta && meta.art && typeof artUrl === 'function') {
      const url = artUrl(meta.art, meta);
      if (url) { return '<img class="stats-art" src="' + escapeHtml(url) + '" alt="" loading="lazy">'; }
    }
    return ART;
  }

  function peerName(peerId, peers) {
    const p = (peers || []).find((x) => Number(x.id) === Number(peerId));
    return p ? p.name : null;
  }

  // One Top row. `entity` is tracks / artists / albums / genres; `max` the
  // top row's plays for the share bar.
  function topRowHtml(item, entity, max, { peers = [], artUrl = null, now = null, tz = 'UTC' } = {}) {
    let title;
    let subHtml;
    let art = '';
    if (entity === 'tracks') {
      const m = metaOf(item.track);
      title = m.title || 'Unknown track';
      subHtml = escapeHtml(m.artist);
      if (item.origin === 'peer') {
        subHtml += (subHtml ? ' · ' : '') + '<span class="stats-via">via ' + escapeHtml(peerName(item.peerId, peers) || 'a peer') + '</span>';
      }
      art = artFor(m, artUrl);
    } else {
      title = item.name || 'Unknown';
      subHtml = entity === 'albums' && item.artist ? escapeHtml(item.artist) : (item.tracks ? fmtInt(item.tracks) + (item.tracks === 1 ? ' track' : ' tracks') : '');
    }
    const share = max > 0 ? Math.max(0.02, (Number(item.plays) || 0) / max) : 0;
    const last = entity === 'tracks' && item.lastPlayed && now ? dayLabel(item.lastPlayed, now, tz) : '';
    return '<div class="stats-row">'
      + '<div class="stats-rank">' + fmtInt(item.rank) + '</div>'
      + art
      + '<div class="stats-row-main"><div class="stats-row-title">' + escapeHtml(title) + '</div>'
      + '<div class="stats-row-sub">' + subHtml + '</div></div>'
      + '<div class="stats-row-right">'
      + '<div class="stats-share"><div class="stats-share-fill" style="width: ' + Math.round(share * 100) + '%;"></div></div>'
      + '<div class="stats-plays">' + fmtInt(item.plays) + (item.plays === 1 ? ' play' : ' plays') + '</div>'
      + '<div class="stats-minutes">' + fmtDuration(item.listenedMs) + '</div>'
      + '<div class="stats-last">' + escapeHtml(last) + '</div>'
      + '</div></div>';
  }

  const OUTCOME = {
    completed: { cls: 'completed', word: 'Completed' },
    skipped: { cls: 'skipped', word: 'Skipped' },
    stopped: { cls: 'stopped', word: 'Stopped' },
    legacy: { cls: 'legacy', word: 'Scrobbled' },
  };

  // The outcome dot + words for a history item: "Skipped at 0:08",
  // "Stopped at 1:32", "Completed", "Scrobbled at 0:30" for a legacy row.
  function outcomeParts(item) {
    const legacy = item.source === 'legacy';
    const o = OUTCOME[legacy ? 'legacy' : item.outcome] || OUTCOME.stopped;
    let detail = '';
    if (item.outcome !== 'completed' || legacy) { detail = ' at ' + fmtClock(item.playedMs); }
    return { cls: o.cls, text: o.word + detail };
  }

  function listenedText(item) {
    const legacy = item.source === 'legacy';
    if (item.outcome === 'completed' && !legacy) { return fmtClock(item.durationMs || item.playedMs); }
    if (item.durationMs) { return fmtClock(item.playedMs) + ' of ' + fmtClock(item.durationMs); }
    return fmtClock(item.playedMs);
  }

  function clientText(item) {
    const c = item.client || '';
    if (!c) { return item.source === 'legacy' ? 'older client' : ''; }
    if (c === 'legacy') { return 'older web player'; }
    if (c.startsWith('mstream-webapp')) { return 'web player'; }
    return c.replace('/', ' ');
  }

  // One history row.
  function historyRowHtml(item, { now, tz = 'UTC', peers = [], artUrl = null } = {}) {
    const m = metaOf(item.track);
    const title = m.title || (item.filePath ? String(item.filePath).split('/').pop() : 'Unknown track');
    let sub = escapeHtml(m.artist);
    if (item.origin === 'peer') {
      sub += (sub ? ' · ' : '') + '<span class="stats-via">via ' + escapeHtml(peerName(item.peerId, peers) || 'a peer') + '</span>';
    }
    const o = outcomeParts(item);
    const counted = item.counted ? '' : '<span class="stats-muted"> · not counted</span>';
    return '<div class="stats-row stats-history-row" data-id="' + escapeHtml(item.id) + '">'
      + '<div class="stats-when"><div class="stats-time">' + escapeHtml(timeLabel(item.startedAt, tz)) + '</div><div class="stats-day">' + escapeHtml(dayLabel(item.startedAt, now, tz)) + '</div></div>'
      + artFor(m, artUrl)
      + '<div class="stats-row-main"><div class="stats-row-title">' + escapeHtml(title) + '</div><div class="stats-row-sub">' + sub + '</div></div>'
      + '<div class="stats-outcome"><span class="stats-dot ' + o.cls + '"></span><span>' + escapeHtml(o.text) + '</span></div>'
      + '<div class="stats-listened">' + escapeHtml(listenedText(item)) + counted + '</div>'
      + '<div class="stats-client"><span class="stats-client-name">' + escapeHtml(clientText(item)) + '</span>'
      + '<button type="button" class="stats-forget" data-id="' + escapeHtml(item.id) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M15 9l-6 6"></path><path d="M9 9l6 6"></path></svg>Forget this play</button></div>'
      + '</div>';
  }

  // ── the tiles ────────────────────────────────────────────────────────

  // Six tiles from a summary (and the previous period's, when there is one).
  function tiles(summary, previous, { versus = null, libraryTracks = null } = {}) {
    const s = summary || {};
    const p = previous || {};
    const streak = s.streakDays || {};
    const sessions = s.sessions || {};
    const skipRate = fmtPercent(s.skipRate);
    return [
      { label: 'Plays', value: fmtInt(s.plays), sub: versus ? (deltaText(s.plays, p.plays, versus) || 'nothing to compare with yet') : 'counted plays' },
      { label: 'Listening time', value: fmtDuration(s.listenedMs), sub: versus ? (deltaDuration(s.listenedMs, p.listenedMs, versus) || 'nothing to compare with yet') : 'across every play' },
      { label: 'Tracks', value: fmtInt(s.uniqueTracks), sub: Number.isFinite(s.libraryCoveragePct) && libraryTracks ? 'of ' + fmtInt(libraryTracks) + ' in the library · ' + Math.round(s.libraryCoveragePct) + '%' : (Number.isFinite(s.libraryCoveragePct) ? Math.round(s.libraryCoveragePct) + '% of the library' : 'different tracks') },
      { label: 'Skips', value: fmtInt(s.skips), sub: skipRate ? skipRate + ' of starts' : 'moved on early' },
      { label: 'Streak', value: fmtInt(streak.current) + (streak.current === 1 ? ' day' : ' days'), sub: 'longest ' + fmtInt(streak.longest) },
      { label: 'Sessions', value: fmtInt(sessions.count), sub: sessions.avgMs ? 'about ' + fmtDuration(sessions.avgMs) + ' each' : 'sittings' },
    ];
  }

  function tilesHtml(list) {
    return list.map((t) => '<div class="stats-tile"><div class="stats-tile-label">' + escapeHtml(t.label) + '</div><div class="stats-tile-value">' + escapeHtml(t.value) + '</div><div class="stats-tile-sub">' + escapeHtml(t.sub) + '</div></div>').join('');
  }

  // "Every play this account reported through this server since 1 September…"
  function provenance(summary, { peersNamed = 0, clients = 0 } = {}) {
    const from = summary && summary.period && summary.period.from ? new Date(summary.period.from) : null;
    const since = from && !Number.isNaN(from.getTime()) ? ' since ' + from.getUTCDate() + ' ' + MONTHS[from.getUTCMonth()] : '';
    const apps = clients > 1 ? ' — from ' + clients + ' apps' : '';
    const peers = peersNamed > 0 ? ', including peers’ tracks played here' : '';
    return 'Every play this account reported through this server' + since + apps + peers + '. Times in your zone.';
  }

  return {
    escapeHtml, fmtDuration, fmtClock, fmtInt, fmtPercent, deltaText, deltaDuration,
    dayLabel, timeLabel, dayKeyLabel, hourLabel, periodOptions, versusLabel,
    niceTicks, columnChart, dayAxisLabels, dailySeries, monthSeries, monthAxisLabels, hourSeries, hoursNote, daysNote,
    metaOf, topRowHtml, historyRowHtml, outcomeParts, listenedText, clientText, tiles, tilesHtml, provenance,
    WEEKDAYS, MONTHS,
  };
}));
