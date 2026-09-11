// /stats — the listening page (webapp/stats/). Reads the Stats API v2 as the
// signed-in user (public mode: as the operator) and renders it through
// stats-view.js, which holds every pure piece. Served at /stats by
// src/server.js behind the same gate as the player; relative URLs resolve
// from /stats/, so `../api/v1/...` is the server.
(() => {
  const V = window.STATSVIEW;
  const $ = (id) => document.getElementById(id);
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
  const token = (() => { try { return localStorage.getItem('token') || ''; } catch (_) { return ''; } })();
  const state = {
    period: 'month', offset: 0, origin: 'all', entity: 'tracks', topLimit: 8, historyLimit: 8,
    cursor: null, peers: [], periodList: [], periodOptions: [], bounds: null, libraryTracks: null,
    summary: null, last: null, seq: 0,
  };

  // ── the server ────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; }
    if (token) { headers['x-access-token'] = token; }
    const res = await fetch('../' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const err = new Error(method + ' ' + path + ' failed: ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res;
  }
  const getJson = (path) => api('GET', path).then((r) => r.json());
  function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== null && v !== '') { u.set(k, v); } }
    return u.toString();
  }
  function range(offsetDelta = 0) {
    const p = { tz, origin: state.origin };
    if (state.period === 'all') { p.period = 'all'; } else { p.period = state.period; p.offset = state.offset + offsetDelta; }
    return p;
  }
  const artUrl = (file) => '../album-art/' + encodeURIComponent(file) + (token ? '?token=' + encodeURIComponent(token) : '');
  const nowIso = () => new Date().toISOString();

  // ── once: periods, peers, the library size ────────────────────────────
  async function loadContext() {
    const [periods, peers, status] = await Promise.all([
      getJson('api/v1/stats/periods?' + qs({ tz })).catch(() => null),
      getJson('api/v1/federation/peers').then((r) => (r && Array.isArray(r.peers) ? r.peers : [])).catch(() => []),
      getJson('api/v1/db/status').catch(() => null),
    ]);
    state.peers = peers;
    state.bounds = periods;
    state.periodList = (periods && Array.isArray(periods.periods)) ? periods.periods : [];
    state.libraryTracks = status && Number.isFinite(status.totalFileCount) ? status.totalFileCount : null;
    state.periodOptions = V.periodOptions(periods);
    const sel = $('stats-period');
    sel.innerHTML = state.periodOptions.map((o) => '<option value="' + V.escapeHtml(o.value) + '">' + V.escapeHtml(o.label) + '</option>').join('');
    sel.value = state.period + ':' + state.offset;
    if (sel.value !== state.period + ':' + state.offset) {   // the default period has no data: take the first option
      const first = state.periodOptions[0];
      state.period = first.period; state.offset = first.offset; sel.value = first.value;
    }
    $('stats-origin').hidden = peers.length === 0 && !(state.bounds && state.bounds.peers);
  }

  // The toggle also appears once the log itself shows peer plays.
  function revealOriginIfPeerPlays(summary) {
    const o = summary && summary.origins && summary.origins.peers;
    if (o && o.plays > 0) { $('stats-origin').hidden = false; }
  }

  // ── the period's data ─────────────────────────────────────────────────
  async function load() {
    const seq = ++state.seq;
    state.cursor = null;
    const r = range();
    const monthly = state.period === 'year' || state.period === 'all';
    try {
      const [summary, prev, series, hours, top, history] = await Promise.all([
        getJson('api/v1/stats/summary?' + qs(r)),
        state.period === 'all' ? Promise.resolve(null) : getJson('api/v1/stats/summary?' + qs(range(-1))).catch(() => null),
        getJson('api/v1/stats/timeseries?' + qs({ ...r, bucket: monthly ? 'month' : 'day' })),
        getJson('api/v1/stats/timeseries?' + qs({ ...r, bucket: 'hourOfDay' })),
        getJson('api/v1/stats/top?' + qs({ ...r, entity: state.entity, metric: 'plays', limit: state.topLimit })),
        getJson('api/v1/stats/history?' + qs({ origin: state.origin, limit: state.historyLimit })),
      ]);
      if (seq !== state.seq) { return; }
      state.summary = summary;
      state.last = { summary, prev, series, hours, monthly };
      render({ summary, prev, series, hours, top, history, monthly });
      $('stats-loading').hidden = true;
      $('stats-error').hidden = true;
      $('stats').hidden = false;
    } catch (err) {
      if (seq !== state.seq) { return; }
      showError(err);
    }
  }

  function showError(err) {
    const box = $('stats-error');
    if (err && (err.status === 401 || err.status === 403)) {
      box.innerHTML = 'Sign in to see your listening. <a href="../login">Go to the login page</a>.';
    } else if (err && err.status === 404) {
      box.textContent = 'This server does not have the Stats API yet — it arrived in mStream 6.27.';
    } else {
      box.textContent = 'Could not load your listening: ' + (err && err.message ? err.message : 'unknown error') + '.';
    }
    box.hidden = false;
    $('stats-loading').hidden = true;
  }

  // ── rendering ─────────────────────────────────────────────────────────
  function render({ summary, prev, series, hours, top, history, monthly }) {
    const empty = !summary || !summary.events;
    const noPlaysEver = state.periodList.length === 0 && empty;
    $('stats-provenance').textContent = empty
      ? 'Plays this account reports through this server. Times in your zone.'
      : V.provenance(summary, { peersNamed: state.peers.length });
    $('stats-empty').hidden = !empty;
    $('stats-body').hidden = empty;
    if (empty) { renderEmpty(noPlaysEver); return; }

    revealOriginIfPeerPlays(summary);
    const prevEntry = state.periodList.find((p) => p.period === state.period && p.offset === state.offset - 1);
    const versus = V.versusLabel(state.period, prevEntry && prevEntry.label);
    $('stats-tiles').innerHTML = V.tilesHtml(V.tiles(summary, prev, { versus, libraryTracks: state.libraryTracks }));
    renderCharts({ summary, series, hours, monthly });
    renderOrigins(summary);
    renderTop(top);
    renderHistory(history, true);
  }

  function peakLabelFor(values) {
    const max = Math.max(0, ...values);
    return max > 0 ? V.fmtInt(max) : null;
  }

  function renderCharts({ summary, series, hours, monthly }) {
    // "All time" starts at the retention floor, years before the first play;
    // the chart starts where the log does.
    let from = series && series.period && series.period.from;
    const to = series && series.period && series.period.to;
    if (state.period === 'all' && state.bounds && state.bounds.earliest && (!from || state.bounds.earliest > from)) {
      from = state.bounds.earliest;
    }
    const s = monthly ? V.monthSeries(series.items, from, to, tz) : V.dailySeries(series.items, from, to, tz);
    const box = $('stats-days-chart');
    const width = Math.max(320, Math.min(1180, box.clientWidth || 1180));
    $('stats-days-title').textContent = monthly ? 'Plays per month' : 'Plays per day';
    box.innerHTML = V.columnChart(s.values, {
      width, height: 190,
      labels: monthly ? V.monthAxisLabels(s.keys) : V.dayAxisLabels(s.keys),
      peakLabel: peakLabelFor(s.values),
      barMax: monthly ? 40 : 24,
      titles: s.keys.map((k, i) => (monthly ? k : V.dayKeyLabel(k)) + ': ' + V.fmtInt(s.values[i]) + (s.values[i] === 1 ? ' play' : ' plays')),
    });
    $('stats-days-note').textContent = V.daysNote(summary);

    const hv = V.hourSeries(hours && hours.items);
    const hbox = $('stats-hours-chart');
    const hw = Math.max(280, Math.min(580, hbox.clientWidth || 560));
    hbox.innerHTML = V.columnChart(hv, {
      width: hw, height: 160,
      labels: [[0, '0'], [6, '6'], [12, '12'], [18, '18'], [23, '23']],
      peakLabel: Number.isInteger(summary.peakHour) ? V.hourLabel(summary.peakHour) : null,
      barMax: 16,
      titles: hv.map((v, i) => V.hourLabel(i) + ': ' + V.fmtInt(v) + (v === 1 ? ' play' : ' plays')),
    });
    $('stats-hours-note').textContent = V.hoursNote(summary);
  }

  function renderOrigins(summary) {
    const o = (summary && summary.origins) || {};
    const local = o.local || { plays: 0, listenedMs: 0 };
    const peers = o.peers || { plays: 0, listenedMs: 0 };
    const show = state.peers.length > 0 || (peers.plays || 0) > 0;
    const card = $('stats-origins').closest('.stats-card');
    card.hidden = !show;
    $('stats-hours-chart').closest('.stats-two').classList.toggle('stats-two-single', !show);
    if (!show) { return; }
    const total = ((local.plays || 0) + (peers.plays || 0)) || 1;
    const line = (name, slice, note) => '<div class="stats-origin"><div class="stats-origin-head"><div class="stats-origin-name">' + V.escapeHtml(name) + '</div>'
      + '<div class="stats-origin-nums">' + V.fmtInt(slice.plays) + (slice.plays === 1 ? ' play' : ' plays') + ' · ' + V.fmtDuration(slice.listenedMs) + '</div></div>'
      + '<div class="stats-meter"><div class="stats-meter-fill" style="width: ' + Math.round(100 * (slice.plays || 0) / total) + '%;"></div></div>'
      + '<div class="stats-hint">' + V.escapeHtml(note) + '</div></div>';
    const one = state.peers.length === 1;
    const peerName = one ? state.peers[0].name : 'Peers’ tracks';
    const peerNote = one
      ? 'A peer’s tracks, played through this server. Counted here, never on the peer.'
      : (state.peers.length > 1 ? 'Tracks from ' + state.peers.length + ' peers' : 'Peers’ tracks') + ', played through this server. Counted here, never on the peer.';
    $('stats-origins').innerHTML = line('This server', local, 'Your own library.') + line(peerName, peers, peerNote);
  }

  function renderTop(top) {
    const items = (top && top.items) || [];
    const max = items.length ? Math.max(...items.map((i) => i.plays || 0)) : 0;
    $('stats-top').innerHTML = items.length
      ? items.map((it) => V.topRowHtml(it, state.entity, max, { peers: state.peers, artUrl, now: nowIso(), tz })).join('')
      : '<div class="stats-hint" style="padding: 10px 8px;">Nothing here for this period.</div>';
    $('stats-top-more').hidden = state.topLimit >= 20 || items.length < state.topLimit;
  }

  function renderHistory(history, reset) {
    const items = (history && history.items) || [];
    const html = items.map((it) => V.historyRowHtml(it, { now: nowIso(), tz, peers: state.peers, artUrl })).join('');
    if (reset) {
      $('stats-history').innerHTML = html || '<div class="stats-hint" style="padding: 10px 8px;">No plays yet.</div>';
    } else {
      $('stats-history').insertAdjacentHTML('beforeend', html);
    }
    state.cursor = history && history.next ? history.next : null;
    $('stats-history-more').hidden = !state.cursor;
    $('stats-history-note').textContent = state.summary && state.summary.events
      ? V.fmtInt(state.summary.events) + (state.summary.events === 1 ? ' start' : ' starts') + ' in this period' : '';
  }

  function renderEmpty(noPlaysEver) {
    const actions = $('stats-empty-actions');
    if (noPlaysEver) {
      $('stats-empty-title').textContent = 'No plays yet';
      $('stats-empty-copy').textContent = 'Plays land here as you listen. The web player reports each track when it ends, and the mobile app sends its history when it is online. Older apps that still scrobble at 30 seconds count too.';
      actions.innerHTML = '<a class="stats-button" href="./" style="display: inline-flex; align-items: center; text-decoration: none;">Play something</a>';
      return;
    }
    const current = state.period + ':' + state.offset;
    const label = (state.periodOptions.find((o) => o.value === current) || {}).label || 'this period';
    $('stats-empty-title').textContent = 'Nothing in ' + label.replace(/^(This|Last) /, (m) => m.toLowerCase()).split(' · ')[0];
    const earliest = state.bounds && state.bounds.earliest ? new Date(state.bounds.earliest) : null;
    $('stats-empty-copy').textContent = 'No plays started in this period.'
      + (earliest && !Number.isNaN(earliest.getTime()) ? ' Your log begins on ' + earliest.getDate() + ' ' + V.MONTHS[earliest.getMonth()] + ' ' + earliest.getFullYear() + '.' : '');
    const others = state.periodOptions.filter((o) => o.value !== current).slice(-3);
    actions.innerHTML = others.map((o) => '<button type="button" class="stats-pill" data-period="' + V.escapeHtml(o.value) + '">' + V.escapeHtml(o.label.split(' · ')[0]) + '</button>').join('');
  }

  // ── actions ───────────────────────────────────────────────────────────
  function setPeriod(value) {
    const [period, offset] = String(value).split(':');
    state.period = period;
    state.offset = Number(offset) || 0;
    state.topLimit = 8;
    $('stats-period').value = value;
    load();
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wire() {
    $('stats-period').addEventListener('change', (e) => setPeriod(e.target.value));
    $('stats-origin').addEventListener('click', (e) => {
      const b = e.target.closest('[data-origin]');
      if (!b) { return; }
      state.origin = b.dataset.origin;
      for (const x of $('stats-origin').querySelectorAll('.stats-pill')) { x.classList.toggle('on', x === b); }
      load();
    });
    $('stats-entity').addEventListener('click', (e) => {
      const b = e.target.closest('[data-entity]');
      if (!b) { return; }
      state.entity = b.dataset.entity;
      state.topLimit = 8;
      for (const x of $('stats-entity').querySelectorAll('.stats-pill')) { x.classList.toggle('on', x === b); }
      getJson('api/v1/stats/top?' + qs({ ...range(), entity: state.entity, metric: 'plays', limit: state.topLimit })).then(renderTop).catch(showError);
    });
    $('stats-top-more').addEventListener('click', () => {
      state.topLimit = 20;
      getJson('api/v1/stats/top?' + qs({ ...range(), entity: state.entity, metric: 'plays', limit: state.topLimit })).then(renderTop).catch(showError);
    });
    $('stats-history-more').addEventListener('click', () => {
      if (!state.cursor) { return; }
      const b = $('stats-history-more');
      b.disabled = true;
      getJson('api/v1/stats/history?' + qs({ origin: state.origin, limit: 20, before: state.cursor }))
        .then((h) => renderHistory(h, false)).catch(showError).finally(() => { b.disabled = false; });
    });
    $('stats-history').addEventListener('click', (e) => {
      const b = e.target.closest('.stats-forget');
      if (!b) { return; }
      const row = b.closest('.stats-history-row');
      b.disabled = true;
      row.classList.add('stats-row-gone');
      api('DELETE', 'api/v1/stats/plays/' + encodeURIComponent(b.dataset.id))
        .then(() => { row.remove(); return load(); })
        .catch((err) => { row.classList.remove('stats-row-gone'); b.disabled = false; showError(err); });
    });
    $('stats-empty-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-period]');
      if (b) { setPeriod(b.dataset.period); }
    });
    $('stats-export').addEventListener('click', () => {
      const b = $('stats-export');
      b.disabled = true;
      api('GET', 'api/v1/stats/export').then((r) => r.blob())
        .then((blob) => download(blob, 'mstream-listening-' + new Date().toISOString().slice(0, 10) + '.ndjson'))
        .catch(showError).finally(() => { b.disabled = false; });
    });
    $('stats-clear').addEventListener('click', () => { $('stats-confirm').hidden = false; });
    $('stats-confirm').addEventListener('click', (e) => {
      const b = e.target.closest('[data-scope]');
      if (!b) { return; }
      if (b.dataset.scope === 'cancel') { $('stats-confirm').hidden = true; return; }
      for (const x of $('stats-confirm').querySelectorAll('button')) { x.disabled = true; }
      api('POST', 'api/v1/stats/reset', { scope: b.dataset.scope })
        .then(() => loadContext()).then(() => load())
        .catch(showError)
        .finally(() => { $('stats-confirm').hidden = true; for (const x of $('stats-confirm').querySelectorAll('button')) { x.disabled = false; } });
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.last && state.summary && state.summary.events) { renderCharts(state.last); } }, 200);
    });
  }

  wire();
  loadContext().then(load).catch(showError);
})();
