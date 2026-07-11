// Mobile-friendly /torrent page. Same backend contract as the sidebar
// Add Torrent panel in webapp/alpha/m.js — see setupAddTorrentPanel
// there for the desktop sibling. Both surfaces call:
//   GET  /api/v1/ping                     → vpaths
//   GET  /api/v1/torrent/preflight        → feature-gate status
//   GET  /api/v1/torrent/path-templates   → per-vpath path templates
//   POST /api/v1/torrent/seed-existing    → pre-/add seed check
//   POST /api/v1/torrent/add              → the actual add (multipart)
//
// What we DON'T reproduce here (yet):
//   - Tier-3 server-side auto-detect button (network-heavy; the smart
//     desktop panel is the right surface for it).
//   - The partial-match suggestion picker — sub-flow that pulls in
//     extra UI state; we degrade to "no_match → fall through to /add".
//
// Auth: localStorage `token` from the login page. If missing, redirect
// to /login like every other webapp surface.

(function () {
  'use strict';

  const State = {
    file:         null,
    parsedName:   null,
    templates:    {},          // vpath → { template }
    pathEdited:   false,       // sticky once the user types in #path-input
    preflight:    null,
  };

  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setStatus(kind, msg) {
    const el = $('status');
    el.className = 'status show ' + kind;
    el.textContent = msg;
  }
  function clearStatus() {
    const el = $('status');
    el.className = 'status';
    el.textContent = '';
  }

  // ── Bencode `info.name` extractor — mirrors extractTorrentName in
  // webapp/alpha/m.js. Forward-only, byte-level walk; we don't decode
  // the full info dict (pieces blob is multi-MB and we don't need it).
  // Returns null if the structure doesn't look like a .torrent.
  function extractTorrentName(uint8Array) {
    try {
      const dec = new TextDecoder('utf-8', { fatal: false });
      const ASCII_d = 100, ASCII_e = 101, ASCII_i = 105, ASCII_l = 108, ASCII_COLON = 58;
      const len = uint8Array.length;
      // Find "4:info" then descend into the value dict.
      const needle = [52, 58, 105, 110, 102, 111];  // "4:info"
      let i = 0;
      outer: while (i < len - 6) {
        for (let j = 0; j < 6; j++) {
          if (uint8Array[i + j] !== needle[j]) { i++; continue outer; }
        }
        i += 6;
        break;
      }
      if (uint8Array[i] !== ASCII_d) { return null; }
      i++;
      // Walk top-level keys until we hit "name".
      while (i < len && uint8Array[i] !== ASCII_e) {
        // key: <len>:<bytes>
        let n = 0;
        while (i < len && uint8Array[i] !== ASCII_COLON) { n = n * 10 + (uint8Array[i] - 48); i++; }
        i++;
        const keyBytes = uint8Array.slice(i, i + n);
        i += n;
        const key = dec.decode(keyBytes);
        // value: read into the right token type
        const tok = uint8Array[i];
        if (tok === ASCII_i) {
          while (i < len && uint8Array[i] !== ASCII_e) { i++; }
          i++;
        } else if (tok === ASCII_l || tok === ASCII_d) {
          // Skip nested container by depth-count.
          let depth = 1; i++;
          while (i < len && depth > 0) {
            const t = uint8Array[i];
            if (t === ASCII_l || t === ASCII_d) { depth++; i++; }
            else if (t === ASCII_e) { depth--; i++; }
            else if (t === ASCII_i) { while (uint8Array[i] !== ASCII_e) { i++; } i++; }
            else if (t >= 48 && t <= 57) {
              let m = 0;
              while (uint8Array[i] !== ASCII_COLON) { m = m * 10 + (uint8Array[i] - 48); i++; }
              i = i + 1 + m;
            } else { return null; }
          }
        } else if (tok >= 48 && tok <= 57) {
          let m = 0;
          while (uint8Array[i] !== ASCII_COLON) { m = m * 10 + (uint8Array[i] - 48); i++; }
          i++;
          const valBytes = uint8Array.slice(i, i + m);
          i += m;
          if (key === 'name') {
            return dec.decode(valBytes).slice(0, 256);
          }
        } else { return null; }
      }
    } catch { /* malformed input */ }
    return null;
  }

  // ── Loose music-name parser. Same intent as parseMusicTorrentName
  // in m.js — only used to pre-fill the form, not to gate anything,
  // so v1 is forgiving and degrades silently. The server's own
  // /torrent/auto-detect endpoint is authoritative when used.
  function parseMusicName(raw) {
    if (!raw) { return { artist: '', album: '', year: '' }; }
    let name = raw.replace(/\.[a-z0-9]{2,4}$/i, '');  // strip extension
    name = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

    // Year token (1900-2099).
    let year = '';
    const yearMatch = name.match(/\b(19[5-9]\d|20\d{2})\b/);
    if (yearMatch) { year = yearMatch[1]; }

    // Artist - Album pattern.
    const dashSplit = name.split(/\s+-\s+/);
    if (dashSplit.length >= 2) {
      return {
        artist: dashSplit[0].trim(),
        album:  dashSplit.slice(1).join(' - ').replace(/\b(19[5-9]\d|20\d{2})\b/, '').replace(/\[.*?\]|\(.*?\)/g, '').trim(),
        year,
      };
    }
    return { artist: '', album: name, year };
  }

  // Match the server's path-template sanitiser
  // (src/torrent/path-template.js sanitizeSegment). The server
  // re-validates on save, so a divergence becomes a visible error
  // rather than a silent corruption.
  function tmplSanitize(s) {
    if (s == null) { return ''; }
    let v = String(s);
    // eslint-disable-next-line no-control-regex
    v = v.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
    v = v.replace(/\s+/g, ' ');
    v = v.replace(/^[.\s]+|[.\s]+$/g, '');
    if (v.length > 200) { v = v.slice(0, 200); }
    return v;
  }

  // Client-side template resolver. Mirrors src/torrent/path-template.js
  // resolveTemplate. Variables: {{ARTIST}}, {{ALBUM}}, {{YEAR}},
  // {{GENRE}}, {{ALBUMARTIST}}. Empty values collapse the segment.
  function resolveTemplate(template, metadata) {
    if (!template || typeof template !== 'string') { return ''; }
    const meta = metadata || {};
    const lookup = {
      ARTIST:      tmplSanitize(meta.artist),
      ALBUM:       tmplSanitize(meta.album),
      YEAR:        tmplSanitize(meta.year),
      GENRE:       tmplSanitize(meta.genre),
      ALBUMARTIST: tmplSanitize(meta.albumartist || meta.artist),
    };
    return template.split('/').map(seg => {
      const filled = seg.replace(/\{\{(\w+)\}\}/g, (_, k) => lookup[k] || '');
      return filled.trim();
    }).filter(Boolean).join('/');
  }

  function metaFromForm() {
    return {
      artist: $('meta-artist').value.trim(),
      album:  $('meta-album').value.trim(),
      year:   $('meta-year').value.trim(),
    };
  }

  function recomputePath() {
    if (State.pathEdited) { return updatePathPreview(); }
    const vpath = $('vpath-select').value;
    const t = State.templates[vpath];
    if (t && t.template) {
      $('path-input').value = resolveTemplate(t.template, metaFromForm());
    } else {
      const m = metaFromForm();
      const artist = tmplSanitize(m.artist);
      const album  = tmplSanitize(m.album);
      $('path-input').value = artist && album ? `${artist}/${album}` : (album || artist || '');
    }
    updatePathPreview();
  }

  function updatePathPreview() {
    const vpath = $('vpath-select').value;
    const rawPath = ($('path-input').value || '').trim().replace(/\/+$/, '');
    $('path-preview').textContent = vpath + (rawPath ? '/' + rawPath : '');
  }

  // ── Auth + bootstrap ────────────────────────────────────────────────
  async function bootstrap() {
    const token = localStorage.getItem('token');
    if (!token) {
      window.location.assign('/login');
      return;
    }
    // api.js's MSTREAMAPI uses currentServer.token for every request.
    // host stays empty so requests go relative to the current origin.
    MSTREAMAPI.currentServer.token = token;
    MSTREAMAPI.currentServer.host  = '';

    try {
      const ping = await MSTREAMAPI.ping();
      MSTREAMAPI.currentServer.vpaths = ping.vpaths || [];
    } catch (err) {
      // 401 or transport error — assume the token expired. Send the
      // user back to login so they can re-auth.
      if (err && err.message && /401/.test(String(err.message))) {
        localStorage.removeItem('token');
        window.location.assign('/login');
        return;
      }
      $('loading').className = 'feature-disabled show';
      $('loading').textContent = 'Could not reach the server. Try reloading.';
      return;
    }

    // Preflight against the global gates. Same call shape as the
    // desktop panel's bootstrap: empty path means we only get
    // active/noUpload/userAllowed back, no vpath-specific noise.
    let preflight;
    try {
      preflight = await MSTREAMAPI.torrentPreflight('');
    } catch {
      preflight = { active: false, reason: 'Could not check torrent feature status' };
    }
    State.preflight = preflight;
    if (!preflight.active || preflight.noUpload || !preflight.userAllowed) {
      hide($('loading'));
      const banner = $('feature-disabled');
      banner.textContent = preflight.reason || 'Torrent feature is not available';
      show(banner);
      return;
    }

    // Templates are best-effort — a failure just means the per-vpath
    // template-resolved autofill falls back to legacy `Artist/Album`.
    try {
      const t = await MSTREAMAPI.getTorrentPathTemplates();
      State.templates = t?.vpaths || {};
    } catch { State.templates = {}; }

    // Populate vpath dropdown.
    const select = $('vpath-select');
    const vpaths = MSTREAMAPI.currentServer.vpaths || [];
    if (vpaths.length === 0) {
      hide($('loading'));
      const banner = $('feature-disabled');
      banner.textContent = "You don't have access to any libraries. An admin needs to grant you a vpath first.";
      show(banner);
      return;
    }
    select.innerHTML = vpaths.map(v => `<option value="${v}">${v}</option>`).join('');

    hide($('loading'));
    show($('add-torrent-form'));
  }

  // ── File pick + form wiring ─────────────────────────────────────────
  async function onFilePicked(file) {
    if (!file) { return; }
    State.file = file;
    State.pathEdited = false;
    $('file-name').textContent = file.name;

    // Parse the torrent's own name (preferring info.name over the
    // filename) then run the loose music-name parser.
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const torrentName = extractTorrentName(buf) || file.name.replace(/\.torrent$/i, '');
      State.parsedName = torrentName;
      const m = parseMusicName(torrentName);
      $('meta-artist').value = m.artist;
      $('meta-album').value  = m.album;
      $('meta-year').value   = m.year;
    } catch {
      // Couldn't read the file — leave the metadata fields empty for
      // the user to fill in manually.
      State.parsedName = file.name;
    }

    show($('meta-step'));
    show($('dest-step'));
    show($('options-step'));
    $('submit-btn').disabled = false;
    recomputePath();
  }

  function wireForm() {
    $('file-input').addEventListener('change', e => onFilePicked(e.target.files[0]));

    // Metadata edits recompute the path autofill — unless the user has
    // started editing the path manually (sticky flag).
    for (const id of ['meta-artist', 'meta-album', 'meta-year']) {
      $(id).addEventListener('input', recomputePath);
    }
    $('vpath-select').addEventListener('change', recomputePath);
    $('path-input').addEventListener('input', () => {
      State.pathEdited = true;
      updatePathPreview();
    });

    $('add-torrent-form').addEventListener('submit', e => {
      e.preventDefault();
      submitForm();
    });
  }

  // ── Submit: seed-existing pre-check (unless force-fresh), then /add.
  async function submitForm() {
    if (!State.file) {
      iziToast.warning({ title: 'Pick a .torrent file first', position: 'topCenter', timeout: 3000 });
      return;
    }
    const vpath = $('vpath-select').value;
    const rawPath = ($('path-input').value || '').trim().replace(/\/+$/, '');
    if (!rawPath) {
      iziToast.warning({ title: 'Enter a path', position: 'topCenter', timeout: 3000 });
      return;
    }
    // Split path into subPath + directoryName the way the server's
    // validator expects (mirrors submitAddTorrentPanel in m.js).
    const segments = rawPath.split('/').filter(Boolean);
    const directoryName = segments.pop();
    const subPath = segments.join('/');

    const submitBtn  = $('submit-btn');
    const renameRoot = $('rename-root').checked;
    const forceFresh = $('force-fresh').checked;

    submitBtn.disabled = true;
    clearStatus();

    try {
      // Step 1: seed-existing check unless the user opted out.
      if (!forceFresh) {
        setStatus('info', 'Checking your library for existing files…');
        const seedFd = new FormData();
        seedFd.append('torrentFile', State.file);
        let seedRes;
        try {
          seedRes = await MSTREAMAPI.seedExisting(seedFd);
        } catch (err) {
          // Non-fatal — fall through to /add. We log so a misconfigured
          // server (e.g. seed-existing route down) doesn't silently
          // become a regular fresh download in user-visible ways.
          console.warn('seed-existing failed; falling through to /add', err);
          seedRes = { outcome: 'no_match' };
        }

        if (seedRes.outcome === 'seeded') {
          setStatus('success',
            `Already in your library — your client is now seeding "${seedRes.name}".`);
          iziToast.success({
            title:   'Seeding existing files',
            message: seedRes.name,
            position: 'topCenter',
            timeout: 4500,
          });
          resetForm();
          return;
        }
        if (seedRes.outcome === 'already_in_daemon') {
          setStatus('info', `Already added to your torrent client: ${seedRes.name || ''}`);
          iziToast.info({
            title:   'Already added',
            message: seedRes.name || '',
            position: 'topCenter',
            timeout: 4500,
          });
          resetForm();
          return;
        }
        if (seedRes.outcome === 'invalid_torrent') {
          setStatus('error', seedRes.error || 'Invalid torrent file');
          submitBtn.disabled = false;
          return;
        }
        if (seedRes.outcome === 'match_unmapped') {
          // Every file is already on disk, but the library's daemon
          // path mapping isn't confirmed — /add would be refused by
          // the same gate (412/409), so falling through just produces
          // a more confusing error. Surface the actionable fix instead.
          setStatus('info', `All files for this torrent are already in your "${seedRes.vpath}" library, ` +
                            'but the torrent client\'s path mapping for it is not set up. ' +
                            'Ask your admin to run auto-detect on the Torrent admin page, then retry.');
          submitBtn.disabled = false;
          return;
        }
        if (seedRes.outcome === 'partial_match') {
          // The desktop panel has a "Use this path" picker for the best
          // candidate. The mobile flow degrades: tell the user we
          // found a partial match and let them choose to proceed with
          // a fresh download (force-fresh) or cancel and rename the
          // path manually. This keeps the UI simple while still being
          // honest about the outcome.
          setStatus('info', 'Some files for this torrent are already on disk under a different path. ' +
                            'Tick "Force fresh download" to add anyway, or cancel and adjust the path.');
          submitBtn.disabled = false;
          return;
        }
        // outcome === 'no_match' → fall through to /add.
      }

      // Step 2: /torrent/add.
      const fd = new FormData();
      fd.append('vpath', vpath);
      if (subPath) { fd.append('subPath', subPath); }
      fd.append('directoryName', directoryName);
      if (renameRoot) { fd.append('renameRoot', 'true'); }
      fd.append('torrentFile', State.file);

      setStatus('info', 'Adding torrent…');
      const res = await MSTREAMAPI.addTorrent(fd);
      const prefix = res.isDuplicate ? 'Already added: ' : 'Added: ';
      setStatus('success', `${prefix}${res.name}\nFiles will land at: ${res.downloadPath}`);
      iziToast.success({
        title:    `${prefix}${res.name}`,
        position: 'topCenter',
        timeout:  3500,
      });
      if (res.renameWarning) {
        iziToast.warning({
          title:    'Rename failed',
          message:  res.renameWarning,
          position: 'topCenter',
          timeout:  6000,
        });
      }
      resetForm();
    } catch (err) {
      const body = err.response?.data || {};
      const msg = body.message || body.error || err.message || 'Add failed';
      setStatus('error', msg);
      iziToast.error({ title: msg, position: 'topCenter', timeout: 5000 });
      submitBtn.disabled = false;
    }
  }

  function resetForm() {
    State.file = null;
    State.parsedName = null;
    State.pathEdited = false;
    $('file-input').value = '';
    $('file-name').textContent = '';
    $('meta-artist').value = '';
    $('meta-album').value  = '';
    $('meta-year').value   = '';
    $('path-input').value  = '';
    hide($('meta-step'));
    hide($('dest-step'));
    hide($('options-step'));
    $('submit-btn').disabled = true;
    $('rename-root').checked = true;
    $('force-fresh').checked = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireForm();
    bootstrap();
  });
})();
