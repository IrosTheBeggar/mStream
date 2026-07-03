// Custom language picker controller. Used by both the top nav-bar and the
// sidenav-bottom variants — they share this factory and DOM shape but have
// different CSS classnames so they can be styled independently.
//
// Why a custom dropdown instead of <select>: native <option> elements can't
// render inline SVG flags. The two visible flag groups (.nav-lang-* and
// .sidenav-lang-*) are styled in webapp/assets/css/lang-dropdown.css.
//
// Dependencies (loaded earlier in webapp/index.html):
//   - window.I18N        (assets/js/i18n.js)
//   - window.FLAG_SVGS   (assets/js/flags.js)
//
// Both instances subscribe to I18N.onChange so they stay in sync with each
// other and with any other code that swaps the active language (the admin
// panel, the Layout-panel selector in m.js, etc.).

function initLangDropdown(toggleId, menuId, classPrefix) {
  const toggle = document.getElementById(toggleId);
  const menu = document.getElementById(menuId);
  if (!toggle || !menu) { return; }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const flagMarkup = (code) => window.FLAG_SVGS && window.FLAG_SVGS[code]
    ? `<span class="${classPrefix}-flag">${window.FLAG_SVGS[code]}</span>`
    : `<span class="${classPrefix}-flag"></span>`;

  const renderCurrent = (code, label) => {
    toggle.querySelector(`.${classPrefix}-current`).innerHTML =
      `${flagMarkup(code)}<span class="${classPrefix}-name">${escapeHtml(label)}</span>`;
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

  let langs = {};

  fetch('locales/languages.json').then(r => r.json()).then(data => {
    langs = data;
    const cur = I18N.getLanguage();

    Object.entries(langs).forEach(([code, name]) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.lang = code;
      li.innerHTML = `${flagMarkup(code)}<span class="${classPrefix}-name">${escapeHtml(name)}</span>`;
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

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !toggle.contains(e.target)) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); }
  });

  // Keep this toggle in sync when the language changes from anywhere else.
  I18N.onChange((code) => {
    renderCurrent(code, langs[code] || code);
    updateSelected(code);
  });
}

initLangDropdown('nav-lang-toggle', 'nav-lang-menu', 'nav-lang');
initLangDropdown('sidenav-lang-toggle', 'sidenav-lang-menu', 'sidenav-lang');
