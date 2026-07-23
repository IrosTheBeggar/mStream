const ADMINDATA = (() => {
  const module = {};

  module.version = { val: false };

  // Used for handling the file explorer selection
  module.sharedSelect = { value: '' };

  // Used for modifying a user
  module.selectedUser = { value: '' };

  // For lastFM user data on new user form
  module.lastFMStorage = { username: '', password: '' };

  // folders
  module.folders = {};
  module.foldersUpdated = { ts: 0 };
  module.winDrives = [];
  // users
  module.users = {};
  module.usersUpdated = { ts: 0 };
  // db stuff
  module.dbParams = {};
  module.dbParamsUpdated = { ts: 0 };
  // lyrics backfill settings (config.lyrics)
  module.lyricsParams = {};
  module.lyricsParamsUpdated = { ts: 0 };
  // server settings
  module.serverParams = {};
  module.serverParamsUpdated = { ts: 0 };
  // server audio backend (rust vs CLI fallback)
  module.serverAudioInfo = { backend: null, player: null, detectedCliPlayers: [] };
  module.serverAudioInfoUpdated = { ts: 0 };
  // transcoding
  module.transcodeParams = {};
  module.transcodeParamsUpdated = { ts: 0 };
  module.downloadPending = { val: false };
  // shared playlists
  module.sharedPlaylists = [];
  module.sharedPlaylistUpdated = { ts: 0 };
  // dlna
  module.dlnaParams = {};
  module.dlnaParamsUpdated = { ts: 0 };
  // subsonic
  module.subsonicParams = {};
  module.subsonicParamsUpdated = { ts: 0 };

  module.irohParams = {};
  module.irohParamsUpdated = { ts: 0 };
  // federation
  module.federationParams = {};
  module.federationParamsUpdated = { ts: 0 };
  module.federationKeys = { list: [] };
  module.federationPeers = { list: [] };
  // torrent (UX-layer settings — client + whitelist gating)
  module.torrentParams = {
    client:       'disabled',
    enabledFor:   'all',
    transmission: { host: '', port: 9091, username: '', rpcPath: '/transmission/rpc', useHttps: false, configured: false },
    qbittorrent:  { host: '', port: 8080, username: '',                                useHttps: false, configured: false },
    deluge:       { host: '', port: 8112,                                              useHttps: false, configured: false },
  };
  module.torrentParamsUpdated = { ts: 0 };
  // Connection status for the active client. Refetched on page load
  // and after Connect/Disconnect actions. Polling is intentionally not
  // wired in v1 — the status card has a "Test" button for on-demand
  // checks.
  module.torrentStatus = { connected: false, configured: false, reason: null, version: null };
  module.torrentStatusUpdated = { ts: 0 };
  // Torrent list. Refetched on demand. Empty array is the legitimate
  // "no torrents" state; `error` is non-null when the daemon couldn't
  // be reached.
  module.torrentList = { torrents: [], error: null };
  module.torrentListUpdated = { ts: 0 };
  // Per-vpath access mapping for the active client. Empty object until
  // a sweep runs. Each entry: {daemonPath, mstreamWritable, confidence,
  // source, method, lastProbedAt, lastError}. Confidence drives the
  // colour; source drives whether the manual-edit input is editable.
  module.torrentVpathAccess = { clientType: null, vpaths: {} };
  module.torrentVpathAccessUpdated = { ts: 0 };
  // Per-vpath path templates (V41). Each entry: {template: string|null}.
  // supportedVars + suggestedTemplate + sampleMetadata come from the
  // server so we don't duplicate the allowlist client-side.
  module.torrentPathTemplates = {
    vpaths:            {},
    supportedVars:     [],
    suggestedTemplate: '',
    sampleMetadata:    {},
  };
  module.torrentPathTemplatesUpdated = { ts: 0 };
  // subsonic — API keys for the currently-authenticated user. Keys are
  // returned in full only at creation; subsequent listings are metadata-only.
  module.apiKeys = [];
  module.apiKeysUpdated = { ts: 0 };
  // Holds the most recently minted key so the UI can render a one-time
  // "copy this now" panel. Cleared as soon as the user dismisses it.
  module.lastMintedKey = { val: null, name: null };

  module.getSharedPlaylists = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/shared`
    });

    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }

    res.data.forEach(item => {
      module.sharedPlaylists.push(item);
    });

    module.sharedPlaylistUpdated.ts = Date.now();
  };

  module.deleteSharedPlaylist = async (playlistObj) => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared`,
      data: { id: playlistObj.playlistId }
    });

    module.sharedPlaylists.splice(module.sharedPlaylists.indexOf(playlistObj), 1);
  };

  module.deleteUnxpShared = async () => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/eternal`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.deleteExpiredShared = async () => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/expired`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.getFolders = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/directories`
    });

    Object.keys(res.data).forEach(key=>{
      module.folders[key] = res.data[key];
    });

    module.foldersUpdated.ts = Date.now();
  };

  module.getUsers = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/users`
    });

    Object.keys(res.data).forEach(key=>{
      module.users[key] = res.data[key];
    });

    module.usersUpdated.ts = Date.now();
  };

  module.getDbParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/params`
    });

    Object.keys(res.data).forEach(key=>{
      module.dbParams[key] = res.data[key];
    });

    module.dbParamsUpdated.ts = Date.now();
  }

  module.getLyricsParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/lyrics`
    });

    Object.keys(res.data).forEach(key=>{
      module.lyricsParams[key] = res.data[key];
    });

    module.lyricsParamsUpdated.ts = Date.now();
  }

  module.getServerParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/config`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverParams[key] = res.data[key];
    });

    module.serverParamsUpdated.ts = Date.now();
  }

  module.getServerAudioInfo = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/server-audio/info`
      });
      module.serverAudioInfo.backend = res.data.backend;
      module.serverAudioInfo.player = res.data.player;
      module.serverAudioInfo.detectedCliPlayers = res.data.detectedCliPlayers || [];
      module.serverAudioInfoUpdated.ts = Date.now();
    } catch (_err) {}
  }

  // Force a fresh detection probe server-side, then pull the updated info.
  module.redetectCliPlayers = async () => {
    try {
      await API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/server-audio/detect`
      });
      await module.getServerAudioInfo();
    } catch (_err) {}
  }

  module.getTranscodeParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/transcode`
    });

    Object.keys(res.data).forEach(key=>{
      module.transcodeParams[key] = res.data[key];
    });

    module.transcodeParamsUpdated.ts = Date.now();
  }

  module.getDlnaParams = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/dlna`
      });
      Object.keys(res.data).forEach(key => { module.dlnaParams[key] = res.data[key]; });
    } catch (err) {}
    module.dlnaParamsUpdated.ts = Date.now();
  }

  module.getSubsonicParams = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/subsonic`
      });
      Object.keys(res.data).forEach(key => { module.subsonicParams[key] = res.data[key]; });
    } catch (err) {}
    module.subsonicParamsUpdated.ts = Date.now();
  }

  module.getIroh = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/iroh`
      });
      Object.keys(res.data).forEach(key => { module.irohParams[key] = res.data[key]; });
    } catch (err) {}
    module.irohParamsUpdated.ts = Date.now();
  }

  module.getFederation = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/federation`
      });
      Object.keys(res.data).forEach(key => { module.federationParams[key] = res.data[key]; });
    } catch (err) {}
    module.federationParamsUpdated.ts = Date.now();
  }

  module.getFederationKeys = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/federation/keys`
      });
      module.federationKeys.list = res.data;
    } catch (err) {}
  }

  module.getFederationPeers = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/federation/peers`
      });
      module.federationPeers.list = res.data;
    } catch (err) {}
  }

  module.getTorrentParams = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/torrent`
      });
      Object.keys(res.data).forEach(key => { module.torrentParams[key] = res.data[key]; });
    } catch (err) {}
    module.torrentParamsUpdated.ts = Date.now();
  }

  module.getTorrentVpathAccess = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/torrent/vpath-access`,
      });
      module.torrentVpathAccess.clientType = res.data.clientType;
      module.torrentVpathAccess.vpaths     = res.data.vpaths || {};
    } catch (err) {
      module.torrentVpathAccess.vpaths = {};
    }
    module.torrentVpathAccessUpdated.ts = Date.now();
  }

  module.getTorrentPathTemplates = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/torrent/path-templates`,
      });
      module.torrentPathTemplates.vpaths            = res.data.vpaths || {};
      module.torrentPathTemplates.supportedVars     = res.data.supportedVars || [];
      module.torrentPathTemplates.suggestedTemplate = res.data.suggestedTemplate || '';
      module.torrentPathTemplates.sampleMetadata    = res.data.sampleMetadata || {};
    } catch (err) {
      module.torrentPathTemplates.vpaths = {};
    }
    module.torrentPathTemplatesUpdated.ts = Date.now();
  }

  module.getTorrentList = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/torrent/list`,
      });
      module.torrentList.torrents = Array.isArray(res.data.torrents) ? res.data.torrents : [];
      module.torrentList.error    = res.data.error || null;
    } catch (err) {
      module.torrentList.torrents = [];
      module.torrentList.error    = err.message || 'request failed';
    }
    module.torrentListUpdated.ts = Date.now();
  }

  module.getTorrentStatus = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/torrent/status`
      });
      Object.keys(module.torrentStatus).forEach(k => { module.torrentStatus[k] = res.data[k] ?? null; });
      // Pick up any new fields the API decides to add later (e.g. rpcVersion).
      Object.keys(res.data).forEach(k => { module.torrentStatus[k] = res.data[k]; });
    } catch (err) {
      module.torrentStatus.connected = false;
      module.torrentStatus.reason    = err.message || 'request failed';
    }
    module.torrentStatusUpdated.ts = Date.now();
  }

  // ── Subsonic API key management ───────────────────────────────────────
  // All three helpers operate on the currently-authenticated user's keys
  // via /api/v1/user/api-keys.
  module.getApiKeys = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/user/api-keys`
      });
      module.apiKeys.length = 0;
      res.data.forEach(k => module.apiKeys.push(k));
    } catch (err) { /* not fatal for panel load */ }
    module.apiKeysUpdated.ts = Date.now();
  }

  module.createApiKey = async (name) => {
    const res = await API.axios({
      method: 'POST',
      url: `${API.url()}/api/v1/user/api-keys`,
      data: { name }
    });
    // Stash the plaintext key for the one-time display card.
    module.lastMintedKey.val = res.data.key;
    module.lastMintedKey.name = res.data.name;
    await module.getApiKeys();
    return res.data.key;
  }

  module.revokeApiKey = async (id) => {
    await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/user/api-keys/${id}`
    });
    await module.getApiKeys();
  }

  // ── Subsonic admin-panel polish data ────────────────────────────────
  module.subsonicStats = { methodsImplemented: 0, methods: [], nowPlaying: [] };
  module.subsonicStatsUpdated = { ts: 0 };
  module.getSubsonicStats = async () => {
    try {
      const res = await API.axios({
        method: 'GET', url: `${API.url()}/api/v1/admin/subsonic/stats`,
      });
      Object.assign(module.subsonicStats, res.data);
    } catch (err) { /* UI shows placeholder */ }
    module.subsonicStatsUpdated.ts = Date.now();
  }

  // Jukebox status card. `available: false` means autoBootServerAudio is
  // disabled or the rust-server-audio binary isn't reachable — the UI
  // hides the whole card in that case.
  module.jukeboxStatus = { available: false };
  module.jukeboxStatusUpdated = { ts: 0 };
  module.getJukeboxStatus = async () => {
    try {
      const res = await API.axios({
        method: 'GET', url: `${API.url()}/api/v1/admin/subsonic/jukebox`,
      });
      module.jukeboxStatus = res.data;
    } catch (err) { module.jukeboxStatus = { available: false, reason: err.message }; }
    module.jukeboxStatusUpdated.ts = Date.now();
  }

  // Recent token-auth rejections. Each entry is { username, client, at, ua }.
  module.tokenAuthAttempts = [];
  module.tokenAuthAttemptsUpdated = { ts: 0 };
  module.getTokenAuthAttempts = async () => {
    try {
      const res = await API.axios({
        method: 'GET', url: `${API.url()}/api/v1/admin/subsonic/token-auth-attempts`,
      });
      module.tokenAuthAttempts.length = 0;
      (res.data.attempts || []).forEach(a => module.tokenAuthAttempts.push(a));
    } catch (err) { /* empty list */ }
    module.tokenAuthAttemptsUpdated.ts = Date.now();
  }

  module.clearTokenAuthAttempts = async () => {
    await API.axios({
      method: 'DELETE', url: `${API.url()}/api/v1/admin/subsonic/token-auth-attempts`,
    });
    await module.getTokenAuthAttempts();
  }

  // Admin mints a key on behalf of a specific user. Returns the plaintext
  // key once so the admin can relay it to the affected client.
  module.mintKeyFor = async (username, name) => {
    const res = await API.axios({
      method: 'POST',
      url: `${API.url()}/api/v1/admin/subsonic/mint-key`,
      data: { username, name },
    });
    return res.data;
  }

  // Hit the Subsonic API as a real client would and return { ok, latencyMs, ... }.
  module.testSubsonicConnection = async () => {
    try {
      const res = await API.axios({
        method: 'GET', url: `${API.url()}/api/v1/admin/subsonic/test`,
      });
      return res.data;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  module.getVersion = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api`
      });
      module.version.val = res.data.server;
    }catch (err) {} 
  }

  module.getWinDrives = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/file-explorer/win-drives`
      });

      module.winDrives.length = 0;
      res.data.forEach((d) => {
        module.winDrives.push(d);
      });

      console.log(res.data)
      return res;
    }catch(err){}
  }

  // ── Backup destinations (V28) ───────────────────────────────────
  // Mirrors the foldersUpdated/foldersTS pattern: an array of rows
  // populated by getBackupDestinations(), and a timestamp field that
  // the view uses to gate its loading spinner. Live status is polled
  // separately via getBackupStatus() — when active is non-null, a
  // backup worker is currently running and the UI should display
  // a progress indicator.
  module.backupDestinations = [];
  module.backupDestinationsUpdated = { ts: 0 };
  module.backupStatus = { active: null, queueLength: 0 };
  // defaultExcludes is declared here (not added later) so Vue 2's
  // observer picks it up — properties added after observation aren't
  // reactive, and the add form watches this to seed its patterns field.
  module.backupPlatform = { value: null, homedir: null, defaultExcludes: null };
  // Hand-off slot for backup-history-modal: the main view stashes the
  // destination row here when "History" is clicked, the modal reads it
  // on creation. Mirrors the selectedUser / sharedSelect pattern.
  module.selectedBackupDest = null;

  module.getBackupDestinations = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/backup/destinations`
      });
      module.backupDestinations.length = 0;
      res.data.destinations.forEach((d) => module.backupDestinations.push(d));
      module.backupDestinationsUpdated.ts = Date.now();
    } catch (_err) { /* keep last-known list on transient failures */ }
  };

  module.getBackupStatus = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/backup/status`
      });
      module.backupStatus.active = res.data.active;
      module.backupStatus.queueLength = res.data.queueLength;
    } catch (_err) {}
  };

  module.getBackupPlatform = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/backup/platform`
      });
      module.backupPlatform.value = res.data.platform;
      module.backupPlatform.homedir = res.data.homedir;
      module.backupPlatform.defaultExcludes = res.data.defaultExcludes || null;
    } catch (_err) {}
  };

  return module;
})();

// Load in data
ADMINDATA.getTranscodeParams();
ADMINDATA.getFolders();
ADMINDATA.getUsers();
ADMINDATA.getDbParams();
ADMINDATA.getServerParams();
ADMINDATA.getServerAudioInfo();
ADMINDATA.getDlnaParams();
ADMINDATA.getSubsonicParams();
ADMINDATA.getIroh();
ADMINDATA.getTorrentParams();
ADMINDATA.getTorrentStatus();
ADMINDATA.getTorrentList();
ADMINDATA.getTorrentVpathAccess();
ADMINDATA.getTorrentPathTemplates();
ADMINDATA.getApiKeys();
ADMINDATA.getSubsonicStats();
ADMINDATA.getJukeboxStatus();
ADMINDATA.getTokenAuthAttempts();
ADMINDATA.getVersion();
ADMINDATA.getWinDrives();
ADMINDATA.getBackupDestinations();
ADMINDATA.getBackupPlatform();
ADMINDATA.getBackupStatus();

// initialize modal
M.Modal.init(document.querySelectorAll('.modal'), {
  onCloseEnd: () => {
    // reset modal on every close
    modVM.currentViewModal = 'null-modal';
  }
});

// Intialize Clipboard
new ClipboardJS('.fed-copy-button');
new ClipboardJS('.iroh-copy-button');

// ----- i18n glue for Vue templates -----
// A reactive counter that increments each time the active language changes.
// Templates that call `t(...)` read this counter (below) to establish a
// dependency, so Vue re-renders them automatically when translations swap.
const I18NSTATE = Vue.observable({ version: 0 });

// Expose t() to every Vue component/template. Reading I18NSTATE.version inside
// this method is what ties the template to the reactive store.
Vue.prototype.t = function (key, params) {
  // eslint-disable-next-line no-unused-expressions
  I18NSTATE.version;
  return window.t(key, params);
};

// Bump the version whenever i18n.js finishes loading a new dictionary. If the
// initial load already completed before this listener was attached, the first
// language change (via the UI) will still fire and everything stays in sync.
I18N.onChange(() => { I18NSTATE.version += 1; });

// Flag SVGs are loaded from assets/js/flags.js into window.FLAG_SVGS so the
// admin panel and main webapp can share one source of truth.

// Custom language dropdown for the admin sidebar. Native <select> can't render
// images inside <option>, so we use a button + absolutely-positioned listbox.
// Opens upward (bottom: 100%) because the control sits at the bottom of the
// sidebar.
(() => {
  const toggle = document.getElementById('admin-lang-toggle');
  const menu = document.getElementById('admin-lang-menu');
  if (!toggle || !menu) { return; }

  const base = document.querySelector('meta[name="i18n-base"]')?.content || '';

  // Escape text for use in innerHTML (defensive — language names come from
  // our own JSON, but treating them as user-ish data is cheap insurance).
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const flagMarkup = (code) => window.FLAG_SVGS && window.FLAG_SVGS[code]
    ? `<span class="admin-lang-flag">${window.FLAG_SVGS[code]}</span>`
    : '<span class="admin-lang-flag"></span>';

  const renderCurrent = (code, label) => {
    toggle.querySelector('.admin-lang-current').innerHTML =
      `${flagMarkup(code)}<span class="admin-lang-name">${escapeHtml(label)}</span>`;
  };

  const updateSelected = (code) => {
    menu.querySelectorAll('li').forEach(li => {
      li.setAttribute('aria-selected', li.dataset.lang === code ? 'true' : 'false');
    });
  };

  const openMenu = () => {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  };

  const closeMenu = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  // Track the languages we know about so renderCurrent can look up labels
  // when the language changes externally.
  let langs = {};

  fetch(`${base}locales/languages.json`).then(r => r.json()).then(data => {
    langs = data;
    const cur = I18N.getLanguage();

    Object.entries(langs).forEach(([code, name]) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.lang = code;
      li.innerHTML = `${flagMarkup(code)}<span class="admin-lang-name">${escapeHtml(name)}</span>`;
      li.addEventListener('click', () => {
        I18N.loadLanguage(code);
        closeMenu();
      });
      menu.appendChild(li);
    });

    renderCurrent(cur, langs[cur] || cur);
    updateSelected(cur);
  }).catch(() => { /* noop — control just stays empty */ });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) { openMenu(); } else { closeMenu(); }
  });

  // Click outside closes the menu
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !toggle.contains(e.target)) {
      closeMenu();
    }
  });

  // Escape closes the menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); }
  });

  // Keep the control in sync if the language changes from anywhere else
  // (programmatic switch, future UI, etc.).
  I18N.onChange((code) => {
    renderCurrent(code, langs[code] || code);
    updateSelected(code);
  });
})();

// The p2p announce identity, shared between the Discovery page card
// (loadDiscoveryP2p fills it from the status route) and the description
// modal. One object referenced from both components' data() so a save in
// the modal re-renders the card without a refetch. Declared BEFORE every
// view component: a URL-hash deep-link mounts its view synchronously while
// the tail of this file is still in the const temporal dead zone.
const P2PIDENTITY = { serverName: '', serverDescription: '' };

// Same shared-object pattern (and the same must-be-hoisted TDZ rule) for
// the editable p2p settings: the Discovery card fills it from the status
// route, the max-storage modal edits it.
const P2PSETTINGS = { maxPeerDbStorageMb: 500, peerRetentionDays: 30 };

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render
      dirName: '',
      folder: ADMINDATA.sharedSelect,
      foldersTS: ADMINDATA.foldersUpdated,
      folders: ADMINDATA.folders,
      submitPending: false
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.folders.title') }}</span>
                <form id="choose-directory-form" @submit.prevent="submitForm">
                  <div class="row">
                    <div class="input-field col s12">
                      <input v-on:click="addFolderDialog()" @blur="maybeResetForm()" v-model="folder.value" id="folder-name" required type="text" class="validate">
                      <label for="folder-name">{{ t('admin.folders.selectDirectory') }}</label>
                      <span class="helper-text">{{ t('admin.folders.selectDirectoryHint') }}</span>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12">
                      <input @blur="maybeResetForm()" pattern="[a-zA-Z0-9-]+" v-model="dirName" id="add-directory-name" required type="text" class="validate">
                      <label for="add-directory-name">{{ t('admin.folders.vPathLabel') }}</label>
                      <span class="helper-text">{{ t('admin.folders.vPathHint') }}</span>
                    </div>
                  </div>
                  <div class="row">
                    <div class="col m6 s12">
                      <div class="pad-checkbox"><label>
                        <input id="folder-auto-access" type="checkbox" checked/>
                        <span>{{ t('admin.folders.giveAccessToAll') }}</span>
                      </label></div>
                      <div class="pad-checkbox"><label>
                        <input id="folder-is-audiobooks" type="checkbox"/>
                        <span>{{ t('admin.folders.audiobooks') }}</span>
                      </label></div>
                    </div>
                    <button class="btn green waves-effect waves-light col m6 s12" type="submit" :disabled="submitPending === true">
                      {{ submitPending === false ? t('admin.folders.addButton') : t('admin.folders.adding') }}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-show="foldersTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-show="foldersTS.ts > 0" class="row">
        <div class="col s12">
          <h5>{{ t('admin.folders.heading') }}</h5>
          <table>
            <thead>
              <tr>
                <th>{{ t('admin.folders.vPathHeader') }}</th>
                <th>{{ t('admin.folders.directoryHeader') }}</th>
                <th title="When 'on', the scanner follows symlinks INSIDE this library. Default is 'off' to keep scanned content strictly within the library's physical tree.">Follow symlinks</th>
                <th>{{ t('admin.folders.actionsHeader') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in folders">
                <td>{{k}}</td>
                <td>{{v.root}}</td>
                <td>
                  <select :value="v.followSymlinks ? 'true' : 'false'"
                          v-on:change="setFollowSymlinks(k, $event.target.value === 'true')"
                          style="margin:0;display:inline-block;width:auto;height:28px;font-size:13px">
                    <option value="false">off</option>
                    <option value="true">on</option>
                  </select>
                </td>
                <td>[<a v-on:click="removeFolder(k, v.root)">{{ t('admin.folders.remove') }}</a>]</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    created: function() {
      ADMINDATA.sharedSelect.value = '';
    },
    watch: {
      'folder.value': function (newVal, oldVal) {
        this.makeVPath(newVal);
      }
    },
    methods: {
      // V21: per-library followSymlinks flag. Default false —
      // operators opt in per library when they want the scanner to
      // traverse symlinks inside that vpath.
      setFollowSymlinks: async function(vpath, value) {
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/directory/follow-symlinks`,
            data: { vpath, followSymlinks: value },
          });
          // Reflect the change locally so the <select> stays in sync
          // without waiting for the next folder-list poll.
          if (ADMINDATA.folders[vpath]) {
            Vue.set(ADMINDATA.folders[vpath], 'followSymlinks', value);
          }
          iziToast.success({
            title: `Symlink policy updated for ${vpath}`,
            position: 'topCenter', timeout: 2500,
          });
        } catch (err) {
          iziToast.error({
            title: `Failed: ${err.message || '?'}`,
            position: 'topCenter', timeout: 3000,
          });
        }
      },
      makeVPath(dir) {
        const newName = dir.split(/[\\\/]/).pop().toLowerCase().replace(' ', '-').replace(/[^a-zA-Z0-9-]/g, "");
        
        // TODO: Check that vpath doesn't already exist

        this.dirName = newName;
        this.$nextTick(() => {
          M.updateTextFields();
        });
      },
      maybeResetForm: function() {
        if (this.dirName === '' && this.folder.value === '') {
          document.getElementById("choose-directory-form").reset();
        }
      },
      addFolderDialog: function (event) {
        modVM.currentViewModal = 'file-explorer-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      submitForm: async function () {
        if (ADMINDATA.folders[this.dirName]) {
          iziToast.warn({
            title: t('admin.folders.pathInUse'),
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        try {
          this.submitPending = true;

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/directory`,
            data: {
              directory: this.folder.value,
              vpath: this.dirName,
              autoAccess: document.getElementById('folder-auto-access').checked,
              isAudioBooks: document.getElementById('folder-is-audiobooks').checked
            }
          });

          if (document.getElementById('folder-auto-access').checked) {
            Object.values(ADMINDATA.users).forEach(user => {
              user.vpaths.push(this.dirName);
            });
          }

          Vue.set(ADMINDATA.folders, this.dirName, { root: this.folder.value });
          this.dirName = '';
          this.folder.value = '';
          this.$nextTick(() => {
            M.updateTextFields();
          });
        }catch(err) {
          iziToast.error({
            title: t('admin.folders.addFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.submitPending = false;
        }
      },
      removeFolder: async function(vpath, folder) {
        iziToast.question({
          timeout: 20000,
          close: false,
          overlayClose: true,
          overlay: true,
          displayMode: 'once',
          id: 'question',
          zindex: 99999,
          layout: 2,
          maxWidth: 600,
          title: t('admin.folders.removeTitle', { folder: folder }),
          message: t('admin.folders.removeMessage'),
          position: 'center',
          buttons: [
            [`<button><b>${t('admin.folders.removeButton')}</b></button>`, (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              API.axios({
                method: 'DELETE',
                url: `${API.url()}/api/v1/admin/directory`,
                data: { vpath: vpath }
              }).then(() => {
                iziToast.warning({
                  title: t('admin.folders.rebooting'),
                  position: 'topCenter',
                  timeout: 3500
                });
                Vue.delete(ADMINDATA.folders, vpath);
                Object.values(ADMINDATA.users).forEach(user => {
                  if (user.vpaths.includes(vpath)) {
                    user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
                  }
                });
              }).catch(() => {
                iziToast.error({
                  title: t('admin.folders.removeFailed'),
                  position: 'topCenter',
                  timeout: 3500
                });
              });
            }, true],
            [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }],
          ]
        });
      }
    }
});

