// Desktop Player "Sync Library" modal.
// Runs only in the Electron Desktop Player (detected via window.mstreamElectron).
// Coordinates between the renderer UI and the main-process sync engine.

(function () {
  if (!window.mstreamElectron) { return; }

  let config = null;
  let progressUnsubscribe = null;

  // ── Top-bar progress card ───────────────────────────────────────────────
  // Uses the same `.spc-*` layout as the scan progress indicator.
  function renderTopBar(status) {
    const wrap = document.getElementById('sync-progress-wrap');
    if (!wrap) { return; }
    if (!status || status.state !== 'running') {
      wrap.innerHTML = '';
      return;
    }
    const pct = status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : null;
    const bar = pct != null
      ? `<div class="spc-fill" style="width:${pct}%"></div>`
      : `<div class="spc-fill-ind"></div>`;
    const pctTxt = pct != null ? `${pct}%` : '…';
    const countTxt = status.total > 0
      ? `${status.current.toLocaleString()} / ${status.total.toLocaleString()}`
      : `${(status.current || 0).toLocaleString()} files`;
    const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const titleAttr = status.currentFile ? ` title="${escape(status.currentFile)}"` : '';
    wrap.innerHTML = `<div class="spc-card"${titleAttr}>
      <span class="spc-dot"></span>
      <span class="spc-vpath">Sync</span>
      <div class="spc-track">${bar}</div>
      <span class="spc-pct">${pctTxt}</span>
      <span class="spc-count">${escape(countTxt)}</span>
    </div>`;
  }

  // Subscribe once at module load so the top-bar card stays live regardless
  // of whether the modal is open. Separate modal-scoped listener is installed
  // when the modal opens.
  window.mstreamElectron.onSyncProgress(renderTopBar);
  // Initial paint in case a sync was already running before this page loaded.
  window.mstreamElectron.getSyncStatus().then(renderTopBar).catch(() => {});

  // ── DOM helpers ──────────────────────────────────────────────────────────

  function setMessage(kind, msg) {
    const err = document.getElementById('sync-error');
    const ok = document.getElementById('sync-success');
    if (err) { err.style.display = (kind === 'error' && msg) ? 'block' : 'none'; err.textContent = kind === 'error' ? msg : ''; }
    if (ok)  { ok.style.display  = (kind === 'ok'    && msg) ? 'block' : 'none'; ok.textContent  = kind === 'ok'    ? msg : ''; }
  }

  async function refreshVpaths() {
    try {
      const info = await MSTREAMAPI.ping();
      if (info && Array.isArray(info.vpaths)) {
        MSTREAMAPI.currentServer.vpaths = info.vpaths;
      }
    } catch {
      // Fall back to whatever's cached on MSTREAMAPI.currentServer.vpaths
    }
  }

  function renderVpathList() {
    const list = document.getElementById('sync-vpath-list');
    if (!list) { return; }
    // `MSTREAMAPI` is a `const` in api.js — lives in the global lexical scope,
    // NOT on window. Use the bare identifier (with typeof guard for safety).
    const available = (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.vpaths) || [];
    if (available.length === 0) {
      list.innerHTML = '<em style="opacity: 0.6;">No libraries available on this server</em>';
      return;
    }
    const selected = new Set(config.vpaths || []);
    // Materialize requires class="filled-in" + <span> wrapper for custom
    // checkbox rendering — same pattern used for Auto DJ folder selection.
    list.innerHTML = available.map(v => `
      <p style="margin: 6px 0;">
        <label>
          <input type="checkbox" class="filled-in" name="vpath" value="${v}" ${selected.has(v) ? 'checked' : ''}>
          <span>${v}</span>
        </label>
      </p>
    `).join('');
  }

  function renderState() {
    const methodEl = document.getElementById('sync-method');
    const pathEl = document.getElementById('sync-local-path');
    const intervalEl = document.getElementById('sync-interval');
    if (methodEl)   { methodEl.value = config.method || 'basic'; }
    if (pathEl)     { pathEl.value = config.localFolder || ''; }
    if (intervalEl) { intervalEl.value = String(config.schedule || 0); }
    renderVpathList();
    updateMethodHint();
  }

  function updateMethodHint() {
    const method = document.getElementById('sync-method');
    const hint = document.getElementById('sync-method-hint');
    if (!method || !hint) { return; }
    const v = method.value;
    if (v === 'basic') {
      hint.textContent = 'Downloads every track in the selected libraries. Works with any mStream server.';
    } else if (v === 'basic-manual') {
      hint.textContent = 'Downloads only the library index so you can browse offline. Individual tracks save to your local folder when you click Download on them.';
    } else if (v === 'syncthing-oneway' || v === 'syncthing-twoway') {
      hint.textContent = 'Not available yet — configure Federation on the remote first.';
    }
    updateFieldVisibility(v);
  }

  // Toggle rows tagged with data-sync-only so they hide when the current
  // method isn't in the allowlist. e.g. data-sync-only="basic" hides in
  // basic-manual mode.
  function updateFieldVisibility(method) {
    const rows = document.querySelectorAll('[data-sync-only]');
    for (const row of rows) {
      const allow = row.getAttribute('data-sync-only').split(',').map(s => s.trim());
      row.style.display = allow.includes(method) ? '' : 'none';
    }
  }

  // ── Progress handler ─────────────────────────────────────────────────────

  function onProgress(status) {
    if (status.state === 'running') {
      const file = status.currentFile ? ' — ' + status.currentFile : '';
      setMessage('ok', `Syncing ${status.current}/${status.total}${file}`);
    } else if (status.state === 'idle') {
      const tail = status.lastError ? ` (last error: ${status.lastError})` : '';
      setMessage('ok', `Sync complete: ${status.current}/${status.total} files${tail}`);
    } else if (status.state === 'error') {
      setMessage('error', status.lastError || 'Sync failed');
    } else if (status.state === 'cancelled') {
      setMessage('error', 'Sync cancelled');
    }
    updateButtons(status.state);
  }

  function updateButtons(state) {
    const startBtn = document.getElementById('sync-start-btn');
    const cancelBtn = document.getElementById('sync-cancel-btn');
    const running = state === 'running';
    if (startBtn)  { startBtn.style.display  = running ? 'none' : ''; }
    if (cancelBtn) { cancelBtn.style.display = running ? '' : 'none'; }
  }

  // ── Public (global) handlers bound from index.html ───────────────────────

  window.cancelSyncLibrary = async function () {
    await window.mstreamElectron.stopSync();
  };

  window.pickLocalSyncFolder = async function () {
    const picked = await window.mstreamElectron.pickFolder(config.localFolder || null);
    if (!picked) { return; }
    config.localFolder = picked;
    const el = document.getElementById('sync-local-path');
    if (el) { el.value = picked; }
  };

  window.submitSyncLibrary = async function () {
    setMessage(null, null);

    const method = document.getElementById('sync-method').value;
    const localFolder = document.getElementById('sync-local-path').value;
    const schedule = parseInt(document.getElementById('sync-interval').value, 10) || 0;
    const vpaths = Array.from(document.querySelectorAll('input[name="vpath"]:checked')).map(el => el.value);

    if (!localFolder) { return setMessage('error', 'Select a local folder first'); }
    if (method === 'basic' && vpaths.length === 0) {
      return setMessage('error', 'Select at least one library');
    }
    if (method !== 'basic' && method !== 'basic-manual') {
      return setMessage('error', 'Only "Basic" and "Basic - Manual Sync" are implemented for now');
    }

    const server = (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.currentServer) || {};
    if (!server.host)  { return setMessage('error', 'No server configured — set up a server first'); }
    if (!server.token) { return setMessage('error', 'Not logged in'); }

    const newCfg = {
      serverUrl: server.host,
      method, localFolder,
      vpaths: method === 'basic-manual' ? [] : vpaths,
      schedule,
    };
    await window.mstreamElectron.setSyncConfig(newCfg);
    config = newCfg;

    if (progressUnsubscribe) { progressUnsubscribe(); }
    progressUnsubscribe = window.mstreamElectron.onSyncProgress(onProgress);

    setMessage('ok', method === 'basic-manual' ? 'Downloading library index...' : 'Starting sync...');
    await window.mstreamElectron.startSync({
      token: server.token,
      snapshotOnly: method === 'basic-manual',
    });
  };

  window.openSyncLibraryModal = async function () {
    config = await window.mstreamElectron.getSyncConfig();
    // Refresh vpaths against the current server before rendering — the cache
    // may be stale or empty if init() hasn't populated it yet.
    await refreshVpaths();
    renderState();

    // Restore current status if a sync is in progress
    const status = await window.mstreamElectron.getSyncStatus();
    if (status.state === 'running' || status.lastError || status.current > 0) {
      if (progressUnsubscribe) { progressUnsubscribe(); }
      progressUnsubscribe = window.mstreamElectron.onSyncProgress(onProgress);
      onProgress(status);
    } else {
      setMessage(null, null);
      updateButtons(status.state);
    }

    // `myModal` is declared with `const` in m.js — lives in the global lexical
    // scope (NOT on window). Accessed as a bare identifier.
    myModal.open('#syncLibrary');

    const methodEl = document.getElementById('sync-method');
    if (methodEl) { methodEl.onchange = updateMethodHint; }
  };
})();
