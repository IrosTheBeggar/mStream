const I18N = (() => {
  const mod = {};
  let strings = {};
  let fallback = {};
  const DEFAULT_LANG = 'en';

  // Listeners notified whenever a new language finishes loading.
  const changeListeners = new Set();

  // Look up a key. Locale files use flat dot-delimited keys (e.g. "login.username"),
  // so try a direct lookup first. Fall back to nested-object walking so future
  // locale files can use either shape.
  function resolve(obj, key) {
    if (obj == null) { return undefined; }
    if (obj[key] !== undefined) { return obj[key]; }
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
  }

  // Pick the correct plural form for a given count.
  // Supports objects with "one"/"other" keys (covers English, Spanish, etc.)
  // or "zero"/"one"/"two"/"few"/"many"/"other" for languages that need them.
  function pluralize(val, count) {
    if (typeof val !== 'object') { return val; }
    if (count === 0 && val.zero !== undefined) { return val.zero; }
    if (count === 1 && val.one !== undefined) { return val.one; }
    if (count === 2 && val.two !== undefined) { return val.two; }
    return val.other !== undefined ? val.other : val.one || '';
  }

  // Core translate function.
  //   t('key')                       → simple lookup
  //   t('key', { name: 'Alice' })    → interpolation: "Hello {{name}}"
  //   t('key', { count: 3 })         → pluralization + interpolation
  mod.t = (key, params) => {
    let val = resolve(strings, key) || resolve(fallback, key) || key;

    // Pluralization: if the resolved value is an object with plural forms, pick one
    if (params && typeof params.count === 'number' && typeof val === 'object') {
      val = pluralize(val, params.count);
    }

    let str = typeof val === 'string' ? val : key;

    // Parameter interpolation: replace {{param}} placeholders
    if (params) {
      Object.keys(params).forEach(p => {
        // A replacer function: a param's own `$&` / `$'` / `$$` (a song
        // title, a peer's name) is text, never a substitution pattern.
        str = str.replace(new RegExp('\\{\\{' + p + '\\}\\}', 'g'), () => String(params[p]));
      });
    }

    return str;
  };

  // Detect browser language, falling back to DEFAULT_LANG.
  // Returns a 2-letter code (e.g. "es" from "es-MX").
  function detectLanguage() {
    const stored = localStorage.getItem('mstream-lang');
    if (stored) { return stored; }
    const nav = (navigator.language || navigator.userLanguage || DEFAULT_LANG);
    return nav.split('-')[0].toLowerCase();
  }

  // Load a language's JSON file. Falls back to English for missing keys.
  mod.loadLanguage = async (lang) => {
    const base = document.querySelector('meta[name="i18n-base"]')?.content || '';

    // Always load English as the fallback dictionary
    if (!Object.keys(fallback).length) {
      try {
        const enRes = await fetch(`${base}locales/en.json`);
        fallback = await enRes.json();
      } catch (_) {
        fallback = {};
      }
    }

    if (lang === DEFAULT_LANG) {
      strings = fallback;
    } else {
      try {
        const res = await fetch(`${base}locales/${lang}.json`);
        strings = await res.json();
      } catch (_) {
        strings = fallback;
      }
    }

    localStorage.setItem('mstream-lang', lang);
    mod.translatePage();
    changeListeners.forEach(fn => { try { fn(lang); } catch (_) { /* noop */ } });
  };

  // Subscribe to language-change events. Returns an unsubscribe function.
  // Used by Vue-based pages (admin) to re-render when the dictionary updates.
  mod.onChange = (fn) => {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  };

  // Promise that resolves after the first loadLanguage() completes.
  // Pages that build UI dynamically can await this before rendering.
  mod.ready = new Promise(resolve => {
    const unsub = mod.onChange(() => { unsub(); resolve(); });
  });

  // Scan the DOM for data-i18n attributes and translate matching elements.
  // Use data-i18n-attr to translate an attribute (e.g. placeholder) instead of textContent.
  mod.translatePage = () => {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr');
      const translated = mod.t(key);
      if (translated === key) { return; }
      if (attr) {
        el.setAttribute(attr, translated);
      } else {
        el.textContent = translated;
      }
    });
  };

  mod.getLanguage = () => localStorage.getItem('mstream-lang') || DEFAULT_LANG;
  mod.detectLanguage = detectLanguage;

  window.t = mod.t;

  return mod;
})();