const usersView = Vue.component('users-view', {
  data() {
    return {
      directories: ADMINDATA.folders,
      users: ADMINDATA.users,
      usersTS: ADMINDATA.usersUpdated,
      // Used to gate the optional Subsonic-password field on the
      // user-create form — only shown if Subsonic is enabled.
      subsonicParams: ADMINDATA.subsonicParams,
      newUsername: '',
      newPassword: '',
      // Optional opt-in Subsonic-specific password (V35). When set,
      // the new user can immediately use token-auth Subsonic clients
      // (Symfonium, DSub, etc); otherwise the user has to set one
      // themselves later via the mobile-clients panel.
      newSubsonicPassword: '',
      makeAdmin: Object.keys(ADMINDATA.users).length === 0 ? true : false,
      allowMkdir: true,
      allowUpload: true,
      // Opt-in per user. Admins bypass the gate anyway; everyone else
      // starts without /api/v1/server-playback access and gets it only
      // when the operator ticks the box explicitly.
      allowServerAudio: false,
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
              <span class="card-title">{{ t('admin.users.title') }}</span>
                <form id="add-user-form" @submit.prevent="addUser">
                  <div class="row">
                    <div class="input-field directory-name-field col s12 m6">
                      <input @blur="maybeResetForm()" v-model="newUsername" id="new-username" required type="text" class="validate">
                      <label for="new-username">{{ t('admin.users.usernameLabel') }}</label>
                    </div>
                    <div class="input-field directory-name-field col s12 m6">
                      <input @blur="maybeResetForm()" v-model="newPassword" id="new-password" required type="password" class="validate">
                      <label for="new-password">{{ t('admin.users.passwordLabel') }}</label>
                    </div>
                  </div>
                  <div class="row" v-if="subsonicParams.mode && subsonicParams.mode !== 'disabled'">
                    <div class="input-field directory-name-field col s12 m6">
                      <input v-model="newSubsonicPassword" id="new-subsonic-password" type="password" class="validate">
                      <label for="new-subsonic-password">Subsonic password (optional)</label>
                    </div>
                    <div class="col s12 m6" style="font-size: 0.85em; opacity: 0.85; padding-top: 1.5em;">
                      Optional separate password for token-auth Subsonic clients.
                      Stored encrypted (recoverable) — intentionally less secure than the main password.
                      Leave blank to let the user set one themselves via the mobile-clients panel.
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12">
                      <select class="material-select" :disabled="Object.keys(directories).length === 0" id="new-user-dirs" multiple>
                        <option disabled selected value="" v-if="Object.keys(directories).length === 0">{{ t('admin.users.noDirsWarning') }}</option>
                        <option selected v-for="(key, value) in directories" :value="value">{{ value }}</option>
                      </select>
                      <label for="new-user-dirs">{{ t('admin.users.selectDirs') }}</label>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12 m6">
                      <div class="pad-checkbox"><label>
                        <input id="folder-autoaccess" type="checkbox" v-model="makeAdmin"/>
                        <span>{{ t('admin.users.makeAdmin') }}</span>
                      </label></div>
                      <div class="pad-checkbox"><label>
                        <input type="checkbox" v-model="allowMkdir"/>
                        <span>{{ t('admin.users.allowFolders') }}</span>
                      </label></div>
                      <div class="pad-checkbox"><label>
                        <input type="checkbox" v-model="allowUpload"/>
                        <span>{{ t('admin.users.allowUpload') }}</span>
                      </label></div>
                      <div class="pad-checkbox"><label>
                        <input type="checkbox" v-model="allowServerAudio"/>
                        <span>Allow Server Audio</span>
                      </label></div>
                    </div>
                    <!-- <div class="col s12 m6">
                      <a v-on:click="openLastFmModal()" href="#!">Add last.fm account</a>
                    </div> -->
                  </div>
                  <div class="row">
                    <button id="submit-add-user-form" class="btn green waves-effect waves-light col m6 s12" type="submit" :disabled="submitPending === true">
                      {{ submitPending === false ? t('admin.users.addButton') : t('admin.users.adding') }}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="usersTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else-if="Object.keys(users).length === 0" class="container">
        <h5>
          {{ t('admin.users.noUsers') }}
        </h5>
        <h5>
          {{ t('admin.users.addWarning') }}
        </h5>
      </div>
      <div v-else="usersTS.ts > 0" class="row">
        <div class="col s12">
          <h5>{{ t('admin.users.heading') }}</h5>
          <table>
            <thead>
              <tr>
                <th>{{ t('admin.users.userHeader') }}</th>
                <th>{{ t('admin.users.dirsHeader') }}</th>
                <th>{{ t('admin.users.adminHeader') }}</th>
                <th>{{ t('admin.users.foldersHeader') }}</th>
                <th>{{ t('admin.users.uploadHeader') }}</th>
                <th>{{ t('admin.users.modifyHeader') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td>{{k}}</td>
                <td>{{v.vpaths.join(', ')}}</td>
                <td>
                  <svg v-if="v.admin === true" height="24px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 117.72 117.72"><path d="M58.86 0c9.13 0 17.77 2.08 25.49 5.79-3.16 2.5-6.09 4.9-8.82 7.21a48.673 48.673 0 00-16.66-2.92c-13.47 0-25.67 5.46-34.49 14.29-8.83 8.83-14.29 21.02-14.29 34.49 0 13.47 5.46 25.66 14.29 34.49 8.83 8.83 21.02 14.29 34.49 14.29s25.67-5.46 34.49-14.29c8.83-8.83 14.29-21.02 14.29-34.49 0-3.2-.31-6.34-.9-9.37 2.53-3.3 5.12-6.59 7.77-9.85a58.762 58.762 0 013.21 19.22c0 16.25-6.59 30.97-17.24 41.62-10.65 10.65-25.37 17.24-41.62 17.24-16.25 0-30.97-6.59-41.62-17.24C6.59 89.83 0 75.11 0 58.86c0-16.25 6.59-30.97 17.24-41.62S42.61 0 58.86 0zM31.44 49.19L45.8 49l1.07.28c2.9 1.67 5.63 3.58 8.18 5.74a56.18 56.18 0 015.27 5.1c5.15-8.29 10.64-15.9 16.44-22.9a196.16 196.16 0 0120.17-20.98l1.4-.54H114l-3.16 3.51C101.13 30 92.32 41.15 84.36 52.65a325.966 325.966 0 00-21.41 35.62l-1.97 3.8-1.81-3.87c-3.34-7.17-7.34-13.75-12.11-19.63-4.77-5.88-10.32-11.1-16.79-15.54l1.17-3.84z" fill="#01a601"/></svg>
                </td>
                <td>
                  <svg v-if="v.allowMkdir !== false" height="24px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 117.72 117.72"><path d="M58.86 0c9.13 0 17.77 2.08 25.49 5.79-3.16 2.5-6.09 4.9-8.82 7.21a48.673 48.673 0 00-16.66-2.92c-13.47 0-25.67 5.46-34.49 14.29-8.83 8.83-14.29 21.02-14.29 34.49 0 13.47 5.46 25.66 14.29 34.49 8.83 8.83 21.02 14.29 34.49 14.29s25.67-5.46 34.49-14.29c8.83-8.83 14.29-21.02 14.29-34.49 0-3.2-.31-6.34-.9-9.37 2.53-3.3 5.12-6.59 7.77-9.85a58.762 58.762 0 013.21 19.22c0 16.25-6.59 30.97-17.24 41.62-10.65 10.65-25.37 17.24-41.62 17.24-16.25 0-30.97-6.59-41.62-17.24C6.59 89.83 0 75.11 0 58.86c0-16.25 6.59-30.97 17.24-41.62S42.61 0 58.86 0zM31.44 49.19L45.8 49l1.07.28c2.9 1.67 5.63 3.58 8.18 5.74a56.18 56.18 0 015.27 5.1c5.15-8.29 10.64-15.9 16.44-22.9a196.16 196.16 0 0120.17-20.98l1.4-.54H114l-3.16 3.51C101.13 30 92.32 41.15 84.36 52.65a325.966 325.966 0 00-21.41 35.62l-1.97 3.8-1.81-3.87c-3.34-7.17-7.34-13.75-12.11-19.63-4.77-5.88-10.32-11.1-16.79-15.54l1.17-3.84z" fill="#01a601"/></svg>
                </td>
                <td>
                  <svg v-if="v.allowUpload !== false" height="24px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 117.72 117.72"><path d="M58.86 0c9.13 0 17.77 2.08 25.49 5.79-3.16 2.5-6.09 4.9-8.82 7.21a48.673 48.673 0 00-16.66-2.92c-13.47 0-25.67 5.46-34.49 14.29-8.83 8.83-14.29 21.02-14.29 34.49 0 13.47 5.46 25.66 14.29 34.49 8.83 8.83 21.02 14.29 34.49 14.29s25.67-5.46 34.49-14.29c8.83-8.83 14.29-21.02 14.29-34.49 0-3.2-.31-6.34-.9-9.37 2.53-3.3 5.12-6.59 7.77-9.85a58.762 58.762 0 013.21 19.22c0 16.25-6.59 30.97-17.24 41.62-10.65 10.65-25.37 17.24-41.62 17.24-16.25 0-30.97-6.59-41.62-17.24C6.59 89.83 0 75.11 0 58.86c0-16.25 6.59-30.97 17.24-41.62S42.61 0 58.86 0zM31.44 49.19L45.8 49l1.07.28c2.9 1.67 5.63 3.58 8.18 5.74a56.18 56.18 0 015.27 5.1c5.15-8.29 10.64-15.9 16.44-22.9a196.16 196.16 0 0120.17-20.98l1.4-.54H114l-3.16 3.51C101.13 30 92.32 41.15 84.36 52.65a325.966 325.966 0 00-21.41 35.62l-1.97 3.8-1.81-3.87c-3.34-7.17-7.34-13.75-12.11-19.63-4.77-5.88-10.32-11.1-16.79-15.54l1.17-3.84z" fill="#01a601"/></svg>
                </td>
                <td>
                  [<a v-on:click="changePassword(k)">{{ t('admin.users.changePass') }}</a>]
                  [<a v-on:click="changeVPaths(k)">{{ t('admin.users.changeFolders') }}</a>]
                  [<a v-on:click="changeAccess(k)">{{ t('admin.users.changeAccess') }}</a>]
                  [<a v-on:click="deleteUser(k)">{{ t('admin.users.delete') }}</a>]
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll(".material-select"));
    },
    beforeDestroy: function() {
      this.selectInstance[0].destroy();
    },
    methods: {
      openLastFmModal: function() {
        modVM.currentViewModal = 'lastfm-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      maybeResetForm: function() {

      },
      changeVPaths: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-vpaths-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      changeAccess: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-access-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      changePassword: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-password-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      deleteUser: function (username) {
        iziToast.question({
          timeout: 20000,
          close: false,
          overlayClose: true,
          overlay: true,
          displayMode: 'once',
          id: 'question',
          zindex: 99999,
          title: t('admin.users.deleteTitle', { username: username }),
          position: 'center',
          buttons: [
            [`<button><b>${t('admin.users.deleteButton')}</b></button>`, async (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              try {
                await API.axios({
                  method: 'DELETE',
                  url: `${API.url()}/api/v1/admin/users`,
                  data: { username: username }
                });
                Vue.delete(ADMINDATA.users, username);
              } catch (err) {
                iziToast.error({
                  title: t('admin.users.deleteFailed'),
                  position: 'topCenter',
                  timeout: 3500
                });
              }
            }, true],
            [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }],
          ]
        });
      },
      addUser: async function (event) {
        try {
          this.submitPending = true;

          const selected = document.querySelectorAll('#new-user-dirs option:checked');

          const data = {
            username: this.newUsername,
            password: this.newPassword,
            vpaths: Array.from(selected).map(el => el.value),
            admin: this.makeAdmin,
            allowMkdir: this.allowMkdir,
            allowUpload: this.allowUpload,
            allowServerAudio: this.allowServerAudio
          };
          // V35: only include the field when the admin actually filled
          // it in. Empty string would round-trip through Joi as
          // "missing" anyway, but be explicit.
          if (this.newSubsonicPassword) {
            data.subsonicPassword = this.newSubsonicPassword;
          }

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/users`,
            data: data
          });

          Vue.set(ADMINDATA.users, this.newUsername, { vpaths: data.vpaths, admin: data.admin, allowMkdir: data.allowMkdir, allowUpload: data.allowUpload, allowServerAudio: data.allowServerAudio });
          this.newUsername = '';
          this.newPassword = '';
          this.newSubsonicPassword = '';

          // if this is the first user, prompt user and take them to login page
          if (Object.keys(ADMINDATA.users).length === 1) {
            iziToast.question({
              timeout: false,
              close: false,
              overlay: true,
              displayMode: 'once',
              id: 'question',
              zindex: 99999,
              title: t('admin.users.loginRedirect'),
              position: 'center',
              buttons: [[`<button>${t('admin.users.go')}</button>`, (instance, toast) => {
                API.logout();
                instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              }, true]],
            });
          }

          this.$nextTick(() => {
            M.updateTextFields();
          });
        }catch(err) {
          iziToast.error({
            title: t('admin.users.addFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const advancedView = Vue.component('advanced-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated,
      audioInfo: ADMINDATA.serverAudioInfo,
      audioInfoTS: ADMINDATA.serverAudioInfoUpdated,
      dbCacheSizeDraft: null
    };
  },
  computed: {
    activePlayerLabel: function() {
      if (!this.audioInfo.backend) { return 'None'; }
      if (this.audioInfo.backend === 'rust') { return 'rust-server-audio (native)'; }
      if (this.audioInfo.backend === 'cli') { return (this.audioInfo.player || 'cli') + ' (CLI fallback)'; }
      return this.audioInfo.player || 'Unknown';
    },
    detectedCliPlayersLabel: function() {
      const d = this.audioInfo.detectedCliPlayers || [];
      return d.length ? d.join(', ') : 'None';
    }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.security') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.fileUploading') }}</b> {{ params.noUpload === false ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleFileUpload()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.createFolder') }}</b> {{ params.noMkdir === false ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleMkdir()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.fileModification') }}</b> {{ params.noFileModify === false ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleFileModify()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.authKey') }}</b> ****************{{params.secret}}</td>
                      <td>
                        [<a v-on:click="generateNewKey()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.network') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.port') }}</b> {{params.port}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-port-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.maxRequestSize') }}</b> {{params.maxRequestSize}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-request-size-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.downloadSizeLimit') }}</b> {{ params.downloadSizeLimit === '0' ? t('admin.settings.unlimited') : params.downloadSizeLimit }}</td>
                      <td>
                        [<a v-on:click="openModal('edit-download-size-limit-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.address') }}</b> {{params.address}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-address-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.trustProxy') }}</b> {{ params.trustProxy === true ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleTrustProxy()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.frontend') }}</b> {{uiLabel(params.ui)}}</td>
                      <td>
                        [<a v-on:click="switchUI()">switch to {{uiLabel(nextUI(params.ui))}}</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.serverAudio') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.autoBoot') }}</b> {{ params.autoBootServerAudio ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleAutoBootServerAudio()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.rustPlayerPort') }}</b> {{params.rustPlayerPort}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-rust-player-port-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Active player:</b> {{ activePlayerLabel }}</td>
                      <td>
                        [<a v-on:click="refreshServerAudioInfo()">refresh</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Detected CLI players:</b> {{ detectedCliPlayersLabel }}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Database</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b title="SQLite write durability for the main connection. FULL fsyncs every commit, so no scrobble, rating, or playlist edit is lost on a power cut. NORMAL skips the per-commit fsync for faster writes — still crash-safe under WAL (never corrupts), but a hard power loss can lose the last few committed actions. Applied live, no restart.">Write Durability (synchronous):</b> {{params.dbSynchronous || 'FULL'}}</td>
                      <td>
                        [<a v-on:click="toggleDbSynchronous()">switch to {{ (params.dbSynchronous === 'NORMAL') ? 'FULL' : 'NORMAL' }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b title="SQLite page-cache size for the main connection, in MB (applied as a negative cache_size). A larger cache keeps more of the DB + indexes hot in RAM, cutting disk reads on big libraries under heavy browse/search load, at the cost of that much process memory. Applied live, no restart.">Page cache (MB):</b> {{params.dbCacheSizeMb || 64}}</td>
                      <td>
                        <input type="number" min="1" max="2048" v-model.number="dbCacheSizeDraft" :placeholder="params.dbCacheSizeMb || 64" style="width:90px" />
                        [<a v-on:click="saveDbCacheSize()">save</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b title="HTTP response compression for text payloads (API JSON, HTML, JS, CSS). brotli = best ratio; gzip = widest compatibility; none = off. Audio and range/seek streams are never compressed. Applied live, no restart.">Compression:</b> {{params.compression || 'none'}}</td>
                      <td>
                        <span v-for="m in ['none','gzip','brotli']" :key="m" style="margin-right:6px">
                          <b v-if="(params.compression || 'none') === m">[{{m}}]</b>
                          <span v-else>[<a v-on:click="setCompression(m)">{{m}}</a>]</span>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div v-if="!params.ssl || !params.ssl.cert">
                <div class="card-content">
                  <span class="card-title">{{ t('admin.settings.ssl') }}</span>
                  <a v-on:click="openModal('edit-ssl-modal')" class="waves-effect waves-light btn">{{ t('admin.settings.addSSL') }}</a>
                </div>
              </div>
              <div v-else>
                <div class="card-content">
                  <span class="card-title">{{ t('admin.settings.ssl') }}</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>Cert:</b> {{params.ssl.cert}}</td>
                      </tr>
                      <tr>
                        <td><b>Key:</b> {{params.ssl.key}}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="card-action">
                  <a v-on:click="openModal('edit-ssl-modal')" class="waves-effect waves-light btn">{{ t('admin.settings.editSSL') }}</a>
                  <a v-on:click="removeSSL()" class="waves-effect waves-light btn">{{ t('admin.settings.removeSSL') }}</a>
                </div>
              </div>
            </div>
          </div>
    </div>
  `,
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    // Lookup: internal UI id → user-visible label. The `subsonic`
    // value (Airsonic Refix — webapp/subsonic/) is still valid in
    // the Joi validator and can be set by hand-editing config.json,
    // but it is intentionally NOT listed in the switcher rotation
    // below. The admin panel + shared pages don't yet render cleanly
    // under the Subsonic UI; until that's sorted out we don't want
    // to let operators trap themselves in a broken state by flipping
    // to it from here. `uiLabel` still knows the Subsonic label so
    // an operator who set it via config.json sees the correct name
    // rendered instead of a raw 'subsonic' string.
    uiLabel: function(id) {
      return ({ default: 'Default', velvet: 'Velvet', subsonic: 'Subsonic UI' })[id] || id;
    },
    // Rotate through the switcher-exposed UIs on each click.
    // Subsonic is deliberately omitted — see uiLabel comment.
    nextUI: function(id) {
      const order = ['default', 'velvet'];
      const i = order.indexOf(id);
      return order[(i < 0 ? 0 : i + 1) % order.length];
    },
    switchUI: function() {
      const newUI = this.nextUI(this.params.ui);
      const label = this.uiLabel(newUI);
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${t('admin.settings.switchFrontend', { label: label })}</b>`,
        message: t('admin.settings.switchRestart'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.settings.switchingTo', { label: label })}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/ui`,
              data: { ui: newUI }
            }).then(() => {
              iziToast.success({
                title: t('admin.settings.switchingTo', { label: label }),
                message: t('admin.settings.serverRestarting'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.settings.cancel')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    removeSSL: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: t('admin.settings.removeSSLTitle'),
        message: t('admin.settings.serverReboot'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.folders.removeButton')} SSL</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            try {
              await API.axios({
                method: 'DELETE',
                url: `${API.url()}/api/v1/admin/ssl`
              });

              setTimeout(() => {
                window.location.href = window.location.href.replace('https://', 'http://'); 
              }, 4000);
      
              iziToast.success({
                title: t('admin.settings.certsDeleted'),
                position: 'topCenter',
                timeout: 8500
              });
            } catch (err) {
              iziToast.error({
                title: t('admin.settings.certDeleteFailed'),
                position: 'topCenter',
                timeout: 3500
              });
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    generateNewKey: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${t('admin.settings.generateAuthKey')}</b>`,
        message: t('admin.settings.authKeyWarning'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.settings.generateButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/secret`,
              data: { strength: 128 }
            }).then(() => {
              API.logout();
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleMkdir: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.params.noMkdir === false ? t('admin.settings.disableFolders') : t('admin.settings.enableFolders')}</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.params.noMkdir === false ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/nomkdir`,
              data: { noMkdir: !this.params.noMkdir }
            }).then(() => {
              Vue.set(ADMINDATA.serverParams, 'noMkdir', !this.params.noMkdir);

              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleFileModify: function() {
      const self = this;
      iziToast.question({
        timeout: 20000, close: false, overlayClose: true, overlay: true,
        displayMode: 'once', id: 'question', zindex: 99999, layout: 2, maxWidth: 600,
        title: `<b>${self.params.noFileModify === false ? t('admin.settings.disableModify') : t('admin.settings.enableModify')}</b>`,
        message: t('admin.settings.modifyHint'),
        position: 'center',
        buttons: [
          [`<button><b>${self.params.noFileModify === false ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/nofilemodify`,
              data: { noFileModify: !self.params.noFileModify }
            }).then(() => {
              Vue.set(ADMINDATA.serverParams, 'noFileModify', !self.params.noFileModify);
              iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
            }).catch(() => {
              iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleFileUpload: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.params.noUpload === false ? t('admin.settings.disableUploading') : t('admin.settings.enableUploading')}</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.params.noUpload === false ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/noupload`,
              data: { noUpload: !this.params.noUpload }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.serverParams, 'noUpload', !this.params.noUpload);

              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    refreshServerAudioInfo: function() {
      ADMINDATA.redetectCliPlayers();
    },
    toggleDbSynchronous: async function() {
      const next = (this.params.dbSynchronous === 'NORMAL') ? 'FULL' : 'NORMAL';
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/db-synchronous`,
          data: { synchronous: next }
        });
        Vue.set(ADMINDATA.serverParams, 'dbSynchronous', next);
        iziToast.success({
          title: `DB write durability set to ${next}`,
          position: 'topCenter',
          timeout: 2500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to change DB synchronous setting',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    saveDbCacheSize: async function() {
      const mb = Number(this.dbCacheSizeDraft);
      if (!Number.isInteger(mb) || mb < 1 || mb > 2048) {
        iziToast.error({
          title: 'Cache size must be a whole number between 1 and 2048 MB',
          position: 'topCenter',
          timeout: 3500
        });
        return;
      }
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/db-cache-size`,
          data: { cacheSizeMb: mb }
        });
        Vue.set(ADMINDATA.serverParams, 'dbCacheSizeMb', mb);
        this.dbCacheSizeDraft = null;
        iziToast.success({
          title: `DB page cache set to ${mb} MB`,
          position: 'topCenter',
          timeout: 2500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to change DB cache size',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    setCompression: async function(mode) {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/compression`,
          data: { mode }
        });
        Vue.set(ADMINDATA.serverParams, 'compression', mode);
        iziToast.success({
          title: `Compression set to ${mode}`,
          position: 'topCenter',
          timeout: 2500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to change compression setting',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    toggleTrustProxy: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.params.trustProxy ? t('admin.settings.disableTrustProxy') : t('admin.settings.enableTrustProxy')}</b>`,
        message: t('admin.settings.trustProxyHint'),
        position: 'center',
        buttons: [
          [`<button><b>${this.params.trustProxy ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/trust-proxy`,
              data: { trustProxy: !this.params.trustProxy }
            }).then(() => {
              Vue.set(ADMINDATA.serverParams, 'trustProxy', !this.params.trustProxy);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleAutoBootServerAudio: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.params.autoBootServerAudio ? t('admin.settings.disableAutoBoot') : t('admin.settings.enableAutoBoot')}</b>`,
        message: t('admin.settings.autoBootHint'),
        position: 'center',
        buttons: [
          [`<button><b>${this.params.autoBootServerAudio ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/auto-boot-server-audio`,
              data: { autoBootServerAudio: !this.params.autoBootServerAudio }
            }).then(() => {
              Vue.set(ADMINDATA.serverParams, 'autoBootServerAudio', !this.params.autoBootServerAudio);
              setTimeout(() => ADMINDATA.getServerAudioInfo(), 500);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    }
  }
});


const dbView = Vue.component('db-view', {
  data() {
    return {
      dbParams: ADMINDATA.dbParams,
      dbStats: '',
      sharedPlaylists: ADMINDATA.sharedPlaylists,
      sharedPlaylistsTS: ADMINDATA.sharedPlaylistUpdated,
      isPullingStats: false,
      isPullingShared: false
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.scanSettings') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.db.scanInterval') }}</b> {{dbParams.scanInterval}} hours</td>
                      <td>
                        [<a v-on:click="openModal('edit-scan-interval-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.bootScanDelay') }}</b> {{dbParams.bootScanDelay}} seconds</td>
                      <td>
                        [<a v-on:click="openModal('edit-boot-scan-delay-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.skipImageMeta') }}</b> {{dbParams.skipImg}}</td>
                      <td>
                        [<a v-on:click="toggleSkipImg()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.compressImages') }}</b> {{dbParams.compressImage}}</td>
                      <td>
                        [<a v-on:click="recompressImages()">{{ t('admin.db.recompress') }}</a>]
                        [<a v-on:click="toggleCompressImage()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Generate waveforms after scans:</b> {{dbParams.generateWaveforms}}</td>
                      <td>
                        [<a v-on:click="toggleGenerateWaveforms()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Analyse BPM + key (essentia, post-scan):</b> {{dbParams.analyzeBpm}}</td>
                      <td>
                        [<a v-on:click="toggleAnalyzeBpm()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>BPM/key tracks analysed per pass:</b> {{dbParams.analyzeBpmPerRun}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-analyze-bpm-per-run-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Identify tracks via AcoustID (fingerprint &rarr; MusicBrainz ID, post-scan):</b> {{dbParams.analyzeAcoustid}}</td>
                      <td>
                        [<a v-on:click="toggleAnalyzeAcoustid()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Ignore dot-hidden files (.name.mp3) when scanning:</b> {{dbParams.ignoreDotFiles}}</td>
                      <td>
                        [<a v-on:click="toggleIgnoreDotFiles()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Ignore dot-hidden folders (.name/) when scanning:</b> {{dbParams.ignoreDotFolders}}</td>
                      <td>
                        [<a v-on:click="toggleIgnoreDotFolders()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Watch libraries for changes (instant scans, local disks):</b> {{dbParams.watcherEnabled}}</td>
                      <td>
                        [<a v-on:click="toggleWatcherEnabled()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Tracks identified per AcoustID pass:</b> {{dbParams.acoustidPerRun}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-acoustid-per-run-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Collect music-discovery data (separate discovery.db):</b> {{dbParams.collectDiscoveryData}}</td>
                      <td>
                        [<a v-on:click="toggleCollectDiscoveryData()">{{ t('admin.settings.edit') }}</a>]
                        [<a v-on:click="exportDiscoveryData()">Export</a>]
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>Discovery embedding model:</b> {{dbParams.discoveryModel}}
                        <span v-if="dbParams.discoveryModel === 'effnet-discogs'"> — Discogs-EffNet by MTG-UPF (CC BY-NC-SA 4.0, non-commercial)</span>
                      </td>
                      <td></td>
                    </tr>
                    <tr>
                      <td><b>Discovery tracks embedded per pass:</b> {{dbParams.discoveryPerRun}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-discovery-per-run-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.albumArtLookup') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.db.autoLookup') }}</b> {{ dbParams.autoAlbumArt ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleAutoAlbumArt()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.autoArtMode') }}</b> {{ dbParams.autoAlbumArtMode === 'all' ? t('admin.db.autoArtModeAll') : t('admin.db.autoArtModeMissing') }}</td>
                      <td>
                        [<a v-on:click="toggleAutoAlbumArtMode()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.autoArtPerRun') }}</b> {{ dbParams.autoAlbumArtPerRun }}</td>
                      <td>
                        [<a v-on:click="openModal('edit-auto-album-art-per-run-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.autoWriteToFolder') }}</b> {{ dbParams.autoAlbumArtWriteToFolder ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleAutoAlbumArtWriteToFolder()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.writeToFolder') }}</b> {{ dbParams.albumArtWriteToFolder ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleAlbumArtWriteToFolder()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.embedInFile') }}</b> {{ dbParams.albumArtWriteToFile ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleAlbumArtWriteToFile()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.serviceOrder') }}</b> {{dbParams.albumArtServices ? dbParams.albumArtServices.join(', ') : 'musicbrainz, itunes, deezer'}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-album-art-services-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.scanQueueStats') }}</span>
                <a v-on:click="scanDB" class="waves-effect waves-light btn">{{ t('admin.db.startScan') }}</a>
                <a v-on:click="forceRescan" class="waves-effect waves-light btn orange">{{ t('admin.db.forceRescan') }}</a>
                <a v-on:click="pullStats" class="waves-effect waves-light btn">{{ t('admin.db.pullStats') }}</a>
                <div v-if="isPullingStats === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <pre v-else>
                  {{dbStats}}
                </pre>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.sharedPlaylists') }}</span>
                <a v-on:click="loadShared" class="waves-effect waves-light btn">{{ t('admin.db.loadPlaylists') }}</a>
                <br><br>
                <div v-if="isPullingShared === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length > 0">
                  [<a v-on:click="deleteUnxpShared">{{ t('admin.db.deleteNoExpiry') }}</a>]
                  <br>
                  [<a v-on:click="deleteExpiredShared">{{ t('admin.db.deleteExpired') }}</a>]
                  <br>
                  <table>
                    <thead>
                      <tr>
                        <th>{{ t('admin.db.playlistId') }}</th>
                        <th>{{ t('admin.db.user') }}</th>
                        <th>{{ t('admin.db.expires') }}</th>
                        <th>{{ t('admin.db.actions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(v, k) in sharedPlaylists">
                        <th><a target="_blank" v-bind:href="'/shared/'+ v.playlistId">{{v.playlistId}}</a></th>
                        <th>{{v.user}}</th>
                        <th>{{ v.expires ? new Date(v.expires * 1000).toLocaleString() : t('admin.db.never') }}</th>
                        <th>[<a v-on:click="deletePlaylist(v)">{{ t('admin.db.deleteLower') }}</a>]</th>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length === 0">
                  {{ t('admin.db.noSharedPlaylists') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    pullStats: async function() {
      try {
        this.isPullingStats = true;
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/db/scan/stats`
        });

        this.dbStats = res.data
      } catch (err) {
        iziToast.error({
          title: t('admin.db.pullDataFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingStats = false;
      }
    },
    loadShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.getSharedPlaylists();
      } catch (err) {
        iziToast.error({
          title: t('admin.db.pullDataFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    deletePlaylist: async function(playlistObj) {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: t('admin.db.deletePlaylistTitle', { id: playlistObj.playlistId }),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.users.deleteButton')}</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            try {
              await ADMINDATA.deleteSharedPlaylist(playlistObj);
            } catch (err) {
              iziToast.error({
                title: t('admin.db.deletePlaylistFailed'),
                position: 'topCenter',
                timeout: 3500
              });
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    deleteUnxpShared: async function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: t('admin.db.deleteAllTitle'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.users.deleteButton')}</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            try {
              this.isPullingShared = true;
              await ADMINDATA.deleteUnxpShared();
              await ADMINDATA.getSharedPlaylists();
            } catch (err) {
              iziToast.error({
                title: t('admin.db.deleteAllFailed'),
                position: 'topCenter',
                timeout: 3500
              });
            } finally {
              this.isPullingShared = false;
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    deleteExpiredShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.deleteExpiredShared();
        await ADMINDATA.getSharedPlaylists();
      } catch (err) {
        iziToast.error({
          title: t('admin.db.pullDataFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    scanDB: async function() {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/scan/all`
        });

        iziToast.success({
          title: t('admin.db.scanStarted'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: t('admin.db.scanStartFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    forceRescan: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${t('admin.db.forceRescanTitle')}</b>`,
        message: t('admin.db.forceRescanDesc'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.db.forceRescan')}</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            try {
              await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/db/scan/force-rescan`
              });
              iziToast.success({
                title: t('admin.db.forceRescanStarted'),
                position: 'topCenter',
                timeout: 3500
              });
            } catch (err) {
              iziToast.error({
                title: t('admin.db.rescanStartFailed'),
                position: 'topCenter',
                timeout: 3500
              });
            }
          }, true],
          [`<button>${t('admin.settings.cancel')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    recompressImages: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${t('admin.db.compressAllTitle')}</b>`,
        message: t('admin.db.compressBackground'),
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.db.startButton')}</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            
            try {
              const res = await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/db/force-compress-images`,
              });

              if (res.data.started === true) {
                iziToast.success({
                  title: t('admin.db.processStarted'),
                  position: 'topCenter',
                  timeout: 3500
                });
              } else {
                iziToast.warning({
                  title: t('admin.db.compressionInProgress'),
                  position: 'topCenter',
                  timeout: 3500
                });
              }

            } catch (err) {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleCompressImage: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.compressImage === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} ${t('admin.db.toggleCompressImages')}?</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.compressImage === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/compress-image`,
              data: { compressImage: !this.dbParams.compressImage }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.dbParams, 'compressImage', !this.dbParams.compressImage);

              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleGenerateWaveforms: function() {
      // Waveforms are generated by a background pass AFTER each scan
      // (the scan itself no longer decodes audio). Disabling skips the
      // pass; waveforms still appear in the UI via the on-demand
      // /api/v1/db/waveform endpoint, which regenerates via ffmpeg on
      // first playback — a few hundred ms latency on the first request
      // per track. Enabling immediately queues a backfill pass.
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.generateWaveforms === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} background waveform generation?</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.generateWaveforms === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/generate-waveforms`,
              data: { generateWaveforms: !this.dbParams.generateWaveforms }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, 'generateWaveforms', !this.dbParams.generateWaveforms);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    // Dot-entry ignore toggles. Applied on the NEXT scan: enabling
    // removes already-indexed dot-hidden entries (the sweep converges
    // them out); disabling brings them back on the next scan. Names
    // starting with '..' are never treated as hidden.
    toggleIgnoreDot: function(field, route, noun) {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams[field] === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} ignoring dot-hidden ${noun}?</b>`,
        message: 'Takes effect on the next scan; already-indexed matching entries are removed (or re-added) then.',
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams[field] === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/${route}`,
              data: { [field]: !this.dbParams[field] }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, field, !this.dbParams[field]);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleIgnoreDotFiles: function() {
      this.toggleIgnoreDot('ignoreDotFiles', 'ignore-dot-files', 'files');
    },
    toggleIgnoreDotFolders: function() {
      this.toggleIgnoreDot('ignoreDotFolders', 'ignore-dot-folders', 'folders');
    },
    // Filesystem-watcher toggle. Live: the server starts/stops the
    // watchers on POST — no reboot. Same confirm-toast pattern as the
    // other boolean scan params.
    toggleWatcherEnabled: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.watcherEnabled === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} watching libraries for changes?</b>`,
        message: 'Changed files trigger a targeted scan within seconds. Network mounts (NAS shares) usually emit no change events — the scheduled scan interval still covers those.',
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.watcherEnabled === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/watcher-enabled`,
              data: { watcherEnabled: !this.dbParams.watcherEnabled }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, 'watcherEnabled', !this.dbParams.watcherEnabled);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleAnalyzeAcoustid: function() {
      iziToast.question({
        timeout: false,
        close: false,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.analyzeAcoustid === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} AcoustID identification? (post-scan; sends acoustic fingerprints of un-identified tracks to api.acoustid.org and fills in MusicBrainz recording IDs)</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.analyzeAcoustid === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/analyze-acoustid`,
              data: { analyzeAcoustid: !this.dbParams.analyzeAcoustid }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, 'analyzeAcoustid', !this.dbParams.analyzeAcoustid);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleAnalyzeBpm: function() {
      // DEPRECATED — currently a no-op: scan-time BPM/key analysis was
      // removed with scan-time decode and returns as the separate
      // essentia enrichment scanner. The toggle persists the config
      // value (it will seed the essentia scanner's default), tag-sourced
      // BPM/key is always ingested, and existing analysis-derived rows
      // keep their values.
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.analyzeBpm === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} essentia BPM + key analysis? (post-scan, CPU-heavy — runs in the background and fills tracks with no BPM/key tag)</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.analyzeBpm === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/analyze-bpm`,
              data: { analyzeBpm: !this.dbParams.analyzeBpm }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, 'analyzeBpm', !this.dbParams.analyzeBpm);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleCollectDiscoveryData: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.collectDiscoveryData === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} music-discovery data collection? (stores per-track audio fingerprint IDs + embeddings in a separate discovery.db you can export; disabling keeps existing data — but if the discovery network is enabled, new music will stop reaching your published snapshot)</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.collectDiscoveryData === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/collect-discovery-data`,
              data: { collectDiscoveryData: !this.dbParams.collectDiscoveryData }
            }).then(() => {
              Vue.set(ADMINDATA.dbParams, 'collectDiscoveryData', !this.dbParams.collectDiscoveryData);
              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    exportDiscoveryData: function() {
      // Build a fresh snapshot, then pull it down. The endpoint 404s until
      // collection has been enabled at least once.
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/db/discovery-export`
      }).then((response) => {
        iziToast.success({
          title: `Discovery export ready: ${response.data.rowCount} tracks`,
          position: 'topCenter',
          timeout: 3500
        });
        window.location.href = `${API.url()}/api/v1/admin/db/discovery-export/download?token=${API.token()}`;
      }).catch((err) => {
        iziToast.error({
          title: (err && err.response && err.response.status === 404)
            ? 'Enable music-discovery data collection first'
            : t('admin.settings.failed'),
          position: 'topCenter',
          timeout: 3500
        });
      });
    },
    toggleSkipImg: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.dbParams.skipImg === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')} ${t('admin.db.toggleSkipImg')}?</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.skipImg === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/skip-img`,
              data: { skipImg: !this.dbParams.skipImg }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.dbParams, 'skipImg', !this.dbParams.skipImg);

              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    // Binary setting — the "edit" link just flips to the other value.
    toggleAutoAlbumArtMode: function() {
      const self = this;
      const next = self.dbParams.autoAlbumArtMode === 'all' ? 'missing' : 'all';
      API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/auto-album-art-mode`,
        data: { autoAlbumArtMode: next }
      }).then(() => {
        Vue.set(ADMINDATA.dbParams, 'autoAlbumArtMode', next);
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      }).catch(() => { iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 }); });
    },
    toggleAutoAlbumArtWriteToFolder: function() {
      const self = this;
      API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/auto-album-art-write-to-folder`,
        data: { autoAlbumArtWriteToFolder: !self.dbParams.autoAlbumArtWriteToFolder }
      }).then(() => {
        Vue.set(ADMINDATA.dbParams, 'autoAlbumArtWriteToFolder', !self.dbParams.autoAlbumArtWriteToFolder);
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      }).catch(() => { iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 }); });
    },
    toggleAutoAlbumArt: function() {
      const self = this;
      API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/auto-album-art`,
        data: { autoAlbumArt: !self.dbParams.autoAlbumArt }
      }).then(() => {
        Vue.set(ADMINDATA.dbParams, 'autoAlbumArt', !self.dbParams.autoAlbumArt);
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      }).catch(() => { iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 }); });
    },
    toggleAlbumArtWriteToFolder: function() {
      const self = this;
      API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/album-art-write-to-folder`,
        data: { albumArtWriteToFolder: !self.dbParams.albumArtWriteToFolder }
      }).then(() => {
        Vue.set(ADMINDATA.dbParams, 'albumArtWriteToFolder', !self.dbParams.albumArtWriteToFolder);
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      }).catch(() => { iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 }); });
    },
    toggleAlbumArtWriteToFile: function() {
      const self = this;
      API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/album-art-write-to-file`,
        data: { albumArtWriteToFile: !self.dbParams.albumArtWriteToFile }
      }).then(() => {
        Vue.set(ADMINDATA.dbParams, 'albumArtWriteToFile', !self.dbParams.albumArtWriteToFile);
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      }).catch(() => { iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 }); });
    },
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    }
  }
});

const lyricsView = Vue.component('lyrics-view', {
  data() {
    return {
      loaded: false,
      // Local mirrors of config.lyrics, populated in created() so the
      // template binds to reactive data fields (not late-added keys on
      // the shared ADMINDATA object).
      backfill: false,
      writeSidecar: false,
      providers: { lrclib: true, netease: false, kugou: false },
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Lyrics Backfill</span>
                <p>After each library scan, proactively look up lyrics for tracks that don't already have them (from their tags or a sidecar file). Off by default.</p>
                <table v-if="loaded">
                  <tbody>
                    <tr>
                      <td><b>Backfill lyrics after scans:</b> {{ backfill ? 'Enabled' : 'Disabled' }}</td>
                      <td>
                        [<a v-on:click="toggleBackfill()">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Write fetched lyrics to sidecar files (.lrc next to each track):</b> {{ writeSidecar ? 'Enabled' : 'Disabled' }}</td>
                      <td>
                        [<a v-on:click="toggleWriteSidecar()">edit</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Lyrics Sources</span>
                <p>Which providers to query, in priority order — the first one with a match wins. <b>LRCLib</b> is the recommended default. <b>NetEase</b> and <b>Kugou</b> are unofficial third-party APIs (better coverage for CJK / Asian music) and are off by default; enable them only if you want them.</p>
                <div v-if="loaded">
                  <p><label><input type="checkbox" class="filled-in" v-model="providers.lrclib" v-on:change="saveProviders()" /><span>LRCLib (lrclib.net)</span></label></p>
                  <p><label><input type="checkbox" class="filled-in" v-model="providers.netease" v-on:change="saveProviders()" /><span>NetEase Cloud Music &mdash; unofficial</span></label></p>
                  <p><label><input type="checkbox" class="filled-in" v-model="providers.kugou" v-on:change="saveProviders()" /><span>Kugou &mdash; unofficial</span></label></p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  created: async function () {
    try {
      await ADMINDATA.getLyricsParams();
      this.backfill = !!ADMINDATA.lyricsParams.backfill;
      this.writeSidecar = !!ADMINDATA.lyricsParams.writeSidecar;
      const list = Array.isArray(ADMINDATA.lyricsParams.providers) ? ADMINDATA.lyricsParams.providers : ['lrclib'];
      this.providers = {
        lrclib: list.includes('lrclib'),
        netease: list.includes('netease'),
        kugou: list.includes('kugou'),
      };
    } catch (err) {
      iziToast.error({ title: 'Failed to load lyrics settings', position: 'topCenter', timeout: 3000 });
    }
    this.loaded = true;
  },
  methods: {
    toggleBackfill: function () {
      const next = !this.backfill;
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/lyrics/backfill`,
        data: { backfill: next }
      }).then(() => {
        this.backfill = next;
        Vue.set(ADMINDATA.lyricsParams, 'backfill', next);
        iziToast.success({ title: 'Saved', position: 'topCenter', timeout: 2000 });
      }).catch(() => {
        iziToast.error({ title: 'Update failed', position: 'topCenter', timeout: 3000 });
      });
    },
    toggleWriteSidecar: function () {
      const next = !this.writeSidecar;
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/lyrics/write-sidecar`,
        data: { writeSidecar: next }
      }).then(() => {
        this.writeSidecar = next;
        Vue.set(ADMINDATA.lyricsParams, 'writeSidecar', next);
        iziToast.success({ title: 'Saved', position: 'topCenter', timeout: 2000 });
      }).catch(() => {
        iziToast.error({ title: 'Update failed', position: 'topCenter', timeout: 3000 });
      });
    },
    saveProviders: function () {
      const order = ['lrclib', 'netease', 'kugou'];
      const list = order.filter(p => this.providers[p]);
      if (list.length === 0) {
        // At least one source is required — re-enable LRCLib and bail.
        this.providers.lrclib = true;
        iziToast.warning({ title: 'Keep at least one source enabled', position: 'topCenter', timeout: 3000 });
        return;
      }
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/lyrics/providers`,
        data: { providers: list }
      }).then(() => {
        Vue.set(ADMINDATA.lyricsParams, 'providers', list.slice());
        iziToast.success({ title: 'Saved', position: 'topCenter', timeout: 2000 });
      }).catch(() => {
        iziToast.error({ title: 'Update failed', position: 'topCenter', timeout: 3000 });
      });
    },
  },
});

