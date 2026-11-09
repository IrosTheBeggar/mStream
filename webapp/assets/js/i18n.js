const I18N = (() => {
  const mod = {};
  let strings = {};
  let fallback = {};
  const DEFAULT_LANG = 'en';
  // The language `strings` is written in: the requested one once its file
  // loaded, else English (strings is then the English dictionary itself).
  // Plural forms are read by this language's rules, not the UI's.
  let stringsLang = DEFAULT_LANG;

  // Listeners notified whenever a new language finishes loading.
  const changeListeners = new Set();

  // Intl.PluralRules per language, built on first use; null when the
  // runtime has no Intl.PluralRules or refuses the tag.
  const pluralRules = new Map();

  // Look up a key. Locale files use flat dot-delimited keys (e.g. "login.username"),
  // so try a direct lookup first. Fall back to nested-object walking so future
  // locale files can use either shape.
  function resolve(obj, key) {
    if (obj == null) { return undefined; }
    if (obj[key] !== undefined) { return obj[key]; }
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
  }

  // The CLDR plural category of `count` in `lang`: 'one', 'few', 'many',
  // 'other'… (Russian 21 → one, 22 → few, 25 → many; French 0 → one).
  // Without Intl.PluralRules, or for a tag the runtime refuses, the
  // English rule: 1 → one, anything else → other.
  function pluralCategory(lang, count) {
    let rules = pluralRules.get(lang);
    if (rules === undefined) {
      rules = null;
      try {
        if (typeof Intl !== 'undefined' && Intl && typeof Intl.PluralRules === 'function') {
          rules = new Intl.PluralRules(lang);
        }
      } catch (_) {
        rules = null;
      }
      pluralRules.set(lang, rules);
    }
    if (rules) {
      try { return rules.select(count); } catch (_) { /* the English rule below */ }
    }
    return count === 1 ? 'one' : 'other';
  }

  // Pick the plural form of `val` for `count` by the plural rules of `lang`,
  // the language of the dictionary `val` came from. Forms are named by CLDR
  // category: one/other (English, German, Spanish…), one/few/many/other
  // (Russian, Polish), other alone (Japanese, Korean, Chinese). A form the
  // object lacks reads `other` (Spanish or French `many`, 1 000 000), else
  // `one`. An explicit `zero` still wins for 0.
  function pluralize(val, count, lang) {
    if (typeof val !== 'object' || val === null) { return val; }
    if (count === 0 && val.zero !== undefined) { return val.zero; }
    const form = pluralCategory(lang, count);
    if (val[form] !== undefined) { return val[form]; }
    return val.other !== undefined ? val.other : val.one || '';
  }

  // Core translate function.
  //   t('key')                       → simple lookup
  //   t('key', { name: 'Alice' })    → interpolation: "Hello {{name}}"
  //   t('key', { count: 3 })         → pluralization + interpolation
  mod.t = (key, params) => {
    // A key this language lacks (or has as '') falls back to English, and an
    // English value is pluralized by English rules: an English plural inside
    // a Russian page reads "21 songs", not the Russian `one` for 21.
    let val = resolve(strings, key);
    let lang = stringsLang;
    if (!val) {
      val = resolve(fallback, key);
      lang = DEFAULT_LANG;
    }
    if (!val) { val = key; }

    // Pluralization: a plural object needs a count that is a number (NaN and
    // Infinity read `other`). A string count, even '3', picks no form — a
    // grouped "1.001" would read as 1.001 — so the object stays unread and
    // t() returns the key, as it does with no count. Pass the number, and
    // re-group its digits in the result if needed (vp.js dmCount).
    if (params && typeof params.count === 'number' && typeof val === 'object') {
      val = pluralize(val, params.count, lang);
    }

    let str = typeof val === 'string' ? val : key;

    // Parameter interpolation, one pass over the string: a param's value is
    // never scanned again, so a title holding "{{album}}" or a layout like
    // "{{ARTIST}}/{{ALBUM}}" is text, and so are its `$&` / `$'` / `$$`
    // (a replacer function). A placeholder with no param stays as written.
    if (params) {
      str = str.replace(/\{\{(\w+)\}\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
      ));
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
      stringsLang = DEFAULT_LANG;
    } else {
      try {
        const res = await fetch(`${base}locales/${lang}.json`);
        strings = await res.json();
        stringsLang = lang;
      } catch (_) {
        strings = fallback;
        stringsLang = DEFAULT_LANG;
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
