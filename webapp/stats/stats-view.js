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
  // ── translation ────────────────────────────────────────────────────────
  // Every string a viewer reads goes through tr(): the page hands in the
  // app's translator (I18N.t) and language; on node, or for a key a locale
  // lacks, the English below answers. `{{x}}` interpolates; a {one, other}
  // value picks by params.count.
  const EN = {
    'stats.tile.plays': 'Plays', 'stats.tile.listeningTime': 'Listening time', 'stats.tile.tracks': 'Tracks',
    'stats.tile.skips': 'Skips', 'stats.tile.streak': 'Streak', 'stats.tile.sessions': 'Sessions',
    'stats.sub.countedPlays': 'counted plays', 'stats.sub.acrossEveryPlay': 'across every play',
    'stats.sub.ofLibrary': 'of {{n}} in the library · {{pct}}%', 'stats.sub.pctOfLibrary': '{{pct}}% of the library',
    'stats.sub.differentTracks': 'different tracks', 'stats.sub.pctOfStarts': '{{pct}}% of starts',
    'stats.sub.movedOnEarly': 'moved on early', 'stats.sub.longest': 'longest {{n}}', 'stats.sub.aboutEach': 'about {{d}} each',
    'stats.sub.sittings': 'sittings', 'stats.sub.nothingToCompare': 'nothing to compare with yet',
    'stats.sub.sameAs': 'same as {{versus}}', 'stats.sub.deltaUp': '+{{pct}}% vs {{versus}}', 'stats.sub.deltaDown': '−{{pct}}% vs {{versus}}',
    'stats.sub.deltaTimeUp': '+{{d}} vs {{versus}}', 'stats.sub.deltaTimeDown': '−{{d}} vs {{versus}}',
    'stats.count.days': { one: '{{count}} day', other: '{{count}} days' },
    'stats.count.plays': { one: '{{count}} play', other: '{{count}} plays' },
    'stats.count.tracks': { one: '{{count}} track', other: '{{count}} tracks' },
    'stats.count.starts': { one: '{{count}} start in this period', other: '{{count}} starts in this period' },
    'stats.unit.minutes': '{{n}} min', 'stats.unit.hours': '{{h}}h', 'stats.unit.hoursMinutes': '{{h}}h {{m}}m',
    'stats.outcome.completed': 'Completed', 'stats.outcome.skipped': 'Skipped', 'stats.outcome.stopped': 'Stopped',
    'stats.outcome.scrobbled': 'Scrobbled', 'stats.outcome.atTime': '{{outcome}} at {{t}}', 'stats.listened.of': '{{played}} of {{total}}',
    'stats.notCounted': 'not counted', 'stats.unknownTrack': 'Unknown track', 'stats.unknown': 'Unknown', 'stats.day.today': 'Today', 'stats.day.yesterday': 'Yesterday',
    'stats.client.webPlayer': 'web player', 'stats.client.olderWebPlayer': 'older web player', 'stats.client.olderClient': 'older client',
    'stats.via': 'via {{name}}', 'stats.aPeer': 'a peer', 'stats.forget': 'Forget this play',
    'stats.period.thisWeek': 'This week', 'stats.period.lastWeek': 'Last week', 'stats.period.thisMonth': 'This month',
    'stats.period.lastMonth': 'Last month', 'stats.period.thisQuarter': 'This quarter', 'stats.period.lastQuarter': 'Last quarter',
    'stats.period.thisHalf': 'This half-year', 'stats.period.lastHalf': 'Last half-year', 'stats.period.thisYear': 'This year',
    'stats.period.lastYear': 'Last year', 'stats.period.allTime': 'All time', 'stats.period.weekOf': 'Week of {{date}}',
    'stats.versus.lastWeek': 'last week', 'stats.versus.lastMonth': 'last month', 'stats.versus.lastQuarter': 'last quarter',
    'stats.versus.lastHalf': 'the last half-year', 'stats.versus.lastYear': 'last year', 'stats.versus.previous': 'the previous period',
    'stats.note.mostOn': 'Most on {{day}} · {{plays}}, {{time}}', 'stats.note.mostOnNoTime': 'Most on {{day}} · {{plays}}',
    'stats.note.mostAround': 'Most around {{hour}}', 'stats.note.mostlyOn': 'mostly on {{weekday}}',
    'stats.provenance.plain': 'Every play this account reported through this server. Times in your zone.',
    'stats.provenance.since': 'Every play this account reported through this server since {{date}}. Times in your zone.',
    'stats.provenance.peers': 'Every play this account reported through this server, including peers’ tracks played here. Times in your zone.',
    'stats.provenance.sincePeers': 'Every play this account reported through this server since {{date}}, including peers’ tracks played here. Times in your zone.',
    'stats.provenance.empty': 'Plays this account reports through this server. Times in your zone.',
    'stats.playsPerMonth': 'Plays per month', 'stats.nothingHere': 'Nothing here for this period.',
    'stats.error.signIn': 'Sign in to see your listening.', 'stats.error.goToLogin': 'Go to the login page',
    'stats.error.noApi': 'This server does not have the Stats API yet — it arrived in mStream 6.27.',
    'stats.error.load': 'Could not load your listening: {{message}}.',
    'stats.empty.noPlaysTitle': 'No plays yet',
    'stats.empty.noPlaysCopy': 'Plays land here as you listen. The web player reports each track when it ends, and the mobile app sends its history when it is online. Older apps that still scrobble at 30 seconds count too.',
    'stats.empty.playSomething': 'Play something', 'stats.empty.nothingIn': 'Nothing in {{period}}',
    'stats.empty.noneInPeriod': 'No plays started in this period.', 'stats.empty.logBegins': 'Your log begins on {{date}}.',
    'stats.origins.thisServer': 'This server', 'stats.origins.yourLibrary': 'Your own library.',
    'stats.origins.peersTracks': 'Peers’ tracks',
    'stats.origins.peerNote': 'A peer’s tracks, played through this server. Counted here, never on the peer.',
    'stats.origins.peersNote': '{{who}}, played through this server. Counted here, never on the peer.',
    'stats.origins.fromPeers': 'Tracks from {{n}} peers',
  };
  let translator = null;
  let language = 'en';
  function configure({ t, lang } = {}) {
    translator = typeof t === 'function' ? t : null;
    language = typeof lang === 'string' && lang ? lang : 'en';
  }
  function interpolate(str, params) {
    if (!params) { return str; }
    return String(str).replace(/\{\{(\w+)\}\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
  }
  function fallback(key, params) {
    let v = EN[key];
    if (v == null) { return key; }
    if (typeof v === 'object') {
      const n = params && typeof params.count === 'number' ? params.count : 0;
      v = n === 1 && v.one !== undefined ? v.one : v.other;
    }
    return interpolate(v, params);
  }
  function tr(key, params) {
    if (translator) {
      const v = translator(key, params);
      if (typeof v === 'string' && v !== key && !v.includes('{{')) { return v; }
    }
    return fallback(key, params);
  }
  // Calendar dates in the page's language. English keeps the design's own
  // shapes ("1 Sep", "3 September 2026"); other languages ask the browser.
  function formatDate(date, style) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) { return ''; }
    if (language === 'en' || language.startsWith('en-')) {
      return style === 'long'
        ? date.getDate() + ' ' + MONTHS_LONG[date.getMonth()] + ' ' + date.getFullYear()
        : date.getDate() + ' ' + MONTHS[date.getMonth()];
    }
    try {
      return new Intl.DateTimeFormat(language, style === 'long' ? { dateStyle: 'long' } : { day: 'numeric', month: 'short' }).format(date);
    } catch (_) { return date.getDate() + ' ' + MONTHS[date.getMonth()]; }
  }
  // Month and weekday names in the page's language, from the browser.
  function monthName(monthIndex, style = 'short') {
    try { return new Intl.DateTimeFormat(language, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, monthIndex, 1))); }
    catch (_) { return MONTHS[monthIndex]; }
  }
  function weekdayName(dayIndex, style = 'long') {
    try { return new Intl.DateTimeFormat(language, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 6 + dayIndex))); }
    catch (_) { return WEEKDAYS[dayIndex]; }
  }

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
    if (mins < 60) { return tr('stats.unit.minutes', { n: mins }); }
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? tr('stats.unit.hoursMinutes', { h, m: String(m).padStart(2, '0') }) : tr('stats.unit.hours', { h });
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
    try { return (Number(n) || 0).toLocaleString(language); }
    catch (_) { return (Number(n) || 0).toLocaleString('en-US'); }
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
    if (pct === 0) { return tr('stats.sub.sameAs', { versus }); }
    return tr(pct > 0 ? 'stats.sub.deltaUp' : 'stats.sub.deltaDown', { pct: Math.abs(pct), versus });
  }

  // Durations compare as time, not percent: "+1h 05m vs August".
  function deltaDuration(currentMs, previousMs, versus) {
    if (!Number.isFinite(previousMs) || previousMs <= 0 || !Number.isFinite(currentMs)) { return null; }
    const diff = currentMs - previousMs;
    if (Math.abs(diff) < 60000) { return tr('stats.sub.sameAs', { versus }); }
    return tr(diff > 0 ? 'stats.sub.deltaTimeUp' : 'stats.sub.deltaTimeDown', { d: fmtDuration(Math.abs(diff)), versus });
  }

  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
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
    if (diff === 0) { return tr('stats.day.today'); }
    if (diff === 1) { return tr('stats.day.yesterday'); }
    const withYear = a.y !== b.y;
    if (language === 'en' || language.startsWith('en-')) { return monthName(a.m - 1) + ' ' + a.d + (withYear ? ', ' + a.y : ''); }
    try {
      return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}) })
        .format(new Date(Date.UTC(a.y, a.m - 1, a.d)));
    } catch (_) { return monthName(a.m - 1) + ' ' + a.d + (withYear ? ', ' + a.y : ''); }
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
    return weekdayName(d.getUTCDay(), 'short') + ' ' + Number(m[3]);
  }

  function hourLabel(h) {
    return String(h).padStart(2, '0') + ':00';
  }

  // ── periods ──────────────────────────────────────────────────────────

  // The options for the period select, from GET stats/periods: the current
  // and previous instance of each preset that has data, then All time.
  // Falls back to a plain set when the log is empty.
  // "Week of 2026-09-07" · "September 2026" · "Q3 2026" — the server's label,
  // reworded in the page's language when the row carries its start instant.
  function periodLabel(x) {
    const from = x && x.from ? new Date(x.from) : null;
    if (!from || Number.isNaN(from.getTime())) { return (x && x.label) || ''; }
    if (x.period === 'week') {
      const key = from.getFullYear() + '-' + String(from.getMonth() + 1).padStart(2, '0') + '-' + String(from.getDate()).padStart(2, '0');
      return tr('stats.period.weekOf', { date: key });
    }
    if (x.period === 'month') {
      if (language === 'en' || language.startsWith('en-')) { return MONTHS_LONG[from.getMonth()] + ' ' + from.getFullYear(); }
      try { return new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(from); }
      catch (_) { return x.label || ''; }
    }
    return x.label || '';
  }

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
    const names = { week: tr('stats.period.thisWeek'), month: tr('stats.period.thisMonth'), quarter: tr('stats.period.thisQuarter'), half: tr('stats.period.thisHalf'), year: tr('stats.period.thisYear') };
    const prev = { week: tr('stats.period.lastWeek'), month: tr('stats.period.lastMonth'), quarter: tr('stats.period.lastQuarter'), half: tr('stats.period.lastHalf'), year: tr('stats.period.lastYear') };
    for (const p of ['week', 'month', 'quarter', 'half', 'year']) {
      const have = list.filter((x) => x.period === p);
      if (have.length === 0) { continue; }
      for (const x of have) {
        const label = periodLabel(x);
        if (x.offset === 0) { push(p, 0, names[p] + (label ? ' · ' + label : '')); }
        else if (x.offset === -1) { push(p, -1, prev[p] + (label ? ' · ' + label : '')); }
        else if (p === 'month' || p === 'year') { push(p, x.offset, label || (p + ' ' + x.offset)); }
      }
    }
    if (out.length === 0) { push('month', 0, tr('stats.period.thisMonth')); }
    push('all', 0, tr('stats.period.allTime'));
    return out;
  }

  // What "vs" a period compares with, in words: August · last week · 2025.
  function versusLabel(period, prevLabel) {
    if (period === 'all') { return null; }
    if (prevLabel) { return prevLabel; }
    const key = { week: 'stats.versus.lastWeek', month: 'stats.versus.lastMonth', quarter: 'stats.versus.lastQuarter', half: 'stats.versus.lastHalf', year: 'stats.versus.lastYear' }[period];
    return tr(key || 'stats.versus.previous');
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
      if (i % step === 0 || i === keys.length - 1) { out.push([i, m === 0 ? monthName(0) + ' ' + k.slice(0, 4) : monthName(m)]); }
    });
    return out;
  }

  // "Most around 20:00, mostly Thursdays" from the summary's peaks.
  function hoursNote(summary) {
    const s = summary || {};
    const parts = [];
    if (Number.isInteger(s.peakHour)) { parts.push(tr('stats.note.mostAround', { hour: hourLabel(s.peakHour) })); }
    if (Number.isInteger(s.peakWeekday) && s.peakWeekday >= 0 && s.peakWeekday < 7) {
      const w = tr('stats.note.mostlyOn', { weekday: weekdayName(s.peakWeekday) });
      parts.push(parts.length ? w : w.charAt(0).toUpperCase() + w.slice(1));
    }
    return parts.join(', ');
  }

  // "Most on Thu 3 · 19 plays, 1h 12m" from the summary's top day.
  function daysNote(summary) {
    const d = summary && summary.topDay;
    if (!d || !d.date) { return ''; }
    const plays = tr('stats.count.plays', { count: d.plays || 0 });
    return d.listenedMs
      ? tr('stats.note.mostOn', { day: dayKeyLabel(d.date), plays, time: fmtDuration(d.listenedMs) })
      : tr('stats.note.mostOnNoTime', { day: dayKeyLabel(d.date), plays });
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
      title = m.title || tr('stats.unknownTrack');
      subHtml = escapeHtml(m.artist);
      if (item.origin === 'peer') {
        subHtml += (subHtml ? ' · ' : '') + '<span class="stats-via">' + escapeHtml(tr('stats.via', { name: item.peerName || peerName(item.peerId, peers) || tr('stats.aPeer') })) + '</span>';
      }
      art = artFor(m, artUrl);
    } else {
      title = item.name || tr('stats.unknown');
      subHtml = entity === 'albums' && item.artist ? escapeHtml(item.artist) : (item.tracks ? escapeHtml(tr('stats.count.tracks', { count: item.tracks })) : '');
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
      + '<div class="stats-plays">' + escapeHtml(tr('stats.count.plays', { count: item.plays || 0 })) + '</div>'
      + '<div class="stats-minutes">' + fmtDuration(item.listenedMs) + '</div>'
      + '<div class="stats-last">' + escapeHtml(last) + '</div>'
      + '</div></div>';
  }

  const OUTCOME = {
    completed: { cls: 'completed', key: 'stats.outcome.completed' },
    skipped: { cls: 'skipped', key: 'stats.outcome.skipped' },
    stopped: { cls: 'stopped', key: 'stats.outcome.stopped' },
    legacy: { cls: 'legacy', key: 'stats.outcome.scrobbled' },
  };

  // The outcome dot + words for a history item: "Skipped at 0:08",
  // "Stopped at 1:32", "Completed", "Scrobbled at 0:30" for a legacy row.
  function outcomeParts(item) {
    const legacy = item.source === 'legacy';
    const o = OUTCOME[legacy ? 'legacy' : item.outcome] || OUTCOME.stopped;
    const word = tr(o.key);
    const text = (item.outcome !== 'completed' || legacy) ? tr('stats.outcome.atTime', { outcome: word, t: fmtClock(item.playedMs) }) : word;
    return { cls: o.cls, text };
  }

  function listenedText(item) {
    const legacy = item.source === 'legacy';
    if (item.outcome === 'completed' && !legacy) { return fmtClock(item.durationMs || item.playedMs); }
    if (item.durationMs) { return tr('stats.listened.of', { played: fmtClock(item.playedMs), total: fmtClock(item.durationMs) }); }
    return fmtClock(item.playedMs);
  }

  function clientText(item) {
    const c = item.client || '';
    if (!c) { return item.source === 'legacy' ? tr('stats.client.olderClient') : ''; }
    if (c === 'legacy') { return tr('stats.client.olderWebPlayer'); }
    if (c.startsWith('mstream-webapp')) { return tr('stats.client.webPlayer'); }
    return c.replace('/', ' ');
  }

  // One history row.
  function historyRowHtml(item, { now, tz = 'UTC', peers = [], artUrl = null } = {}) {
    const m = metaOf(item.track);
    const title = m.title || (item.filePath ? String(item.filePath).split('/').pop() : tr('stats.unknownTrack'));
    let sub = escapeHtml(m.artist);
    if (item.origin === 'peer') {
      sub += (sub ? ' · ' : '') + '<span class="stats-via">' + escapeHtml(tr('stats.via', { name: item.peerName || peerName(item.peerId, peers) || tr('stats.aPeer') })) + '</span>';
    }
    const o = outcomeParts(item);
    const counted = item.counted ? '' : '<span class="stats-muted"> · ' + escapeHtml(tr('stats.notCounted')) + '</span>';
    return '<div class="stats-row stats-history-row" data-id="' + escapeHtml(item.id) + '">'
      + '<div class="stats-when"><div class="stats-time">' + escapeHtml(timeLabel(item.startedAt, tz)) + '</div><div class="stats-day">' + escapeHtml(dayLabel(item.startedAt, now, tz)) + '</div></div>'
      + artFor(m, artUrl)
      + '<div class="stats-row-main"><div class="stats-row-title">' + escapeHtml(title) + '</div><div class="stats-row-sub">' + sub + '</div></div>'
      + '<div class="stats-outcome"><span class="stats-dot ' + o.cls + '"></span><span>' + escapeHtml(o.text) + '</span></div>'
      + '<div class="stats-listened">' + escapeHtml(listenedText(item)) + counted + '</div>'
      + '<div class="stats-client"><span class="stats-client-name">' + escapeHtml(clientText(item)) + '</span>'
      + '<button type="button" class="stats-forget" data-id="' + escapeHtml(item.id) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M15 9l-6 6"></path><path d="M9 9l6 6"></path></svg>' + escapeHtml(tr('stats.forget')) + '</button></div>'
      + '</div>';
  }

  // ── the tiles ────────────────────────────────────────────────────────

  // Six tiles from a summary (and the previous period's, when there is one).
  function tiles(summary, previous, { versus = null, libraryTracks = null } = {}) {
    const s = summary || {};
    const p = previous || {};
    const streak = s.streakDays || {};
    const sessions = s.sessions || {};
    const none = tr('stats.sub.nothingToCompare');
    return [
      { label: tr('stats.tile.plays'), value: fmtInt(s.plays), sub: versus ? (deltaText(s.plays, p.plays, versus) || none) : tr('stats.sub.countedPlays') },
      { label: tr('stats.tile.listeningTime'), value: fmtDuration(s.listenedMs), sub: versus ? (deltaDuration(s.listenedMs, p.listenedMs, versus) || none) : tr('stats.sub.acrossEveryPlay') },
      { label: tr('stats.tile.tracks'), value: fmtInt(s.uniqueTracks), sub: Number.isFinite(s.libraryCoveragePct) && libraryTracks
        ? tr('stats.sub.ofLibrary', { n: fmtInt(libraryTracks), pct: Math.round(s.libraryCoveragePct) })
        : (Number.isFinite(s.libraryCoveragePct) ? tr('stats.sub.pctOfLibrary', { pct: Math.round(s.libraryCoveragePct) }) : tr('stats.sub.differentTracks')) },
      { label: tr('stats.tile.skips'), value: fmtInt(s.skips), sub: Number.isFinite(s.skipRate) ? tr('stats.sub.pctOfStarts', { pct: Math.round(s.skipRate * 100) }) : tr('stats.sub.movedOnEarly') },
      { label: tr('stats.tile.streak'), value: tr('stats.count.days', { count: streak.current || 0 }), sub: tr('stats.sub.longest', { n: fmtInt(streak.longest) }) },
      { label: tr('stats.tile.sessions'), value: fmtInt(sessions.count), sub: sessions.avgMs ? tr('stats.sub.aboutEach', { d: fmtDuration(sessions.avgMs) }) : tr('stats.sub.sittings') },
    ];
  }

  function tilesHtml(list) {
    return list.map((t) => '<div class="stats-tile"><div class="stats-tile-label">' + escapeHtml(t.label) + '</div><div class="stats-tile-value">' + escapeHtml(t.value) + '</div><div class="stats-tile-sub">' + escapeHtml(t.sub) + '</div></div>').join('');
  }

  // "Every play this account reported through this server since 1 September…"
  function provenance(summary, { peersNamed = 0 } = {}) {
    const from = summary && summary.period && summary.period.from ? new Date(summary.period.from) : null;
    const date = formatDate(from, 'short') || null;
    const peers = peersNamed > 0;
    if (date && peers) { return tr('stats.provenance.sincePeers', { date }); }
    if (date) { return tr('stats.provenance.since', { date }); }
    if (peers) { return tr('stats.provenance.peers'); }
    return tr('stats.provenance.plain');
  }

  return {
    escapeHtml, fmtDuration, fmtClock, fmtInt, fmtPercent, deltaText, deltaDuration,
    dayLabel, timeLabel, dayKeyLabel, hourLabel, periodOptions, versusLabel,
    niceTicks, columnChart, dayAxisLabels, dailySeries, monthSeries, monthAxisLabels, hourSeries, hoursNote, daysNote,
    metaOf, topRowHtml, historyRowHtml, outcomeParts, listenedText, clientText, tiles, tilesHtml, provenance,
    configure, tr, monthName, weekdayName, formatDate, periodLabel, EN, WEEKDAYS, MONTHS,
  };
}));