const rpnView = Vue.component('rpn-view', {
  data() {
    return {
      tabs: null,
      submitPending: false
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <h1>mStream RPN</h1>
          <div class="card">
            <ul id="tab-thing" class="tabs tabs-fixed-width">
              <li class="tab"><a class="active" href="#test1">Standard</a></li>
              <li class="tab"><a href="#test2">Advanced</a></li>
            </ul>
            <div id="test1">
              <form @submit.prevent="standardLogin">
                <div class="card-content">
                  <span class="card-title">Login</span>
                  <div class="row">
                    <div class="col s12 m6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-username" required type="text">
                          <label for="rpn-simple-username">Username</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-password" required type="password">
                          <label for="rpn-simple-password">Password</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m6 hide-on-small-only">
                      <div class="row">
                        <h5 class="center-align">Help Support mStream</h5>
                      </div>
                      <div class="row">
                        <div class="col s2"></div>
                        <a target="_blank" href="https://mstream.io/reverse-proxy-network" class="col s8 blue darken-3 waves-effect waves-light btn">Sign Up</a>
                        <div class="col s2"></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Login to RPN' : 'Pending...'}}
                  </button>
                </div>
              </form>
            </div>
            <div id="test2">
              <form @submit.prevent="advancedLogin">
                <div class="card-content">
                  <span class="card-title">Config</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-address" required type="text">
                          <label for="rpn-advanced-address">Server Address</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-port" required type="number" type="number" min="2" max="65535">
                          <label for="rpn-advanced-port">Port</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-domain" required type="text">
                          <label for="rpn-advanced-domain">Server Domain</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-password" required type="password">
                          <label for="rpn-advanced-password">Server Key</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <h5>
                        <a target="_blank" href="https://github.com/fog-machine/tunnel-server">
                          Check the docs to learn how to deploy your own server
                        </a>
                      </h5>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Connect To Server' : 'Connecting...'}}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <h4>Features</h4>
        <ul class="browser-default">
          <li>Choose your own domain @ https://your-name.mstream.io</li>
          <li>Automatic SSL Encryption for your server</li>
          <li>'Hole Punching' software guarantees your server stays online as long as you have a working internet connection</li>
          <li>IP Obfuscation hides your IP address and adds an additional layer of security</li>  
        </ul>
      </div>
    </div>`,
  mounted: function () {
    this.tabs = M.Tabs.init(document.getElementById('tab-thing'), {});
    this.tabs.select('test1')
  },
  beforeDestroy: function() {
    this.tabs.destroy();
  },
  methods: {
    standardLogin: function() {
      console.log('STAND')
    },
    advancedLogin: function() {
      console.log('ADV')
    }
  }
});

const infoView = Vue.component('info-view', {
  data() {
    return {
      version: ADMINDATA.version
    };
  },
  template: `
    <div class="container">
      <div class="row logo-row-mstream">
        <svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" x="0" y="0" viewBox="0 0 612 153" xml:space="preserve"><style>.st0,.st1{fill-rule:evenodd;clip-rule:evenodd;fill:#264679}.st1{fill:#6684b2}</style><path class="st0" d="M179.9 45.5c-6.2 0-11.5 1.7-15.9 5s-6.5 8.1-6.5 14.4c0 4.9 1.3 9.1 3.8 12.4 2.5 3.4 5.7 5.8 9.3 7.3 3.7 1.5 7.3 2.8 11 3.8s6.8 2.3 9.3 3.9c2.5 1.5 3.8 3.5 3.8 5.8 0 4.8-4.4 7.2-13.1 7.2h-24.1V118h24.1c17.1 0 25.6-6.7 25.6-20.2 0-1.9-.2-3.8-.6-5.8-.4-2-1.2-4-2.6-6-1.3-2.1-3.3-3.7-5.8-4.9-2.5-1.2-6.4-2.7-11.5-4.5l-8.8-3.1c-.7-.2-1.7-.7-2.9-1.3-1.3-.7-2.2-1.3-2.8-1.9-.6-.6-1.1-1.4-1.6-2.3-.5-.9-.7-2-.7-3.2 0-2 1-3.5 2.9-4.6 1.9-1.1 4.3-1.6 7-1.6h24.6V45.5h-24.5zM226.4 58.3v31c0 10.2 2.5 17.6 7.6 22 5.1 4.4 13 6.6 23.7 6.6v-12.8c-2.7 0-4.9-.2-6.8-.4-1.8-.3-3.7-.9-5.8-1.9-2-.9-3.6-2.6-4.7-4.9-1.1-2.3-1.6-5.2-1.6-8.7V58.3h18.8V45.5h-18.8V31.6L214 58.3h12.4zM281.1 118V76.8c0-7.2.9-12 2.6-14.5 1-1.3 2.2-2.2 3.6-2.8 1.4-.6 2.6-1 3.6-1.1 1-.1 2.5-.1 4.3-.1H310V45.5h-12.2c-3.6 0-6.5.1-8.6.3-2.1.2-4.5.9-7.3 2s-5.1 2.8-7.1 5c-4 4.4-6 12.4-6 24V118h12.3zM326.2 53.8c-6.2 7.4-9.3 17-9.3 28.9 0 10.7 3.2 19.4 9.5 26.2s14.7 10.1 25.3 10.1c8.7 0 16.3-2.7 22.7-8.1L366 102c-3.7 2.1-8.5 3.2-14.3 3.2-6.5 0-11.8-2.3-15.8-6.9-4-4.6-6-10.5-6-17.9 0-7 1.9-12.9 5.6-17.9 3.8-5 8.9-7.5 15.5-7.5 3.3 0 6.1.8 8.2 2.4 2.1 1.6 3.2 4 3.2 7.2 0 5-1.2 8.5-3.6 10.6-2.4 2.1-6.7 3.2-12.9 3.2h-6.7v11.7h5.7c20.3 0 30.5-8.5 30.5-25.4 0-13.6-7.9-20.7-23.7-21.5-10.8-.2-19.3 3.3-25.5 10.6zM412.3 73.2c-7.4 0-13.6 1.9-18.5 5.7-4.9 3.8-7.4 9.4-7.4 16.7 0 7.3 2.3 12.9 7 16.7 4.6 3.8 10.9 5.7 18.8 5.7h31V73.6c0-9.1-2.4-16-7.2-20.8-4.8-4.8-11.7-7.2-20.7-7.2h-22.9v12.8h22.3c10.9 0 16.4 6.1 16.4 18.2v28.7h-18.4c-9.1 0-13.6-3.2-13.6-9.8 0-3.3 1.2-5.9 3.6-7.8 2.4-1.8 5.8-2.7 10.2-2.7 5.1 0 9.4 1.4 12.9 4.3v-14c-4.9-1.4-9.3-2.1-13.5-2.1zM458.8 118H471V58.3h24.4V118h12.2V58.3h5.7c6.8 0 11.3.7 13.5 2 4.3 2.5 6.5 7.7 6.5 15.5V118h12.2V75.7c0-6-.6-11.2-1.9-15.5-1.2-4.3-3.9-7.8-7.9-10.6-3.9-2.7-9.1-4.1-15.7-4.1h-61.4V118z"/><path class="st1" d="M75 118.5v-83l21 13v70z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#26477b" d="M99 118.5v-69l11.5 7 10.5-7v69z"/><path class="st1" d="M124 118.5v-70l21-13v83z"/></svg>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <blockquote>
                <h4><b>mStream v{{version.val}}</b></h4>
                <h4>Developed By: Paul Sori</h4>
                <h5><a href="mailto:paul.sori@pm.me">paul@mstream.io</a></h5>
              </blockquote>
              <br>
              <div>
                <iframe src="https://github.com/sponsors/IrosTheBeggar/button" title="Donate" height="35" width="200px" style="border: 0;"></iframe>
              </div>
              <br>
              <a href="https://discord.gg/AM896Rr" target="_blank">
                <svg style="max-height:70px;" viewBox="0 0 292 80" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0)"><g clip-path="url(#clip1)" fill="#5865F2"><path d="M61.796 16.494a59.415 59.415 0 00-15.05-4.73 44.128 44.128 0 00-1.928 4.003c-5.612-.844-11.172-.844-16.68 0a42.783 42.783 0 00-1.95-4.002 59.218 59.218 0 00-15.062 4.74C1.6 30.9-.981 44.936.31 58.772c6.317 4.717 12.44 7.583 18.458 9.458a45.906 45.906 0 003.953-6.51 38.872 38.872 0 01-6.225-3.03 30.957 30.957 0 001.526-1.208c12.004 5.615 25.046 5.615 36.906 0 .499.416 1.01.82 1.526 1.208a38.775 38.775 0 01-6.237 3.035 45.704 45.704 0 003.953 6.511c6.025-1.875 12.153-4.74 18.47-9.464 1.515-16.04-2.588-29.947-10.844-42.277zm-37.44 33.767c-3.603 0-6.558-3.363-6.558-7.46 0-4.096 2.892-7.466 6.559-7.466 3.666 0 6.621 3.364 6.558 7.466.006 4.097-2.892 7.46-6.558 7.46zm24.237 0c-3.603 0-6.558-3.363-6.558-7.46 0-4.096 2.892-7.466 6.558-7.466 3.667 0 6.622 3.364 6.558 7.466 0 4.097-2.891 7.46-6.558 7.46zM98.03 26.17h15.663c3.776 0 6.966.604 9.583 1.806 2.61 1.201 4.567 2.877 5.864 5.022 1.296 2.145 1.95 4.6 1.95 7.367 0 2.707-.677 5.163-2.031 7.36-1.354 2.204-3.414 3.944-6.185 5.228-2.771 1.283-6.203 1.928-10.305 1.928h-14.54V26.17zm14.378 21.414c2.542 0 4.499-.65 5.864-1.945 1.366-1.301 2.049-3.071 2.049-5.316 0-2.08-.609-3.739-1.825-4.98-1.216-1.243-3.058-1.87-5.52-1.87h-4.9v14.111h4.332zM154.541 54.846c-2.169-.575-4.126-1.407-5.864-2.503v-6.81c1.314 1.038 3.075 1.893 5.284 2.567 2.209.668 4.344 1.002 6.409 1.002.964 0 1.693-.128 2.186-.386.494-.258.741-.569.741-.926 0-.41-.132-.75-.402-1.026-.27-.275-.792-.504-1.566-.697l-4.82-1.108c-2.76-.656-4.717-1.565-5.881-2.73-1.165-1.161-1.745-2.685-1.745-4.572 0-1.588.505-2.965 1.527-4.143 1.015-1.178 2.461-2.087 4.337-2.725 1.877-.645 4.068-.967 6.587-.967 2.249 0 4.309.246 6.186.738 1.876.492 3.425 1.12 4.659 1.887v6.44c-1.263-.767-2.709-1.37-4.361-1.828a19.138 19.138 0 00-5.084-.674c-2.519 0-3.775.44-3.775 1.313 0 .41.195.715.585.92.39.205 1.107.416 2.146.639l4.016.738c2.623.463 4.579 1.278 5.864 2.438 1.286 1.16 1.928 2.878 1.928 5.152 0 2.49-1.061 4.465-3.19 5.93-2.129 1.465-5.147 2.198-9.06 2.198a26.36 26.36 0 01-6.707-.867zM182.978 53.984c-2.3-1.149-4.039-2.708-5.198-4.677-1.159-1.969-1.744-4.184-1.744-6.645 0-2.462.602-4.665 1.807-6.605 1.205-1.94 2.972-3.464 5.302-4.571 2.329-1.108 5.112-1.659 8.354-1.659 4.016 0 7.35.862 10.001 2.585v7.507c-.935-.656-2.026-1.19-3.271-1.6-1.245-.41-2.576-.615-3.999-.615-2.49 0-4.435.463-5.841 1.395-1.406.931-2.111 2.144-2.111 3.65 0 1.477.682 2.685 2.048 3.634 1.366.944 3.345 1.418 5.944 1.418 1.337 0 2.657-.2 3.959-.592 1.297-.398 2.416-.885 3.351-1.459v7.261c-2.943 1.805-6.357 2.707-10.242 2.707-3.27-.011-6.059-.586-8.36-1.734zM211.518 53.984c-2.318-1.148-4.085-2.72-5.302-4.718-1.216-1.998-1.83-4.225-1.83-6.686 0-2.462.608-4.66 1.83-6.587 1.222-1.928 2.978-3.44 5.285-4.536 2.3-1.096 5.049-1.641 8.233-1.641 3.185 0 5.933.545 8.234 1.64 2.301 1.097 4.057 2.597 5.262 4.513 1.205 1.917 1.807 4.114 1.807 6.605 0 2.461-.602 4.688-1.807 6.687-1.205 1.998-2.967 3.569-5.285 4.717-2.318 1.149-5.055 1.723-8.216 1.723-3.162 0-5.899-.568-8.211-1.717zm12.204-7.279c.976-.996 1.469-2.314 1.469-3.955s-.488-2.948-1.469-3.915c-.975-.973-2.307-1.46-3.993-1.46-1.716 0-3.059.487-4.04 1.46-.975.973-1.463 2.274-1.463 3.915 0 1.64.488 2.96 1.463 3.956.976.996 2.324 1.5 4.04 1.5 1.686-.006 3.018-.504 3.993-1.5zM259.17 31.34v8.86c-1.021-.685-2.341-1.025-3.976-1.025-2.141 0-3.793.662-4.941 1.986-1.153 1.325-1.727 3.388-1.727 6.177v7.548h-9.84V30.888h9.64v7.63c.533-2.79 1.4-4.846 2.593-6.176 1.188-1.325 2.725-1.987 4.596-1.987 1.417 0 2.634.328 3.655.985zM291.864 25.35v29.537h-9.841v-5.374c-.832 2.022-2.094 3.563-3.792 4.618-1.699 1.049-3.799 1.576-6.289 1.576-2.226 0-4.165-.55-5.824-1.658-1.658-1.108-2.937-2.626-3.838-4.554-.895-1.928-1.349-4.108-1.349-6.546-.028-2.514.448-4.77 1.429-6.769.976-1.998 2.358-3.557 4.137-4.676 1.779-1.12 3.81-1.682 6.088-1.682 4.688 0 7.832 2.08 9.438 6.235V25.35h9.841zm-11.309 21.191c1.004-.996 1.503-2.29 1.503-3.873 0-1.53-.488-2.778-1.463-3.733-.976-.956-2.313-1.436-3.994-1.436-1.658 0-2.983.486-3.976 1.46-.993.972-1.486 2.232-1.486 3.79 0 1.56.493 2.831 1.486 3.816.993.984 2.301 1.477 3.936 1.477 1.658-.006 2.989-.504 3.994-1.5zM139.382 33.443c2.709 0 4.906-2.015 4.906-4.5 0-2.486-2.197-4.501-4.906-4.501-2.71 0-4.906 2.015-4.906 4.5 0 2.486 2.196 4.501 4.906 4.501zM134.472 36.544c3.006 1.324 6.736 1.383 9.811 0v18.471h-9.811V36.544z"></path></g></g><defs><clipPath id="clip0"><path fill="#fff" transform="translate(0 11.765)" d="M0 0h292v56.471H0z"></path></clipPath><clipPath id="clip1"><path fill="#fff" transform="translate(0 11.765)" d="M0 0h292v56.471H0z"></path></clipPath></defs></svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>`
});

const transcodeView = Vue.component('transcode-view', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      paramsTS: ADMINDATA.transcodeParamsUpdated,
      downloadPending: ADMINDATA.downloadPending,
    };
  },
  template: `
    <div class="container">
      <div class="row logo-row">
        <h4>{{ t('admin.transcode.poweredBy') }}</h4>
        <?xml version="1.0" encoding="UTF-8" standalone="no"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink" height="120" viewBox="0 0 224.44334 60.186738" version="1.1">
          <defs>
            <radialGradient id="a" gradientUnits="userSpaceOnUse" cy="442.72311" cx="-122.3936" gradientTransform="matrix(1,0,0,-1,134.4463,453.7334)" r="29.5804">
              <stop stop-color="#fff" offset="0"/>
              <stop stop-color="#007808" offset="1"/>
            </radialGradient>
          </defs>
          <g>
            <polygon points="0.511 12.364 0.511 5.078 5.402 6.763 5.402 13.541" fill="#0b4819"/>
            <polygon points="4.455 42.317 4.455 15.226 9.13 16.215 9.13 41.393" fill="#0b4819"/>
            <polygon points="27.321 5.066 15.306 18.846 15.306 24.71 33.126 4.617 61.351 2.432 19.834 45.706 25.361 45.997 55.516 15.154 55.516 44.305 52.166 47.454 60.662 47.913 60.662 55.981 34.012 53.917 47.597 40.738 47.597 34.243 28.175 53.465 4.919 51.667 42.222 11.55 36.083 11.882 9.13 41.393 9.13 16.215 11.683 13.201 5.402 13.541 5.402 6.763" fill="#105c80"/>
            <polygon points="4.455 15.226 7.159 11.971 11.683 13.201 9.13 16.215" fill="#0b4819"/>
            <polygon points="11.004 18.039 15.306 18.846 15.306 24.71 11.004 24.358" fill="#084010"/>
            <polygon points="15.82 47.006 19.834 45.706 25.361 45.997 21.714 47.346" fill="#0c541e"/>
            <polygon points="23.808 3.106 27.321 5.066 15.306 18.846 11.004 18.039" fill="#1a5c34"/>
            <polygon points="11.004 24.358 30.022 2.58 33.126 4.617 15.306 24.71" fill="#0b4819"/>
            <polygon points="33.195 10.432 36.083 11.882 9.13 41.393 4.455 42.317" fill="#1a5c34"/>
            <polygon points="0 53.344 39.798 10.042 42.222 11.55 4.919 51.667" fill="#0b4819"/>
            <polygon points="45.597 34.677 47.597 34.243 28.175 53.465 24.721 55.437" fill="#1a5c34"/>
            <polygon points="45.597 41.737 45.597 34.677 47.597 34.243 47.597 40.738" fill="#0b4819"/>
            <polygon points="30.973 55.965 45.597 41.737 47.597 40.738 34.012 53.917" fill="#0b4819"/>
            <polygon points="54.168 45.648 50.538 49.059 52.166 47.454 55.516 44.305" fill="#13802d"/>
            <polygon points="21.714 47.346 54.168 13.9 55.516 15.154 25.361 45.997" fill="#0b4819"/>
            <polygon points="54.168 13.9 55.516 15.154 55.516 44.305 54.168 45.648" fill="#084010"/>
            <polygon points="59.759 49.604 60.662 47.913 60.662 55.981 59.759 58.403" fill="#084010"/>
            <polygon points="60.507 0 61.351 2.432 19.834 45.706 15.82 47.006" fill="#1a5c34"/>
            <polygon points="23.808 3.106 11.004 18.039 11.004 24.358 30.022 2.58 60.507 0 15.82 47.006 21.714 47.346 54.168 13.9 54.168 45.648 50.538 49.059 59.759 49.604 59.759 58.403 30.973 55.965 45.597 41.737 45.597 34.677 24.721 55.437 0 53.344 39.798 10.042 33.195 10.432 4.455 42.317 4.455 15.226 7.159 11.971 0.511 12.364 0.511 5.078" fill="url(#a)"/>
          </g>
          <g transform="matrix(2.6160433,0,0,2.6160433,70,-145)">
            <polygon points="2.907 66.777 6.825 66.777 6.825 69.229 2.907 69.229 2.907 74.687 0.797 74.687 0.797 74.688 0.797 61.504 8.218 61.504 8.218 63.965 2.907 63.965"/>
            <polygon points="11.13 66.777 15.049 66.777 15.049 69.229 11.13 69.229 11.13 74.687 9.021 74.687 9.021 74.688 9.021 61.504 16.442 61.504 16.442 63.965 11.13 63.965"/>
            <path d="m19.69 69.063v5.625h-2.461v-8.534l2.461-0.264v0.782c0.551-0.517 1.254-0.773 2.109-0.773 1.113 0 1.963 0.337 2.549 1.011 0.645-0.674 1.611-1.011 2.9-1.011 1.113 0 1.963 0.337 2.549 1.011 0.586 0.675 0.879 1.45 0.879 2.329v5.449h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.691-0.491-1.283-0.51-0.486 0.035-0.908 0.357-1.266 0.967-0.029 0.183-0.044 0.366-0.044 0.555v5.186h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.689-0.492-1.281-0.511-0.539 0.034-1.005 0.394-1.398 1.08z"/>
            <path d="m31.913 78.379v-12.225l2.461-0.264v0.703c0.656-0.47 1.301-0.703 1.934-0.703 1.348 0 2.417 0.438 3.208 1.317 0.791 0.88 1.187 1.904 1.187 3.076s-0.396 2.197-1.187 3.076-1.86 1.318-3.208 1.318c-0.879-0.06-1.523-0.296-1.934-0.712v4.421l-2.461-0.007zm2.461-8.885v1.425c0.117 0.983 0.732 1.562 1.846 1.73 1.406-0.111 2.197-0.841 2.373-2.188-0.059-1.642-0.85-2.49-2.373-2.55-1.114 0.176-1.729 0.704-1.846 1.583z"/>
            <path d="m41.094 70.293c0-1.289 0.41-2.345 1.23-3.164 0.82-0.82 1.875-1.23 3.164-1.23s2.314 0.41 3.076 1.23c0.762 0.819 1.143 1.875 1.143 3.164v0.879h-6.064c0.059 0.469 0.264 0.835 0.615 1.099s0.762 0.396 1.23 0.396c0.82 0 1.553-0.233 2.197-0.702l1.406 1.405c-0.645 0.879-1.846 1.318-3.604 1.318-1.289 0-2.344-0.41-3.164-1.23s-1.229-1.875-1.229-3.165zm5.625-1.977c-0.352-0.264-0.762-0.396-1.23-0.396s-0.879 0.132-1.23 0.396-0.527 0.63-0.527 1.099h3.516c-0.002-0.469-0.178-0.835-0.529-1.099z"/>
            <path d="m59.037 66.163v7.822c0 1.23-0.366 2.259-1.099 3.085s-1.655 1.263-2.769 1.311l-0.527 0.053c-1.699-0.035-3.018-0.521-3.955-1.459l1.143-1.318c0.645 0.47 1.427 0.732 2.347 0.791 0.938 0 1.572-0.22 1.902-0.659 0.332-0.438 0.497-0.923 0.497-1.449v-0.439c-0.656 0.527-1.418 0.791-2.285 0.791-1.348 0-2.358-0.396-3.032-1.187s-1.011-1.86-1.011-3.208c0-1.289 0.366-2.345 1.099-3.164 0.733-0.82 1.772-1.23 3.12-1.23 0.996 0.06 1.699 0.325 2.109 0.8v-0.8l2.461 0.26zm-2.461 4.921v-1.424c-0.117-0.983-0.732-1.562-1.846-1.73-1.465 0.053-2.256 0.782-2.373 2.188 0.059 1.642 0.85 2.49 2.373 2.55 1.114-0.177 1.729-0.705 1.846-1.584z"/>
          </g>
        </svg>
      </div>
      <div v-if="paramsTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.transcode.settings') }}</span>
              <table>
                <tbody>
                  <tr>
                    <td><b>FFmpeg Directory:</b> {{params.ffmpegDirectory}}</td>
                    <td>
                      [<a v-on:click="changeFolder()">{{ t('admin.settings.edit') }}</a>]
                    </td>
                  </tr>
                  <tr>
                    <td><b>FFmpeg Downloaded:</b> {{downloadPending.val === true ? 'pending...' : params.downloaded}}</td>
                    <td>
                      [<a v-on:click="downloadFFMpeg()">download</a>]
                    </td>
                  </tr>
                  <tr>
                    <td><b>Default Codec:</b> {{params.defaultCodec}}</td>
                    <td>
                      [<a v-on:click="changeCodec()">{{ t('admin.settings.edit') }}</a>]
                    </td>
                  </tr>
                  <tr>
                    <td><b>Default Bitrate:</b> {{params.defaultBitrate}}</td>
                    <td>
                      [<a v-on:click="changeBitrate()">{{ t('admin.settings.edit') }}</a>]
                    </td>
                  </tr>
                  <tr>
                    <td><b title="Automatically update the managed ffmpeg build on a weekly check. Disable to pin the current binary — useful if a rolling upstream build regresses, or for reproducible/air-gapped installs. No effect when running off system ffmpeg.">Auto-Update FFmpeg:</b> {{params.autoUpdate ? 'on' : 'off'}}</td>
                    <td>
                      [<a v-on:click="toggleAutoUpdate()">{{ params.autoUpdate ? 'disable' : 'enable' }}</a>]
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    changeCodec: function() {
      modVM.currentViewModal = 'edit-transcode-codec-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    changeBitrate: function() {
      modVM.currentViewModal = 'edit-transcode-bitrate-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    toggleAutoUpdate: async function() {
      const next = !this.params.autoUpdate;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/auto-update`,
          data: { autoUpdate: next }
        });
        Vue.set(ADMINDATA.transcodeParams, 'autoUpdate', next);
        iziToast.success({
          title: next ? 'FFmpeg auto-update enabled' : 'FFmpeg auto-update disabled',
          position: 'topCenter',
          timeout: 2500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to change auto-update setting',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    downloadFFMpeg: async function() {
      if (this.downloadPending.val === true) {
        return;
      }

      try {
        this.downloadPending.val = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/download`,
        });
        Vue.set(ADMINDATA.transcodeParams, 'downloaded', true);
        iziToast.success({
          title: t('admin.transcode.ffmpegDownloaded'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: t('admin.transcode.ffmpegFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.downloadPending.val = false;
      }
    },
    changeFolder: function() {
      iziToast.warning({
        title: t('admin.transcode.comingSoon'),
        position: 'topCenter',
        timeout: 3500
      });
    }
  }
});

// ── Federation ──────────────────────────────────────────────────────
// Ticket-paired read-only library sharing between mStream servers over
// a dedicated iroh endpoint. Three cards: status/toggle, keys this
// server minted (with their swap-ready tickets), and peers this server
// can read. Same hardcoded-English style as the iroh Quick Connect
// panel above.
const federationView = Vue.component('federation-view', {
  data() {
    return {
      fedTS: ADMINDATA.federationParamsUpdated,
      fed: ADMINDATA.federationParams,
      keys: ADMINDATA.federationKeys,
      peers: ADMINDATA.federationPeers,
      togglePending: false,
      // Add-peer form state
      peerTicket: '',
      peerName: '',
      addPeerPending: false,
      // Per-row pending flags (Vue.set'd by id)
      rowPending: {},
    };
  },
  computed: {
    // Client-side preview of a pasted ticket: decode mstrfed1:<base64url(JSON)>
    // just enough to show who/what before the admin commits. Parse errors
    // return null and the UI shows a gentle "doesn't look right" hint.
    peerPreview() {
      const s = this.peerTicket.trim();
      if (!s) { return null; }
      const m = s.match(/^mstrfed(\d+):(.*)$/s);
      if (!m) { return { error: true }; }
      try {
        const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64));
        if (typeof payload.t !== 'string' || typeof payload.k !== 'string') { return { error: true }; }
        return {
          error: false,
          name: typeof payload.n === 'string' ? payload.n : '(unnamed server)',
          libraries: Array.isArray(payload.l) ? payload.l : [],
        };
      } catch (e) {
        return { error: true };
      }
    },
  },
  methods: {
    refresh() {
      ADMINDATA.getFederation();
      ADMINDATA.getFederationKeys();
      ADMINDATA.getFederationPeers();
    },
    setRowPending(id, val) { Vue.set(this.rowPending, id, val); },
    async toggle() {
      this.togglePending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/federation`, data: { enabled: !this.fed.enabled } });
        await ADMINDATA.getFederation();
        await ADMINDATA.getFederationKeys(); // tickets appear/disappear with the endpoint
        if (this.fed.enabled && this.fed.available === false) {
          iziToast.warning({ title: 'Unavailable', message: 'Iroh has no prebuilt binary for this server’s platform; the federation endpoint could not start.' });
        }
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to update the federation setting.' });
      }
      this.togglePending = false;
    },
    openNewTicketModal() {
      modVM.currentViewModal = 'federation-new-ticket-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    async revokeKey(key) {
      this.setRowPending(key.id, true);
      try {
        await API.axios({ method: 'DELETE', url: `${API.url()}/api/v1/admin/federation/keys/${key.id}` });
        await ADMINDATA.getFederationKeys();
        iziToast.success({ title: 'Revoked', message: `'${key.name}' can no longer read this server.`, position: 'topCenter', timeout: 3500 });
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to revoke the key.' });
      }
      this.setRowPending(key.id, false);
    },
    async resetBinding(key) {
      this.setRowPending(key.id, true);
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/federation/keys/${key.id}/reset-binding` });
        await ADMINDATA.getFederationKeys();
        iziToast.success({ title: 'Binding reset', message: 'The next server to redeem this ticket claims it again.', position: 'topCenter', timeout: 3500 });
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to reset the binding.' });
      }
      this.setRowPending(key.id, false);
    },
    async addPeer() {
      this.addPeerPending = true;
      try {
        const data = { ticket: this.peerTicket.trim() };
        if (this.peerName.trim()) { data.name = this.peerName.trim(); }
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/federation/peers`, data });
        this.peerTicket = '';
        this.peerName = '';
        await ADMINDATA.getFederationPeers();
        iziToast.success({ title: 'Peer added', message: 'Testing the connection in the background…', position: 'topCenter', timeout: 3500 });
        // The async first health check lands a moment later; refresh the dots.
        setTimeout(() => ADMINDATA.getFederationPeers(), 4000);
      } catch (e) {
        iziToast.error({ title: 'Error', message: (e.response && e.response.data && e.response.data.error) || 'Failed to add the peer.' });
      }
      this.addPeerPending = false;
    },
    async testPeer(peer) {
      this.setRowPending(peer.id, true);
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/federation/peers/${peer.id}/test` });
        await ADMINDATA.getFederationPeers();
        if (res.data.ok) {
          iziToast.success({ title: 'Connected', message: `'${peer.name}' shares: ${res.data.health.libraries.join(', ') || '(nothing)'}`, position: 'topCenter', timeout: 3500 });
        } else {
          iziToast.warning({ title: 'Unreachable', message: res.data.error, position: 'topCenter', timeout: 3500 });
        }
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Test failed.' });
      }
      this.setRowPending(peer.id, false);
    },
    async removePeer(peer) {
      this.setRowPending(peer.id, true);
      try {
        await API.axios({ method: 'DELETE', url: `${API.url()}/api/v1/admin/federation/peers/${peer.id}` });
        await ADMINDATA.getFederationPeers();
        iziToast.success({ title: 'Removed', message: `'${peer.name}' forgotten.`, position: 'topCenter', timeout: 3500 });
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to remove the peer.' });
      }
      this.setRowPending(peer.id, false);
    },
    async toggleDiscovery(peer) {
      this.setRowPending(peer.id, true);
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/federation/peers/${peer.id}/discovery`,
          data: { enabled: peer.use_discovery !== 1 },
        });
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to update the peer.' });
      }
      // Refresh either way so the checkbox always mirrors the server's truth.
      await ADMINDATA.getFederationPeers();
      this.setRowPending(peer.id, false);
    },
    statusDot(peer) {
      if (peer.last_status === 'ok') { return '#2e7d32'; }
      if (peer.last_status) { return '#c62828'; }
      return '#9e9e9e';
    },
    fmtDate(s) { return s ? s.replace('T', ' ').slice(0, 16) : '—'; },
  },
  mounted() { this.refresh(); },
  template: `
    <div v-if="fedTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Federation</span>
              <p>Pair with a friend's mStream server to share libraries <b>read-only</b>, peer-to-peer and end-to-end encrypted — no port-forwarding or DNS. You mint a ticket for the libraries you want to share; your friend pastes it into their Peers list (and mints one for you if the sharing is mutual). Distributed backups between paired servers build on this.</p>
              <div v-if="fed.available === false" class="card-panel orange lighten-4" style="margin-top:16px">
                <p><b>Not available on this platform.</b> The Iroh native component has no prebuilt binary for this server’s OS/CPU, so the federation endpoint can’t run here.</p>
              </div>
              <p><b>Tickets are credentials.</b> Anyone holding an unredeemed ticket can read the libraries it grants — send tickets over a private channel. The first server to use a ticket claims it; revoke a ticket at any time to cut access.</p>
              <p style="margin-top:8px" v-if="fed.enabled && fed.running"><b>Status:</b>
                <span style="color:#2e7d32">On{{ fed.online ? ' · connected to relay' : ' · connecting…' }}</span>
                <span style="word-break:break-all;font-family:monospace;font-size:0.8em;display:block">{{ fed.endpointId }}</span>
              </p>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="toggle()" :class="{disabled: togglePending}" class="waves-effect waves-light btn right">
                {{ fed.enabled ? 'Turn Off' : 'Turn On' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div v-if="fed.enabled" class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Shared Libraries — Tickets You Minted</span>
              <p style="font-size:0.9em;color:#777">Each ticket is a read-only grant for the libraries you picked. Copy it and send it to the friend it's for.</p>
              <table v-if="keys.list.length > 0" class="striped">
                <thead><tr><th>Name</th><th>Libraries</th><th>Last used</th><th>Redeemed</th><th style="width:280px"></th></tr></thead>
                <tbody>
                  <tr v-for="k in keys.list" :key="k.id">
                    <td>{{ k.name }}</td>
                    <td>{{ k.library_names.join(', ') }}</td>
                    <td>{{ fmtDate(k.last_used) }}</td>
                    <td>
                      <span v-if="k.bound_endpoint_id" style="color:#2e7d32">✔ claimed</span>
                      <span v-else style="color:#9e9e9e">not yet</span>
                    </td>
                    <td class="right-align">
                      <a v-if="k.ticket" class="btn-flat btn-small waves-effect fed-copy-button" :data-clipboard-text="k.ticket" title="Copy the ticket to send to your friend">Copy ticket</a>
                      <a v-if="k.bound_endpoint_id" class="btn-flat btn-small waves-effect" :class="{disabled: rowPending[k.id]}" v-on:click="resetBinding(k)" title="Friend reinstalled? Let the ticket be claimed again.">Reset</a>
                      <a class="btn-small red lighten-1 waves-effect" :class="{disabled: rowPending[k.id]}" v-on:click="revokeKey(k)">Revoke</a>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else style="color:#777">No tickets yet.</p>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="openNewTicketModal()" class="waves-effect waves-light btn right">New Ticket</a>
            </div>
          </div>
        </div>
      </div>

      <div v-if="fed.enabled" class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Peers — Servers You Can Read</span>
              <table v-if="peers.list.length > 0" class="striped">
                <thead><tr><th></th><th>Name</th><th>Status</th><th>Last seen</th><th>Discovery</th><th style="width:200px"></th></tr></thead>
                <tbody>
                  <tr v-for="p in peers.list" :key="p.id">
                    <td><span :style="{color: statusDot(p)}" style="font-size:1.4em">●</span></td>
                    <td>{{ p.name }}</td>
                    <td style="font-size:0.85em">{{ p.last_status || 'never tested' }}</td>
                    <td>{{ fmtDate(p.last_seen) }}</td>
                    <td>
                      <label title="Let the Discover panel ask this peer for similar music. Queries reveal what you're listening to — to this peer only.">
                        <input type="checkbox" :checked="p.use_discovery === 1" :disabled="rowPending[p.id]" v-on:change="toggleDiscovery(p)"/>
                        <span></span>
                      </label>
                    </td>
                    <td class="right-align">
                      <a class="btn-flat btn-small waves-effect" :class="{disabled: rowPending[p.id]}" v-on:click="testPeer(p)">Test</a>
                      <a class="btn-small red lighten-1 waves-effect" :class="{disabled: rowPending[p.id]}" v-on:click="removePeer(p)">Remove</a>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else style="color:#777">No peers yet — paste a friend's ticket below.</p>
              <div style="margin-top:16px">
                <div class="input-field">
                  <textarea id="fed-peer-ticket" class="materialize-textarea" v-model="peerTicket" placeholder="Paste a federation ticket (mstrfed1:…)"></textarea>
                </div>
                <div v-if="peerPreview && peerPreview.error" style="color:#c62828;font-size:0.9em">That doesn't look like a federation ticket.</div>
                <div v-if="peerPreview && !peerPreview.error" class="card-panel green lighten-5" style="padding:10px">
                  <b>{{ peerPreview.name }}</b>
                  <span v-if="peerPreview.libraries.length"> — shares: {{ peerPreview.libraries.join(', ') }}</span>
                </div>
                <div class="input-field" style="max-width:320px">
                  <input id="fed-peer-name" type="text" v-model="peerName" placeholder="Optional display name"/>
                </div>
                <a v-on:click="addPeer()" :class="{disabled: addPeerPending || !peerPreview || peerPreview.error}" class="waves-effect waves-light btn">Add Peer</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
});



const logsView = Vue.component('logs-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated,
      // Live-log viewer state. logLines holds the rendered tail; lastSeq is
      // the cursor we poll from; paused freezes the feed; autoscroll keeps
      // us pinned to the bottom unless the user scrolls up to read history.
      logLines: [],
      lastSeq: 0,
      paused: false,
      autoscroll: true,
      pollTimer: null
    };
  },
  mounted() {
    this.fetchRecent();
    this.pollTimer = setInterval(() => { this.fetchRecent(); }, 2000);
  },
  beforeDestroy() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.logs.title') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.logs.writeLogs') }}</b> {{ params.writeLogs === true ? t('admin.settings.enabled') : t('admin.settings.disabled') }}</td>
                      <td>
                        [<a v-on:click="toggleWriteLogs">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.logs.logsDirectory') }}</b> {{params.storage.logsDirectory}}</td>
                      <td>
                        [<a v-on:click="changeLogsDir()">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.logs.bufferSize') }}</b> {{ params.logBufferSize === 0 ? t('admin.logs.bufferDisabled') : params.logBufferSize }}</td>
                      <td>
                        [<a v-on:click="openModal('edit-log-buffer-size-modal')">{{ t('admin.settings.edit') }}</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="card-action">
                <a v-on:click="downloadLogs()" class="waves-effect waves-light btn">{{ t('admin.logs.download') }}</a>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">
                  {{ t('admin.logs.liveTitle') }}
                  <span style="font-size:0.55em; vertical-align:middle; margin-left:8px;" :style="{ color: paused ? '#ff9800' : '#4caf50' }">
                    ● {{ paused ? t('admin.logs.paused') : t('admin.logs.live') }}
                  </span>
                </span>
                <div v-if="params.logBufferSize === 0">
                  <blockquote>{{ t('admin.logs.bufferOff') }}</blockquote>
                </div>
                <div v-else>
                  <div style="margin-bottom:10px;">
                    <a v-on:click="togglePause" class="waves-effect waves-light btn-small">{{ paused ? t('admin.logs.resume') : t('admin.logs.pause') }}</a>
                    <a v-on:click="clearLog" class="waves-effect waves-light btn-small grey lighten-1" style="margin-left:6px;">{{ t('admin.logs.clear') }}</a>
                  </div>
                  <div ref="logbox" v-on:scroll="onScroll" style="background:#1e1e1e; color:#d4d4d4; font-family:monospace; font-size:12px; line-height:1.45; height:360px; overflow-y:auto; padding:10px; border-radius:4px; white-space:pre-wrap; word-break:break-word;">
                    <div v-if="logLines.length === 0" style="color:#888;">{{ t('admin.logs.bufferEmpty') }}</div>
                    <div v-for="line in logLines" :key="line.seq" :style="{ color: lineColor(line.level) }">{{ fmtTime(line.t) }} {{ line.level }}: {{ line.message }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    togglePause: function() {
      this.paused = !this.paused;
      // Resuming jumps back to the live tail.
      if (!this.paused) { this.autoscroll = true; this.fetchRecent(); }
    },
    clearLog: function() {
      this.logLines = [];
    },
    fmtTime: function(iso) {
      // ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' -> 'HH:MM:SS'
      return (typeof iso === 'string' && iso.length >= 19) ? iso.slice(11, 19) : '';
    },
    lineColor: function(level) {
      switch (level) {
        case 'error': return '#ff5252';
        case 'warn': return '#ffb74d';
        case 'info': return '#9ccc65';
        case 'debug': return '#90a4ae';
        default: return '#d4d4d4';
      }
    },
    onScroll: function() {
      const el = this.$refs.logbox;
      if (!el) { return; }
      // Stick to the bottom only while the user is already near it, so
      // scrolling up to read history isn't yanked back down by new lines.
      this.autoscroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 30;
    },
    fetchRecent: async function() {
      if (this.paused) { return; }
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/logs/recent?since=${this.lastSeq}`
        });
        // A server restart resets the seq counter; if the server cursor
        // fell below ours the buffer is fresh — drop what we have and reseed.
        if (typeof res.data.lastSeq === 'number' && res.data.lastSeq < this.lastSeq) {
          this.logLines = [];
        }
        const entries = Array.isArray(res.data.entries) ? res.data.entries : [];
        if (entries.length) {
          for (const e of entries) { this.logLines.push(e); }
          // Cap the rendered list so the DOM stays bounded on a busy server.
          const MAXVIEW = 2000;
          if (this.logLines.length > MAXVIEW) {
            this.logLines.splice(0, this.logLines.length - MAXVIEW);
          }
          this.$nextTick(() => {
            const el = this.$refs.logbox;
            if (el && this.autoscroll) { el.scrollTop = el.scrollHeight; }
          });
        }
        if (typeof res.data.lastSeq === 'number') { this.lastSeq = res.data.lastSeq; }
      } catch (_err) { /* transient — next poll retries */ }
    },
    changeLogsDir: function() {
      iziToast.warning({
        title: t('admin.transcode.comingSoon'),
        position: 'topCenter',
        timeout: 3500
      });
    },
    downloadLogs: async function() {
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/logs/download`, //your url
          method: 'GET',
          responseType: 'blob', // important
        });

        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'mstream-logs.zip'); //or any other extension
        document.body.appendChild(link);
        link.click();
      } catch (err) {
        console.log(err)
        iziToast.error({
          title: t('admin.logs.downloadFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    toggleWriteLogs: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>${this.params.writeLogs === true ? t('admin.logs.disableTitle') : t('admin.logs.enableTitle')}</b>`,
        position: 'center',
        buttons: [
          [`<button><b>${this.params.writeLogs === true ? t('admin.settings.disableButton') : t('admin.settings.enableButton')}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/write-logs`,
              data: { writeLogs: !this.params.writeLogs }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.serverParams, 'writeLogs', !this.params.writeLogs);

              iziToast.success({
                title: t('admin.settings.updated'),
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: t('admin.settings.failed'),
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
  }
});

const securityView = Vue.component('security-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated,
      // Local form state, hydrated from serverParams.adminAccess once loaded.
      selectedMode: 'all',
      // Local editable copy of the whitelist so edits aren't committed to the
      // saved config until Apply succeeds.
      whitelistDraft: [],
      newEntry: '',
      applyPending: false,
    };
  },
  watch: {
    'paramsTS.ts': {
      immediate: true,
      handler: function() {
        const aa = this.params.adminAccess || {};
        this.selectedMode = aa.mode || 'all';
        this.whitelistDraft = Array.isArray(aa.whitelist) ? aa.whitelist.slice() : [];
      }
    }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.security.title') }}</span>
              <p>{{ t('admin.security.description') }}</p>
              <div style="margin-top:16px">
                <p><b>{{ t('admin.security.currentMode') }}</b> {{ (params.adminAccess && params.adminAccess.mode) || 'all' }}</p>
              </div>
              <div style="margin-top:20px">
                <p><b>{{ t('admin.security.changeMode') }}</b></p>
                <p>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="all" />
                    <span>{{ t('admin.security.modeAll') }}</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="localhost" />
                    <span>{{ t('admin.security.modeLocalhost') }}</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="whitelist" />
                    <span>{{ t('admin.security.modeWhitelist') }}</span>
                  </label>
                  <label>
                    <input type="radio" v-model="selectedMode" value="none" />
                    <span>{{ t('admin.security.modeNone') }}</span>
                  </label>
                </p>
                <p class="grey-text" style="margin-top:4px">
                  <span v-if="selectedMode === 'all'">{{ t('admin.security.modeAllHint') }}</span>
                  <span v-else-if="selectedMode === 'localhost'">{{ t('admin.security.modeLocalhostHint') }}</span>
                  <span v-else-if="selectedMode === 'whitelist'">{{ t('admin.security.modeWhitelistHint') }}</span>
                  <span v-else-if="selectedMode === 'none'">{{ t('admin.security.modeNoneHint') }}</span>
                </p>
              </div>
              <div v-if="selectedMode === 'whitelist'" style="margin-top:16px">
                <p><b>{{ t('admin.security.whitelistTitle') }}</b></p>
                <p class="grey-text">{{ t('admin.security.whitelistHint') }}</p>
                <table class="striped" style="max-width:480px">
                  <tbody>
                    <tr v-for="(entry, idx) in whitelistDraft" :key="idx">
                      <td>{{ entry }}</td>
                      <td style="text-align:right">[<a v-on:click="removeEntry(idx)">{{ t('admin.security.remove') }}</a>]</td>
                    </tr>
                    <tr v-if="whitelistDraft.length === 0">
                      <td colspan="2" class="grey-text">{{ t('admin.security.whitelistEmpty') }}</td>
                    </tr>
                  </tbody>
                </table>
                <div class="input-field" style="max-width:480px; margin-top:8px">
                  <input id="security-new-entry" type="text" v-model.trim="newEntry"
                         @keyup.enter="addEntry()" :placeholder="t('admin.security.entryPlaceholder')" />
                  <a v-on:click="addEntry()" class="waves-effect waves-light btn-small">{{ t('admin.security.add') }}</a>
                </div>
              </div>
              <div v-if="selectedMode === 'localhost' || selectedMode === 'whitelist'" class="card-panel orange lighten-4" style="margin-top:16px">
                <p><b>{{ t('admin.security.proxyNoticeTitle') }}</b> {{ t('admin.security.proxyNotice') }}</p>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyMode()" :disabled="applyPending"
                 class="waves-effect waves-light btn right">
                {{ t('admin.security.apply') }}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    addEntry: function() {
      const v = (this.newEntry || '').trim();
      if (!v) { return; }
      if (!this.whitelistDraft.includes(v)) {
        this.whitelistDraft.push(v);
      }
      this.newEntry = '';
    },
    removeEntry: function(idx) {
      this.whitelistDraft.splice(idx, 1);
    },
    doApply: async function() {
      const mode = this.selectedMode;
      try {
        this.applyPending = true;
        const data = { mode };
        if (mode === 'whitelist') { data.whitelist = this.whitelistDraft.slice(); }
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/admin-access`,
          data
        });
        // Reflect the saved state back into the shared config. In whitelist
        // mode we just sent the list; otherwise keep whatever was saved.
        const next = {
          mode,
          whitelist: mode === 'whitelist'
            ? this.whitelistDraft.slice()
            : ((this.params.adminAccess && this.params.adminAccess.whitelist) || [])
        };
        Vue.set(ADMINDATA.serverParams, 'adminAccess', next);
        iziToast.success({
          title: t('admin.security.applied'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: err.response?.data?.error || err.message || t('admin.security.applyFailed'),
          position: 'topCenter',
          timeout: 4500
        });
      } finally {
        this.applyPending = false;
      }
    },
    applyMode: function() {
      // 'none' disables the entire admin panel — confirm first, mirroring the
      // old Lock Admin flow.
      if (this.selectedMode === 'none') {
        iziToast.question({
          timeout: 20000,
          close: false,
          overlayClose: true,
          overlay: true,
          displayMode: 'once',
          id: 'security-question',
          zindex: 99999,
          layout: 2,
          maxWidth: 600,
          title: `<b>${t('admin.security.confirmNoneTitle')}</b>`,
          message: t('admin.security.confirmNoneMessage'),
          position: 'center',
          buttons: [
            [`<button><b>${t('admin.security.confirmNoneButton')}</b></button>`, (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              this.doApply();
            }, true],
            [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }],
          ]
        });
        return;
      }
      this.doApply();
    }
  }
});

const dlnaView = Vue.component('dlna-view', {
  data() {
    return {
      paramsTS: ADMINDATA.dlnaParamsUpdated,
      params: ADMINDATA.dlnaParams,
      selectedMode: 'disabled',
      selectedPort: 3011,
      selectedBrowse: 'dirs',
      selectedName: '',
      selectedUuid: '',
      applyPending: false,
      browsePending: false,
      identityPending: false,
    };
  },
  watch: {
    'paramsTS.ts': {
      immediate: true,
      handler: function() {
        this.selectedMode   = this.params.mode   || 'disabled';
        this.selectedPort   = this.params.port   || 3011;
        this.selectedBrowse = this.params.browse || 'dirs';
        this.selectedName   = this.params.name   || '';
        this.selectedUuid   = this.params.uuid   || '';
      }
    }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">DLNA Media Server</span>
              <p>DLNA lets smart TVs, receivers, and other devices on your local network discover and play music from mStream without needing to log in.</p>
              <div style="margin-top:16px">
                <p><b>Current mode:</b> {{params.mode || 'disabled'}}</p>
                <p v-if="params.mode !== 'disabled'"><b>Server name:</b> {{params.name}}</p>
                <p v-if="params.mode !== 'disabled'"><b>UUID:</b> {{params.uuid}}</p>
                <p v-if="params.mode === 'separate-port'"><b>DLNA port:</b> {{params.port}}</p>
              </div>
              <div style="margin-top:20px">
                <p><b>Change mode:</b></p>
                <p>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="disabled" />
                    <span>Disabled</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="same-port" />
                    <span>Same port as mStream</span>
                  </label>
                  <label>
                    <input type="radio" v-model="selectedMode" value="separate-port" />
                    <span>Separate port (recommended)</span>
                  </label>
                </p>
                <div v-if="selectedMode === 'separate-port'" style="margin-top:12px">
                  <div class="input-field" style="max-width:200px">
                    <input id="dlna-port" type="number" v-model.number="selectedPort" min="1" max="65535" />
                    <label for="dlna-port" class="active">DLNA Port</label>
                  </div>
                </div>
              </div>
              <div v-if="selectedMode !== 'disabled'" class="card-panel orange lighten-4" style="margin-top:16px">
                <p><b>Security notice:</b> DLNA exposes your music library to anyone on the local network without authentication.</p>
                <p v-if="selectedMode === 'same-port'" style="margin-top:8px"><b>Note:</b> In same-port mode, media streaming may be blocked for password-protected libraries. Use separate-port mode for full compatibility.</p>
                <p v-if="selectedMode === 'same-port'" style="margin-top:8px"><b>HTTPS notice:</b> DLNA is not compatible with self-signed HTTPS certificates. Most DLNA renderers will refuse the connection.</p>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyMode()" :disabled="applyPending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Identity</span>
              <p>The name renderers display for this server, and its DLNA UUID (the unique id devices use to recognize it). Changing these while DLNA is active re-announces the server on the network so clients pick up the new values; no restart needed.</p>
              <div class="input-field" style="max-width:420px;margin-top:16px">
                <input id="dlna-name" type="text" maxlength="256" v-model.trim="selectedName" />
                <label for="dlna-name" class="active">Server Name</label>
              </div>
              <div class="input-field" style="max-width:420px">
                <input id="dlna-uuid" type="text" v-model.trim="selectedUuid" />
                <label for="dlna-uuid" class="active">UUID</label>
                <span class="helper-text">[<a v-on:click="generateUuid()">generate a new UUID</a>] Changing the UUID makes existing clients re-discover the server as a new device.</span>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyIdentity()" :disabled="identityPending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Default View</span>
              <p>DLNA clients always see all five views (Folders, Artists, Albums, Genres, All Tracks) as sibling containers. This setting controls which one is listed first &mdash; useful for clients that auto-drill into the first container.</p>
              <div style="margin-top:16px">
                <p><b>Current:</b> {{params.browse || 'dirs'}}</p>
              </div>
              <div style="margin-top:16px">
                <p>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedBrowse" value="dirs" />
                    <span>Folders</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedBrowse" value="artist" />
                    <span>Artists</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedBrowse" value="album" />
                    <span>Albums</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedBrowse" value="genre" />
                    <span>Genres</span>
                  </label>
                  <label>
                    <input type="radio" v-model="selectedBrowse" value="flat" />
                    <span>All Tracks</span>
                  </label>
                </p>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyBrowse()" :disabled="browsePending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    generateUuid: function() {
      // Prefer the platform RNG; crypto.randomUUID needs a secure context
      // (https or localhost), so fall back to a v4 builder over plain http.
      let u;
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        u = window.crypto.randomUUID();
      } else {
        u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (window.crypto && window.crypto.getRandomValues
            ? window.crypto.getRandomValues(new Uint8Array(1))[0] & 15
            : Math.floor(Math.random() * 16));
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      this.selectedUuid = u;
    },
    applyIdentity: async function() {
      const name = (this.selectedName || '').trim();
      const uuid = (this.selectedUuid || '').trim();
      if (!name) {
        iziToast.error({ title: 'Server name cannot be empty', position: 'topCenter', timeout: 3500 });
        return;
      }
      const nameChanged = name !== (this.params.name || '');
      const uuidChanged = uuid !== (this.params.uuid || '');
      if (!nameChanged && !uuidChanged) {
        iziToast.info({ title: 'No changes to apply', position: 'topCenter', timeout: 3500 });
        return;
      }
      try {
        this.identityPending = true;
        if (nameChanged) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/dlna/name`,
            data: { name }
          });
        }
        if (uuidChanged) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/dlna/uuid`,
            data: { uuid }
          });
        }
        await ADMINDATA.getDlnaParams();
        iziToast.success({ title: 'DLNA identity updated', position: 'topCenter', timeout: 3500 });
      } catch(err) {
        const msg = err && err.response && err.response.data && err.response.data.error
          ? err.response.data.error : 'Failed to update DLNA identity';
        iziToast.error({ title: msg, position: 'topCenter', timeout: 4000 });
        // Re-sync the inputs so a rejected value doesn't linger in the form.
        await ADMINDATA.getDlnaParams();
      } finally {
        this.identityPending = false;
      }
    },
    applyBrowse: async function() {
      try {
        this.browsePending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/dlna/browse`,
          data: { browse: this.selectedBrowse }
        });
        await ADMINDATA.getDlnaParams();
        const labels = { dirs: 'Folders', artist: 'Artists', flat: 'All Tracks', album: 'Albums', genre: 'Genres' };
        iziToast.success({ title: `Default view set to: ${labels[this.selectedBrowse] || this.selectedBrowse}`, position: 'topCenter', timeout: 3500 });
      } catch(err) {
        iziToast.error({ title: 'Failed to update browse mode', position: 'topCenter', timeout: 3500 });
      } finally {
        this.browsePending = false;
      }
    },
    applyMode: async function() {
      const mode = this.selectedMode;
      const port = this.selectedPort;
      const modeLabels = { disabled: 'Disabled', 'same-port': 'Same Port', 'separate-port': 'Separate Port' };
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'dlna-question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `Set DLNA mode to "${modeLabels[mode] || mode}"?`,
        position: 'center',
        buttons: [
          [`<button><b>Apply</b></button>`, async (instance, toast) => {
            try {
              this.applyPending = true;
              const data = { mode };
              if (mode === 'separate-port') { data.port = port; }
              await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/dlna/mode`,
                data
              });
              await ADMINDATA.getDlnaParams();
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              iziToast.success({
                title: `DLNA mode set to ${modeLabels[mode] || mode}`,
                position: 'topCenter',
                timeout: 3500
              });
            } catch(err) {
              iziToast.error({ title: 'Failed to update DLNA setting', position: 'topCenter', timeout: 3500 });
            } finally {
              this.applyPending = false;
            }
          }, true],
          [`<button>Cancel</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    }
  }
});

const subsonicView = Vue.component('subsonic-view', {
  data() {
    return {
      paramsTS: ADMINDATA.subsonicParamsUpdated,
      params: ADMINDATA.subsonicParams,
      selectedMode: 'disabled',
      selectedPort: 3012,
      applyPending: false,
      // API keys — the state lives in ADMINDATA so every view sees a fresh
      // list, but we reach in locally for the inputs driving this form.
      apiKeysTS:  ADMINDATA.apiKeysUpdated,
      apiKeys:    ADMINDATA.apiKeys,
      newKeyName: '',
      mintPending: false,
      lastMintedKey: ADMINDATA.lastMintedKey,
      // Polish widgets — stats / now-playing / jukebox / token-auth log.
      statsTS:            ADMINDATA.subsonicStatsUpdated,
      stats:              ADMINDATA.subsonicStats,
      jukeboxTS:          ADMINDATA.jukeboxStatusUpdated,
      jukebox:            ADMINDATA.jukeboxStatus,
      tokenAttemptsTS:    ADMINDATA.tokenAuthAttemptsUpdated,
      tokenAttempts:      ADMINDATA.tokenAuthAttempts,
      testResult:         null,
      testPending:        false,
      showMethodList:     false,
      // Transient success message shown next to the purge buttons.
      lyricsCachePurgeMsg: null,
      // One-time display for admin-minted-on-behalf-of keys. Mirrors
      // `lastMintedKey` but carries the target username too.
      adminMintedForUser: { val: null, name: null, username: null },
      pollTimer:          null,
    };
  },

  mounted() {
    // Refresh the live widgets every 5s so now-playing / jukebox state
    // stays fresh without the admin reloading the page. Stopped on unmount.
    this.pollTimer = setInterval(() => {
      ADMINDATA.getSubsonicStats();
      ADMINDATA.getJukeboxStatus();
      ADMINDATA.getTokenAuthAttempts();
    }, 5000);
  },
  beforeDestroy() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },
  watch: {
    'paramsTS.ts': {
      immediate: true,
      handler: function() {
        this.selectedMode = this.params.mode || 'disabled';
        this.selectedPort = this.params.port || 3012;
      }
    }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Subsonic REST API</span>
              <p>The Subsonic API lets you use third-party music apps &mdash; DSub, Symfonium, Substreamer, play:Sub, Feishin, Sonixd, and many others &mdash; as clients for your mStream library. Each user signs in with their mStream username and password (or an API key they generate on their profile) from inside the client app.</p>
              <div style="margin-top:16px">
                <p><b>Current mode:</b> {{params.mode || 'disabled'}}</p>
                <p v-if="params.mode === 'separate-port'"><b>Subsonic port:</b> {{params.port}}</p>
              </div>
              <div style="margin-top:20px">
                <p><b>Change mode:</b></p>
                <p>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="disabled" />
                    <span>Disabled</span>
                  </label>
                  <label style="margin-right:20px">
                    <input type="radio" v-model="selectedMode" value="same-port" />
                    <span>Same port as mStream</span>
                  </label>
                  <label>
                    <input type="radio" v-model="selectedMode" value="separate-port" />
                    <span>Separate port</span>
                  </label>
                </p>
                <div v-if="selectedMode === 'separate-port'" style="margin-top:12px">
                  <div class="input-field" style="max-width:200px">
                    <input id="subsonic-port" type="number" v-model.number="selectedPort" min="1" max="65535" />
                    <label for="subsonic-port" class="active">Subsonic Port</label>
                  </div>
                </div>
              </div>
              <div v-if="selectedMode !== 'disabled'" class="card-panel orange lighten-4" style="margin-top:16px">
                <p><b>Security notice:</b> Subsonic clients authenticate with your mStream user credentials. For best security, enable HTTPS before exposing the Subsonic API to untrusted networks, and use an API key in each client instead of sharing your password.</p>
                <p style="margin-top:8px">Mint and revoke API keys in the section below. Token-style auth (<code>t=</code>, <code>s=</code>) is not supported &mdash; use plaintext over HTTPS, or an API key.</p>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyMode()" :disabled="applyPending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Methods implemented + test connection -->
      <div v-if="params.mode !== 'disabled'" class="row">
        <div class="col s12 m6">
          <div class="card">
            <div class="card-content">
              <span class="card-title">API Surface</span>
              <p style="font-size:32px;font-weight:300;margin:8px 0">
                {{stats.methodsImplemented || '—'}}
                <span style="font-size:14px;color:#777;font-weight:400">
                  Subsonic methods implemented
                </span>
              </p>
              <p v-if="stats.fullCount != null" style="color:#777;margin:0 0 4px">
                <small>{{stats.fullCount}} fully implemented &middot; {{stats.stubCount}} stubbed (empty response — real feature not backed)</small>
              </p>
              <p style="color:#777"><small>Subsonic 1.16.1 + OpenSubsonic defines roughly 70 methods. The ones this server does not implement at all return a "method not found" error — see the decline list in docs/subsonic-phase3.md.</small></p>
              <a v-on:click="showMethodList = !showMethodList" class="btn-flat waves-effect" style="padding:0 8px">
                {{showMethodList ? 'Hide' : 'Show'}} method list
              </a>
              <div v-if="showMethodList" style="margin-top:12px;max-height:220px;overflow-y:auto;background:#f5f5f5;padding:8px;border-radius:4px;font-family:monospace;font-size:12px">
                <!-- New shape: per-method {name, status}. Fall back to the
                     plain list on older server builds that don't emit it. -->
                <div v-if="stats.methodStatuses && stats.methodStatuses.length">
                  <div v-for="m in stats.methodStatuses" :key="m.name">
                    <span v-if="m.status === 'stub'"
                          style="display:inline-block;min-width:42px;background:#f0ad4e;color:#fff;padding:0 4px;border-radius:2px;margin-right:6px;font-size:10px;text-align:center;vertical-align:1px">STUB</span>
                    <span v-else
                          style="display:inline-block;min-width:42px;background:#5cb85c;color:#fff;padding:0 4px;border-radius:2px;margin-right:6px;font-size:10px;text-align:center;vertical-align:1px">FULL</span>
                    {{m.name}}
                  </div>
                </div>
                <div v-else>
                  <div v-for="m in stats.methods" :key="m">{{m}}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="col s12 m6">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Test Connection</span>
              <p>Make a ping request against the running Subsonic endpoint as if a client were connecting. Useful for verifying a mode change took effect.</p>
              <a v-on:click="runTest()" :disabled="testPending"
                 class="waves-effect waves-light btn" style="margin-top:8px">
                {{testPending ? 'Testing…' : 'Test Connection'}}
              </a>
              <div v-if="testResult" style="margin-top:16px" :class="testResult.ok ? 'card-panel green lighten-4' : 'card-panel red lighten-4'">
                <p><b>{{testResult.ok ? 'OK' : 'Failed'}}</b>
                  <span v-if="testResult.ok"> — {{testResult.latencyMs}}ms, server v{{testResult.serverVersion}}</span>
                  <span v-else> — {{testResult.reason || testResult.status || 'unknown error'}}</span>
                </p>
                <p v-if="testResult.url" style="margin-top:6px"><small><code>{{testResult.url}}</code></small></p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Now-playing strip -->
      <div v-if="params.mode !== 'disabled'" class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Now Playing</span>
              <p v-if="stats.nowPlaying.length === 0" style="color:#777"><i>Nobody is streaming right now.</i></p>
              <table v-else class="striped">
                <thead>
                  <tr><th>User</th><th>Track</th><th>Artist</th><th>Album</th><th>Since</th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in stats.nowPlaying" :key="p.username + ':' + p.trackId">
                    <td><b>{{p.username}}</b></td>
                    <td>{{p.title || '(unknown title)'}}</td>
                    <td>{{p.artist || '—'}}</td>
                    <td>{{p.album || '—'}}</td>
                    <td><small>{{formatSince(p.sinceMs)}}</small></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Lyrics cache ledger (read-only). Lyrics are filled by the proactive
           backfill worker now, configured in the dedicated "Lyrics" admin
           section — this card only surfaces the cache / cooldown ledger and a
           purge control. Visible regardless of Subsonic mode because the
           ledger is shared by every lyrics path. -->
      <div v-if="stats.lyrics" class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Lyrics Cache</span>
              <p>
                Lyrics are fetched ahead of time by the proactive backfill worker.
                Enable it, choose providers, and toggle sidecar writing in the
                <b>Lyrics</b> admin section. This card just shows the read-only
                cache / cooldown ledger that the worker keeps.
              </p>
              <table v-if="stats.lyrics.cache" style="max-width:400px">
                <tbody>
                  <tr><td><b>Cached hits</b></td>  <td>{{stats.lyrics.cache.hit}}</td></tr>
                  <tr><td><b>Cached misses</b></td><td>{{stats.lyrics.cache.miss}}</td></tr>
                  <tr><td><b>Errors</b></td>       <td>{{stats.lyrics.cache.error}}</td></tr>
                  <tr><td><b>Pending</b></td>      <td>{{stats.lyrics.cache.pending}}</td></tr>
                  <tr><td><b>Total rows</b></td>   <td>{{stats.lyrics.cache.total}}</td></tr>
                </tbody>
              </table>
              <p style="margin-top:12px">
                <a v-on:click="purgeLyricsCache('retry')" class="btn-flat waves-effect" style="padding:0 8px">
                  Retry errors
                </a>
                <a v-on:click="purgeLyricsCache('full')" class="btn-flat waves-effect red-text" style="padding:0 8px">
                  Purge all
                </a>
                <span v-if="lyricsCachePurgeMsg" style="margin-left:12px;color:#5cb85c">
                  {{lyricsCachePurgeMsg}}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Jukebox live status -->
      <div v-if="params.mode !== 'disabled' && jukebox.available" class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Jukebox (Server Audio)</span>
              <p>
                <span v-if="jukebox.playing" class="chip green lighten-4" style="font-size:12px">Playing</span>
                <span v-else-if="jukebox.paused" class="chip orange lighten-4" style="font-size:12px">Paused</span>
                <span v-else class="chip grey lighten-3" style="font-size:12px">Idle</span>
                <span v-if="jukebox.queueLength > 0" style="margin-left:12px">
                  Track {{jukebox.queueIndex + 1}} of {{jukebox.queueLength}}
                </span>
              </p>
              <p v-if="jukebox.currentFile"><b>Current file:</b> <code>{{jukebox.currentFile}}</code></p>
              <p v-if="jukebox.duration > 0">
                <b>Position:</b> {{formatSeconds(jukebox.position)}} / {{formatSeconds(jukebox.duration)}}
              </p>
              <p>
                <b>Volume:</b> {{Math.round(jukebox.volume * 100)}}% &middot;
                <b>Loop:</b> {{jukebox.loopMode}} &middot;
                <b>Shuffle:</b> {{jukebox.shuffle ? 'on' : 'off'}}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Token-auth warning log -->
      <div v-if="params.mode !== 'disabled' && tokenAttempts.length > 0" class="row">
        <div class="col s12">
          <div class="card orange lighten-5">
            <div class="card-content">
              <span class="card-title" style="color:#bf5700">Token-auth attempts — clients stuck in a login loop</span>
              <p>mStream cannot support Subsonic's legacy token auth (the server would need the plaintext password to compute the MD5 digest — it only keeps PBKDF2 hashes). Clients that default to token auth get rejected with error 41 and usually loop. Mint an API key for the affected user below and hand it to them.</p>
              <table class="striped" style="margin-top:12px">
                <thead>
                  <tr><th>User</th><th>Client</th><th>When</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="(a, i) in tokenAttempts" :key="i">
                    <td><b>{{a.username || '(anonymous)'}}</b></td>
                    <td>{{a.client || '—'}}</td>
                    <td><small>{{formatSince(Date.now() - a.at)}} ago</small></td>
                    <td>
                      <a v-if="a.username" v-on:click="mintForUser(a.username)"
                         class="btn-small waves-effect waves-light blue">Generate key for {{a.username}}</a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="clearTokenLog()" class="btn-flat waves-effect right">Clear log</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Admin-minted-key one-time display -->
      <div v-if="adminMintedForUser.val" class="row">
        <div class="col s12">
          <div class="card-panel green lighten-4">
            <p><b>Key created for user "{{adminMintedForUser.username}}":</b> {{adminMintedForUser.name}}</p>
            <p style="margin-top:8px">
              <code style="user-select:all;word-break:break-all;background:#fff;padding:4px 8px;border-radius:4px;display:inline-block">{{adminMintedForUser.val}}</code>
            </p>
            <p style="margin-top:8px"><small>Relay this to the user. They paste it as their API key in their Subsonic client.</small></p>
            <a v-on:click="dismissAdminMintedKey()" class="waves-effect btn-flat">Dismiss</a>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Your Subsonic API Keys</span>
              <p>API keys are per-user. Each key authenticates Subsonic clients without exposing your mStream password. The full key value is only shown at creation &mdash; copy it into your client immediately, or revoke it and mint a new one.</p>

              <div v-if="lastMintedKey.val" class="card-panel green lighten-4" style="margin-top:16px">
                <p><b>New key created:</b> {{lastMintedKey.name}}</p>
                <p style="margin-top:8px">
                  <code style="user-select:all;word-break:break-all;background:#fff;padding:4px 8px;border-radius:4px;display:inline-block">{{lastMintedKey.val}}</code>
                </p>
                <p style="margin-top:8px"><small>This is the only time the full key will be shown. Paste it into your Subsonic client now.</small></p>
                <a v-on:click="dismissMintedKey()" class="waves-effect btn-flat">Dismiss</a>
              </div>

              <div style="margin-top:16px">
                <div class="row" style="margin-bottom:0">
                  <div class="input-field col s12 m8">
                    <input id="api-key-name" type="text" v-model="newKeyName" maxlength="100" placeholder="e.g. phone-dsub, laptop-feishin" />
                    <label for="api-key-name" class="active">New key name</label>
                  </div>
                  <div class="col s12 m4" style="padding-top:20px">
                    <a v-on:click="mintKey()" :disabled="mintPending || !newKeyName.trim()"
                       class="waves-effect waves-light btn">Generate key</a>
                  </div>
                </div>
              </div>

              <div v-if="apiKeysTS.ts > 0" style="margin-top:16px">
                <p v-if="apiKeys.length === 0"><i>No API keys yet.</i></p>
                <table v-else class="striped">
                  <thead>
                    <tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="k in apiKeys" :key="k.id">
                      <td>{{k.name || '(unnamed)'}}</td>
                      <td><small>{{formatTs(k.created_at)}}</small></td>
                      <td><small>{{formatTs(k.last_used) || '—'}}</small></td>
                      <td>
                        <a v-on:click="revokeKey(k)" class="waves-effect waves-red btn-small red lighten-1">Revoke</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    formatTs: function(s) {
      if (!s) { return null; }
      // SQLite stores as "YYYY-MM-DD HH:MM:SS" in UTC.
      const d = new Date(s.replace(' ', 'T') + 'Z');
      return isNaN(d.getTime()) ? s : d.toLocaleString();
    },
    // "12.3 seconds ago" → "12s", "123s" → "2m", "4000s" → "1h". Tight
    // formatting for the inline-table durations.
    formatSince: function(ms) {
      if (!Number.isFinite(ms) || ms < 0) { return '—'; }
      const s = Math.floor(ms / 1000);
      if (s < 60)   { return `${s}s`; }
      if (s < 3600) { return `${Math.floor(s / 60)}m`; }
      return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    },
    // "1:23" / "62:15" position/duration formatting.
    formatSeconds: function(s) {
      if (!Number.isFinite(s) || s < 0) { return '0:00'; }
      const m = Math.floor(s / 60);
      const ss = String(Math.floor(s) % 60).padStart(2, '0');
      return `${m}:${ss}`;
    },
    dismissMintedKey: function() {
      ADMINDATA.lastMintedKey.val = null;
      ADMINDATA.lastMintedKey.name = null;
    },
    dismissAdminMintedKey: function() {
      this.adminMintedForUser = { val: null, name: null, username: null };
    },
    runTest: async function() {
      this.testPending = true;
      this.testResult = null;
      try {
        this.testResult = await ADMINDATA.testSubsonicConnection();
      } catch (err) {
        this.testResult = { ok: false, reason: err.message };
      } finally {
        this.testPending = false;
      }
    },
    // Lyrics cache ledger purge (the enable / sidecar-write toggles moved to
    // the dedicated Lyrics admin view). mode='full' wipes all rows, 'retry'
    // clears error/pending; each call refreshes the stats counters.
    purgeLyricsCache: async function(mode) {
      try {
        const r = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/subsonic/lyrics-cache/purge`,
          data: { mode },
        });
        this.lyricsCachePurgeMsg = `Removed ${r.data.removed} row(s).`;
        setTimeout(() => { this.lyricsCachePurgeMsg = null; }, 4000);
        await ADMINDATA.getSubsonicStats();
      } catch (err) {
        iziToast.error({ title: `Purge failed: ${err.message || '?'}`,
          position: 'topCenter', timeout: 3000 });
      }
    },
    mintForUser: async function(username) {
      // Same prompt shape as iziToast's question so it feels consistent
      // with the rest of the admin panel's confirm dialogs.
      const name = `admin-minted-${new Date().toISOString().slice(0, 10)}`;
      iziToast.question({
        timeout: 20000, close: false, overlayClose: true, overlay: true,
        displayMode: 'once', id: 'admin-mint-key', zindex: 99999, layout: 2,
        title: `Create a Subsonic API key for "${username}"?`,
        message: `The key will be labelled "${name}". You will see the key value once and must relay it to the user yourself.`,
        position: 'center',
        buttons: [
          [`<button><b>Create key</b></button>`, async (instance, toast) => {
            try {
              const data = await ADMINDATA.mintKeyFor(username, name);
              this.adminMintedForUser = { val: data.key, name: data.name, username: data.username };
              iziToast.success({ title: `Key created for ${username}`, position: 'topCenter', timeout: 3000 });
            } catch (err) {
              iziToast.error({ title: `Failed to create key: ${err.message || 'unknown error'}`, position: 'topCenter', timeout: 4000 });
            } finally {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }
          }, true],
          [`<button>Cancel</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    clearTokenLog: async function() {
      try {
        await ADMINDATA.clearTokenAuthAttempts();
      } catch (err) {
        iziToast.error({ title: 'Failed to clear log', position: 'topCenter', timeout: 3000 });
      }
    },
    mintKey: async function() {
      const name = this.newKeyName.trim();
      if (!name) { return; }
      try {
        this.mintPending = true;
        await ADMINDATA.createApiKey(name);
        this.newKeyName = '';
        iziToast.success({ title: 'API key created', position: 'topCenter', timeout: 3000 });
      } catch (err) {
        iziToast.error({ title: 'Failed to create API key', position: 'topCenter', timeout: 3500 });
      } finally {
        this.mintPending = false;
      }
    },
    revokeKey: function(k) {
      iziToast.question({
        timeout: 20000, close: false, overlayClose: true, overlay: true,
        displayMode: 'once', id: 'api-key-revoke', zindex: 99999, layout: 2,
        title: `Revoke API key "${k.name || '(unnamed)'}"?`,
        message: 'Any client using this key will stop working. You cannot undo this.',
        position: 'center',
        buttons: [
          [`<button><b>Revoke</b></button>`, async (instance, toast) => {
            try {
              await ADMINDATA.revokeApiKey(k.id);
              iziToast.success({ title: 'Key revoked', position: 'topCenter', timeout: 2500 });
            } catch (err) {
              iziToast.error({ title: 'Failed to revoke key', position: 'topCenter', timeout: 3500 });
            } finally {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }
          }, true],
          [`<button>Cancel</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    applyMode: async function() {
      const mode = this.selectedMode;
      const port = this.selectedPort;
      const modeLabels = { disabled: 'Disabled', 'same-port': 'Same Port', 'separate-port': 'Separate Port' };
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'subsonic-question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `Set Subsonic mode to "${modeLabels[mode] || mode}"?`,
        message: mode === 'same-port' || this.params.mode === 'same-port'
          ? 'This will restart the mStream server.'
          : '',
        position: 'center',
        buttons: [
          [`<button><b>Apply</b></button>`, async (instance, toast) => {
            try {
              this.applyPending = true;
              const data = { mode };
              if (mode === 'separate-port') { data.port = port; }
              await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/subsonic/mode`,
                data
              });
              await ADMINDATA.getSubsonicParams();
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              iziToast.success({
                title: `Subsonic mode set to ${modeLabels[mode] || mode}`,
                position: 'topCenter',
                timeout: 3500
              });
            } catch(err) {
              iziToast.error({ title: 'Failed to update Subsonic setting', position: 'topCenter', timeout: 3500 });
            } finally {
              this.applyPending = false;
            }
          }, true],
          [`<button>Cancel</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    }
  }
});

// ── Torrent (V37 — UX-layer settings) ──────────────────────────────────────
// First-cut admin surface for the optional torrent-client feature. Two
// dropdowns:
//   client      — 'disabled' (default) or 'transmission'. More backends
//                 will land later (qBittorrent, Deluge, rTorrent); the
//                 dropdown is a single-select on purpose because only one
//                 client is active at a time in v1.
//   enabledFor  — 'all' (every authenticated user) or 'whitelist' (only
//                 users with users.allow_torrent = 1). When 'whitelist'
//                 is selected, an inline user-grant table appears so the
//                 admin can flip the per-user flag without leaving the
//                 page.
const torrentView = Vue.component('torrent-view', {
  data() {
    return {
      paramsTS:   ADMINDATA.torrentParamsUpdated,
      params:     ADMINDATA.torrentParams,
      statusTS:   ADMINDATA.torrentStatusUpdated,
      status:     ADMINDATA.torrentStatus,
      listTS:     ADMINDATA.torrentListUpdated,
      list:       ADMINDATA.torrentList,
      listRefreshPending: false,
      // Client-side substring filter for the torrents table. Matches
      // against name + infoHash so operators can paste a hash and find
      // the row instantly. Cleared when the user clicks the ✕ button.
      listFilter:      '',
      // Soft render cap. Daemons can return thousands of torrents; we
      // render LIST_PAGE_SIZE at a time and let the operator click
      // "Show more" / "Show all" to expand. Reset to LIST_PAGE_SIZE on
      // every Refresh so the table doesn't accidentally render 10k rows
      // after the operator left the page open overnight.
      listVisibleCap:  100,
      // Per-info-hash pending flag while DELETE /admin/torrent/:hash is
      // in flight. Stops the operator from double-clicking the same
      // row, which would surface a confusing 404 after the first call
      // succeeded.
      removePending:   {},
      accessTS:   ADMINDATA.torrentVpathAccessUpdated,
      access:     ADMINDATA.torrentVpathAccess,
      accessRefreshPending: false,
      // Per-vpath edit-mode tracking. Keyed by vpath name. When the
      // operator clicks "Override" on a confirmed row, we flip the
      // input from disabled→editable here and accept a new daemon
      // path entry. Cleared on Save / Cancel.
      accessEditPath: {},        // { 'music': '/downloads/music', … } — input value
      accessEditPending: {},     // per-row pending flag during /manual POST
      accessEditMode:    {},     // 'view' | 'edit' — defaults to 'view' for
                                  // confirmed rows, 'edit' for unconfirmed
      // ── Path Templates (V41) ──────────────────────────────────────
      // Per-vpath template editor state. Mirrors the access-edit
      // pattern: a draft string per vpath plus a per-row pending
      // flag during the PUT.
      tmplTS:       ADMINDATA.torrentPathTemplatesUpdated,
      tmpl:         ADMINDATA.torrentPathTemplates,
      tmplDraft:    {},          // { 'music': '{{ARTIST}}/{{ALBUM}}', ... }
      tmplPending:  {},
      tmplError:    {},          // per-row inline error from the API
      // ── Import for Seeding ───────────────────────────────────────
      // Drag-drop + bounded-concurrency uploader state. seedResults
      // is an array of per-file rows the UI renders; each row gets
      // populated with the route's outcome as the corresponding
      // request resolves. Rows are added eagerly (pending=true) so
      // the operator sees the upload set immediately, even before
      // any responses come back.
      seedIsDragOver:    false,
      seedSelectedVpaths: [],     // empty array = check ALL libraries (route default)
      seedResults:       [],
      seedRunningCount:  0,
      seedConcurrency:   6,       // parallel requests cap
      users:      ADMINDATA.users,
      usersTS:    ADMINDATA.usersUpdated,
      selectedClient:     'disabled',
      selectedEnabledFor: 'all',
      clientPending:     false,
      enabledForPending: false,
      // Per-row pending state so a slow request on one user doesn't
      // disable every checkbox.
      grantPending: {},
      // Transmission login form. Pre-filled with sane defaults; bound
      // to the inputs in the v-if='!params.transmission.configured'
      // block.
      tForm: {
        host:     '',
        port:     9091,
        username: '',
        password: '',
        rpcPath:  '/transmission/rpc',
        useHttps: false,
      },
      tFormError:        null,
      tConnectPending:   false,
      tTestPending:      false,
      tDisconnectPending: false,
      // qBittorrent login form. No `rpcPath` — the WebAPI is mounted
      // at a fixed /api/v2/* under the host, not user-configurable.
      qForm: {
        host:     '',
        port:     8080,
        username: '',
        password: '',
        useHttps: false,
      },
      qFormError:        null,
      qConnectPending:   false,
      qTestPending:      false,
      qDisconnectPending: false,
      // Deluge login form. Smaller than the others — no username and
      // no rpcPath. Default port 8112 (Deluge WebUI).
      dForm: {
        host:     '',
        port:     8112,
        password: '',
        useHttps: false,
      },
      dFormError:        null,
      dConnectPending:   false,
      dTestPending:      false,
      dDisconnectPending: false,
    };
  },
  watch: {
    'paramsTS.ts': {
      immediate: true,
      handler: function() {
        this.selectedClient     = this.params.client     || 'disabled';
        this.selectedEnabledFor = this.params.enabledFor || 'all';
      }
    }
  },
  computed: {
    // Substring match on name + infoHash. Case-insensitive. Empty
    // filter short-circuits to the full list so the common case (no
    // filter, small N) doesn't allocate a new array on every render.
    filteredTorrents: function() {
      const q = (this.listFilter || '').trim().toLowerCase();
      if (!q) { return this.list.torrents; }
      return this.list.torrents.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.infoHash || '').toLowerCase().includes(q)
      );
    },
    // What actually gets rendered into the DOM. Cap is reset to its
    // default on every Refresh; "Show more" bumps it by one page and
    // "Show all" sets it to Infinity.
    visibleTorrents: function() {
      const filtered = this.filteredTorrents;
      if (this.listVisibleCap >= filtered.length) { return filtered; }
      return filtered.slice(0, this.listVisibleCap);
    }
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">
                Torrent Client
                <span style="display:inline-block; margin-left:8px; padding:2px 8px; font-size:0.55em; font-weight:bold; letter-spacing:0.5px; background:#ff9800; color:#fff; border-radius:3px; vertical-align:middle;">BETA</span>
              </span>
              <p>Hand off magnet links and <code>.torrent</code> files to a torrent client running on this host (or reachable on the LAN). Completed downloads are picked up by the next library scan.</p>
              <p style="font-size:0.85em; color:#888; margin-top:-6px; margin-bottom:14px;">
                <b style="color:#e67e22;">Beta:</b> The torrent feature is new — please <a href="https://github.com/IrosTheBeggar/mStream/issues" target="_blank" rel="noopener">report any issues</a> you run into.
              </p>
              <p style="font-size:0.85em; margin-top:-6px; margin-bottom:14px; padding:8px 12px; background:rgba(33,150,243,0.10); border-left:3px solid #2196f3; border-radius:3px;">
                <b>Mobile:</b> Users can add torrents from their phone at <a href="/torrent" target="_blank" rel="noopener" style="color:#90caf9;"><code>/torrent</code></a> — a standalone, mobile-friendly add-torrent page. The torrent feature isn't exposed by the apps; this gives users a way to add them on the go.
              </p>
              <div style="margin-top:16px">
                <p><b>Current:</b> {{params.client || 'disabled'}}</p>
              </div>
              <div style="margin-top:16px;max-width:320px">
                <select class="browser-default" v-model="selectedClient">
                  <option value="disabled">Disabled</option>
                  <option value="transmission">Transmission</option>
                  <option value="qbittorrent">qBittorrent</option>
                  <option value="deluge">Deluge</option>
                </select>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyClient()" :disabled="clientPending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Transmission backend: only when client is Transmission. Two
           mutually-exclusive states based on whether credentials are
           saved. Login form when not configured; status card when
           configured. -->
      <div class="row" v-if="params.client === 'transmission' && !params.transmission.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Connect to Transmission</span>
              <p>Provide RPC credentials. <b>Test</b> probes the daemon without saving; <b>Connect</b> persists the credentials on a successful probe.</p>
              <div class="row" style="margin-top:16px">
                <div class="input-field col s12 m8">
                  <input id="t-host" type="text" v-model.trim="tForm.host" placeholder="127.0.0.1" />
                  <label for="t-host" class="active">Host</label>
                </div>
                <div class="input-field col s12 m4">
                  <input id="t-port" type="number" v-model.number="tForm.port" min="1" max="65535" />
                  <label for="t-port" class="active">Port</label>
                </div>
              </div>
              <div class="row">
                <div class="input-field col s12 m6">
                  <input id="t-username" type="text" v-model.trim="tForm.username" />
                  <label for="t-username" class="active">Username</label>
                </div>
                <div class="input-field col s12 m6">
                  <input id="t-password" type="password" v-model="tForm.password" autocomplete="new-password" />
                  <label for="t-password" class="active">Password</label>
                </div>
              </div>
              <div class="row">
                <div class="input-field col s12 m8">
                  <input id="t-rpcpath" type="text" v-model.trim="tForm.rpcPath" />
                  <label for="t-rpcpath" class="active">RPC Path</label>
                </div>
                <div class="col s12 m4" style="padding-top:1.5em">
                  <label>
                    <input type="checkbox" class="filled-in" v-model="tForm.useHttps" />
                    <span>Use HTTPS</span>
                  </label>
                </div>
              </div>
              <div v-if="tFormError" class="card-panel red lighten-4" style="margin-top:8px">
                <b>Connection failed:</b> {{tFormError}}
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="testTransmission()" :disabled="tTestPending || tConnectPending"
                 class="waves-effect waves-light btn-flat right" style="margin-right:8px">
                {{ tTestPending ? 'Testing…' : 'Test' }}
              </a>
              <a v-on:click="connectTransmission()" :disabled="tConnectPending || tTestPending"
                 class="waves-effect waves-light btn right">
                {{ tConnectPending ? 'Connecting…' : 'Connect' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- qBittorrent: login form / status card. Same structure as
           the Transmission pair but no rpcPath field — qBittorrent's
           WebAPI mount point is fixed. -->
      <div class="row" v-if="params.client === 'qbittorrent' && !params.qbittorrent.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Connect to qBittorrent</span>
              <p>Provide WebUI credentials. <b>Test</b> probes the daemon without saving; <b>Connect</b> persists the credentials on a successful probe.</p>
              <div class="card-panel yellow lighten-4" style="padding:8px 12px;margin:8px 0;font-size:0.85em">
                <b>Note:</b> mStream does not send a <code>Referer</code> header on its WebAPI calls. If you've enabled qBittorrent's <i>"Enable Cross-Site Request Forgery (CSRF) protection"</i> option (off by default), connections will fail. Disable CSRF in qBittorrent's <i>WebUI</i> settings or restrict access via <i>"Bypass authentication for clients on localhost"</i> + a host allowlist.
              </div>
              <div class="row" style="margin-top:16px">
                <div class="input-field col s12 m8">
                  <input id="q-host" type="text" v-model.trim="qForm.host" placeholder="127.0.0.1" />
                  <label for="q-host" class="active">Host</label>
                </div>
                <div class="input-field col s12 m4">
                  <input id="q-port" type="number" v-model.number="qForm.port" min="1" max="65535" />
                  <label for="q-port" class="active">Port</label>
                </div>
              </div>
              <div class="row">
                <div class="input-field col s12 m6">
                  <input id="q-username" type="text" v-model.trim="qForm.username" />
                  <label for="q-username" class="active">Username</label>
                </div>
                <div class="input-field col s12 m6">
                  <input id="q-password" type="password" v-model="qForm.password" autocomplete="new-password" />
                  <label for="q-password" class="active">Password</label>
                </div>
              </div>
              <div class="row">
                <div class="col s12 m4" style="padding-top:1.5em">
                  <label>
                    <input type="checkbox" class="filled-in" v-model="qForm.useHttps" />
                    <span>Use HTTPS</span>
                  </label>
                </div>
              </div>
              <div v-if="qFormError" class="card-panel red lighten-4" style="margin-top:8px">
                <b>Connection failed:</b> {{qFormError}}
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="testQbittorrent()" :disabled="qTestPending || qConnectPending"
                 class="waves-effect waves-light btn-flat right" style="margin-right:8px">
                {{ qTestPending ? 'Testing…' : 'Test' }}
              </a>
              <a v-on:click="connectQbittorrent()" :disabled="qConnectPending || qTestPending"
                 class="waves-effect waves-light btn right">
                {{ qConnectPending ? 'Connecting…' : 'Connect' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div class="row" v-if="params.client === 'qbittorrent' && params.qbittorrent.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">qBittorrent Connection</span>
              <div v-if="statusTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <p style="margin-top:8px">
                  <span v-if="status.connected" class="card-panel green lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Connected</b><span v-if="status.version"> &mdash; qBittorrent {{status.version}}</span>
                  </span>
                  <span v-else class="card-panel red lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Disconnected</b><span v-if="status.reason"> &mdash; {{status.reason}}</span>
                  </span>
                </p>
                <table style="margin-top:16px">
                  <tbody>
                    <tr><td style="width:140px"><b>Host</b></td><td>{{params.qbittorrent.host}}</td></tr>
                    <tr><td><b>Port</b></td><td>{{params.qbittorrent.port}}</td></tr>
                    <tr><td><b>Username</b></td><td>{{params.qbittorrent.username || '(none)'}}</td></tr>
                    <tr><td><b>HTTPS</b></td><td>{{params.qbittorrent.useHttps ? 'yes' : 'no'}}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="disconnectQbittorrent()" :disabled="qDisconnectPending"
                 class="waves-effect waves-light btn-flat red-text right" style="margin-right:8px">
                {{ qDisconnectPending ? 'Disconnecting…' : 'Disconnect' }}
              </a>
              <a v-on:click="refreshStatus()" :disabled="qTestPending"
                 class="waves-effect waves-light btn right">
                {{ qTestPending ? 'Testing…' : 'Test' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Deluge: login form / status card. Password-only auth. -->
      <div class="row" v-if="params.client === 'deluge' && !params.deluge.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Connect to Deluge</span>
              <p>Provide WebUI credentials. <b>Test</b> probes the daemon without saving; <b>Connect</b> persists the credentials on a successful probe.</p>
              <div class="row" style="margin-top:16px">
                <div class="input-field col s12 m8">
                  <input id="d-host" type="text" v-model.trim="dForm.host" placeholder="127.0.0.1" />
                  <label for="d-host" class="active">Host</label>
                </div>
                <div class="input-field col s12 m4">
                  <input id="d-port" type="number" v-model.number="dForm.port" min="1" max="65535" />
                  <label for="d-port" class="active">Port</label>
                </div>
              </div>
              <div class="row">
                <div class="input-field col s12 m8">
                  <input id="d-password" type="password" v-model="dForm.password" autocomplete="new-password" />
                  <label for="d-password" class="active">WebUI password</label>
                </div>
                <div class="col s12 m4" style="padding-top:1.5em">
                  <label>
                    <input type="checkbox" class="filled-in" v-model="dForm.useHttps" />
                    <span>Use HTTPS</span>
                  </label>
                </div>
              </div>
              <div v-if="dFormError" class="card-panel red lighten-4" style="margin-top:8px">
                <b>Connection failed:</b> {{dFormError}}
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="testDeluge()" :disabled="dTestPending || dConnectPending"
                 class="waves-effect waves-light btn-flat right" style="margin-right:8px">
                {{ dTestPending ? 'Testing…' : 'Test' }}
              </a>
              <a v-on:click="connectDeluge()" :disabled="dConnectPending || dTestPending"
                 class="waves-effect waves-light btn right">
                {{ dConnectPending ? 'Connecting…' : 'Connect' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div class="row" v-if="params.client === 'deluge' && params.deluge.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Deluge Connection</span>
              <div v-if="statusTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <p style="margin-top:8px">
                  <span v-if="status.connected" class="card-panel green lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Connected</b><span v-if="status.version"> &mdash; Deluge {{status.version}}</span>
                  </span>
                  <span v-else class="card-panel red lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Disconnected</b><span v-if="status.reason"> &mdash; {{status.reason}}</span>
                  </span>
                </p>
                <table style="margin-top:16px">
                  <tbody>
                    <tr><td style="width:140px"><b>Host</b></td><td>{{params.deluge.host}}</td></tr>
                    <tr><td><b>Port</b></td><td>{{params.deluge.port}}</td></tr>
                    <tr><td><b>HTTPS</b></td><td>{{params.deluge.useHttps ? 'yes' : 'no'}}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="disconnectDeluge()" :disabled="dDisconnectPending"
                 class="waves-effect waves-light btn-flat red-text right" style="margin-right:8px">
                {{ dDisconnectPending ? 'Disconnecting…' : 'Disconnect' }}
              </a>
              <a v-on:click="refreshStatus()" :disabled="dTestPending"
                 class="waves-effect waves-light btn right">
                {{ dTestPending ? 'Testing…' : 'Test' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Per-vpath access mapping. The table tells the operator which
           libraries are reachable from the active torrent client and
           the daemon's view of each (the absolute path it would use
           internally — usually different from mStream's path when the
           daemon is in Docker). Confirmed rows show the resolved path
           in a disabled input. Unconfirmed rows expose an editable
           input where the operator can manually type the daemon-side
           path; submitting runs the same probe primitive as
           auto-detect. -->
      <div class="row" v-if="(params.client === 'transmission' && params.transmission.configured) || (params.client === 'qbittorrent' && params.qbittorrent.configured) || (params.client === 'deluge' && params.deluge.configured)">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">
                Library Access
                <a v-on:click="refreshAccess()" :disabled="accessRefreshPending"
                   class="waves-effect waves-light btn-flat right" style="margin-top:-6px">
                  {{ accessRefreshPending ? 'Auto-detecting…' : 'Auto-detect' }}
                </a>
              </span>
              <p style="opacity:0.85;margin-bottom:8px">
                The paths below are <b>as seen by the torrent client</b>, not by mStream.
                When the daemon runs in Docker (or any container), its absolute paths
                usually differ from mStream's. Verified rows are confirmed via the daemon
                directly; unverified rows need a manual mapping before torrents can be added.
              </p>
              <div v-if="accessTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else-if="Object.keys(access.vpaths).length === 0" style="margin-top:8px;opacity:0.7">
                <i>No libraries defined. Add one on the Directories page first.</i>
              </div>
              <table v-else style="margin-top:8px">
                <thead>
                  <tr>
                    <th style="width:140px">Library</th>
                    <th style="width:140px">Status</th>
                    <th>Path (as seen by {{params.client}})</th>
                    <th style="width:1px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(v, name) in access.vpaths" :key="name">
                    <td><b>{{name}}</b></td>
                    <td>
                      <span class="status-chip" :class="accessChipClass(v)">
                        {{accessChipLabel(v)}}
                      </span>
                      <div v-if="v.lastError" style="font-size:0.75em;color:#c62828;margin-top:4px">{{v.lastError}}</div>
                    </td>
                    <td>
                      <input type="text"
                             :value="accessInputValue(name, v)"
                             @input="onAccessInput(name, $event.target.value)"
                             :disabled="!accessIsEditing(name, v)"
                             :placeholder="accessPlaceholder(v)"
                             style="margin:0" />
                      <div v-if="!accessIsEditing(name, v) && v.daemonPath && v.confidence !== 'pending'" style="font-size:0.75em;opacity:0.65;margin-top:2px">
                        verified via {{v.method || 'auto-detect'}}<span v-if="v.source === 'manual'"> · manually set</span>
                      </div>
                    </td>
                    <td>
                      <a v-if="accessIsEditing(name, v)"
                         v-on:click="saveManualMapping(name)"
                         :disabled="accessEditPending[name]"
                         class="waves-effect waves-light btn-small green">
                        {{ accessEditPending[name] ? '…' : 'Save' }}
                      </a>
                      <a v-else
                         v-on:click="enterEditMode(name, v)"
                         class="waves-effect waves-light btn-small btn-flat">
                        Override
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Path Templates (V41). Per-vpath template strings the player
           UI uses to construct the destination path from auto-detected
           metadata. Hidden when there are no libraries to template
           against. Server validates the template (parse + sample
           resolve + path safety) before persisting; errors render
           inline below the row that failed. -->
      <div class="row" v-if="(params.client === 'transmission' && params.transmission.configured) || (params.client === 'qbittorrent' && params.qbittorrent.configured) || (params.client === 'deluge' && params.deluge.configured)">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Path Templates</span>
              <p>
                Templates the player uses to construct the destination path when a torrent is added.
                Variables resolve from the torrent's metadata; empty variables drop their segment.
              </p>
              <p style="font-size:0.85em;opacity:0.75">
                <b>Supported:</b>
                <code v-for="v in tmpl.supportedVars" :key="v" style="margin-right:6px">{{tmplVarDisplay(v)}}</code>
              </p>
              <div v-if="tmplTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else-if="Object.keys(tmpl.vpaths).length === 0" style="margin-top:8px;opacity:0.7">
                <i>No libraries defined.</i>
              </div>
              <table v-else style="margin-top:8px">
                <thead>
                  <tr>
                    <th style="width:140px">Library</th>
                    <th>Template</th>
                    <th>Preview</th>
                    <th style="width:1px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(t, name) in tmpl.vpaths" :key="name">
                    <td><b>{{name}}</b></td>
                    <td>
                      <input type="text"
                             :value="tmplInputValue(name, t)"
                             @input="onTmplInput(name, $event.target.value)"
                             placeholder="(empty — uses manual freeform entry)"
                             style="margin:0" />
                      <div v-if="tmplError[name]" style="font-size:0.78em;color:#c62828;margin-top:4px">
                        {{tmplError[name]}}
                      </div>
                      <a v-if="!tmplInputValue(name, t)" v-on:click="useSuggestedTemplate(name)"
                         style="font-size:0.78em;cursor:pointer;display:inline-block;margin-top:4px">
                        Use suggested: <code>{{tmpl.suggestedTemplate}}</code>
                      </a>
                    </td>
                    <td>
                      <code style="font-size:0.8em;opacity:0.75;word-break:break-all">{{tmplPreview(name, t)}}</code>
                    </td>
                    <td>
                      <a v-on:click="saveTmpl(name)" :disabled="tmplPending[name]"
                         class="waves-effect waves-light btn-small green">
                        {{ tmplPending[name] ? '…' : 'Save' }}
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Import for Seeding. Drop N .torrent files; for each we
           check whether the contents already live under one of the
           libraries and, on a match, hand the torrent to the daemon
           paused=false so it starts seeding. UI fires uploads in
           parallel (bounded by seedConcurrency) and renders one row
           per file as responses land. -->
      <div class="row" v-if="(params.client === 'transmission' && params.transmission.configured) || (params.client === 'qbittorrent' && params.qbittorrent.configured) || (params.client === 'deluge' && params.deluge.configured)">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Import for Seeding</span>
              <p>
                Upload <code>.torrent</code> files for content already on disk. mStream checks each torrent's files against your libraries and, when every file matches, registers the torrent with the daemon so it starts seeding without re-downloading.
              </p>
              <div class="seed-drop-zone"
                   :class="{ 'is-dragover': seedIsDragOver, 'is-busy': seedRunningCount > 0 }"
                   v-on:dragover.prevent="seedIsDragOver = true"
                   v-on:dragleave.prevent="seedIsDragOver = false"
                   v-on:drop.prevent="onSeedDrop">
                <p style="margin:0">
                  <b>Drop .torrent files here</b>, or
                  <a v-on:click="seedClickPicker" style="cursor:pointer;text-decoration:underline">browse</a>
                </p>
                <input ref="seedFileInput" type="file" multiple accept=".torrent"
                       v-on:change="onSeedFilePick" style="display:none">
                <p v-if="seedRunningCount > 0" style="margin-top:8px;font-size:0.85em;opacity:0.7">
                  Checking {{seedRunningCount}} torrent<span v-if="seedRunningCount !== 1">s</span>…
                </p>
              </div>
              <div style="margin-top:12px;font-size:0.9em">
                <b>Search in:</b>
                <label v-for="(v, name) in tmpl.vpaths" :key="name" style="margin-left:12px">
                  <input type="checkbox" v-model="seedSelectedVpaths" :value="name">
                  <span>{{name}}</span>
                </label>
                <span v-if="seedSelectedVpaths.length === 0" style="margin-left:12px;opacity:0.65">
                  (none selected = every library)
                </span>
              </div>
              <div v-if="seedResults.length > 0" style="margin-top:16px">
                <table class="striped" style="margin-top:0">
                  <thead>
                    <tr>
                      <th style="width:30%">File</th>
                      <th style="width:140px">Outcome</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, idx) in seedResults" :key="idx">
                      <td :title="r.filename">
                        <code style="font-size:0.85em">{{r.filename}}</code>
                      </td>
                      <td>
                        <span v-if="r.pending" class="status-chip" :class="'status-pending'">⟳ Checking…</span>
                        <span v-else class="status-chip" :class="seedChipClass(r.outcome)">{{seedChipLabel(r.outcome)}}</span>
                      </td>
                      <td style="font-size:0.85em;opacity:0.85">
                        <span v-if="r.outcome === 'seeded'">
                          ✓ {{r.vpath}} → <code>{{r.addedAt}}</code>
                        </span>
                        <span v-else-if="r.outcome === 'partial_match'">
                          {{r.matched}}/{{r.total}} files matched in <b>{{r.vpath}}</b>; missing:
                          <span v-for="(m, i) in r.missing.slice(0, 3)" :key="i" style="font-family:monospace">
                            {{m}}<span v-if="i < 2 && i < r.missing.length - 1">, </span>
                          </span>
                          <span v-if="r.missing.length > 3">…+{{r.missing.length - 3}}</span>
                        </span>
                        <span v-else-if="r.outcome === 'no_match'">
                          Not found in {{r.checkedVpaths.join(', ')}}
                        </span>
                        <span v-else-if="r.outcome === 'already_in_daemon'">
                          Daemon already has this torrent — no action taken
                        </span>
                        <span v-else-if="r.outcome === 'invalid_torrent'" style="color:#c62828">
                          {{r.error}}
                        </span>
                        <span v-else-if="r.outcome === 'daemon_error'" style="color:#c62828">
                          {{r.error || 'Daemon refused the add'}}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div style="margin-top:8px">
                  <a v-on:click="seedClearResults" class="waves-effect waves-light btn-flat btn-small">
                    Clear results
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- All torrents the daemon knows about. Rendered as soon as
           credentials are saved; if the daemon is unreachable the card
           still shows, with the error inline rather than disappearing
           — invisible failure is worse than a visible one. -->
      <div class="row" v-if="(params.client === 'transmission' && params.transmission.configured) || (params.client === 'qbittorrent' && params.qbittorrent.configured) || (params.client === 'deluge' && params.deluge.configured)">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">
                Torrents
                <a v-on:click="refreshList()" :disabled="listRefreshPending"
                   class="waves-effect waves-light btn-flat right" style="margin-top:-6px">
                  {{ listRefreshPending ? 'Loading…' : 'Refresh' }}
                </a>
              </span>
              <div v-if="listTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else-if="list.error" class="card-panel red lighten-4" style="margin-top:8px">
                <b>Couldn't fetch torrents:</b> {{list.error}}
              </div>
              <div v-else-if="list.torrents.length === 0" style="margin-top:8px;opacity:0.7">
                <i>No torrents.</i>
              </div>
              <div v-else>
                <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                  <div style="position:relative;flex:1;min-width:200px;max-width:360px">
                    <input type="text" v-model="listFilter" placeholder="Filter by name or info-hash…"
                           style="margin:0;padding-right:28px;height:36px;font-size:0.9em">
                    <a v-if="listFilter" v-on:click="listFilter = ''"
                       style="position:absolute;right:6px;top:6px;cursor:pointer;opacity:0.6;font-size:1.2em;line-height:1"
                       title="Clear filter">&times;</a>
                  </div>
                  <span style="font-size:0.85em;opacity:0.7">
                    <span v-if="listFilter">{{filteredTorrents.length}} of {{list.torrents.length}} match</span>
                    <span v-else>{{list.torrents.length}} torrent<span v-if="list.torrents.length !== 1">s</span></span>
                  </span>
                </div>
                <div v-if="filteredTorrents.length === 0" style="margin-top:8px;opacity:0.7">
                  <i>No torrents match the filter.</i>
                </div>
                <table v-if="filteredTorrents.length > 0" class="striped" style="margin-top:8px">
                <thead>
                  <tr>
                    <th style="width:38%">Name</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>DL</th>
                    <th>Size</th>
                    <th>Source</th>
                    <th style="width:1px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in visibleTorrents" :key="t.infoHash"
                      :class="{ 'managed-row': t.managedByMstream }">
                    <td :title="t.name + ' &mdash; ' + t.infoHash">
                      <span style="display:inline-block;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">{{t.name}}</span>
                    </td>
                    <td>
                      <span class="status-chip" :class="'status-' + t.status">{{t.status}}</span>
                      <div v-if="t.errorMessage" style="font-size:0.75em;color:#c62828;margin-top:4px">{{t.errorMessage}}</div>
                    </td>
                    <td style="min-width:120px">
                      <div style="font-size:0.85em">{{Math.round(t.percent * 100)}}%</div>
                      <div style="background:#e0e0e0;border-radius:3px;height:6px;width:100px;overflow:hidden">
                        <div :style="{ width: (t.percent * 100) + '%', background: t.status === 'seeding' ? '#43a047' : '#1e88e5', height: '100%' }"></div>
                      </div>
                    </td>
                    <td>{{ t.rateDownload > 0 ? formatRate(t.rateDownload) : '—' }}</td>
                    <td>{{formatSize(t.sizeBytes)}}</td>
                    <td>
                      <span v-if="t.managedByMstream"
                            class="status-chip status-managed"
                            :title="t.managedBy ? 'Added by ' + t.managedBy + ' via mStream' : 'Added via mStream'">
                        ● mStream<span v-if="t.managedBy"> ({{t.managedBy}})</span>
                      </span>
                      <span v-else style="opacity:0.55;font-size:0.85em">external</span>
                    </td>
                    <td>
                      <!-- Remove is mStream-managed only. External torrents (added
                           directly via the daemon's own client) are intentionally
                           untouchable from here — operator uses the daemon UI for
                           those. Confirm dialog spells out the "files stay on disk"
                           contract so a click isn't catastrophic. -->
                      <a v-if="t.managedByMstream"
                         v-on:click="removeTorrent(t)"
                         :disabled="removePending[t.infoHash]"
                         class="waves-effect waves-light btn-small btn-flat red-text"
                         :title="'Remove from daemon (keeps files on disk)'">
                        {{ removePending[t.infoHash] ? '…' : '✕ Remove' }}
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="filteredTorrents.length > visibleTorrents.length"
                   style="margin-top:8px;display:flex;align-items:center;gap:12px">
                <span style="font-size:0.85em;opacity:0.7">
                  Showing {{visibleTorrents.length}} of {{filteredTorrents.length}}
                </span>
                <a v-on:click="showMore()" class="waves-effect waves-light btn-flat btn-small">
                  Show 100 more
                </a>
                <a v-on:click="showAll()" class="waves-effect waves-light btn-flat btn-small">
                  Show all
                </a>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="row" v-if="params.client === 'transmission' && params.transmission.configured">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Transmission Connection</span>
              <div v-if="statusTS.ts === 0" style="margin-top:8px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <p style="margin-top:8px">
                  <span v-if="status.connected" class="card-panel green lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Connected</b><span v-if="status.version"> &mdash; Transmission {{status.version}}</span>
                  </span>
                  <span v-else class="card-panel red lighten-4" style="display:inline-block;padding:6px 14px;margin:0">
                    <b>● Disconnected</b><span v-if="status.reason"> &mdash; {{status.reason}}</span>
                  </span>
                </p>
                <table style="margin-top:16px">
                  <tbody>
                    <tr><td style="width:140px"><b>Host</b></td><td>{{params.transmission.host}}</td></tr>
                    <tr><td><b>Port</b></td><td>{{params.transmission.port}}</td></tr>
                    <tr><td><b>Username</b></td><td>{{params.transmission.username || '(none)'}}</td></tr>
                    <tr><td><b>RPC path</b></td><td>{{params.transmission.rpcPath}}</td></tr>
                    <tr><td><b>HTTPS</b></td><td>{{params.transmission.useHttps ? 'yes' : 'no'}}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="disconnectTransmission()" :disabled="tDisconnectPending"
                 class="waves-effect waves-light btn-flat red-text right" style="margin-right:8px">
                {{ tDisconnectPending ? 'Disconnecting…' : 'Disconnect' }}
              </a>
              <a v-on:click="refreshStatus()" :disabled="tTestPending"
                 class="waves-effect waves-light btn right">
                {{ tTestPending ? 'Testing…' : 'Test' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Enabled For</span>
              <p>Pick who can use the torrent feature.</p>
              <div style="margin-top:16px">
                <p><b>Current:</b> {{params.enabledFor || 'all'}}</p>
              </div>
              <div style="margin-top:16px">
                <p>
                  <label style="margin-right:24px">
                    <input type="radio" v-model="selectedEnabledFor" value="all" />
                    <span><b>All users</b> &mdash; every authenticated user can add torrents.</span>
                  </label>
                </p>
                <p>
                  <label>
                    <input type="radio" v-model="selectedEnabledFor" value="whitelist" />
                    <span><b>Whitelist</b> &mdash; only users you explicitly grant.</span>
                  </label>
                </p>
              </div>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="applyEnabledFor()" :disabled="enabledForPending"
                 class="waves-effect waves-light btn right">
                Apply
              </a>
            </div>
          </div>
        </div>
      </div>

      <div class="row" v-if="(params.enabledFor || 'all') === 'whitelist'">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Whitelisted Users</span>
              <p>Toggle access per user. Changes apply immediately.</p>
              <div v-if="usersTS.ts === 0" style="margin-top:16px">
                <svg class="spinner" width="36px" height="36px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else-if="Object.keys(users).length === 0" style="margin-top:16px">
                <p><i>No users defined yet. Add users on the Users page first.</i></p>
              </div>
              <table v-else style="margin-top:16px">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Admin</th>
                    <th>Torrent access</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(v, k) in users">
                    <td>{{k}}</td>
                    <td>
                      <span v-if="v.admin">yes</span>
                      <span v-else>no</span>
                    </td>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          class="filled-in"
                          :checked="v.allowTorrent === true"
                          :disabled="grantPending[k] === true"
                          @change="toggleAccess(k, $event.target.checked)" />
                        <span>&nbsp;</span>
                      </label>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    applyClient: async function() {
      const client = this.selectedClient;
      try {
        this.clientPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/client`,
          data: { client }
        });
        await ADMINDATA.getTorrentParams();
        await ADMINDATA.getTorrentStatus();
        // List depends on active client; refetch so the table reflects
        // whatever the newly-selected client is reporting (or clears
        // when switching to 'disabled').
        await ADMINDATA.getTorrentList();
        iziToast.success({
          title: `Torrent client set to ${client}`,
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({ title: 'Failed to update torrent client', position: 'topCenter', timeout: 3500 });
      } finally {
        this.clientPending = false;
      }
    },
    applyEnabledFor: async function() {
      const enabledFor = this.selectedEnabledFor;
      try {
        this.enabledForPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/enabled-for`,
          data: { enabledFor }
        });
        await ADMINDATA.getTorrentParams();
        iziToast.success({
          title: `Torrent access policy set to "${enabledFor}"`,
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({ title: 'Failed to update torrent policy', position: 'topCenter', timeout: 3500 });
      } finally {
        this.enabledForPending = false;
      }
    },
    toggleAccess: async function(username, allowTorrent) {
      Vue.set(this.grantPending, username, true);
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/users/torrent-access`,
          data: { username, allowTorrent }
        });
        Vue.set(ADMINDATA.users[username], 'allowTorrent', allowTorrent);
        iziToast.success({
          title: `${username}: torrent ${allowTorrent ? 'granted' : 'revoked'}`,
          position: 'topCenter',
          timeout: 2500
        });
      } catch(err) {
        iziToast.error({ title: 'Failed to update access', position: 'topCenter', timeout: 3500 });
      } finally {
        Vue.set(this.grantPending, username, false);
      }
    },
    // ── Transmission backend actions ─────────────────────────────────
    _credsFromForm() {
      return {
        host:     this.tForm.host,
        port:     this.tForm.port,
        username: this.tForm.username,
        password: this.tForm.password,
        rpcPath:  this.tForm.rpcPath || '/transmission/rpc',
        useHttps: !!this.tForm.useHttps,
      };
    },
    async testTransmission() {
      this.tFormError = null;
      this.tTestPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/transmission/test`,
          data: this._credsFromForm(),
        });
        if (res.data.ok) {
          iziToast.success({
            title: `Reachable${res.data.version ? ' (Transmission ' + res.data.version + ')' : ''}`,
            position: 'topCenter', timeout: 3000
          });
        } else {
          this.tFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.tFormError = err.message || 'Request failed';
      } finally {
        this.tTestPending = false;
      }
    },
    async connectTransmission() {
      this.tFormError = null;
      this.tConnectPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/transmission/connect`,
          data: this._credsFromForm(),
        });
        if (res.data.ok) {
          await ADMINDATA.getTorrentParams();
          await ADMINDATA.getTorrentStatus();
          // The server runs _sweepVpathsForActiveClient inside /connect
          // so the access cache is fresh by the time the response
          // arrives — but the UI's cached vpath-access list was last
          // pulled at page-load against the prior client (or none),
          // and would otherwise show "needs a path" until a reload.
          // Same applies to qBittorrent + Deluge below.
          await ADMINDATA.getTorrentVpathAccess();
          iziToast.success({
            title: `Connected${res.data.version ? ' to Transmission ' + res.data.version : ''}`,
            position: 'topCenter', timeout: 3500
          });
          // Wipe the password field once it's been accepted — the
          // status card doesn't need it.
          this.tForm.password = '';
        } else {
          this.tFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.tFormError = err.message || 'Request failed';
      } finally {
        this.tConnectPending = false;
      }
    },
    async disconnectTransmission() {
      this.tDisconnectPending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/transmission/disconnect`,
        });
        await ADMINDATA.getTorrentParams();
        await ADMINDATA.getTorrentStatus();
        iziToast.success({ title: 'Disconnected', position: 'topCenter', timeout: 2500 });
      } catch (err) {
        iziToast.error({ title: 'Failed to disconnect', position: 'topCenter', timeout: 3500 });
      } finally {
        this.tDisconnectPending = false;
      }
    },
    // ── Library Access (per-vpath path-mapping) ────────────────────
    accessChipClass(v) {
      switch (v.confidence) {
        case 'verified':    return 'status-verified';
        case 'inferred':    return 'status-inferred';
        case 'pending':     return 'status-pending';
        default:            return 'status-unconfirmed';
      }
    },
    accessChipLabel(v) {
      switch (v.confidence) {
        case 'verified':    return '✓ Verified';
        case 'inferred':    return '~ Inferred';
        case 'pending':     return '⟳ Probing…';
        default:            return '✗ Unconfirmed';
      }
    },
    accessIsEditing(name, v) {
      // Confirmed rows are view-mode by default; unconfirmed rows are
      // edit-mode by default. PENDING rows render as view-mode (the
      // probe is mid-flight, manual override during a sweep would be
      // confusing). The accessEditMode override flips a confirmed row
      // to editable when the operator clicks "Override".
      const override = this.accessEditMode[name];
      if (override === 'edit') { return true; }
      if (override === 'view') { return false; }
      return v.confidence === 'unconfirmed';
    },
    accessInputValue(name, v) {
      // Edit-mode draft (if any) takes precedence; otherwise the
      // verified value; otherwise empty for the operator to type.
      if (this.accessEditPath[name] != null) { return this.accessEditPath[name]; }
      return v.daemonPath || '';
    },
    accessPlaceholder(v) {
      if (v.confidence === 'unconfirmed') {
        return `Enter the path ${this.params.client} uses for this library`;
      }
      if (v.confidence === 'pending') {
        return 'Probing daemon…';
      }
      return '';
    },
    onAccessInput(name, val) {
      Vue.set(this.accessEditPath, name, val);
    },
    enterEditMode(name, v) {
      Vue.set(this.accessEditMode, name, 'edit');
      Vue.set(this.accessEditPath, name, v.daemonPath || '');
    },
    async saveManualMapping(name) {
      const daemonPath = (this.accessEditPath[name] || '').trim();
      if (!daemonPath) {
        iziToast.error({ title: 'Enter a path first', position: 'topCenter', timeout: 2500 });
        return;
      }
      Vue.set(this.accessEditPending, name, true);
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/vpath-access/manual`,
          data: { vpathName: name, daemonPath },
        });
        await ADMINDATA.getTorrentVpathAccess();
        Vue.set(this.accessEditPath, name, null);
        Vue.set(this.accessEditMode, name, 'view');
        iziToast.success({
          title: `${name}: mapped → ${res.data.daemonPath} (${res.data.confidence})`,
          position: 'topCenter', timeout: 3000
        });
      } catch (err) {
        const errorData = err.response?.data || {};
        // Refresh the cache to pick up the latest probe row. vpath-access-cache.upsert
        // ran with source=MANUAL even on verification failure, so the operator can see
        // last_error / last_probed_at for what they tried. No multi-attempt audit log
        // is persisted — just the final state.
        await ADMINDATA.getTorrentVpathAccess();
        iziToast.error({
          title: errorData.message || errorData.error || err.message || 'Could not verify path',
          position: 'topCenter', timeout: 5000
        });
      } finally {
        Vue.set(this.accessEditPending, name, false);
      }
    },
    async refreshAccess() {
      this.accessRefreshPending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/vpath-access/auto-detect`,
          data: {},
        });
        await ADMINDATA.getTorrentVpathAccess();
        // Clear any pending edit drafts since the canonical state just
        // changed; the operator can re-Override if they still want to
        // edit something.
        this.accessEditPath = {};
        this.accessEditMode = {};
        iziToast.success({ title: 'Auto-detect complete', position: 'topCenter', timeout: 2500 });
      } catch (err) {
        const errorData = err.response?.data || {};
        iziToast.error({
          title: errorData.message || errorData.error || err.message || 'Auto-detect failed',
          position: 'topCenter', timeout: 3500
        });
      } finally {
        this.accessRefreshPending = false;
      }
    },
    // ── Path Templates ───────────────────────────────────────────────
    // Render a variable name as the template token the operator types.
    // Done in a method (not inline) because Vue's template parser
    // treats the literal `{{` in a mustache as the interpolation
    // delimiter and silently bails on nested cases.
    tmplVarDisplay(v) { return '{{' + v + '}}'; },
    tmplInputValue(name, t) {
      // Draft (if any) wins over the persisted server value.
      if (this.tmplDraft[name] != null) { return this.tmplDraft[name]; }
      return t.template || '';
    },
    onTmplInput(name, val) {
      Vue.set(this.tmplDraft, name, val);
      // Drafts invalidate the last error — the operator is mid-fix.
      if (this.tmplError[name]) { Vue.set(this.tmplError, name, null); }
    },
    useSuggestedTemplate(name) {
      Vue.set(this.tmplDraft, name, this.tmpl.suggestedTemplate);
    },
    // Live preview by resolving the current draft against the server-
    // supplied sample metadata. Mirrors src/torrent/path-template.js
    // — see resolveTemplate() there for the authoritative version.
    // Both implementations need to stay in sync; the server re-validates
    // on save so a divergence becomes a visible "preview said X but the
    // save rejected" error rather than a silent corruption.
    tmplPreview(name, t) {
      const raw = (this.tmplInputValue(name, t) || '').trim();
      if (!raw) { return '(no template — operator types path manually)'; }
      const meta = this.tmpl.sampleMetadata || {};
      const lookup = {
        ARTIST:      this._tmplSanitize(meta.artist),
        ALBUM:       this._tmplSanitize(meta.album),
        YEAR:        this._tmplSanitize(meta.year),
        GENRE:       this._tmplSanitize(meta.genre),
        ALBUMARTIST: this._tmplSanitize(meta.albumartist || meta.artist),
      };
      const subst = raw.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, n) => {
        const key = n.toUpperCase();
        return lookup[key] != null ? lookup[key] : '';
      });
      const path = subst.split(/[/\\]+/).map(s => s.trim()).filter(s => s.length > 0).join('/');
      return path || '(template resolves to empty)';
    },
    _tmplSanitize(s) {
      if (s == null) { return ''; }
      let v = String(s);
      // eslint-disable-next-line no-control-regex
      v = v.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
      v = v.replace(/\s+/g, ' ');
      v = v.replace(/^[.\s]+|[.\s]+$/g, '');
      if (v.length > 200) { v = v.slice(0, 200); }
      return v;
    },
    async saveTmpl(name) {
      Vue.set(this.tmplPending, name, true);
      Vue.set(this.tmplError, name, null);
      const raw = (this.tmplInputValue(name, this.tmpl.vpaths[name]) || '').trim();
      try {
        const res = await API.axios({
          method: 'PUT',
          url: `${API.url()}/api/v1/admin/torrent/path-templates/${encodeURIComponent(name)}`,
          data: { template: raw || null },
        });
        if (res.data.ok) {
          // Clear the draft now that the server holds the canonical value.
          Vue.delete(this.tmplDraft, name);
          await ADMINDATA.getTorrentPathTemplates();
          iziToast.success({
            title: raw ? `${name}: template saved` : `${name}: template cleared`,
            position: 'topCenter', timeout: 2500
          });
        } else {
          Vue.set(this.tmplError, name, res.data.message || res.data.error || 'Save failed');
        }
      } catch (err) {
        const body = err.response?.data || {};
        Vue.set(this.tmplError, name, body.message || body.error || err.message || 'Save failed');
      } finally {
        Vue.set(this.tmplPending, name, false);
      }
    },
    // ── Import for Seeding ───────────────────────────────────────────
    seedClickPicker() {
      this.$refs.seedFileInput.click();
    },
    onSeedFilePick(ev) {
      const files = Array.from(ev.target.files || []);
      // Reset the input so picking the same filename again re-fires
      // the change event.
      ev.target.value = '';
      this.seedProcessFiles(files);
    },
    onSeedDrop(ev) {
      this.seedIsDragOver = false;
      const files = Array.from(ev.dataTransfer?.files || []);
      this.seedProcessFiles(files);
    },
    seedChipClass(outcome) {
      switch (outcome) {
        case 'seeded':            return 'status-verified';
        case 'partial_match':     return 'status-inferred';
        case 'already_in_daemon': return 'status-inferred';
        case 'no_match':          return 'status-unconfirmed';
        case 'invalid_torrent':   return 'status-unconfirmed';
        case 'daemon_error':      return 'status-unconfirmed';
        default:                  return 'status-unconfirmed';
      }
    },
    seedChipLabel(outcome) {
      switch (outcome) {
        case 'seeded':            return '✓ Seeding';
        case 'partial_match':     return '~ Partial';
        case 'already_in_daemon': return '⊝ Already there';
        case 'no_match':          return '✗ Not found';
        case 'invalid_torrent':   return '✗ Invalid';
        case 'daemon_error':      return '✗ Daemon error';
        default:                  return outcome;
      }
    },
    seedClearResults() {
      this.seedResults = [];
    },
    async seedProcessFiles(files) {
      const torrents = files.filter(f => /\.torrent$/i.test(f.name));
      if (torrents.length === 0) {
        iziToast.warning({
          title: 'Drop .torrent files only', position: 'topCenter', timeout: 2500
        });
        return;
      }
      // Seed the results array with placeholder rows; the workers
      // below patch each row in place when its request resolves so
      // the operator sees "checking…" badges first, then outcomes
      // as they land. Preserves drop order in the UI.
      const startIdx = this.seedResults.length;
      for (const f of torrents) {
        this.seedResults.push({ filename: f.name, pending: true });
      }
      const queue = torrents.map((file, i) => ({ file, idx: startIdx + i }));
      const workers = [];
      for (let i = 0; i < this.seedConcurrency; i++) {
        workers.push(this._seedWorker(queue));
      }
      await Promise.all(workers);
    },
    async _seedWorker(queue) {
      // Workers pull from the shared queue array; an empty queue
      // means the worker is done. Each request is independent, so
      // we don't have to coordinate failures across workers — the
      // catch below patches the individual row and moves on.
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) { return; }
        this.seedRunningCount++;
        try {
          const fd = new FormData();
          fd.append('torrentFile', item.file);
          if (this.seedSelectedVpaths.length > 0) {
            fd.append('vpaths', JSON.stringify(this.seedSelectedVpaths));
          }
          const res = await API.axios({
            method: 'POST',
            url:    `${API.url()}/api/v1/admin/torrent/seed-existing`,
            data:   fd,
          });
          // axios + the route's "every outcome is HTTP 200" contract:
          // the body always has {ok:true, outcome:...}. Patch the row
          // in place. Vue.set is required because seedResults entries
          // were added before the worker started, and direct property
          // assignment on a non-reactive object wouldn't trigger a
          // re-render.
          Vue.set(this.seedResults, item.idx, {
            filename: item.file.name,
            pending:  false,
            ...res.data,
          });
        } catch (err) {
          // HTTP-level failure (network drop, 4xx pre-route-handler
          // like multipart parse error). Surface as a synthetic
          // outcome so the row's still readable.
          const body = err.response?.data || {};
          Vue.set(this.seedResults, item.idx, {
            filename: item.file.name,
            pending:  false,
            outcome:  body.error || 'daemon_error',
            error:    body.message || err.message || 'Request failed',
          });
        } finally {
          this.seedRunningCount--;
          // Refresh the torrents list too so newly-seeded entries
          // appear without a manual click. Cheap; reuses the same
          // ADMINDATA cache the Torrents card consumes.
          ADMINDATA.getTorrentList().catch(() => {});
        }
      }
    },

    async refreshList() {
      this.listRefreshPending = true;
      // Reset the soft cap so a stale "Show all" from a previous
      // session doesn't silently re-render thousands of rows when the
      // operator hits Refresh.
      this.listVisibleCap = 100;
      try {
        await ADMINDATA.getTorrentList();
        if (this.list.error) {
          iziToast.error({ title: this.list.error, position: 'topCenter', timeout: 3500 });
        }
      } finally {
        this.listRefreshPending = false;
      }
    },
    // ── Remove (managed-only, no data) ──────────────────────────────
    // The confirm() dialog is intentionally explicit about the
    // "files stay on disk" contract — operators have been burned by
    // other tools where "remove" silently means "remove + delete data".
    async removeTorrent(t) {
      if (!t || !t.managedByMstream) { return; }
      const yes = window.confirm(
        `Remove "${t.name}" from ${this.params.client}?\n\n` +
        `Files on disk will be KEPT — only the daemon's record of the torrent is dropped.\n` +
        `Use the daemon's own UI if you want to delete the files.`
      );
      if (!yes) { return; }
      Vue.set(this.removePending, t.infoHash, true);
      try {
        const res = await API.axios({
          method: 'DELETE',
          url:    `${API.url()}/api/v1/admin/torrent/${encodeURIComponent(t.infoHash)}`,
        });
        const body = res.data || {};
        if (body.daemonRemoveOk === false) {
          // Managed row was dropped but the daemon-side delete failed.
          // Surface as a warning rather than success so the operator
          // knows the daemon may still have the torrent in its session.
          iziToast.warning({
            title:    `${t.name}: mStream record removed, daemon-side delete failed`,
            message:  body.daemonRemoveError || 'See server logs',
            position: 'topCenter', timeout: 5500,
          });
        } else {
          iziToast.success({
            title:    `Removed ${t.name}`,
            message:  'Files on disk kept',
            position: 'topCenter', timeout: 3000,
          });
        }
        await ADMINDATA.getTorrentList();
      } catch (err) {
        const body = err.response?.data || {};
        iziToast.error({
          title:    body.message || body.error || err.message || 'Remove failed',
          position: 'topCenter', timeout: 4000,
        });
      } finally {
        Vue.delete(this.removePending, t.infoHash);
      }
    },
    showMore() { this.listVisibleCap += 100; },
    showAll()  { this.listVisibleCap = Infinity; },
    formatRate(bytesPerSec) {
      // KB/s when small, MB/s once we cross the megabyte line. Two
      // levels is enough for residential connection rates.
      if (!bytesPerSec) { return '—'; }
      if (bytesPerSec >= 1024 * 1024) { return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s'; }
      return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    },
    formatSize(bytes) {
      if (!bytes) { return '0 B'; }
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let v = bytes;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(i >= 2 ? 2 : 0) + ' ' + u[i];
    },
    async refreshStatus() {
      // Used by Transmission, qBittorrent, and Deluge status cards.
      // The pending flag flips based on which client is active so
      // only the right button shows "Testing…" while the call is
      // in flight.
      const client = this.params.client;
      const setBusy = v => {
        if (client === 'qbittorrent')     { this.qTestPending = v; }
        else if (client === 'deluge')     { this.dTestPending = v; }
        else                              { this.tTestPending = v; }
      };
      const label = client === 'qbittorrent' ? 'qBittorrent'
                  : client === 'deluge'      ? 'Deluge'
                  :                            'Transmission';
      setBusy(true);
      try {
        await ADMINDATA.getTorrentStatus();
        if (this.status.connected) {
          iziToast.success({
            title: `Reachable${this.status.version ? ` (${label} ${this.status.version})` : ''}`,
            position: 'topCenter', timeout: 3000
          });
        } else {
          iziToast.error({
            title: this.status.reason || 'Not reachable',
            position: 'topCenter', timeout: 4000
          });
        }
      } finally {
        setBusy(false);
      }
    },
    // ── qBittorrent backend actions ──────────────────────────────────
    _qCredsFromForm() {
      return {
        host:     this.qForm.host,
        port:     this.qForm.port,
        username: this.qForm.username,
        password: this.qForm.password,
        useHttps: !!this.qForm.useHttps,
      };
    },
    async testQbittorrent() {
      this.qFormError = null;
      this.qTestPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/qbittorrent/test`,
          data: this._qCredsFromForm(),
        });
        if (res.data.ok) {
          iziToast.success({
            title: `Reachable${res.data.version ? ' (qBittorrent ' + res.data.version + ')' : ''}`,
            position: 'topCenter', timeout: 3000
          });
        } else {
          this.qFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.qFormError = err.message || 'Request failed';
      } finally {
        this.qTestPending = false;
      }
    },
    async connectQbittorrent() {
      this.qFormError = null;
      this.qConnectPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/qbittorrent/connect`,
          data: this._qCredsFromForm(),
        });
        if (res.data.ok) {
          await ADMINDATA.getTorrentParams();
          await ADMINDATA.getTorrentStatus();
          await ADMINDATA.getTorrentVpathAccess();
          await ADMINDATA.getTorrentList();
          iziToast.success({
            title: `Connected${res.data.version ? ' to qBittorrent ' + res.data.version : ''}`,
            position: 'topCenter', timeout: 3500
          });
          this.qForm.password = '';
        } else {
          this.qFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.qFormError = err.message || 'Request failed';
      } finally {
        this.qConnectPending = false;
      }
    },
    async disconnectQbittorrent() {
      this.qDisconnectPending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/qbittorrent/disconnect`,
        });
        await ADMINDATA.getTorrentParams();
        await ADMINDATA.getTorrentStatus();
        await ADMINDATA.getTorrentList();
        iziToast.success({ title: 'Disconnected', position: 'topCenter', timeout: 2500 });
      } catch (err) {
        iziToast.error({ title: 'Failed to disconnect', position: 'topCenter', timeout: 3500 });
      } finally {
        this.qDisconnectPending = false;
      }
    },
    // ── Deluge backend actions ───────────────────────────────────────
    _dCredsFromForm() {
      return {
        host:     this.dForm.host,
        port:     this.dForm.port,
        password: this.dForm.password,
        useHttps: !!this.dForm.useHttps,
      };
    },
    async testDeluge() {
      this.dFormError = null;
      this.dTestPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/deluge/test`,
          data: this._dCredsFromForm(),
        });
        if (res.data.ok) {
          iziToast.success({
            title: `Reachable${res.data.version ? ' (Deluge ' + res.data.version + ')' : ''}`,
            position: 'topCenter', timeout: 3000
          });
        } else {
          this.dFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.dFormError = err.message || 'Request failed';
      } finally {
        this.dTestPending = false;
      }
    },
    async connectDeluge() {
      this.dFormError = null;
      this.dConnectPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/deluge/connect`,
          data: this._dCredsFromForm(),
        });
        if (res.data.ok) {
          await ADMINDATA.getTorrentParams();
          await ADMINDATA.getTorrentStatus();
          await ADMINDATA.getTorrentVpathAccess();
          await ADMINDATA.getTorrentList();
          iziToast.success({
            title: `Connected${res.data.version ? ' to Deluge ' + res.data.version : ''}`,
            position: 'topCenter', timeout: 3500
          });
          this.dForm.password = '';
        } else {
          this.dFormError = res.data.message || res.data.error || 'Unknown error';
        }
      } catch (err) {
        this.dFormError = err.message || 'Request failed';
      } finally {
        this.dConnectPending = false;
      }
    },
    async disconnectDeluge() {
      this.dDisconnectPending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/torrent/deluge/disconnect`,
        });
        await ADMINDATA.getTorrentParams();
        await ADMINDATA.getTorrentStatus();
        await ADMINDATA.getTorrentList();
        iziToast.success({ title: 'Disconnected', position: 'topCenter', timeout: 2500 });
      } catch (err) {
        iziToast.error({ title: 'Failed to disconnect', position: 'topCenter', timeout: 3500 });
      } finally {
        this.dDisconnectPending = false;
      }
    },
  }
});

