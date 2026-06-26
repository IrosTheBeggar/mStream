// Quick Connect (Iroh) — demo/public-server only.
//
// Calls GET /api/v1/iroh/code. That endpoint only returns the pairing code when
// the operator has opted in (config iroh.shareCodePublic = true, not exposed in
// the admin UI — it's for the public demo). On a success response we reveal the
// green "Quick Connect" button in the top bar and render the pairing code as a
// QR in the explainer modal. On anything else we stay hidden, so normal servers
// show nothing.
//
// Self-contained: defines window.QUICKCONNECT.open() for the button's onclick,
// uses the bundled qrcodegen (assets/js/lib/qr.js) and HystModal (already loaded).
(function () {
  'use strict';

  var modal = null;
  function getModal() {
    if (!modal && typeof HystModal !== 'undefined') { modal = new HystModal({}); }
    return modal;
  }

  window.QUICKCONNECT = {
    open: function () {
      var m = getModal();
      if (m) { m.open('#quickConnectModal'); }
    }
  };

  function renderQr(code) {
    var el = document.getElementById('quick-connect-qr');
    if (!el || typeof qrcodegen === 'undefined') { return; }
    try {
      var qr = qrcodegen.QrCode.encodeText(code, qrcodegen.QrCode.Ecc.MEDIUM);
      el.innerHTML = qr.toSvgString(2);
      var svg = el.querySelector('svg');
      if (svg) { svg.style.width = '240px'; svg.style.height = '240px'; }
    } catch (e) { /* leave empty if encoding fails */ }
  }

  function init() {
    // Relative to the page origin (the demo serves the API from the same host).
    fetch('api/v1/iroh/code', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.shared !== true || d.available !== true || !d.code) { return; }
        var btn = document.getElementById('quick-connect-btn');
        if (btn) { btn.style.display = ''; }
        renderQr(d.code);
      })
      .catch(function () { /* not shared / unreachable — stay hidden */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
