// mStream-specific overlay for Airsonic Refix.
//
// Refix is a pre-built third-party bundle with no admin interface of its
// own (it's a Subsonic client, not a server admin tool). Operators who
// pick `ui: 'subsonic'` in mStream need a way back to /admin — not just
// the URL-bar workaround, but a visible link in the sidebar so they
// don't lose track of it.
//
// This file is loaded as a plain <script> from webapp/subsonic/index.html
// AFTER Refix's main bundle. Refix renders the sidebar asynchronously
// (Vue 3 mounting + router-resolved links), so we watch the DOM with a
// MutationObserver and inject an mStream Admin nav entry the moment a
// .sidebar-container appears. The link uses Refix's own .nav-link class
// so it inherits hover/focus/theme styling automatically.
//
// Idempotent: re-inserts if Refix unmounts and remounts the sidebar
// (client-side route change → <KeepAlive> dispose).

(function () {
  'use strict';

  var INSERTED_MARK = 'data-mstream-admin-link-inserted';

  function injectAdminLink(sidebar) {
    if (!sidebar || sidebar.getAttribute(INSERTED_MARK)) { return; }
    sidebar.setAttribute(INSERTED_MARK, '1');

    // A standalone section at the bottom of the sidebar so it doesn't
    // visually blend with Refix's own routed nav items. Heading text
    // matches Refix's sidebar-heading muted-label convention.
    var heading = document.createElement('h6');
    heading.className = 'sidebar-heading text-muted';
    heading.style.marginTop = '1.5rem';
    heading.textContent = 'Server';

    var link = document.createElement('a');
    link.className = 'nav-link';
    link.href = '/admin';
    // Full page load rather than SPA-internal navigation — /admin is
    // NOT a Refix route, it's mStream's admin panel served from a
    // separate static tree. Refix's client router would 404 it.
    link.setAttribute('rel', 'external');
    // Simple unicode gear for identity — no icon dependency.
    link.textContent = '\u2699\uFE0F  mStream Admin';

    sidebar.appendChild(heading);
    sidebar.appendChild(link);
  }

  function scan(root) {
    // Refix's .sidebar-container is the parent of the routed nav links.
    // There may be more than one instance during mount/remount; inject
    // into every one we see (guarded by INSERTED_MARK).
    var found = root.querySelectorAll ? root.querySelectorAll('.sidebar-container') : [];
    for (var i = 0; i < found.length; i++) { injectAdminLink(found[i]); }
  }

  function init() {
    scan(document);
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) { continue; } // Element nodes only
          if (node.classList && node.classList.contains('sidebar-container')) {
            injectAdminLink(node);
          } else {
            scan(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