// ── Backup destinations (V28) ──────────────────────────────────────────────
// Lives in its own admin section. Lets operators register one or more local
// mirror destinations per library (typically: a second drive on the same
// host), pick a trigger (after-scan / daily / manual), and watch run history.
//
// Path picking reuses the existing fileExplorerModal — the modal already
// renders the Windows drive picker (winDrives, populated server-side via
// `wmic logicaldisk`) and a directory browser everywhere else, so no
// platform-specific code is needed in the view itself.
//
// Path validation is two-layered:
//   1. A debounced /check-path POST as the operator edits/picks the dest,
//      surfacing hard errors and soft warnings inline before submission.
//      The "same drive as source" warning is the most operationally useful
//      one — it catches the failure mode where a single disk failure loses
//      both copies of the music library.
//   2. The same checks run on the actual create endpoint, so a determined
//      user bypassing the UI still can't store an invalid configuration.
const backupView = Vue.component('backup-view', {
  data() {
    return {
      // List + spinner gate (same idiom as foldersView)
      destinationsTS: ADMINDATA.backupDestinationsUpdated,
      destinations: ADMINDATA.backupDestinations,
      status: ADMINDATA.backupStatus,
      platform: ADMINDATA.backupPlatform,

      // Add-form state
      sharedSelect: ADMINDATA.sharedSelect,
      folders: ADMINDATA.folders,
      libraryName: '',                // selected vpath (resolves to library_id at submit)
      destPath: '',
      triggerType: 'after-scan',
      dailyAtHour: 3,                 // 3am — quiet hour, picked when trigger=daily
      retentionDays: 30,
      // Comma-separated patterns the user can edit. Seeded from the
      // server's default list (GET /backup/platform) so a fresh form
      // shows what a fresh destination would actually exclude; when the
      // user leaves it untouched, submitForm omits excludeGlobs so the
      // row stores NULL and tracks future default changes. The platform
      // fetch fires at page load, so it has normally landed long before
      // this view mounts — the serverDefaultExcludes watcher below
      // covers the race when it hasn't.
      excludePatternsCsv: (ADMINDATA.backupPlatform.defaultExcludes || []).join(', '),
      // 0 = no throttle. The form helper text frames "200ms" as a
      // sensible value for users who want to keep streaming smooth
      // during a backup; we don't pre-fill that as a default because
      // most users don't care about backup-vs-streaming contention.
      interFileDelayMs: 0,
      submitPending: false,

      // Live validation state — refreshed by checkPath() on path change.
      // errors block submission; warnings are informational.
      checkPending: false,
      checkErrors: [],
      checkWarnings: [],
      checkInfo: null,
      checkDebounceTimer: null,

      // Polling — the live status row updates every 2s while a run is
      // active so the operator sees progress without manually refreshing.
      pollTimer: null,
    };
  },
  template: `
    <div>
      <!-- BETA notice. The feature shipped with caveats — telling the
           operator now sets expectations for any UI/config changes that
           land in subsequent releases. -->
      <div class="row" style="margin:8px 16px 0 16px">
        <div class="col s12" style="background:#fff8e1;border-left:4px solid #f9a825;padding:10px 14px;border-radius:2px">
          <strong style="color:#f57f17;letter-spacing:0.5px;font-size:12px">BETA</strong>
          <span style="margin-left:8px;font-size:13px">
            The backup feature is new and the configuration UI may change in a future release.
            Existing destinations will keep working, but expect some fields and behaviours to evolve
            as we get feedback. Please report bugs or suggestions on GitHub.
          </span>
        </div>
      </div>

      <!-- Live progress card. Renders only while a backup is active.
           The destinations table below shows the same run's row in less
           detail (last-run summary + history link); this card is the
           prominent at-a-glance "what's happening right now" view. -->
      <div v-if="status.active" class="container">
        <div class="card-panel" style="background:#e3f2fd;border-left:4px solid #1976d2;padding:14px 18px">
          <div style="display:flex;align-items:center;flex-wrap:wrap;margin-bottom:8px">
            <strong style="font-size:15px;letter-spacing:0.3px">Backup running</strong>
            <span style="margin-left:auto;font-size:12px;color:#555" :title="status.active.startedAt">
              {{ formatElapsed(status.active.startedAt) }} elapsed
            </span>
          </div>
          <div style="margin-bottom:8px;font-size:13px">
            <strong>{{ status.active.libraryName }}</strong>
            <span style="color:#888">→</span>
            <code style="font-size:12px">{{ status.active.destPath }}</code>
            <span style="margin-left:8px;font-size:11px;color:#777">trigger: {{ status.active.triggerReason }}</span>
          </div>
          <div class="progress" style="margin:6px 0;background-color:#bbdefb">
            <div v-if="progressPercent !== null" class="determinate" :style="{ width: progressPercent + '%' }"></div>
            <div v-else class="indeterminate"></div>
          </div>
          <div style="font-size:13px;margin-top:6px">
            <span><strong>{{ status.active.filesCopied }}</strong> copied</span>
            <span style="margin-left:14px"><strong>{{ status.active.filesUnchanged }}</strong> unchanged</span>
            <span style="margin-left:14px"><strong>{{ status.active.filesTrashed }}</strong> trashed</span>
            <span v-if="progressPercent !== null" style="margin-left:14px;color:#1976d2">
              <strong>{{ progressPercent }}%</strong>
              <span style="color:#666">({{ progressDone }}/{{ status.active.expectedFiles }})</span>
            </span>
          </div>
          <div style="font-size:12px;color:#555;margin-top:4px">
            <span v-if="status.active.bytesCopied > 0">
              {{ formatBytesShort(status.active.bytesCopied) }} written
            </span>
            <span v-else style="color:#888">no bytes written yet (worker may be checking unchanged files)</span>
          </div>
        </div>
      </div>

      <!-- Queued notice. Tasks are waiting (most commonly behind a scan,
           since the task-queue mutex blocks scan ⇄ backup overlap). -->
      <div v-else-if="status.queueLength > 0" class="container">
        <div class="card-panel grey lighten-4" style="border-left:4px solid #9e9e9e;padding:10px 14px;font-size:13px">
          <strong>{{ status.queueLength }}</strong>
          {{ status.queueLength === 1 ? 'task' : 'tasks' }} queued — waiting for the active scan or backup to finish.
        </div>
      </div>

      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Add backup destination</span>
                <p class="grey-text" style="margin-top:-8px">
                  Pick a folder on a different drive — typically a second internal disk or an external USB drive.
                  After-scan triggers fire automatically every time the library finishes scanning.
                  <br><br>
                  Tip: add multiple destinations to back up the same library to several drives, or different libraries to different drives. Each destination has its own settings and history.
                </p>

                <form @submit.prevent="submitForm">
                  <div class="row">
                    <div class="input-field col s12 m6">
                      <select v-model="libraryName" id="backup-library" class="browser-default">
                        <option value="" disabled>Select a library</option>
                        <option v-for="(v, k) in folders" :value="k">{{ k }} — {{ v.root }}</option>
                      </select>
                    </div>
                    <div class="input-field col s12 m6">
                      <select v-model="triggerType" id="backup-trigger" class="browser-default">
                        <option value="after-scan">Run after each library scan</option>
                        <option value="daily">Run daily at a specific hour</option>
                        <option value="manual">Manual only (no automatic runs)</option>
                      </select>
                    </div>
                  </div>

                  <div class="row">
                    <div class="input-field col s12">
                      <input v-on:click="addPathDialog()" v-model="destPath" id="backup-dest-path" required type="text" class="validate" autocomplete="off">
                      <label for="backup-dest-path" :class="{ active: destPath }">Destination folder</label>
                      <span class="helper-text">Click to browse. Must not be inside the source library.</span>
                    </div>
                  </div>

                  <div class="row">
                    <div class="input-field col s6 m3" v-if="triggerType === 'daily'">
                      <input v-model.number="dailyAtHour" id="backup-daily-hour" required type="number" min="0" max="23" class="validate">
                      <label for="backup-daily-hour" class="active">Hour (0–23)</label>
                    </div>
                    <div class="input-field col s6 m3">
                      <input v-model.number="retentionDays" id="backup-retention" type="number" min="0" class="validate">
                      <label for="backup-retention" class="active">Retention (days)</label>
                      <span class="helper-text">Days deleted/changed files stay recoverable in the backup's trash. 0 = no trash: old copies are deleted immediately and unrecoverably.</span>
                    </div>
                    <div class="input-field col s6 m3">
                      <input v-model.number="interFileDelayMs" id="backup-throttle" type="number" min="0" max="60000" class="validate">
                      <label for="backup-throttle" class="active">Throttle (ms/file)</label>
                      <span class="helper-text">0 = off. ~200 keeps streaming smooth during backups.</span>
                    </div>
                  </div>

                  <div class="row">
                    <div class="input-field col s12">
                      <input v-model="excludePatternsCsv" id="backup-exclude" type="text" autocomplete="off">
                      <label for="backup-exclude" class="active">Exclude patterns</label>
                      <span class="helper-text">
                        Comma-separated globs matched against filenames (case-insensitive).
                        <code>*</code> = any chars, <code>?</code> = single char.
                        Defaults skip OS detritus (<code>Thumbs.db</code>, <code>desktop.ini</code>, etc.).
                        Leave blank to back up everything.
                      </span>
                    </div>
                  </div>

                  <div v-if="checkPending" class="row" style="color:#888">
                    <div class="col s12">Checking path…</div>
                  </div>
                  <div v-if="!checkPending && checkErrors.length > 0" class="row">
                    <div class="col s12" style="background:#ffebee;border-left:4px solid #c62828;padding:8px 12px">
                      <strong style="color:#c62828">Cannot save:</strong>
                      <ul style="margin:4px 0 0 0">
                        <li v-for="e in checkErrors" :key="e">{{ e }}</li>
                      </ul>
                    </div>
                  </div>
                  <div v-if="!checkPending && checkErrors.length === 0 && checkWarnings.length > 0" class="row">
                    <div class="col s12" style="background:#fff8e1;border-left:4px solid #f9a825;padding:8px 12px">
                      <strong style="color:#f57f17">Heads up:</strong>
                      <ul style="margin:4px 0 0 0">
                        <li v-for="w in checkWarnings" :key="w">{{ w }}</li>
                      </ul>
                    </div>
                  </div>

                  <div class="row">
                    <button class="btn green waves-effect waves-light col m4 s12" type="submit"
                            :disabled="submitPending || checkPending || checkErrors.length > 0 || !libraryName || !destPath || !numbersValid">
                      {{ submitPending ? 'Adding…' : 'Add destination' }}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-show="destinationsTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-show="destinationsTS.ts > 0" class="row">
        <div class="col s12">
          <h5>Configured destinations</h5>
          <p v-if="destinations.length === 0" class="grey-text">No destinations yet — add one above.</p>
          <table v-else>
            <thead>
              <tr>
                <th>Library</th>
                <th>Destination</th>
                <th>Trigger</th>
                <th>Retention</th>
                <th title="Per-file delay applied during backup. 0 = no throttle. Helps keep streaming playback smooth during a backup at the cost of slower backup runs.">Throttle</th>
                <th>Excludes</th>
                <th>Last run</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in destinations" :key="d.id" :class="{ 'backup-row-active': status.active && status.active.destinationId === d.id }">
                <td>{{ d.library_name }}</td>
                <td><code style="font-size:12px">{{ d.dest_path }}</code></td>
                <td>{{ formatTrigger(d) }}</td>
                <td>{{ d.retention_days === 0 ? 'hard delete' : d.retention_days + 'd' }}</td>
                <td>
                  <input type="number" min="0" max="60000"
                         :value="d.inter_file_delay_ms || 0"
                         @change="setThrottle(d, $event)"
                         style="margin:0;display:inline-block;width:70px;height:28px;font-size:13px;padding:0 4px"
                         :title="(d.inter_file_delay_ms || 0) === 0 ? 'No throttle' : (d.inter_file_delay_ms + 'ms between files')">
                  <span class="grey-text" style="font-size:11px">ms</span>
                </td>
                <td :title="(d.excludeGlobs || []).join(', ')" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  <span v-if="(d.excludeGlobs || []).length === 0" class="grey-text">none</span>
                  <span v-else>{{ (d.excludeGlobs || []).join(', ') }}</span>
                </td>
                <td>
                  <span v-if="status.active && status.active.destinationId === d.id" style="color:#1976d2">running…</span>
                  <span v-else-if="!d.lastRun" class="grey-text">never</span>
                  <span v-else :title="d.lastRun.error_message || ''" :style="{ color: statusColor(d.lastRun.status) }">
                    {{ d.lastRun.status }}
                    <!-- failed/skipped rows have zero counts → empty summary;
                         suppress the parens rather than render "failed ()" -->
                    <span v-if="formatRunSummary(d.lastRun)" class="grey-text" style="font-size:11px">({{ formatRunSummary(d.lastRun) }})</span>
                  </span>
                </td>
                <td>
                  <select :value="d.enabled ? 'true' : 'false'"
                          v-on:change="setEnabled(d, $event)"
                          style="margin:0;display:inline-block;width:auto;height:28px;font-size:13px">
                    <option value="true">on</option>
                    <option value="false">off</option>
                  </select>
                </td>
                <td>
                  [<a v-on:click="showEditDestination(d)">Edit</a>]
                  <!-- A disabled destination always 400s on /run — grey the
                       link out instead of offering a dead button. -->
                  [<a v-if="d.enabled" v-on:click="runNow(d)">Run now</a><span v-else class="grey-text" style="cursor:default" title="Destination is disabled — set Enabled to 'on' to run it">Run now</span>]
                  [<a v-on:click="showHistory(d)">History</a>]
                  [<a v-on:click="removeDestination(d)" style="color:#c62828">Delete</a>]
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `,
  watch: {
    // sharedSelect is mutated by fileExplorerModal when the user picks a path.
    // We watch it to populate the form. (No scheduleCheck here — setting
    // destPath fires the destPath watcher below; a second call would
    // just reset the same debounce timer.)
    'sharedSelect.value': function (newVal) {
      if (newVal) {
        this.destPath = newVal;
      }
    },
    // Re-validate on ANY path change — picked via the dialog or typed/
    // edited by hand. Without this, manual edits left checkErrors stale
    // in both directions: a fixed path never re-enabled the submit
    // button, and a broken path kept it enabled until the server 400'd.
    destPath: function () { this.scheduleCheck(); },
    // Re-check when library changes — sameDrive detection depends on the
    // source path which comes from the selected library.
    libraryName: function () { this.scheduleCheck(); },
    // Late-arriving platform data (view mounted before the boot-time
    // fetch landed): seed the patterns field, but only if the user
    // hasn't already typed into it.
    serverDefaultExcludes: function (newVal, oldVal) {
      if (this.excludePatternsCsv === (oldVal || []).join(', ')) {
        this.excludePatternsCsv = (newVal || []).join(', ');
      }
    },
  },
  created: function () {
    // Reset the shared select so a stale value from another view doesn't
    // get accidentally consumed by our form.
    ADMINDATA.sharedSelect.value = '';
    // Refresh on view entry so users see fresh data after navigating away
    // and back. Cheap (single SELECT on a tiny table).
    ADMINDATA.getBackupDestinations();
    // Poll status while this view is mounted. 2s is fast enough for live
    // feedback on a manual "Run now" without hammering the server.
    this.pollTimer = setInterval(() => {
      ADMINDATA.getBackupStatus();
      // While a run is active, also refresh the destinations list so the
      // last-run summary updates as soon as the worker finishes.
      if (this.status.active) {
        ADMINDATA.getBackupDestinations();
      }
    }, 2000);
  },
  beforeDestroy: function () {
    if (this.pollTimer) { clearInterval(this.pollTimer); }
    if (this.checkDebounceTimer) { clearTimeout(this.checkDebounceTimer); }
  },
  computed: {
    // The live default exclude list, from GET /backup/platform. Null
    // until that fetch lands (see the watcher that handles the race).
    serverDefaultExcludes() {
      return this.platform.defaultExcludes;
    },
    // Client-side mirror of the server's numeric constraints so the
    // form catches them inline instead of round-tripping to a Joi 400
    // toast. v-model.number yields '' for a cleared field, which
    // Number.isInteger correctly rejects.
    numbersValid() {
      const hourOk = this.triggerType !== 'daily'
        || (Number.isInteger(this.dailyAtHour) && this.dailyAtHour >= 0 && this.dailyAtHour <= 23);
      const retentionOk = Number.isInteger(this.retentionDays) && this.retentionDays >= 0;
      const throttleOk = Number.isInteger(this.interFileDelayMs)
        && this.interFileDelayMs >= 0 && this.interFileDelayMs <= 60000;
      return hourOk && retentionOk && throttleOk;
    },
    // Sum of all entries the active run has processed so far. Lines
    // up with the denominator (status.active.expectedFiles), which is
    // the previous successful run's copied+unchanged+trashed total.
    progressDone() {
      const a = this.status.active;
      if (!a) { return 0; }
      return (a.filesCopied || 0) + (a.filesUnchanged || 0) + (a.filesTrashed || 0);
    },
    // null = render an indeterminate spinner (first-ever run for this
    // destination, or expectedFiles missing for any reason). Otherwise
    // an integer 0..100. Clamped because real-world runs sometimes
    // overshoot the previous-run estimate (a few new files in source).
    progressPercent() {
      const a = this.status.active;
      if (!a || !a.expectedFiles) { return null; }
      const pct = Math.round((this.progressDone / a.expectedFiles) * 100);
      return Math.max(0, Math.min(100, pct));
    },
  },
  methods: {
    // SQLite's datetime('now') stores UTC 'YYYY-MM-DD HH:MM:SS'. The
    // status endpoint passes that string through verbatim; parse as
    // UTC and compare to wall-clock now to get elapsed time.
    formatElapsed(startedAt) {
      if (!startedAt) { return ''; }
      const start = new Date(startedAt.replace(' ', 'T') + 'Z');
      const ms = Math.max(0, Date.now() - start.getTime());
      if (ms < 60_000) { return Math.floor(ms / 1000) + 's'; }
      if (ms < 3_600_000) {
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return m + 'm ' + s + 's';
      }
      const h = Math.floor(ms / 3_600_000);
      const mm = Math.floor((ms % 3_600_000) / 60_000);
      return h + 'h ' + mm + 'm';
    },
    formatBytesShort(n) {
      if (!n) { return '0 B'; }
      if (n < 1024) { return n + ' B'; }
      if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
      if (n < 1024 * 1024 * 1024) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    },
    formatTrigger(d) {
      if (d.trigger_type === 'after-scan') { return 'after each scan'; }
      if (d.trigger_type === 'daily') { return `daily at ${String(d.daily_at_hour).padStart(2, '0')}:00`; }
      return 'manual only';
    },
    formatRunSummary(run) {
      const parts = [];
      if (run.files_copied > 0) { parts.push(`${run.files_copied} copied`); }
      if (run.files_unchanged > 0) { parts.push(`${run.files_unchanged} unchanged`); }
      if (run.files_trashed > 0) { parts.push(`${run.files_trashed} trashed`); }
      if (parts.length === 0 && run.status === 'success') { parts.push('no changes'); }
      return parts.join(', ');
    },
    statusColor(status) {
      return status === 'success' ? '#2e7d32'
           : status === 'failed' ? '#c62828'
           : status === 'partial' ? '#e65100'
           : status === 'skipped' ? '#f57f17'
           : '#1976d2';
    },
    addPathDialog() {
      ADMINDATA.sharedSelect.value = '';
      modVM.currentViewModal = 'file-explorer-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    // Debounce path checks so we don't fire one per keystroke. 400ms feels
    // responsive without being chatty — most users either click "Browse"
    // (one event) or type once and stop. checkPending is raised HERE, not
    // in checkPath, so the submit gate blocks for the whole debounce
    // window — otherwise an edit followed by a quick submit would race
    // the timer and go out against the previous path's stale results.
    scheduleCheck() {
      this.checkPending = true;
      if (this.checkDebounceTimer) { clearTimeout(this.checkDebounceTimer); }
      this.checkDebounceTimer = setTimeout(() => this.checkPath(), 400);
    },
    async checkPath() {
      if (!this.libraryName || !this.destPath) {
        this.checkErrors = [];
        this.checkWarnings = [];
        this.checkInfo = null;
        this.checkPending = false;
        return;
      }
      const lib = this.folders[this.libraryName];
      // Match by name → id via the libraries cache. Backend endpoints take
      // numeric library ids; the UI uses the vpath name as the key. If the
      // cache has no id (structure drift), skip the live check; submit
      // still validates server-side.
      if (!lib || !lib.id) {
        this.checkPending = false;
        return;
      }
      const libraryId = lib.id;
      try {
        this.checkPending = true;
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/backup/check-path`,
          data: { libraryId, destPath: this.destPath },
        });
        this.checkErrors = res.data.errors || [];
        this.checkWarnings = res.data.warnings || [];
        this.checkInfo = res.data.info || null;
      } catch (err) {
        this.checkErrors = [err.response?.data?.error || err.message || 'Path check failed'];
      } finally {
        this.checkPending = false;
      }
    },
    // Convert the comma-separated input into the array shape the API
     // expects. Trims whitespace, drops empties — so `Thumbs.db, , *.tmp`
    // sends `["Thumbs.db", "*.tmp"]`.
    parseExcludeCsv(csv) {
      return String(csv || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
    async submitForm() {
      const lib = this.folders[this.libraryName];
      if (!lib) { return; }
      // An untouched patterns field means "the defaults" — OMIT
      // excludeGlobs so the row stores NULL and tracks future default
      // changes (the API's three-state semantics: omitted → NULL →
      // defaults at read time; [] → exclude nothing; array → pinned).
      // Sending the parsed copy instead would pin today's snapshot,
      // which the edit modal's "Reset patterns to defaults" button
      // exists to undo. undefined keys drop out of the JSON body.
      const parsedExcludes = this.parseExcludeCsv(this.excludePatternsCsv);
      // If the platform fetch never landed the field seeded empty — treat
      // blank as untouched there too (omit → defaults): pinning "exclude
      // nothing" should require having SEEN the defaults and cleared them.
      const isDefaultExcludes = this.serverDefaultExcludes
        ? JSON.stringify(parsedExcludes) === JSON.stringify(this.serverDefaultExcludes)
        : parsedExcludes.length === 0;
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/backup/destinations`,
          data: {
            libraryId: lib.id,
            destPath: this.destPath,
            triggerType: this.triggerType,
            dailyAtHour: this.triggerType === 'daily' ? this.dailyAtHour : undefined,
            retentionDays: this.retentionDays,
            enabled: true,
            excludeGlobs: isDefaultExcludes ? undefined : parsedExcludes,
            interFileDelayMs: this.interFileDelayMs,
          },
        });
        iziToast.success({ title: 'Destination added', position: 'topCenter', timeout: 2500 });
        this.libraryName = '';
        this.destPath = '';
        this.triggerType = 'after-scan';
        this.dailyAtHour = 3;
        this.retentionDays = 30;
        this.interFileDelayMs = 0;
        this.excludePatternsCsv = (this.serverDefaultExcludes || []).join(', ');
        this.checkErrors = [];
        this.checkWarnings = [];
        await ADMINDATA.getBackupDestinations();
      } catch (err) {
        iziToast.error({
          title: err.response?.data?.error || 'Failed to add destination',
          position: 'topCenter',
          timeout: 4000,
        });
      } finally {
        this.submitPending = false;
      }
    },
    async showEditDestination(dest) {
      ADMINDATA.selectedBackupDest = dest;
      modVM.currentViewModal = 'backup-edit-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    async setEnabled(dest, event) {
      const enabled = event.target.value === 'true';
      try {
        await API.axios({
          method: 'PATCH',
          url: `${API.url()}/api/v1/admin/backup/destinations/${dest.id}`,
          data: { enabled },
        });
        // Reflect locally without waiting for refetch, so the toggle stays in sync.
        Vue.set(dest, 'enabled', enabled ? 1 : 0);
      } catch (err) {
        // Snap the <select> back: it's :value-bound, so a rejected change
        // isn't reverted by Vue (the underlying data never moved and the
        // vdom sees nothing to patch) — without this the UI keeps showing
        // a state the server refused.
        event.target.value = dest.enabled ? 'true' : 'false';
        iziToast.error({ title: err.response?.data?.error || 'Toggle failed', position: 'topCenter', timeout: 3000 });
      }
    },
    async setThrottle(dest, event) {
      // Clamp client-side to keep an obviously-bad value from round-tripping
      // to the server only to be 400'd back. The server still re-validates.
      const clamped = Math.max(0, Math.min(60000, Math.round(Number(event.target.value) || 0)));
      try {
        await API.axios({
          method: 'PATCH',
          url: `${API.url()}/api/v1/admin/backup/destinations/${dest.id}`,
          data: { interFileDelayMs: clamped },
        });
        Vue.set(dest, 'inter_file_delay_ms', clamped);
        // Show the value that was actually saved. Vue can't be relied on
        // to patch the :value-bound input when the clamp lands on the
        // value the data already held (typed 99999 over a stored 60000).
        event.target.value = clamped;
      } catch (err) {
        event.target.value = dest.inter_file_delay_ms || 0;
        iziToast.error({ title: err.response?.data?.error || 'Throttle update failed', position: 'topCenter', timeout: 3000 });
      }
    },
    async runNow(dest) {
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/backup/destinations/${dest.id}/run`,
        });
        if (res.data.status === 'queued') {
          iziToast.info({ title: 'Backup started', position: 'topCenter', timeout: 2500 });
        } else if (res.data.status === 'skipped') {
          iziToast.warning({ title: 'Skipped — previous run still in progress', position: 'topCenter', timeout: 3000 });
        }
        // Kick a status poll right away so the running state shows up
        // without waiting for the next 2s tick.
        ADMINDATA.getBackupStatus();
      } catch (err) {
        iziToast.error({ title: err.response?.data?.error || 'Run failed', position: 'topCenter', timeout: 3000 });
      }
    },
    async showHistory(dest) {
      ADMINDATA.selectedBackupDest = dest;
      modVM.currentViewModal = 'backup-history-modal';
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    // iziToast renders message as HTML (the <br> tags below rely on it),
    // so anything user-controlled must be escaped before interpolation —
    // dest_path is admin-entered and round-trips verbatim through the API.
    // Stored self-XSS only (admins set these values), but this is the one
    // spot in the backup UI where API data bypasses Vue's auto-escaping.
    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    removeDestination(dest) {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        layout: 2,
        maxWidth: 600,
        title: `Delete backup destination?`,
        message: `${this.escapeHtml(dest.library_name)} → ${this.escapeHtml(dest.dest_path)}<br><br>The destination's existing files on disk are NOT deleted; only the schedule + history record are removed. You can re-add the same path later.`,
        position: 'center',
        buttons: [
          [`<button><b>Delete</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            try {
              await API.axios({
                method: 'DELETE',
                url: `${API.url()}/api/v1/admin/backup/destinations/${dest.id}`,
              });
              await ADMINDATA.getBackupDestinations();
              iziToast.success({ title: 'Deleted', position: 'topCenter', timeout: 2000 });
            } catch (err) {
              iziToast.error({ title: err.response?.data?.error || 'Delete failed', position: 'topCenter', timeout: 3000 });
            }
          }, true],
          [`<button>Cancel</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ],
      });
    },
  },
});

