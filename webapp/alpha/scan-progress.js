// Top-bar scan progress indicator for the main UI.
// Polls GET /api/v1/scan/progress and renders one `.spc-card` per active scan.
// Empty response → empty wrap → no visible UI (zero layout impact when idle).

(function () {
  const POLL_INTERVAL_MS = 3000;
  let timer = null;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render(scans) {
    const wrap = document.getElementById('scan-progress-wrap');
    if (!wrap) { return; }
    if (!Array.isArray(scans) || scans.length === 0) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = scans.map(sp => {
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
    }).join('');
  }

  async function tick() {
    try {
      const server = (typeof MSTREAMAPI !== 'undefined') ? MSTREAMAPI.currentServer : null;
      if (!server || !server.host || !server.token) { return; }
      const res = await fetch(server.host + 'api/v1/scan/progress', {
        headers: { 'x-access-token': server.token },
      });
      if (!res.ok) { return; }
      render(await res.json());
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
