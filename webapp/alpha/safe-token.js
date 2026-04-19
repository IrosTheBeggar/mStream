// JWT at-rest encryption via Electron safeStorage.
// Current webapp keeps the token in localStorage — many synchronous readers
// rely on that. This module layers on OS-keychain-backed encryption without
// forcing every reader to go async:
//   1. At boot, if safeStorage has a token, mirror it into localStorage so
//      synchronous readers pick it up from there.
//   2. When callers save a token, persist to safeStorage in parallel.
// Result: token is encrypted at rest on disk (safeStorage) AND still available
// to the sync code paths that read localStorage directly. A later refactor
// can retire localStorage entirely by moving readers to async.

(function () {
  if (!window.mstreamElectron || !window.mstreamElectron.safeStorage) { return; }

  const KEY = 'token';
  const safe = window.mstreamElectron.safeStorage;

  window.mstreamSafeToken = {
    // Call once at webapp boot, before anything reads MSTREAMAPI.currentServer.token.
    async hydrate() {
      try {
        if (!(await safe.isAvailable())) { return; }
        const fromSafe = await safe.get(KEY);
        const fromLocal = localStorage.getItem(KEY);
        if (fromSafe && fromSafe !== fromLocal) {
          // safeStorage wins — mirror into localStorage for sync readers
          localStorage.setItem(KEY, fromSafe);
        } else if (!fromSafe && fromLocal) {
          // First-time migration: copy existing plaintext token into safeStorage
          await safe.set(KEY, fromLocal);
        }
      } catch (e) {
        // Non-fatal: app continues with whatever localStorage has
        console.warn('safe-token hydrate failed:', e);
      }
    },

    // Call whenever the token changes (login, server switch, logout).
    save(token) {
      if (!token) {
        safe.remove(KEY).catch(() => {});
        return;
      }
      safe.set(KEY, token).catch(() => {});
    },
  };
})();
