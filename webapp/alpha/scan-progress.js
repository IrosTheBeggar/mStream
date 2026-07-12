// Top-bar scan progress indicator for the main UI.
// Polls GET /api/v1/scan/progress and renders one `.spc-card` per active scan.
// Empty response → empty wrap → no visible UI (zero layout impact when idle).
//
// Also polls GET /api/v1/scan/status (every other tick — enrichment
// passes move slower than scans) and renders one quiet chip while an
// enrichment pass (waveforms, album-art, lyrics, BPM/key, discovery,
// AcoustID) is running. The task queue is strictly serial, so at most
// one enrichment chip can ever show.

(function () {
  const POLL_INTERVAL_MS = 3000;
  // /scan/status is fetched every Nth tick: enrichment passes are
  // minutes-long background work — 6s freshness is plenty, and it keeps
  // the extra request volume at half the scan poll's.
  const STATUS_EVERY_N_TICKS = 2;
  let timer = null;
  let tickCount = 0;
  // Latest running enrichment pass entry (from body.enrichment) or null.
  // Kept between status polls so the chip doesn't flicker on the scan-only
  // ticks in between.
  let enrichRunning = null;

  const ENRICH_LABELS = {
    waveform: 'Waveforms',
    albumart: 'Album art',
    lyrics: 'Lyrics',
    audioanalysis: 'BPM / key',
    discovery: 'Discovery',
    acoustid: 'AcoustID',
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderEnrichChip(enrich) {
    if (!enrich) { return ''; }
    const label = ENRICH_LABELS[enrich.pass] || enrich.pass;
    const prog = enrich.progress;
    const pct = prog && prog.total ? Math.min(100, Math.round((prog.attempted / prog.total) * 100)) : null;
    const bar = pct != null
      ? `<div class="spc-fill" style="width:${pct}%"></div>`
      : `<div class="spc-fill-ind"></div>`;
    const countTxt = prog && prog.total
      ? `${prog.attempted.toLocaleString()} / ${prog.total.toLocaleString()}`
      : '';
    return `<div class="spc-card spc-enrich" title="Post-scan enrichment pass">
      <span class="spc-dot"></span>
      <span class="spc-vpath">${escapeHtml(label)}</span>
      <div class="spc-track">${bar}</div>
      <span class="spc-count">${escapeHtml(countTxt)}</span>
    </div>`;
  }

  function render(scans, enrich) {
    const wrap = document.getElementById('scan-progress-wrap');
    if (!wrap) { return; }
    const scanCards = Array.isArray(scans) ? scans.map(sp => {
      const pctTxt = sp.pct != null ? `${sp.pct}%` : 'Counting…';
      const bar = sp.pct != null
        ? `<div class="spc-fill" style="width:${sp.pct}%"></div>`
        : `<div class="spc-fill-ind"></div>`;
      const countTxt = sp.expected
        ? `${sp.scanned.toLocaleString()} / ${sp.expected.toLocaleString()}`
        : `${sp.scanned.toLocaleString()} files`;
      const titleAttr = sp.currentFile
        ? ` title="${escapeHtml(sp.currentFile)}"`
        : '';
      return `<div class="spc-card"${titleAttr}>
        <span class="spc-dot"></span>
        <span class="spc-vpath">${escapeHtml(sp.vpath)}</span>
        <div class="spc-track">${bar}</div>
        <span class="spc-pct">${escapeHtml(pctTxt)}</span>
        <span class="spc-count">${escapeHtml(countTxt)}</span>
      </div>`;
    }) : [];
    // A running scan and a running enrichment pass are mutually exclusive
    // (strictly serial task queue), but render both defensively — worst
    // case during a transition the chip trails the scan card by one tick.
    wrap.innerHTML = scanCards.join('') + renderEnrichChip(enrich);
  }

  function authedServer() {
    const server = (typeof MSTREAMAPI !== 'undefined') ? MSTREAMAPI.currentServer : null;
    // host is '' on same-origin sessions (m.js builds RELATIVE urls off it
    // everywhere — see its lyrics/album-art fetches), so requiring a truthy
    // host here silently disabled the whole widget for locally-served
    // logins; only the token is actually load-bearing.
    if (!server || !server.token) { return null; }
    return server;
  }

  async function fetchEnrichStatus(server) {
    const res = await fetch(server.host + 'api/v1/scan/status', {
      headers: { 'x-access-token': server.token },
    });
    if (!res.ok) { return; }
    const body = await res.json();
    enrichRunning = (body.enrichment || []).find(p => p.state === 'running') || null;
  }

  async function tick() {
    try {
      const server = authedServer();
      if (!server) { return; }
      if (tickCount++ % STATUS_EVERY_N_TICKS === 0) {
        await fetchEnrichStatus(server).catch(() => {});
      }
      const res = await fetch(server.host + 'api/v1/scan/progress', {
        headers: { 'x-access-token': server.token },
      });
      if (!res.ok) { return; }
      render(await res.json(), enrichRunning);
    } catch { /* ignore transient network errors */ }
  }

  function start() {
    if (timer) { return; }
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
  }

  // Kick off after page ready so MSTREAMAPI has been hydrated by m.js
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Expose for tests / manual control
  window.mstreamScanProgress = { tick, render };
})();