// The Discovery page (Config section of the nav): the p2p network card,
// moved out of the Database page so the network has a home of its own —
// the local-analysis settings (collect/model/per-run) stay with the scan
// settings on the Database page, since they run whether or not p2p is on.
const discoveryView = Vue.component('discovery-view', {
  data() {
    return {
      discoveryP2p: { loaded: false, status: null, peers: [], storage: null, autoFetch: false },
      p2pIdentity: P2PIDENTITY,
      p2pToggling: false,
      peerFilter: ''
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Discovery Network (P2P)</span>
                <div v-if="!discoveryP2p.loaded"><p>Loading…</p></div>
                <div v-else-if="!discoveryP2p.status || discoveryP2p.status.enabled !== true">
                  <p>Join the discovery network to get music recommendations from other people's
                  libraries — the player's Discover panel gains a "From the network" section, and
                  your server appears in the catalog other operators browse.</p>
                  <p><b>What gets shared:</b> a <b>metadata-only</b> snapshot of your library —
                  artist, title, duration, track IDs, and audio "sound fingerprint" embeddings.
                  <b>Never any audio files.</b> Your server's name and description are visible to
                  everyone on the network, and by default the snapshot is published to the public
                  community network.</p>
                  <p>Enabling this also turns on <b>music-discovery data collection</b> (the
                  post-scan analysis that builds the embeddings) if it isn't already on. You can
                  disable the network here at any time; collected data stays local until you
                  re-enable it.</p>
                  <p v-if="discoveryP2p.status && discoveryP2p.status.binaryFound === false" style="color: #b71c1c;">
                    The p2p-sidecar binary was not found for this platform — the network is unavailable.
                  </p>
                  <a v-else v-on:click="enableP2p()" :class="{disabled: p2pToggling}" class="waves-effect waves-light btn green">
                    {{ p2pToggling ? 'Enabling…' : 'Enable Discovery Network' }}
                  </a>
                  <div v-if="p2pToggling" class="progress" style="max-width: 480px; margin: 10px 0 4px 0;"><div class="indeterminate"></div></div>
                </div>
                <div v-else>
                  <p v-if="!discoveryP2p.status.binaryFound" style="color: #b71c1c;">
                    The p2p-sidecar binary was not found for this platform — the network is unavailable.
                  </p>
                  <p><b>Endpoint:</b> <code style="word-break: break-all;">{{ discoveryP2p.status.endpointId || '(sidecar not running yet)' }}</code></p>
                  <p><b>Announcing as:</b> {{ p2pIdentity.serverName }}
                    <span v-if="p2pIdentity.serverDescription"> — {{ p2pIdentity.serverDescription }}</span>
                    <span v-else style="color: #9e9e9e;"> — no description (other servers see only the name)</span>
                    [<a v-on:click="openModal('edit-p2p-identity-modal')">{{ t('admin.settings.edit') }}</a>]
                  </p>
                  <p><b>Network:</b>
                    <span v-if="discoveryP2p.status.neighbors > 0" style="color: #2e7d32;">connected
                      — {{ discoveryP2p.status.neighbors }} mesh neighbor{{ discoveryP2p.status.neighbors === 1 ? '' : 's' }}</span>
                    <span v-else-if="discoveryP2p.status.joined" style="color: #e65100;">joined, waiting for
                      neighbors — the mesh weaves in within a minute or two of another server coming online</span>
                    <span v-else>not joined yet</span>
                  </p>
                  <div v-if="meshSearching" style="max-width: 480px;">
                    <div class="progress" style="margin: 4px 0 6px 0;"><div class="indeterminate"></div></div>
                    <span style="color: #757575; font-size: 0.85em;">searching for peers — this page updates itself every few seconds</span>
                  </div>
                  <p v-if="discoveryP2p.status.ticket"><b>Your ticket</b> — a friend pastes this into their
                  <code>discoveryP2p.bootstrapPeers</code> to befriend this server:<br>
                    <textarea readonly rows="2" style="width:100%; font-size: 0.8em;" onclick="this.select()">{{ discoveryP2p.status.ticket }}</textarea>
                  </p>
                  <p v-if="discoveryP2p.storage"><b>Peer snapshots:</b>
                    {{ discoveryBytes(discoveryP2p.storage.usedBytes) }} of {{ discoveryBytes(discoveryP2p.storage.capBytes) }} used
                    [<a v-on:click="openModal('edit-p2p-max-storage-modal')">{{ t('admin.settings.edit') }}</a>]
                    — auto-fetch {{ discoveryP2p.autoFetch ? 'on' : 'off' }}
                    — community seeds {{ discoveryP2p.status.communitySeeds ? 'on (public network)' : 'off (friends only)' }}
                  </p>
                  <p><b>Forget offline servers:</b>
                    {{ discoveryP2p.status.peerRetentionDays > 0
                      ? 'after ' + discoveryP2p.status.peerRetentionDays + ' days of silence'
                      : 'never (offline servers stay listed forever)' }}
                    [<a v-on:click="openModal('edit-p2p-peer-retention-modal')">{{ t('admin.settings.edit') }}</a>]
                  </p>
                  <div v-if="discoveryP2p.peers.length > 5" class="input-field" style="max-width: 360px; margin: 4px 0 0 0;">
                    <input v-model="peerFilter" id="p2p-peer-filter" type="text" placeholder="Search servers — name or description">
                  </div>
                  <p v-if="peerFilter && discoveryP2p.peers.length > 0" style="color: #757575; font-size: 0.85em; margin: 2px 0;">
                    {{ filteredPeers.length }} of {{ discoveryP2p.peers.length }} servers
                  </p>
                  <table v-if="filteredPeers.length > 0">
                    <thead><tr><th>Server</th><th>Tracks</th><th>Seeders</th><th>Online</th><th>Model</th><th>Downloaded</th><th></th></tr></thead>
                    <tbody>
                      <tr v-for="peer in filteredPeers" :key="peer.from">
                        <td>
                          {{ peer.payload.name || (peer.from.slice(0, 12) + '…') }}
                          <div v-if="peer.payload.description" style="color: #757575; font-size: 0.85em; max-width: 360px;">{{ peer.payload.description }}</div>
                        </td>
                        <td>{{ peer.payload.rowCount }}</td>
                        <td>{{ peer.seeders }}</td>
                        <td :title="peer.updatedAt">{{ peer.online ? 'online' : 'offline' + discoveryAge(peer.updatedAt) }}</td>
                        <td>{{ peer.compatible === null ? 'unknown' : (peer.compatible ? 'compatible' : 'incompatible') }}</td>
                        <td>{{ peer.fetched ? (peer.fetched.stale ? 'update available' : 'yes') : 'no' }}</td>
                        <td>
                          [<a v-on:click="discoveryFetchPeer(peer.from)">{{ peer.fetched ? 'Update' : 'Download' }}</a>]
                          <span v-if="peer.fetched">[<a v-on:click="discoveryRemovePeer(peer.from)">Remove</a>]</span>
                          <span v-if="!peer.online && !peer.fetched">[<a v-on:click="discoveryForgetPeer(peer.from)">Forget</a>]</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-else-if="discoveryP2p.peers.length > 0">No servers match
                    &ldquo;{{ peerFilter }}&rdquo; — [<a v-on:click="peerFilter = ''">clear</a>]</p>
                  <p v-else>No peers heard yet — add a friend's ticket to <code>discoveryP2p.bootstrapPeers</code>
                  (or POST it to the join endpoint) and give gossip a minute.</p>
                  <p>[<a v-on:click="loadDiscoveryP2p()">Refresh</a>]
                  [<a v-on:click="disableP2p()" style="color: #b71c1c;">Disable</a>]</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  computed: {
    // The indeterminate "something is happening" state: the feature is on
    // but the mesh hasn't produced a neighbor yet (sidecar starting, topic
    // joining, or genuinely alone). Once a neighbor exists the numbers
    // speak for themselves and the bar retires.
    meshSearching: function() {
      const s = this.discoveryP2p.status;
      return !!(s && s.enabled === true
        && (!s.running || !s.joined || (s.neighbors || 0) === 0));
    },
    // Case-insensitive substring match over what the operator can see
    // (name, description) plus the endpoint id for exactness. Preserves
    // the server-side seeders/online/size ordering.
    filteredPeers: function() {
      const q = this.peerFilter.trim().toLowerCase();
      if (!q) { return this.discoveryP2p.peers; }
      return this.discoveryP2p.peers.filter((p) =>
        (p.payload.name || '').toLowerCase().includes(q)
        || (p.payload.description || '').toLowerCase().includes(q)
        || p.from.toLowerCase().includes(q));
    },
  },
  created: async function () {
    this.loadDiscoveryP2p();
    // Keep the card live while it's on screen: gossip fills the catalog and
    // the mesh weaves in over ~a minute, and nobody should have to mash
    // Refresh to watch it. Quiet polls (no error toast) so a transient
    // hiccup doesn't nag every 10 seconds; skipped while the tab is hidden
    // and while an enable/disable is in flight.
    this.pollTimer = setInterval(() => {
      if (document.hidden || this.p2pToggling) { return; }
      if (!this.discoveryP2p.status || this.discoveryP2p.status.enabled !== true) { return; }
      this.loadDiscoveryP2p(true);
    }, 10000);
  },
  beforeDestroy: function () {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    // The consent moment. What used to be "edit the config file and
    // restart" is now this dialog — it must say what enabling actually
    // does before anything is published.
    enableP2p: function() {
      iziToast.question({
        timeout: 30000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>Join the discovery network?</b> Your server will publish a metadata-only snapshot of its music library (never audio files) to the public discovery network, with your server's name and description visible to everyone. Music-discovery data collection will also be enabled.`,
        position: 'center',
        buttons: [
          [`<button><b>Enable</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            this.p2pToggling = true;
            try {
              await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/discovery/p2p/enabled`,
                data: { enabled: true }
              });
              iziToast.success({
                title: 'Discovery network enabled',
                message: 'Give the mesh a minute to weave in.',
                position: 'topCenter', timeout: 4000
              });
              await this.loadDiscoveryP2p();
              // Straight into naming the server: 'mStream' next to 18k
              // other 'mStream's is the first thing everyone would want
              // to change, so don't make them find the edit link.
              this.openModal('edit-p2p-identity-modal');
            } catch (err) {
              iziToast.error({
                title: 'Failed to enable the discovery network',
                message: err.response?.data?.error || '',
                position: 'topCenter', timeout: 6000
              });
              this.loadDiscoveryP2p();
            } finally {
              this.p2pToggling = false;
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    disableP2p: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `<b>Leave the discovery network?</b> Your server stops announcing and downloading snapshots. Local discovery features (data collection, the Discover panel) keep working, and already-fetched peer data stays until removed.`,
        position: 'center',
        buttons: [
          [`<button><b>${t('admin.settings.disableButton')}</b></button>`, async (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            this.p2pToggling = true;
            try {
              await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/admin/discovery/p2p/enabled`,
                data: { enabled: false }
              });
              iziToast.success({ title: 'Discovery network disabled', position: 'topCenter', timeout: 3500 });
            } catch (err) {
              iziToast.error({
                title: t('admin.settings.failed'),
                message: err.response?.data?.error || '',
                position: 'topCenter', timeout: 4000
              });
            } finally {
              this.p2pToggling = false;
              this.loadDiscoveryP2p();
            }
          }, true],
          [`<button>${t('admin.folders.goBack')}</button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    loadDiscoveryP2p: async function(quiet) {
      try {
        const status = (await API.axios({
          method: 'GET', url: `${API.url()}/api/v1/admin/discovery/p2p/status`
        })).data;
        this.discoveryP2p.status = status;
        P2PIDENTITY.serverName = status.serverName || '';
        P2PIDENTITY.serverDescription = status.serverDescription || '';
        if (status.maxPeerDbStorageMb) { P2PSETTINGS.maxPeerDbStorageMb = status.maxPeerDbStorageMb; }
        // 0 (= never forget) is a valid value — don't truthiness-check it away.
        if (typeof status.peerRetentionDays === 'number') { P2PSETTINGS.peerRetentionDays = status.peerRetentionDays; }
        if (status.enabled === true) {
          const cat = (await API.axios({
            method: 'GET', url: `${API.url()}/api/v1/admin/discovery/p2p/catalog`
          })).data;
          this.discoveryP2p.peers = cat.peers;
          this.discoveryP2p.storage = cat.storage;
          this.discoveryP2p.autoFetch = cat.autoFetch;
        }
      } catch (err) {
        if (quiet !== true) {
          iziToast.error({ title: 'Failed to load discovery network status', position: 'topCenter', timeout: 3000 });
        }
      }
      this.discoveryP2p.loaded = true;
    },
    discoveryFetchPeer: async function(endpointId) {
      try {
        iziToast.info({ title: 'Downloading peer snapshot…', position: 'topCenter', timeout: 2500 });
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discovery/p2p/peer-dbs/fetch`,
          data: { endpointId }
        });
        iziToast.success({ title: 'Peer snapshot downloaded', position: 'topCenter', timeout: 3000 });
      } catch (err) {
        iziToast.error({
          title: 'Download failed',
          message: err.response?.data?.error || '',
          position: 'topCenter', timeout: 4000
        });
      }
      this.loadDiscoveryP2p();
    },
    discoveryRemovePeer: async function(endpointId) {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discovery/p2p/peer-dbs/remove`,
          data: { endpointId }
        });
      } catch (err) {
        iziToast.error({ title: 'Remove failed', position: 'topCenter', timeout: 3000 });
      }
      this.loadDiscoveryP2p();
    },
    // Drop a dead server from the list right now instead of waiting out
    // the retention window. Harmless by construction: it reappears on its
    // next announcement if it ever comes back.
    discoveryForgetPeer: async function(endpointId) {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discovery/p2p/forget`,
          data: { endpointId }
        });
        iziToast.success({ title: 'Server forgotten — it reappears if it comes back online', position: 'topCenter', timeout: 3500 });
      } catch (err) {
        iziToast.error({
          title: 'Forget failed',
          message: err.response?.data?.error || '',
          position: 'topCenter', timeout: 4000
        });
      }
      this.loadDiscoveryP2p();
    },
    discoveryBytes: function(n) {
      if (typeof n !== 'number' || !isFinite(n)) { return '?'; }
      if (n >= 1073741824) { return (n / 1073741824).toFixed(1) + ' GB'; }
      if (n >= 1048576) { return (n / 1048576).toFixed(1) + ' MB'; }
      return Math.ceil(n / 1024) + ' KB';
    },
    // How long ago a peer was last heard, as a table-cell suffix
    // (' · 3d'). An offline row that's been silent for weeks should read
    // differently from one that dropped off five minutes ago.
    discoveryAge: function(iso) {
      const ms = Date.now() - Date.parse(iso);
      if (!isFinite(ms) || ms < 0) { return ''; }
      const mins = Math.floor(ms / 60000);
      if (mins < 60) { return ' · ' + Math.max(mins, 1) + 'm'; }
      if (mins < 48 * 60) { return ' · ' + Math.floor(mins / 60) + 'h'; }
      return ' · ' + Math.floor(mins / (24 * 60)) + 'd';
    }
  }
});

const irohView = Vue.component('iroh-view', {
  data() {
    return {
      irohTS: ADMINDATA.irohParamsUpdated,
      iroh: ADMINDATA.irohParams,
      togglePending: false,
      rotatePending: false,
    };
  },
  watch: {
    // Re-render the QR whenever fresh status arrives (the ticket changes on
    // enable / secret rotation). $nextTick so the #iroh-qr div exists.
    'irohTS.ts': {
      immediate: true,
      handler() { this.$nextTick(() => this.renderQr()); }
    }
  },
  methods: {
    renderQr() {
      const el = document.getElementById('iroh-qr');
      if (!el) { return; }
      if (this.iroh.enabled && this.iroh.qr && typeof qrcode !== 'undefined') {
        try {
          const qr = qrcode(0, 'L');     // auto version, low EC = max capacity
          qr.addData(this.iroh.qr);
          qr.make();
          el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
          const svg = el.querySelector('svg');
          if (svg) { svg.style.width = '240px'; svg.style.height = '240px'; }
        } catch (e) { el.innerHTML = '<p>Could not render QR.</p>'; }
      } else {
        el.innerHTML = '';
      }
    },
    async toggle() {
      this.togglePending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/iroh`, data: { enabled: !this.iroh.enabled } });
        await ADMINDATA.getIroh();
        if (this.iroh.enabled && this.iroh.available === false) {
          iziToast.warning({ title: 'Unavailable', message: 'Iroh has no prebuilt binary for this server’s platform; the tunnel could not start.' });
        }
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to update Quick Connect setting.' });
      }
      this.togglePending = false;
    },
    async rotate() {
      this.rotatePending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/iroh/rotate-secret`, data: {} });
        await ADMINDATA.getIroh();
        iziToast.success({ title: 'Rotated', message: 'New secret in effect — previously-shared QR codes no longer work.' });
      } catch (e) {
        iziToast.error({ title: 'Error', message: 'Failed to rotate secret.' });
      }
      this.rotatePending = false;
    },
  },
  mounted() { ADMINDATA.getIroh(); },
  template: `
    <div v-if="irohTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else class="container">
      <div class="row" style="margin-top:24px">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Quick Connect</span>
              <p>Reach this server from anywhere with <b>no network configuration</b> — no port-forwarding, dynamic DNS, domain name, or SSL certificate. mStream dials out to the Iroh network; a paired device connects by scanning the code below, and the connection is peer-to-peer and end-to-end encrypted.</p>
              <div class="card-panel amber lighten-4" style="margin-top:8px">
                <p><b>Apps only.</b> Quick Connect works through the mStream mobile/desktop apps.</p>
                <ul class="browser-default" style="margin:8px 0 0 4px">
                  <li>You can't open the web player in a normal browser over this connection.</li>
                  <li><b>Sharing playlists won't work</b> — shared links aren't publicly reachable over the tunnel.</li>
                </ul>
              </div>
              <div v-if="iroh.available === false" class="card-panel orange lighten-4" style="margin-top:16px">
                <p><b>Not available on this platform.</b> The Iroh native component has no prebuilt binary for this server’s OS/CPU, so the tunnel can’t run here. Everything else in mStream is unaffected.</p>
              </div>
              <p><b>Keep the code secret.</b> Anyone who scans it can open a tunnel to this server (your normal mStream login still applies on top). Share it only with your own devices, and rotate it if it leaks.</p>
            </div>
            <div class="card-action flow-root">
              <a v-on:click="toggle()" :class="{disabled: togglePending}" class="waves-effect waves-light btn right">
                {{ iroh.enabled ? 'Turn Off' : 'Turn On' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div v-if="iroh.enabled && iroh.running" class="row">
        <div class="col s12 m6">
          <div class="card">
            <div class="card-content center-align">
              <span class="card-title left-align">Pairing code</span>
              <div id="iroh-qr" style="margin:12px auto"></div>
              <p style="font-size:0.85em;color:#777" class="left-align">Scan from the mStream app, or copy the code into the desktop client.</p>
              <a class="waves-effect waves-light btn-flat iroh-copy-button" :data-clipboard-text="iroh.qr">
                Copy code
              </a>
            </div>
          </div>
        </div>
        <div class="col s12 m6">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Details</span>
              <p style="margin-top:8px"><b>Status:</b>
                <span v-if="iroh.enabled && iroh.running" style="color:#2e7d32">On{{ iroh.online ? ' · connected to relay' : ' · connecting…' }}</span>
                <span v-else style="color:#777">Off</span>
              </p>
              <p style="margin-top:8px"><b>Endpoint ID</b></p>
              <p style="word-break:break-all;font-family:monospace;font-size:0.8em">{{ iroh.endpointId }}</p>
              <p style="margin-top:8px" v-if="iroh.relayUrl"><b>Home relay:</b> {{ iroh.relayUrl }}</p>
              <div style="margin-top:20px">
                <p><b>Rotate secret</b></p>
                <p style="font-size:0.85em;color:#777">Issues a new pairing code and invalidates the current one. Use this if a code leaked or a device should lose access.</p>
                <a v-on:click="rotate()" :class="{disabled: rotatePending}" class="waves-effect waves-light btn red lighten-1" style="margin-top:8px">
                  Rotate secret
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});

// Optional URL-hash deep-link: `/admin/#view=<name>` (or just
// `/admin/#<name>`) opens the matching tab on first paint. Useful for
// bookmarks, support links, and any tooling that wants to drop the user
// on a specific page without the user having to click through the
// sidebar.
function _initialViewFromHash() {
  const valid = new Set([
    'folders-view','users-view','db-view','advanced-view','info-view',
    'transcode-view','federation-view','dlna-view','subsonic-view','iroh-view',
    'torrent-view','logs-view','rpn-view','security-view','backup-view',
    'lyrics-view','discovery-view',
  ]);
  const raw = (location.hash || '').replace(/^#/, '');
  const name = raw.startsWith('view=') ? raw.slice(5) : raw;
  return valid.has(name) ? name : 'folders-view';
}

const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
    'db-view': dbView,
    'advanced-view': advancedView,
    'info-view': infoView,
    'transcode-view': transcodeView,
    'federation-view': federationView,
    'dlna-view': dlnaView,
    'subsonic-view': subsonicView,
    'iroh-view': irohView,
    'discovery-view': discoveryView,
    'torrent-view': torrentView,
    'logs-view': logsView,
    'rpn-view': rpnView,
    'security-view': securityView,
    'backup-view': backupView,
    'lyrics-view': lyricsView,
  },
  data: {
    currentViewMain: _initialViewFromHash(),
    componentKey: false
  }
});

function changeView(viewName, el){
  if (vm.currentViewMain === viewName) { return; }

  document.getElementById('content').scrollTop = 0;
  vm.currentViewMain = viewName;

  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
}

const fileExplorerModal = Vue.component('file-explorer-modal', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render,
      pending: false,
      currentDirectory: null,
      winDrives: ADMINDATA.winDrives,
      contents: []
    };
  },
  template: `
    <div>
      <div class="row">
        <h5>{{ t('admin.fileExplorer.title') }}</h5>
        <span>
          [<a v-on:click="goToDirectory(currentDirectory, '..')">{{ t('admin.fileExplorer.back') }}</a>]
          [<a v-on:click="goToDirectory('~')">{{ t('admin.fileExplorer.home') }}</a>]
          [<a v-on:click="goToDirectory(currentDirectory)">{{ t('admin.fileExplorer.refresh') }}</a>]
        </span>
      </div>
      <div v-if="currentDirectory === null || pending === true" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else="currentDirectory !== null" class="row">
        <div class="flex">
          <select @change="goToDirectory($event.target.value)" v-if="winDrives.length > 0" id="select-win-drive" class="browser-default">
            <option v-for="(value) in winDrives" :selected="currentDirectory.startsWith(value)" :value="value">{{ value }}</option>
          </select>
          <h6>{{currentDirectory}}</h6>
        </div>
        [<a v-on:click="selectDirectory(currentDirectory)">{{ t('admin.fileExplorer.selectCurrent') }}</a>]
        <ul class="collection">
          <li v-on:click="goToDirectory(currentDirectory, dir.name)" v-for="dir in contents" class="collection-item">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" height="32.4px"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
            <div>{{dir.name}}</div>
            <a v-on:click.stop="selectDirectory(currentDirectory, dir.name)" class="secondary-content waves-effect waves-light btn-small">Select</a>
          </li>
        </ul>
      </div>
    </div>`,
  created: async function () {
    this.goToDirectory('~');
  },
  methods: {
    goToDirectory: async function (dir, joinDir) {
      try {
        const params = { directory: dir };
        if (joinDir) { params.joinDirectory = joinDir; }
  
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/file-explorer`,
          data: params
        });
  
        this.currentDirectory = res.data.path
  
        while (this.contents.length > 0) {
          this.contents.pop();
        }
  
        res.data.directories.forEach(d => {
          this.contents.push(d);
        });

        this.$nextTick(() => {
          document.getElementById('dynamic-modal').scrollIntoView();
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.fileExplorer.contentsFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    selectDirectory: async function (dir, joinDir) {
      try {
        let selectThis = dir;

        if (joinDir) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/file-explorer`,
            data: { directory: dir, joinDirectory: joinDir }
          });  
  
          selectThis = res.data.path
        }
  
        Vue.set(ADMINDATA.sharedSelect, 'value', selectThis);
  
        // close the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();
      }catch(err) {
        iziToast.error({
          title: t('admin.fileExplorer.cannotSelect'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    }
  }
});

const userPasswordView = Vue.component('user-password-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      resetPassword: '',
      submitPending: false
    };
  }, 
  template: `
    <form @submit.prevent="updatePassword">
      <div class="modal-content">
        <h4>{{ t('admin.modal.passwordReset') }}</h4>
        <p>{{ t('admin.modal.user') }} <b>{{currentUser.value}}</b></p>
        <div class="input-field">
          <input v-model="resetPassword" id="reset-password" required type="password">
          <label for="reset-password">{{ t('admin.modal.newPassword') }}</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.updatePassword') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  methods: {
    updatePassword: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/users/password`,
          data: {
            username: this.currentUser.value,
            password: this.resetPassword
          }
        });  
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.modal.passwordUpdated'),
          position: 'topCenter',
          timeout: 3500
        });
      }catch(err) {
        iziToast.error({
          title: t('admin.modal.passwordFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const usersVpathsView = Vue.component('user-vpaths-view', {
  data() {
    return {
      users: ADMINDATA.users,
      directories: ADMINDATA.folders,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateFolders">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeFolders') }}</h4>
        <p>{{ t('admin.modal.user') }} <b>{{currentUser.value}}</b></p>
        <select :disabled="Object.keys(directories).length === 0" id="edit-user-dirs" multiple>
          <option :selected="users[currentUser.value].vpaths.includes(value)" v-for="(key, value) in directories" :value="value">{{ value }}</option>
        </select>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll("#edit-user-dirs"));
    },
    beforeDestroy: function() {
      this.selectInstance[0].destroy();
    },
    methods: {
      updateFolders: async function() {
        try {
          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/vpaths`,
            data: {
              username: this.currentUser.value,
              vpaths: this.selectInstance[0].getSelectedValues()
            }
          });

          // update fronted data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'vpaths', this.selectInstance[0].getSelectedValues());
    
          // close & reset the modal
          M.Modal.getInstance(document.getElementById('admin-modal')).close();
  
          iziToast.success({
            title: t('admin.modal.permissionsUpdated'),
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: t('admin.modal.foldersFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const userAccessView = Vue.component('user-access-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      isAdmin: ADMINDATA.users[ADMINDATA.selectedUser.value].admin,
      allowMkdir: ADMINDATA.users[ADMINDATA.selectedUser.value].allowMkdir !== false,
      allowUpload: ADMINDATA.users[ADMINDATA.selectedUser.value].allowUpload !== false,
      allowServerAudio: ADMINDATA.users[ADMINDATA.selectedUser.value].allowServerAudio !== false
    };
  },
  template: `
    <form @submit.prevent="updateUser">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeAccess') }}</h4>
        <p>{{ t('admin.modal.user') }} <b>{{currentUser.value}}</b></p>
        <div class="pad-checkbox"><label>
          <input type="checkbox" v-model="isAdmin"/>
          <span>{{ t('admin.modal.admin') }}</span>
        </label></div>
        <div class="pad-checkbox"><label>
          <input type="checkbox" v-model="allowMkdir"/>
          <span>{{ t('admin.modal.createFolders') }}</span>
        </label></div>
        <div class="pad-checkbox"><label>
          <input type="checkbox" v-model="allowUpload"/>
          <span>{{ t('admin.modal.uploadFiles') }}</span>
        </label></div>
        <div class="pad-checkbox"><label>
          <input type="checkbox" v-model="allowServerAudio"/>
          <span>Allow Server Audio</span>
        </label></div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
    methods: {
      updateUser: async function() {
        try {

          // TODO: Warn user if they are removing admin status from the last admin user
            // They will lose all access to the admin panel

          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/access`,
            data: {
              username: this.currentUser.value,
              admin: this.isAdmin,
              allowMkdir: this.allowMkdir,
              allowUpload: this.allowUpload,
              allowServerAudio: this.allowServerAudio
            }
          });

          // update fronted data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'admin', this.isAdmin);
          Vue.set(ADMINDATA.users[this.currentUser.value], 'allowMkdir', this.allowMkdir);
          Vue.set(ADMINDATA.users[this.currentUser.value], 'allowUpload', this.allowUpload);
          Vue.set(ADMINDATA.users[this.currentUser.value], 'allowServerAudio', this.allowServerAudio);
    
          // close & reset the modal
          M.Modal.getInstance(document.getElementById('admin-modal')).close();
  
          iziToast.success({
            title: t('admin.modal.permissionsUpdated'),
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: t('admin.modal.accessFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const editRequestSizeModal = Vue.component('edit-request-size-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      maxRequestSize: ADMINDATA.serverParams.maxRequestSize
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeMaxRequest') }}</h4>
        <p>{{ t('admin.modal.acceptsKbMb') }}</p>
        <div class="input-field">
          <input v-model="maxRequestSize" id="edit-max-request-size" required type="text">
          <label for="edit-port">{{ t('admin.modal.editMaxRequest') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.requiresReboot') }}
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;
        this.maxRequestSize = this.maxRequestSize.replaceAll(' ', '');

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/max-request-size`,
          data: { maxRequestSize: this.maxRequestSize }
        });

        // update fronted data
        Vue.set(ADMINDATA.serverParams, 'maxRequestSize', this.maxRequestSize);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.modal.rebootSuccess'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});


const editDownloadSizeLimitModal = Vue.component('edit-download-size-limit-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      downloadSizeLimit: ADMINDATA.serverParams.downloadSizeLimit
    };
  },
  template: `
    <form @submit.prevent="updateDownloadSizeLimit">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeDownloadSizeLimit') }}</h4>
        <p>{{ t('admin.modal.acceptsSizeUnits') }}</p>
        <div class="input-field">
          <input v-model="downloadSizeLimit" id="edit-download-size-limit" required type="text">
          <label for="edit-download-size-limit">{{ t('admin.modal.editDownloadSizeLimit') }}</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateDownloadSizeLimit: async function() {
      try {
        this.submitPending = true;
        this.downloadSizeLimit = this.downloadSizeLimit.replaceAll(' ', '');

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/download-size-limit`,
          data: { downloadSizeLimit: this.downloadSizeLimit }
        });

        // No reboot — the download routes read this live. Reflect it in the UI.
        Vue.set(ADMINDATA.serverParams, 'downloadSizeLimit', this.downloadSizeLimit);

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});


const editPortModal = Vue.component('edit-port-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      currentPort: ADMINDATA.serverParams.port
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changePort') }}</h4>
        <div class="input-field">
          <input v-model="currentPort" id="edit-port" required type="number" min="2" max="65535">
          <label for="edit-port">{{ t('admin.modal.editPort') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.requiresReboot') }}
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/port`,
          data: { port: this.currentPort }
        });

        // update fronted data
        // Vue.set(ADMINDATA.serverParams, 'port', this.currentPort);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        setTimeout(() => {
          window.location.href = window.location.href.replace(`:${ADMINDATA.serverParams.port}`, `:${this.currentPort}`); 
        }, 4000);

        iziToast.success({
          title: t('admin.modal.portUpdated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.portFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAddressModal = Vue.component('edit-address-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.serverParams.address
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.serverAddress') }}</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-server-address" required type="text">
          <label for="edit-server-address">{{ t('admin.modal.editAddress') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.requiresReboot') }}<br>
          <b>{{ t('admin.modal.dontEditWarning') }}</b>
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/address`,
          data: { address: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.serverParams, 'address', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.modal.addressUpdated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.addressFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editBootScanView = Vue.component('edit-boot-scan-delay-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.bootScanDelay
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.bootScanDelay') }}</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-scan-delay" required type="number" min="1">
          <label for="edit-scan-delay">{{ t('admin.modal.bootScanDelay') }}</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/boot-scan-delay`,
          data: { bootScanDelay: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'bootScanDelay', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAutoAlbumArtPerRunView = Vue.component('edit-auto-album-art-per-run-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.autoAlbumArtPerRun
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.editAutoArtPerRun') }}</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-auto-album-art-per-run" required type="number" min="1" max="10000">
          <label for="edit-auto-album-art-per-run">{{ t('admin.db.autoArtPerRun') }}</label>
          <span class="helper-text">{{ t('admin.modal.autoArtPerRunHelp') }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/auto-album-art-per-run`,
          data: { autoAlbumArtPerRun: Number(this.editValue) }
        });

        Vue.set(ADMINDATA.dbParams, 'autoAlbumArtPerRun', Number(this.editValue));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAnalyzeBpmPerRunView = Vue.component('edit-analyze-bpm-per-run-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.analyzeBpmPerRun
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>BPM/key tracks analysed per pass</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-analyze-bpm-per-run" required type="number" min="1" max="10000">
          <label for="edit-analyze-bpm-per-run">Tracks per pass</label>
          <span class="helper-text">Caps how many tracks one essentia pass analyses before yielding the task slot. The pass also self-limits by wall-clock time and re-runs to drain any backlog.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/analyze-bpm-per-run`,
          data: { analyzeBpmPerRun: Number(this.editValue) }
        });

        Vue.set(ADMINDATA.dbParams, 'analyzeBpmPerRun', Number(this.editValue));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editAcoustidPerRunView = Vue.component('edit-acoustid-per-run-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.acoustidPerRun
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Tracks identified per AcoustID pass</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-acoustid-per-run" required type="number" min="1" max="10000">
          <label for="edit-acoustid-per-run">Tracks per pass</label>
          <span class="helper-text">Caps how many tracks one AcoustID pass fingerprints and looks up (rate-limited to ~3 requests/second) before yielding the task slot. The pass re-runs to drain any backlog.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/acoustid-per-run`,
          data: { acoustidPerRun: Number(this.editValue) }
        });

        Vue.set(ADMINDATA.dbParams, 'acoustidPerRun', Number(this.editValue));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

// Name + description in one modal — the public identity other servers see
// in their catalogs. Saves only what changed (each save re-announces
// server-side, so a no-op field shouldn't cost a broadcast). Opened from
// the Discovery page's identity line AND auto-opened right after enabling
// the network, so a fresh server never sits in the catalog as 'mStream'.
const editP2pMaxStorageView = Vue.component('edit-p2p-max-storage-modal', {
  data() {
    return {
      submitPending: false,
      editValue: P2PSETTINGS.maxPeerDbStorageMb
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Peer snapshot storage cap</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-p2p-max-storage" required type="number" min="10" max="100000">
          <label for="edit-p2p-max-storage">Max storage (MB)</label>
          <span class="helper-text">How much disk downloaded peer snapshots may use, total. Applies to the next download immediately — lowering it below current usage blocks new downloads but never deletes anything; remove snapshots from the server list to free space.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discovery/p2p/max-storage`,
          data: { maxPeerDbStorageMb: Number(this.editValue) }
        });

        P2PSETTINGS.maxPeerDbStorageMb = Number(this.editValue);

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          message: err.response?.data?.error || '',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

// Retention for the peer catalog: how many days a server may stay silent
// before it's forgotten (0 = never). Applies from the very next hourly
// prune pass — no restart. Downloaded snapshots pin their peer in the list
// regardless, so this can't invisibly orphan storage.
const editP2pPeerRetentionView = Vue.component('edit-p2p-peer-retention-modal', {
  data() {
    return {
      submitPending: false,
      editValue: P2PSETTINGS.peerRetentionDays
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Forget offline servers</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-p2p-peer-retention" required type="number" min="0" max="3650">
          <label for="edit-p2p-peer-retention">Days of silence before a server is forgotten</label>
          <span class="helper-text">A server that hasn't announced itself in this many days is dropped from the list automatically — it reappears the moment it comes back online. Servers whose snapshot you've downloaded are never forgotten; remove the snapshot first. 0 keeps every server forever.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discovery/p2p/peer-retention`,
          data: { peerRetentionDays: Number(this.editValue) }
        });

        P2PSETTINGS.peerRetentionDays = Number(this.editValue);

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          message: err.response?.data?.error || '',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editP2pIdentityView = Vue.component('edit-p2p-identity-modal', {
  data() {
    return {
      submitPending: false,
      editName: P2PIDENTITY.serverName,
      editDescription: P2PIDENTITY.serverDescription
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Server identity on the network</h4>
        <div class="input-field">
          <input v-model="editName" id="edit-p2p-name" required type="text" maxlength="64">
          <label for="edit-p2p-name">Server name ({{ editName.length }}/64 characters)</label>
          <span class="helper-text">How your server appears in every other server's catalog.</span>
        </div>
        <div class="input-field">
          <textarea v-model="editDescription" id="edit-p2p-description" class="materialize-textarea" maxlength="180"></textarea>
          <label for="edit-p2p-description">Description ({{ editDescription.length }}/180 characters)</label>
          <span class="helper-text">Optional blurb next to the name — say what's in your library so others can tell whether your DB is worth downloading. Changes announce immediately; the '|' character isn't allowed.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
    M.textareaAutoResize(document.getElementById('edit-p2p-description'));
  },
  methods: {
    updateParam: async function() {
      const name = this.editName.trim();
      const description = this.editDescription.trim();
      if (name.includes('|') || description.includes('|')) {
        iziToast.warning({ title: `The '|' character is not allowed`, position: 'topCenter', timeout: 3500 });
        return;
      }
      if (!name) {
        iziToast.warning({ title: 'The server name must not be blank', position: 'topCenter', timeout: 3500 });
        return;
      }
      try {
        this.submitPending = true;

        let announced = false;
        if (name !== P2PIDENTITY.serverName) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/discovery/p2p/name`,
            data: { name }
          });
          P2PIDENTITY.serverName = name;
          announced = res.data.announced === true;
        }
        if (description !== P2PIDENTITY.serverDescription) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/discovery/p2p/description`,
            data: { description }
          });
          P2PIDENTITY.serverDescription = description;
          announced = announced || res.data.announced === true;
        }

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: announced
            ? 'Updated — announced to the network'
            : 'Updated — will announce with the next snapshot',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          message: err.response?.data?.error || '',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editDiscoveryPerRunView = Vue.component('edit-discovery-per-run-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.discoveryPerRun
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Discovery tracks embedded per pass</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-discovery-per-run" required type="number" min="1" max="10000">
          <label for="edit-discovery-per-run">Tracks per pass</label>
          <span class="helper-text">Caps how many tracks one discovery pass embeds before yielding the task slot. Each track takes a few seconds of CPU; the pass also self-limits by wall-clock time and re-runs to drain any backlog.</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/discovery-per-run`,
          data: { discoveryPerRun: Number(this.editValue) }
        });

        Vue.set(ADMINDATA.dbParams, 'discoveryPerRun', Number(this.editValue));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editScanIntervalView = Vue.component('edit-scan-interval-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.scanInterval
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.editScanInterval') }}</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-scan-interval" required type="number" min="0">
          <label for="edit-scan-interval">{{ t('admin.modal.scanInterval') }}</label>
          <span class="helper-text">{{ t('admin.modal.disableAutoScans') }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/scan-interval`,
          data: { scanInterval: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'scanInterval', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editSslModal =  Vue.component('edit-ssl-modal', {
  data() {
    return {
      certPath: '',
      keyPath: '',
      submitPending: false
    };
  },
  template: `
    <form @submit.prevent="updateSSL">
      <div class="modal-content">
        <h4>{{ t('admin.modal.setSSL') }}</h4>
        <div class="input-field">
          <input v-model="certPath" id="edit-ssl-cert" required type="text">
          <label for="edit-ssl-cert">{{ t('admin.modal.certPath') }}</label>
        </div>
        <div class="input-field">
          <input v-model="keyPath" id="edit-ssl-key" required type="text">
          <label for="edit-ssl-key">{{ t('admin.modal.keyPath') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.requiresReboot') }}
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  methods: {
    updateSSL: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/ssl`,
          data: { cert: this.certPath, key: this.keyPath }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'scanInterval', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        setTimeout(() => {
          window.location.href = window.location.href.replace('http://', 'https://'); 
        }, 4000);

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeCodecModal = Vue.component('edit-transcode-codec-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultCodec,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.setCodec') }}</h4>
        <select v-model="editValue" id="transcode-codec-dropdown">
          <option value="mp3">MP3</option>
          <option value="opus">Opus</option>
          <option value="aac">AAC</option>
        </select>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    this.selectInstance = M.FormSelect.init(document.querySelectorAll("#transcode-codec-dropdown"));
  },
  beforeDestroy: function() {
    this.selectInstance[0].destroy();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-codec`,
          data: { defaultCodec: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.transcodeParams, 'defaultCodec', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeDefaultBitrate = Vue.component('edit-transcode-bitrate-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultBitrate,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>{{ t('admin.modal.setBitrate') }}</h4>
        <select v-model="editValue" id="transcode-bitrate-dropdown">
          <option value="64k">64k</option>
          <option value="96k">96k</option>
          <option value="128k">128k</option>
          <option value="192k">192k</option>
        </select>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    this.selectInstance = M.FormSelect.init(document.querySelectorAll("#transcode-bitrate-dropdown"));
  },
  beforeDestroy: function() {
    this.selectInstance[0].destroy();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-bitrate`,
          data: { defaultBitrate: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.transcodeParams, 'defaultBitrate', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const lastFMModal = Vue.component('lastfm-modal', {
  data() {
    return {
      lastFMUser: '',
      lastFMPassword: '',
    };
  },
  template: `
    <div>
      Coming Soon
    </div>`,
  methods: {
    setLastFM: async function() {
      try {

      } catch(err) {
        
      }
    }
  }
});



// New-ticket modal for the Federation tab: name the grant, tick the
// libraries it covers, mint, and copy the resulting mstrfed1: ticket.
const federationNewTicketModal = Vue.component('federation-new-ticket-modal', {
  data() {
    return {
      directories: ADMINDATA.folders,
      name: '',
      selected: [],
      submitPending: false,
      mintedTicket: null,
    };
  },
  template: `
    <form @submit.prevent="mint">
      <div class="modal-content">
        <h4>New Federation Ticket</h4>
        <div v-if="mintedTicket === null">
          <div class="input-field">
            <input id="fed-ticket-name" type="text" v-model="name" placeholder="Who is this for? (e.g. Bob's NAS)" maxlength="64"/>
          </div>
          <p style="margin-bottom:4px"><b>Libraries this ticket can read:</b></p>
          <p v-for="(cfg, vpath) in directories" :key="vpath" style="margin:4px 0">
            <label><input type="checkbox" v-model="selected" :value="vpath"/><span>{{ vpath }}</span></label>
          </p>
        </div>
        <div v-else>
          <p><b>Ticket for '{{ name }}'</b> — copy it and send it to your friend over a private channel. Anyone holding it can read the granted libraries until it's claimed or revoked.</p>
          <textarea readonly rows="6" cols="60" style="height:auto" :value="mintedTicket"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect btn-flat">{{ mintedTicket === null ? 'Cancel' : 'Done' }}</a>
        <a v-if="mintedTicket !== null" class="btn green waves-effect waves-light fed-copy-button" :data-clipboard-text="mintedTicket">Copy Ticket</a>
        <button v-else class="btn green waves-effect waves-light" type="submit" :disabled="submitPending || !name.trim() || selected.length === 0">
          {{ submitPending ? 'Minting…' : 'Mint Ticket' }}
        </button>
      </div>
    </form>`,
  methods: {
    mint: async function() {
      this.submitPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/federation/keys`,
          data: { name: this.name.trim(), vpaths: this.selected },
        });
        this.mintedTicket = res.data.ticket || res.data.key;
        if (!res.data.ticket) {
          iziToast.warning({ title: 'Endpoint not running', message: 'Minted the key, but there is no full ticket — turn federation on and re-open the key list.', position: 'topCenter', timeout: 5000 });
        }
        await ADMINDATA.getFederationKeys();
      } catch (err) {
        iziToast.error({ title: 'Failed to mint the ticket', position: 'topCenter', timeout: 3500 });
      } finally {
        this.submitPending = false;
      }
    },
  },
});

const nullModal = Vue.component('null-modal', {
  template: '<div>NULL MODAL ERROR: How did you get here?</div>'
});

const editRustPlayerPortModal = Vue.component('edit-rust-player-port-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      currentPort: ADMINDATA.serverParams.rustPlayerPort
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeRustPort') }}</h4>
        <div class="input-field">
          <input v-model="currentPort" id="edit-rust-port" required type="number" min="1" max="65535">
          <label for="edit-rust-port">{{ t('admin.modal.rustPort') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.nextBoot') }}
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/rust-player-port`,
          data: { rustPlayerPort: Number(this.currentPort) }
        });

        Vue.set(ADMINDATA.serverParams, 'rustPlayerPort', Number(this.currentPort));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();
        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.modal.portFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }

      this.submitPending = false;
    }
  }
});

const editLogBufferSizeModal = Vue.component('edit-log-buffer-size-modal', {
  data() {
    return {
      submitPending: false,
      currentSize: ADMINDATA.serverParams.logBufferSize
    };
  },
  template: `
    <form @submit.prevent="updateSize">
      <div class="modal-content">
        <h4>{{ t('admin.modal.changeLogBuffer') }}</h4>
        <div class="input-field">
          <input v-model="currentSize" id="edit-log-buffer" required type="number" min="0" max="10000">
          <label for="edit-log-buffer">{{ t('admin.modal.logBufferLines') }}</label>
        </div>
        <blockquote>
          {{ t('admin.modal.logBufferHint') }}
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{ submitPending === false ? t('admin.modal.update') : t('admin.modal.updating') }}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateSize: async function() {
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/log-buffer-size`,
          data: { logBufferSize: Number(this.currentSize) }
        });

        Vue.set(ADMINDATA.serverParams, 'logBufferSize', Number(this.currentSize));

        M.Modal.getInstance(document.getElementById('admin-modal')).close();
        iziToast.success({
          title: t('admin.settings.updated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: t('admin.logs.bufferUpdateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }

      this.submitPending = false;
    }
  }
});

const editAlbumArtServicesModal = Vue.component('edit-album-art-services-modal', {
  data() {
    return {
      submitPending: false,
      services: (ADMINDATA.dbParams.albumArtServices || ['musicbrainz', 'itunes', 'deezer']).slice()
    };
  },
  template: `
    <form @submit.prevent="updateServices">
      <div class="modal-content">
        <h4>{{ t('admin.modal.albumArtServiceOrder') }}</h4>
        <p>{{ t('admin.modal.dragToReorder') }}</p>
        <div style="margin:16px 0;">
          <div v-for="(service, index) in services" :key="service" style="display:flex;align-items:center;padding:10px 12px;margin:4px 0;background:#2a2a2a;border-radius:4px;">
            <span style="flex:1;">{{service}}</span>
            <button type="button" v-if="index > 0" @click="moveUp(index)" style="margin:0 4px;cursor:pointer;">&#9650;</button>
            <button type="button" v-if="index < services.length - 1" @click="moveDown(index)" style="margin:0 4px;cursor:pointer;">&#9660;</button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">{{ t('admin.modal.goBack') }}</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending">
          {{ submitPending ? t('admin.modal.saving') : t('admin.modal.saveOrder') }}
        </button>
      </div>
    </form>`,
  methods: {
    moveUp(i) { const s = this.services.splice(i, 1)[0]; this.services.splice(i - 1, 0, s); },
    moveDown(i) { const s = this.services.splice(i, 1)[0]; this.services.splice(i + 1, 0, s); },
    updateServices: async function() {
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/album-art-services`,
          data: { albumArtServices: this.services }
        });
        Vue.set(ADMINDATA.dbParams, 'albumArtServices', this.services.slice());
        M.Modal.getInstance(document.getElementById('admin-modal')).close();
        iziToast.success({ title: t('admin.settings.updated'), position: 'topCenter', timeout: 3500 });
      } catch(err) {
        iziToast.error({ title: t('admin.settings.failed'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

// ── Backup history modal (V28) ─────────────────────────────────────────────
// Opened from the backup-view "History" link. Shows the last ~50 runs for
// the destination passed via ADMINDATA.selectedBackupDest. Read-only — the
// user manages destinations from the main view; this is purely a log.
const backupHistoryModal = Vue.component('backup-history-modal', {
  data() {
    return {
      destination: ADMINDATA.selectedBackupDest,
      history: [],
      pending: true,
    };
  },
  template: `
    <div>
      <h5>Backup history</h5>
      <p v-if="destination" class="grey-text" style="margin-top:-8px">
        {{ destination.library_name }} → <code>{{ destination.dest_path }}</code>
      </p>
      <div v-if="pending" class="row">
        <svg class="spinner" width="40px" height="40px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else>
        <p v-if="history.length === 0" class="grey-text">No runs recorded yet.</p>
        <table v-else>
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Copied</th>
              <th>Unchanged</th>
              <th>Trashed</th>
              <th>Bytes</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in history" :key="run.id">
              <td :title="run.started_at + ' UTC'">{{ formatTime(run.started_at) }}</td>
              <td :style="{ color: statusColor(run.status) }">{{ run.status }}</td>
              <td>{{ run.trigger_reason }}</td>
              <td>{{ run.files_copied }}</td>
              <td>{{ run.files_unchanged }}</td>
              <td>{{ run.files_trashed }}</td>
              <td>{{ formatBytes(run.bytes_copied) }}</td>
              <td style="font-size:12px;color:#555">{{ run.error_message || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
  created: async function () {
    if (!this.destination) { this.pending = false; return; }
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/backup/destinations/${this.destination.id}/history?limit=50`,
      });
      this.history = res.data.history;
    } catch (err) {
      iziToast.error({ title: 'Could not load history', position: 'topCenter', timeout: 3000 });
    } finally {
      this.pending = false;
    }
  },
  methods: {
    formatTime(s) {
      if (!s) { return ''; }
      // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC. Show
      // local time so operators don't have to do timezone math, but keep
      // the original on hover for the curious / cross-server-comparing.
      const d = new Date(s.replace(' ', 'T') + 'Z');
      return d.toLocaleString();
    },
    formatBytes(n) {
      if (!n) { return '0'; }
      if (n < 1024) { return n + ' B'; }
      if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
      if (n < 1024 * 1024 * 1024) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    },
    statusColor(status) {
      return status === 'success' ? '#2e7d32'
           : status === 'failed' ? '#c62828'
           : status === 'partial' ? '#e65100'
           : status === 'skipped' ? '#f57f17'
           : '#1976d2';
    },
  },
});

// ── Backup destination editor ──────────────────────────────────────────────
// Per-destination editor exposing every PATCH-able field except library_id.
// Library is intentionally fixed because changing it would orphan existing
// backups under their old paths and re-trash everything as the new library
// reshapes the source tree — far safer to delete + re-add when the user
// genuinely wants to retarget.
//
// All other fields are safe to edit while a run is queued or active:
//   * runBackupTask reads the destination row fresh from the DB at start,
//     so a queued task picks up new settings when its turn arrives.
//   * An active worker has its config baked into its argv at fork time —
//     it finishes with old settings; the *next* run picks up the new
//     ones. No risk of mid-flight inconsistency.
//   * The schedule + trash sweep timers re-read the table on every tick,
//     so PATCHing trigger / retention is immediate from their POV.
//
// The exclude-patterns block has its own "Reset to defaults" affordance
// because the server's default list lives in db/manager.js
// (DEFAULT_BACKUP_EXCLUDE_GLOBS) and we want operators to be able to opt
// back into those without re-typing them. Sending excludeGlobs: null
// clears the column, so the API resolves NULL → defaults at read time.
const backupEditModal = Vue.component('backup-edit-modal', {
  data() {
    const dest = ADMINDATA.selectedBackupDest || {};
    return {
      destination: dest,
      // Edit-buffer fields seeded from the destination's current values
      destPath: dest.dest_path || '',
      triggerType: dest.trigger_type || 'after-scan',
      dailyAtHour: dest.daily_at_hour ?? 3,
      retentionDays: dest.retention_days ?? 30,
      interFileDelayMs: dest.inter_file_delay_ms || 0,
      patternsText: (dest.excludeGlobs || []).join('\n'),
      submitPending: false,

      // Live path validation (debounced)
      checkPending: false,
      checkErrors: [],
      checkWarnings: [],
      checkDebounceTimer: null,
    };
  },
  template: `
    <div>
      <h5>Edit backup destination</h5>
      <p class="grey-text" style="margin-top:-8px;font-size:13px">
        Source library: <strong>{{ destination.library_name }}</strong>
        <span style="margin-left:8px">(library is fixed — delete + re-add to retarget)</span>
      </p>

      <div class="row">
        <div class="input-field col s12">
          <input v-model="destPath" id="backup-edit-path" type="text" class="validate" autocomplete="off">
          <label for="backup-edit-path" class="active">Destination folder</label>
          <span class="helper-text">Type or paste an absolute path. Must not be inside the source library.</span>
        </div>
      </div>

      <div class="row">
        <div class="input-field col s12 m6">
          <select v-model="triggerType" id="backup-edit-trigger" class="browser-default">
            <option value="after-scan">Run after each library scan</option>
            <option value="daily">Run daily at a specific hour</option>
            <option value="manual">Manual only (no automatic runs)</option>
          </select>
        </div>
        <div class="input-field col s4 m2" v-if="triggerType === 'daily'">
          <input v-model.number="dailyAtHour" id="backup-edit-hour" required type="number" min="0" max="23" class="validate">
          <label for="backup-edit-hour" class="active">Hour (0–23)</label>
        </div>
        <div class="input-field col s4 m2">
          <input v-model.number="retentionDays" id="backup-edit-retention" type="number" min="0" class="validate">
          <label for="backup-edit-retention" class="active">Retention (days)</label>
          <span class="helper-text" style="font-size:11px" title="Days deleted/changed files stay recoverable in the backup's trash before being purged">0 = no trash, deletes are immediate + permanent</span>
        </div>
        <div class="input-field col s4 m2">
          <input v-model.number="interFileDelayMs" id="backup-edit-throttle" type="number" min="0" max="60000" class="validate">
          <label for="backup-edit-throttle" class="active">Throttle (ms/file)</label>
          <span class="helper-text" style="font-size:11px">0 = off</span>
        </div>
      </div>

      <div class="row">
        <div class="input-field col s12">
          <textarea v-model="patternsText" id="backup-edit-patterns" class="materialize-textarea"
                    style="height:120px;min-height:120px;font-family:monospace;font-size:13px"></textarea>
          <label for="backup-edit-patterns" class="active">Exclude patterns (one per line)</label>
          <span class="helper-text" style="font-size:11px">
            <code>*</code> = any chars, <code>?</code> = single char. Case-insensitive. Empty = exclude nothing.
          </span>
        </div>
      </div>

      <div v-if="checkPending" class="row" style="color:#888"><div class="col s12">Checking path…</div></div>
      <div v-if="!checkPending && checkErrors.length > 0" class="row">
        <div class="col s12" style="background:#ffebee;border-left:4px solid #c62828;padding:8px 12px">
          <strong style="color:#c62828">Cannot save:</strong>
          <ul style="margin:4px 0 0 0">
            <li v-for="e in checkErrors" :key="e">{{ e }}</li>
          </ul>
        </div>
      </div>
      <div v-if="!checkPending && checkErrors.length === 0 && checkWarnings.length > 0" class="row">
        <div class="col s12" style="background:#fff8e1;border-left:4px solid #f9a825;padding:8px 12px">
          <strong style="color:#f57f17">Heads up:</strong>
          <ul style="margin:4px 0 0 0">
            <li v-for="w in checkWarnings" :key="w">{{ w }}</li>
          </ul>
        </div>
      </div>

      <div class="row">
        <button class="btn green waves-effect waves-light col m3 s12"
                @click="save" :disabled="submitPending || checkPending || checkErrors.length > 0 || !destPath || !numbersValid">
          {{ submitPending ? 'Saving…' : 'Save' }}
        </button>
        <button class="btn grey waves-effect waves-light col m4 s12 offset-m1"
                @click="resetPatterns" :disabled="submitPending"
                title="Reverts the exclude patterns to the server defaults">
          Reset patterns to defaults
        </button>
        <button class="btn red waves-effect waves-light col m2 s12 offset-m1"
                @click="close" :disabled="submitPending">
          Cancel
        </button>
      </div>
    </div>
  `,
  watch: {
    destPath: function () { this.scheduleCheck(); },
  },
  computed: {
    // Same client-side mirror of the server's numeric constraints as the
    // add form — Save is a plain @click (no <form>), so the min/max
    // attributes alone are never enforced by the browser.
    numbersValid() {
      const hourOk = this.triggerType !== 'daily'
        || (Number.isInteger(this.dailyAtHour) && this.dailyAtHour >= 0 && this.dailyAtHour <= 23);
      const retentionOk = Number.isInteger(this.retentionDays) && this.retentionDays >= 0;
      const throttleOk = Number.isInteger(this.interFileDelayMs)
        && this.interFileDelayMs >= 0 && this.interFileDelayMs <= 60000;
      return hourOk && retentionOk && throttleOk;
    },
  },
  created() {
    // Run an initial validation so warnings (same-drive etc.) show on
    // open even if the user doesn't touch the path field.
    this.$nextTick(() => {
      M.textareaAutoResize(document.getElementById('backup-edit-patterns'));
      this.scheduleCheck();
    });
  },
  beforeDestroy() {
    if (this.checkDebounceTimer) { clearTimeout(this.checkDebounceTimer); }
  },
  methods: {
    parsePatternsText(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
    // checkPending raised here (not in checkPath) so Save is blocked for
    // the whole debounce window — see the add form's scheduleCheck.
    scheduleCheck() {
      this.checkPending = true;
      if (this.checkDebounceTimer) { clearTimeout(this.checkDebounceTimer); }
      this.checkDebounceTimer = setTimeout(() => this.checkPath(), 400);
    },
    async checkPath() {
      if (!this.destPath || !this.destination?.library_id) {
        this.checkErrors = []; this.checkWarnings = [];
        this.checkPending = false;
        return;
      }
      try {
        this.checkPending = true;
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/backup/check-path`,
          data: {
            libraryId: this.destination.library_id,
            destPath: this.destPath,
            // Self-exclude, exactly like the PATCH this dialog submits —
            // otherwise previewing the destination's own unchanged path
            // reports "already uses this path" and Save never enables.
            excludeDestId: this.destination.id,
          },
        });
        this.checkErrors = res.data.errors || [];
        this.checkWarnings = res.data.warnings || [];
      } catch (err) {
        this.checkErrors = [err.response?.data?.error || err.message || 'Path check failed'];
      } finally {
        this.checkPending = false;
      }
    },
    async save() {
      // Build a PATCH body with only fields that actually changed. The
      // server accepts a partial PATCH so unchanged fields stay as-is.
      const body = {};
      if (this.destPath !== this.destination.dest_path) {
        body.destPath = this.destPath;
      }
      if (this.triggerType !== this.destination.trigger_type) {
        body.triggerType = this.triggerType;
      }
      // Always include dailyAtHour when triggerType is or becomes daily —
      // the server requires the pair. Send null otherwise to clear stale
      // values when switching away from daily.
      if (this.triggerType === 'daily') {
        body.dailyAtHour = this.dailyAtHour;
      } else if (this.destination.daily_at_hour != null) {
        body.dailyAtHour = null;
      }
      if (this.retentionDays !== this.destination.retention_days) {
        body.retentionDays = this.retentionDays;
      }
      if (this.interFileDelayMs !== (this.destination.inter_file_delay_ms || 0)) {
        body.interFileDelayMs = this.interFileDelayMs;
      }
      const newPatterns = this.parsePatternsText(this.patternsText);
      const oldPatterns = this.destination.excludeGlobs || [];
      if (JSON.stringify(newPatterns) !== JSON.stringify(oldPatterns)) {
        body.excludeGlobs = newPatterns;
      }

      if (Object.keys(body).length === 0) {
        this.close();
        return;
      }

      try {
        this.submitPending = true;
        const res = await API.axios({
          method: 'PATCH',
          url: `${API.url()}/api/v1/admin/backup/destinations/${this.destination.id}`,
          data: body,
        });
        // Reflect every field locally so the row re-renders immediately
        // (the 2s poll would catch it eventually, but the user just hit
        // Save and expects to see their change).
        for (const k of ['dest_path', 'trigger_type', 'daily_at_hour', 'retention_days',
                         'inter_file_delay_ms', 'enabled']) {
          if (res.data[k] !== undefined) { Vue.set(this.destination, k, res.data[k]); }
        }
        if (res.data.excludeGlobs !== undefined) {
          Vue.set(this.destination, 'excludeGlobs', res.data.excludeGlobs);
        }
        iziToast.success({ title: 'Destination updated', position: 'topCenter', timeout: 2000 });
        this.close();
      } catch (err) {
        iziToast.error({
          title: err.response?.data?.error || 'Save failed',
          position: 'topCenter', timeout: 4000,
        });
      } finally {
        this.submitPending = false;
      }
    },
    async resetPatterns() {
      // Sending excludeGlobs:null clears the column → server resolves
      // NULL → DEFAULT_BACKUP_EXCLUDE_GLOBS at read time. We get the
      // effective list back in the response and use it to refresh the
      // textarea so the user can see what they reset to.
      try {
        this.submitPending = true;
        const res = await API.axios({
          method: 'PATCH',
          url: `${API.url()}/api/v1/admin/backup/destinations/${this.destination.id}`,
          data: { excludeGlobs: null },
        });
        Vue.set(this.destination, 'excludeGlobs', res.data.excludeGlobs);
        this.patternsText = (res.data.excludeGlobs || []).join('\n');
        this.$nextTick(() => { M.textareaAutoResize(document.getElementById('backup-edit-patterns')); });
        iziToast.success({ title: 'Patterns reset to defaults', position: 'topCenter', timeout: 2000 });
      } catch (err) {
        iziToast.error({
          title: err.response?.data?.error || 'Reset failed',
          position: 'topCenter', timeout: 4000,
        });
      } finally {
        this.submitPending = false;
      }
    },
    close() {
      M.Modal.getInstance(document.getElementById('admin-modal')).close();
    },
  },
});

const modVM = new Vue({
  el: '#dynamic-modal',
  components: {
    'user-password-modal': userPasswordView,
    'user-vpaths-modal': usersVpathsView,
    'user-access-modal': userAccessView,
    'file-explorer-modal': fileExplorerModal,
    'edit-port-modal': editPortModal,
    'edit-request-size-modal': editRequestSizeModal,
    'edit-address-modal': editAddressModal,
    'edit-scan-interval-modal': editScanIntervalView,
    'edit-boot-scan-delay-modal': editBootScanView,
    'edit-select-codec-modal': editTranscodeCodecModal,
    'edit-transcode-bitrate-modal': editTranscodeDefaultBitrate,
    'edit-ssl-modal': editSslModal,
    'lastfm-modal': lastFMModal,
    'federation-new-ticket-modal': federationNewTicketModal,
    'edit-rust-player-port-modal': editRustPlayerPortModal,
    'edit-album-art-services-modal': editAlbumArtServicesModal,
    'edit-log-buffer-size-modal': editLogBufferSizeModal,
    'backup-history-modal': backupHistoryModal,
    'backup-edit-modal': backupEditModal,
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal'
  }
});
