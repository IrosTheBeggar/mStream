/**
 * The webapp's translator (webapp/assets/js/i18n.js) and its twelve
 * dictionaries (webapp/locales/*.json), on node.
 *
 * What is pinned:
 *   - the locale files: languages.json names exactly the dictionaries on
 *     disk, all twelve; every file parses and holds no key twice (JSON.parse
 *     would silently keep the last one); every key of a translated file
 *     exists in en.json, with en's shape (string or plural object) and en's
 *     {{placeholders}}; every brace pair in any file is a {{word}}
 *     placeholder (t() fills nothing else, so "{{ count }}" would show as
 *     typed); every data-i18n key of the four pages that load i18n.js that
 *     en.json has is a plain string with no placeholder (translatePage()
 *     passes no params); the retired Youtube DL tab's and old strip's keys
 *     are in no file, and no value names "Youtube DL";
 *   - plural objects: each carries every form its own language's
 *     Intl.PluralRules picks for a whole number, plus `other`, and no form
 *     that language never picks (no `two` in Russian or Polish); a form
 *     more than one number reads ("21 день", French "0 chanson") carries
 *     {{count}}; every plural in every language reads as filled text for
 *     any count 0–1000;
 *   - t(): plural forms by CLDR category (Russian 21 → one, 22 → few,
 *     25 → many; French 0 → one; Japanese always other), read by the rules
 *     of the dictionary the value came from — an English fallback inside a
 *     Russian page reads English ("21 songs"), and so does every value when
 *     the language's file failed; a form the object lacks reads `other`; an
 *     explicit `zero` wins for 0; only a number count picks a form (a
 *     string count, even '3', returns the key, as no count does); without
 *     Intl.PluralRules, or for a tag it refuses, the English rule;
 *     English, German and Dutch read every plural for 0–1000 and a
 *     fraction exactly as the old exact-number pick did (1 → one, else
 *     other); interpolation is one pass — a param's value is never scanned
 *     again, and its `$` patterns are text; a param's name is never a
 *     pattern (a name like "(" used to throw, "a." used to fill {{ab}});
 *   - translatePage(): a string fills textContent, or the one attribute
 *     data-i18n-attr names, an English fallback included; a key no
 *     dictionary has, an empty one and a plural object leave the element
 *     as written.
 *
 * webapp/ has no browser test harness and is eslint-ignored, so this runs
 * the real i18n.js — a plain script ending in `const I18N` — through
 * new Function, with a fetch stub serving the real files from
 * webapp/locales (or a test's own dictionaries) and, where a test needs it,
 * its own `Intl`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = path.join(ROOT, 'webapp', 'locales');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'assets', 'js', 'i18n.js'), 'utf8').replace(/\r\n/g, '\n');

const readLocale = (name) => fs.readFileSync(path.join(LOCALES, name), 'utf8').replace(/\r\n/g, '\n');
const LANGUAGES = JSON.parse(readLocale('languages.json'));
const LANGS = Object.keys(LANGUAGES);
const DICTS = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readLocale(`${l}.json`))]));
const EN = DICTS.en;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlural = (v) => typeof v === 'object' && v !== null;

// i18n.js, fresh per call. `files` (name → dictionary) answers before the
// real files; a name in neither answers as the server's 404 page does (a
// body that is not JSON). `Intl` is the script's own (the runtime's unless
// a test passes another, `undefined` included). `elements` are what
// translatePage() finds for '[data-i18n]'.
function loadI18n(opts = {}) {
  const files = opts.files || {};
  const intl = hasOwn(opts, 'intl') ? opts.intl : globalThis.Intl;
  const elements = opts.elements || [];
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  const document = { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-i18n]' ? elements : []) };
  const fetch = async (url) => {
    const name = String(url).replace(/^.*locales\//, '');
    if (hasOwn(files, name)) { return { json: async () => files[name] }; }
    const file = path.join(LOCALES, name);
    if (/^[a-z]+\.json$/.test(name) && fs.existsSync(file)) { return { json: async () => JSON.parse(readLocale(name)) }; }
    return { json: async () => { throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'); } };
  };
  return new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'Intl', `${I18N_SRC}\nreturn I18N;`)(
    {}, document, localStorage, { language: 'en' }, fetch, intl);
}
async function inLang(lang, opts) {
  const I18N = loadI18n(opts);
  await I18N.loadLanguage(lang);
  return I18N;
}

// The keys of every object in a JSON text, in order, with the ones seen
// twice in the same object — JSON.parse keeps the last without a word.
function duplicateKeys(src) {
  const dups = [];
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') { j += src[j] === '\\' ? 2 : 1; }
      if (top && top.obj && top.expectKey) {
        const key = JSON.parse(src.slice(i, j + 1));
        if (top.keys.has(key)) { dups.push(top.name ? `${top.name} > ${key}` : key); }
        top.keys.add(key);
        top.last = key;
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      stack.push({ obj: c === '{', keys: new Set(), expectKey: c === '{', name: top && top.obj ? top.last : null });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',' && top && top.obj) {
      top.expectKey = true;
    }
  }
  return dups;
}

const placeholders = (s) => [...new Set([...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
const formsOf = (v) => (isPlural(v) ? Object.values(v) : [v]);
const union = (v) => [...new Set(formsOf(v).flatMap(placeholders))].sort();
const withoutCount = (names) => names.filter((n) => n !== 'count');

// What a language's rules make of the whole numbers 0–1000: the categories
// they pick (the forms an object must carry, with `other`), and how many
// numbers each one reads.
const INTS = Array.from({ length: 1001 }, (_, n) => n);
function integerCategories(lang) {
  const rules = new Intl.PluralRules(lang);
  const hits = {};
  INTS.forEach((n) => { const c = rules.select(n); hits[c] = (hits[c] || 0) + 1; });
  return hits;
}

describe('the locale files', () => {
  test('languages.json names the twelve dictionaries on disk, and every file parses', () => {
    assert.deepEqual(LANGS, ['en', 'es', 'zh', 'fr', 'de', 'pt', 'ja', 'ru', 'ko', 'it', 'nl', 'pl']);
    const onDisk = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json') && f !== 'languages.json').map((f) => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(onDisk, [...LANGS].sort());
    LANGS.forEach((l) => {
      assert.equal(typeof DICTS[l], 'object', `${l}.json is an object`);
      assert.ok(!Array.isArray(DICTS[l]) && DICTS[l] !== null, `${l}.json is an object`);
      Object.entries(DICTS[l]).forEach(([k, v]) => {
        assert.ok(typeof v === 'string' || isPlural(v), `${l}.json ${k} is a string or a plural object`);
        if (isPlural(v)) { Object.values(v).forEach((s) => assert.equal(typeof s, 'string', `${l}.json ${k}: every form is a string`)); }
      });
    });
  });

  test('no file holds a key twice (the scanner itself finds a planted one)', () => {
    assert.deepEqual(duplicateKeys('{"a": "x", "b": {"one": "1", "one": "2"}, "c": "\\"a\\"", "a": "y"}'), ['b > one', 'a']);
    ['languages', ...LANGS].forEach((l) => {
      assert.deepEqual(duplicateKeys(readLocale(`${l}.json`)), [], `${l}.json`);
    });
  });

  test('every key of a translated file exists in en.json, with en\'s shape', () => {
    LANGS.filter((l) => l !== 'en').forEach((l) => {
      const extra = Object.keys(DICTS[l]).filter((k) => !hasOwn(EN, k));
      assert.deepEqual(extra, [], `${l}.json keys en.json does not have`);
      const shape = Object.keys(DICTS[l]).filter((k) => isPlural(DICTS[l][k]) !== isPlural(EN[k]));
      assert.deepEqual(shape, [], `${l}.json keys that are a string where en has a plural object, or the other way`);
    });
  });

  test('the Upload window\'s Youtube DL tab and the old Downloading strip took their words with them; no file names "Youtube DL"', () => {
    const retired = ['upload.tabYoutube', 'upload.ytdlDescription', 'upload.ytdlRequirement', 'upload.ytdlTranscodeWarning', 'upload.urlPlaceholder',
      'upload.metaTitle', 'upload.metaArtist', 'upload.metaAlbum', 'upload.metaYear', 'upload.loadingMetadata', 'upload.downloadButton',
      'fileExplorer.downloading', 'toast.youtubeUrlRequired', 'toast.invalidUrl', 'toast.downloadStarted', 'status.downloadingAudio',
      'status.downloadingFiles', 'label.viewDownloads'];
    LANGS.forEach((l) => {
      assert.deepEqual(retired.filter((k) => hasOwn(DICTS[l], k)), [], `${l}.json`);
      const named = Object.keys(DICTS[l]).filter((k) => (isPlural(DICTS[l][k]) ? Object.values(DICTS[l][k]) : [DICTS[l][k]]).some((s) => /youtube dl/i.test(s)));
      assert.deepEqual(named, [], `${l}.json`);
      // what the Upload window, the metadata window and every other
      // failure toast still say
      ['upload.tabFiles', 'upload.location', 'upload.chooseFiles', 'error.callFailed', 'toast.noMetadataFound'].forEach((k) => assert.ok(hasOwn(DICTS[l], k), `${l}.json ${k}`));
    });
    // A song Add from YouTube brought in, in the Downloads panel and the
    // admin's Downloads tab
    assert.equal(EN['downloads.plugin.ytdl'], 'YouTube');
    assert.equal(EN['admin.dplugins.dl.plugin.ytdl'], 'YouTube');
  });

  test('every translation uses en\'s {{placeholders}}, form by form', () => {
    const wrong = [];
    LANGS.filter((l) => l !== 'en').forEach((l) => {
      Object.entries(DICTS[l]).forEach(([k, v]) => {
        const want = union(EN[k]);
        if (!isPlural(v)) {
          if (placeholders(v).join() !== want.join()) { wrong.push(`${l} ${k}: {{${placeholders(v)}}} vs en {{${want}}}`); }
          return;
        }
        // a form may leave {{count}} out ("1 song"), never another param
        Object.entries(v).forEach(([form, s]) => {
          if (withoutCount(placeholders(s)).join() !== withoutCount(want).join()) { wrong.push(`${l} ${k}.${form}: {{${placeholders(s)}}} vs en {{${want}}}`); }
        });
        if (union(v).includes('count') !== want.includes('count')) { wrong.push(`${l} ${k}: {{count}} in en ${want.includes('count')}, here ${union(v).includes('count')}`); }
      });
    });
    assert.deepEqual(wrong, []);
  });

  test('every brace pair is a {{word}} placeholder: "{{ count }}", "{{nom-x}}" or "{{число}}" would show as typed', () => {
    // t() fills only {{[A-Za-z0-9_]+}}; the placeholder test above would
    // miss a malformed one sitting beside a well-formed copy
    const wrong = [];
    LANGS.forEach((l) => {
      Object.entries(DICTS[l]).forEach(([k, v]) => {
        Object.entries(isPlural(v) ? v : { '': v }).forEach(([form, s]) => {
          const rest = s.replace(/\{\{\w+\}\}/g, '');
          if (/\{\{|\}\}/.test(rest)) { wrong.push(`${l} ${k}${form ? `.${form}` : ''}: ${JSON.stringify(s)}`); }
        });
      });
    });
    assert.deepEqual(wrong, []);
  });

  test('every data-i18n key en.json has is a plain string with no placeholder (translatePage() passes no params)', () => {
    // A plural object would leave the element as written, a {{name}} would
    // show raw — and inside the player's Vue root, Vue would read it as an
    // expression. Pages: the four that load i18n.js.
    const pages = ['index.html', 'admin/index.html', 'stats/index.html', 'login/index.html'];
    const wrong = [];
    let seen = 0;
    pages.forEach((p) => {
      const html = fs.readFileSync(path.join(ROOT, 'webapp', p), 'utf8');
      assert.match(html, /<script src="(\.\.\/)?assets\/js\/i18n\.js"><\/script>/, `${p} loads i18n.js (else drop it from this list)`);
      [...html.matchAll(/data-i18n="([^"]*)"/g)].forEach(([, k]) => {
        seen += 1;
        if (!hasOwn(EN, k)) { return; } // left as written, by translatePage's own rule
        if (isPlural(EN[k])) { wrong.push(`${p} ${k}: a plural object`); } else if (placeholders(EN[k]).length) { wrong.push(`${p} ${k}: ${JSON.stringify(EN[k])}`); }
      });
    });
    assert.ok(seen > 100, `found the data-i18n attributes (${seen})`);
    assert.deepEqual(wrong, []);
  });
});

describe('plural objects carry the forms their language picks', () => {
  test('the categories, as the runtime\'s CLDR has them (the test\'s own premise)', () => {
    const cats = (l) => Object.keys(integerCategories(l)).sort().join(',');
    assert.equal(cats('ru'), 'few,many,one');
    assert.equal(cats('pl'), 'few,many,one');
    ['en', 'de', 'nl', 'es', 'it', 'fr', 'pt'].forEach((l) => assert.equal(cats(l), 'one,other', l));
    ['ja', 'ko', 'zh'].forEach((l) => assert.equal(cats(l), 'other', l));
  });

  test('every form a whole number picks, plus other, and none the language never picks', () => {
    const wrong = [];
    LANGS.forEach((l) => {
      const hits = integerCategories(l);
      const need = [...new Set([...Object.keys(hits), 'other'])];
      // also allowed: the language's other CLDR categories (Spanish, French
      // `many`), `one` mirrored from en's shape (ja/ko/zh carry it), and
      // `zero`, the explicit override for 0 that t() honours
      const allowed = new Set([...need, ...new Intl.PluralRules(l).resolvedOptions().pluralCategories, 'one', 'zero']);
      Object.entries(DICTS[l]).filter(([, v]) => isPlural(v)).forEach(([k, v]) => {
        const missing = need.filter((f) => !hasOwn(v, f));
        if (missing.length) { wrong.push(`${l} ${k}: no ${missing.join('/')}`); }
        const odd = Object.keys(v).filter((f) => !allowed.has(f));
        if (odd.length) { wrong.push(`${l} ${k}: ${odd.join('/')} is never picked in ${l}`); }
      });
    });
    assert.deepEqual(wrong, []);
  });

  test('a form that more than one number reads carries {{count}} (Russian 21, French 0)', () => {
    const wrong = [];
    LANGS.forEach((l) => {
      const hits = integerCategories(l);
      Object.entries(DICTS[l]).filter(([, v]) => isPlural(v)).forEach(([k, v]) => {
        if (!union(EN[k]).includes('count')) { return; }
        Object.entries(v).forEach(([form, s]) => {
          const many = form === 'other' || (form !== 'zero' && (hits[form] || 0) > 1);
          if (many && !s.includes('{{count}}')) { wrong.push(`${l} ${k}.${form}: "${s}" is read for ${form === 'other' ? 'every other number' : `${hits[form]} numbers`}`); }
        });
      });
    });
    assert.deepEqual(wrong, []);
  });

  test('every plural in every language reads as filled text for any count 0–1000', async () => {
    for (const l of LANGS) {
      const I18N = await inLang(l);
      Object.entries(EN).filter(([, v]) => isPlural(v)).forEach(([k, v]) => {
        const params = Object.fromEntries(withoutCount(union(v)).map((n) => [n, `‹${n}›`]));
        INTS.forEach((n) => {
          const text = I18N.t(k, { ...params, count: n });
          assert.ok(text && text !== k && !text.includes('{{'), `${l} ${k} at ${n}: ${JSON.stringify(text)}`);
        });
      });
    }
  });
});

describe('t(): the plural form by the CLDR category of the count', () => {
  test('Russian: one for 1, 21, 101; few for 2–4, 22; many for 0, 5–20, 25, 111; other for a fraction', async () => {
    const I18N = await inLang('ru');
    const days = (n) => I18N.t('stats.count.days', { count: n });
    assert.deepEqual([0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 1.5].map(days), [
      '0 дней', '1 день', '2 дня', '3 дня', '4 дня', '5 дней', '11 дней', '12 дней', '14 дней', '21 день', '22 дня', '25 дней', '101 день', '111 дней', '1.5 дня']);
    const tracks = (n) => I18N.t('stats.count.tracks', { count: n });
    assert.deepEqual([1, 3, 7, 21, 23].map(tracks), ['1 трек', '3 трека', '7 треков', '21 трек', '23 трека']);
    const added = (n) => I18N.t('toast.albumQueuedMessage', { count: n });
    assert.deepEqual([1, 3, 5, 21].map(added), ['1 песня добавлена', '3 песни добавлены', '5 песен добавлено', '21 песня добавлена']);
  });

  test('Polish: one for 1 only; few for 2–4, 22–24; many for 0, 5–21, 25; other for a fraction', async () => {
    const I18N = await inLang('pl');
    const tracks = (n) => I18N.t('stats.count.tracks', { count: n });
    assert.deepEqual([0, 1, 2, 4, 5, 12, 21, 22, 25, 1.5].map(tracks), [
      '0 utworów', '1 utwór', '2 utwory', '4 utwory', '5 utworów', '12 utworów', '21 utworów', '22 utwory', '25 utworów', '1.5 utworu']);
    const plays = (n) => I18N.t('stats.count.plays', { count: n });
    assert.deepEqual([1, 3, 5].map(plays), ['1 odtworzenie', '3 odtworzenia', '5 odtworzeń']);
  });

  test('"Get last [100] songs": m.js asks with { count: 2 } for the word beside the 100, which stays the genitive plural', async () => {
    // Under CLDR rules 2 is Russian and Polish `few`; the label sits beside
    // a number input that starts at 100 (`many`), so `few` holds the many
    // word — the same word the old exact-number pick gave.
    assert.equal((await inLang('ru')).t('label.getLastSongs', { count: 2 }), 'песен');
    assert.equal((await inLang('pl')).t('label.getLastSongs', { count: 2 }), 'utworów');
    assert.equal((await inLang('en')).t('label.getLastSongs', { count: 2 }), 'songs');
  });

  test('French and Brazilian Portuguese read 0 as one; a million (`many`) reads other', async () => {
    const fr = await inLang('fr');
    const frAdded = (n) => fr.t('toast.albumQueuedMessage', { count: n });
    assert.deepEqual([0, 1, 2, 1000000].map(frAdded), ['0 chanson ajoutée', '1 chanson ajoutée', '2 chansons ajoutées', '1000000 chansons ajoutées']);
    const pt = await inLang('pt');
    assert.deepEqual([0, 1, 2].map((n) => pt.t('stats.count.days', { count: n })), ['0 dia', '1 dia', '2 dias']);
    const es = await inLang('es');
    assert.deepEqual([0, 1, 1000000].map((n) => es.t('stats.count.days', { count: n })), ['0 días', '1 día', '1000000 días']);
  });

  test('English, German and Dutch: one for 1, other for 0 and the rest', async () => {
    const en = await inLang('en');
    assert.deepEqual([0, 1, 2].map((n) => en.t('stats.count.days', { count: n })), ['0 days', '1 day', '2 days']);
    const de = await inLang('de');
    assert.deepEqual([0, 1, 2].map((n) => de.t('stats.count.days', { count: n })), ['0 Tage', '1 Tag', '2 Tage']);
    const nl = await inLang('nl');
    assert.deepEqual([0, 1, 2].map((n) => nl.t('stats.count.days', { count: n })), ['0 dagen', '1 dag', '2 dagen']);
  });

  test('English, German and Dutch read every plural as the old exact-number pick did: 1 → one, 0–1000 else and fractions → other', async () => {
    // The move to Intl.PluralRules changes nothing a user of these three
    // sees, their own values and English fallbacks alike. The old pick,
    // verbatim: zero for exactly 0, one for 1, two for 2 (when the object
    // has them), else other, else one.
    const oldPick = (v, n) => {
      if (n === 0 && v.zero !== undefined) { return v.zero; }
      if (n === 1 && v.one !== undefined) { return v.one; }
      if (n === 2 && v.two !== undefined) { return v.two; }
      return v.other !== undefined ? v.other : v.one || '';
    };
    const counts = [...INTS, 1.5, 0.5, 2.25, 1000000];
    for (const l of ['en', 'de', 'nl']) {
      const I18N = await inLang(l);
      const wrong = [];
      Object.entries(EN).filter(([, v]) => isPlural(v)).forEach(([k, enVal]) => {
        const v = hasOwn(DICTS[l], k) ? DICTS[l][k] : enVal;
        const params = Object.fromEntries(withoutCount(union(v)).map((n) => [n, `‹${n}›`]));
        counts.forEach((n) => {
          const want = oldPick(v, n).replace(/\{\{(\w+)\}\}/g, (m, p) => (p === 'count' ? String(n) : params[p]));
          const got = I18N.t(k, { ...params, count: n });
          if (got !== want) { wrong.push(`${l} ${k} at ${n}: ${JSON.stringify(got)}, was ${JSON.stringify(want)}`); }
        });
      });
      assert.deepEqual(wrong, [], l);
    }
  });

  test('Japanese, Korean and Chinese always read other (their `one` is never picked)', async () => {
    for (const l of ['ja', 'ko', 'zh']) {
      const I18N = await inLang(l, { files: { [`${l}.json`]: { k: { one: 'ONE {{count}}', other: 'OTHER {{count}}' } } } });
      assert.deepEqual([0, 1, 2].map((n) => I18N.t('k', { count: n })), ['OTHER 0', 'OTHER 1', 'OTHER 2'], l);
    }
  });

  test('a form the object lacks reads other, else one; an explicit zero wins for 0', async () => {
    const ru = await inLang('ru', { files: { 'ru.json': { old: { one: '{{count}} A', other: '{{count}} B' }, bare: { one: '{{count}} A' }, z: { zero: 'none', one: '{{count}} A', other: '{{count}} B' } } } });
    assert.deepEqual([1, 3, 5].map((n) => ru.t('old', { count: n })), ['1 A', '3 B', '5 B']);
    assert.equal(ru.t('bare', { count: 5 }), '5 A');
    assert.equal(ru.t('z', { count: 0 }), 'none');
    const fr = await inLang('fr', { files: { 'fr.json': { z: { zero: 'aucune', one: '{{count}} chanson', other: '{{count}} chansons' } } } });
    assert.equal(fr.t('z', { count: 0 }), 'aucune', 'zero beats French one');
    assert.equal(fr.t('z', { count: 1 }), '1 chanson');
  });
});

describe('t(): an English value is read by English rules', () => {
  test('an English fallback inside a Russian page reads English ("21 songs", not Russian one\'s "1 song")', async () => {
    assert.ok(!hasOwn(DICTS.ru, 'discover.modal.songCount'), 'the key is English-only (else pick another)');
    assert.deepEqual(EN['discover.modal.songCount'], { one: '1 song', other: '{{count}} songs' });
    const ru = await inLang('ru');
    assert.deepEqual([1, 2, 5, 21, 22].map((n) => ru.t('discover.modal.songCount', { count: n })), ['1 song', '2 songs', '5 songs', '21 songs', '22 songs']);
    // …while the page's own Russian values keep Russian rules
    assert.equal(ru.t('stats.count.days', { count: 21 }), '21 день');
  });

  test('an empty translation counts as missing: the English value, by English rules', async () => {
    const ru = await inLang('ru', { files: { 'ru.json': { k: '' }, 'en.json': { k: { one: '1 song', other: '{{count}} songs' } } } });
    assert.equal(ru.t('k', { count: 21 }), '21 songs');
  });

  test('a language whose file failed reads English, by English rules; back to English after a translated language', async () => {
    const sv = await inLang('sv');
    assert.equal(sv.getLanguage(), 'sv', 'the requested language is still the one stored');
    assert.equal(sv.t('stats.count.days', { count: 21 }), '21 days');
    assert.equal(sv.t('stats.count.days', { count: 1 }), '1 day');
    const I18N = await inLang('ru');
    assert.equal(I18N.t('stats.count.days', { count: 21 }), '21 день');
    await I18N.loadLanguage('en');
    assert.equal(I18N.t('stats.count.days', { count: 21 }), '21 days');
    await I18N.loadLanguage('pl');
    assert.equal(I18N.t('stats.count.days', { count: 22 }), '22 dni');
    await I18N.loadLanguage('nope');
    assert.equal(I18N.t('stats.count.days', { count: 22 }), '22 days');
  });
});

describe('t(): the count', () => {
  test('only a number picks a form: a string count, even \'3\', returns the key, as no count does', async () => {
    const ru = await inLang('ru');
    assert.equal(ru.t('stats.count.days', { count: '3' }), 'stats.count.days');
    assert.equal(ru.t('stats.count.days', { count: '1.001' }), 'stats.count.days', 'a grouped number is not misread as 1.001');
    assert.equal(ru.t('stats.count.days'), 'stats.count.days');
    assert.equal(ru.t('stats.count.days', {}), 'stats.count.days');
    // a plain string still takes a string count as text
    assert.equal(ru.t('stats.unit.minutes', { n: '3' }), '3 мин');
    const en = await inLang('en');
    assert.equal(en.t('{{count}} left', { count: '3' }), '3 left');
  });

  test('NaN and Infinity read other; a negative number by its rule', async () => {
    const en = await inLang('en');
    assert.equal(en.t('stats.count.days', { count: NaN }), 'NaN days');
    assert.equal(en.t('stats.count.days', { count: Infinity }), 'Infinity days');
    assert.equal(en.t('stats.count.days', { count: -1 }), '-1 day');
    const ru = await inLang('ru');
    assert.equal(ru.t('stats.count.days', { count: NaN }), 'NaN дня');
  });
});

describe('t(): without Intl.PluralRules, the English rule (1 → one, else other)', () => {
  const ruDays = (I18N) => [0, 1, 2, 5, 21].map((n) => I18N.t('stats.count.days', { count: n }));
  const ENGLISH_RULE = ['0 дня', '1 день', '2 дня', '5 дня', '21 дня'];

  test('no Intl at all, an Intl without PluralRules, and one that throws: the script loads and t() still picks', async () => {
    const throwing = { PluralRules: function PluralRules() { throw new Error('no ICU data'); } };
    const selectThrows = { PluralRules: function PluralRules() { return { select: () => { throw new Error('boom'); } }; } };
    const cases = [['no Intl', undefined], ['Intl null', null], ['no PluralRules', {}], ['the constructor throws', throwing], ['select throws', selectThrows]];
    for (const [label, intl] of cases) {
      const I18N = await inLang('ru', { intl });
      assert.deepEqual(ruDays(I18N), ENGLISH_RULE, label);
      assert.equal(I18N.t('discover.modal.songCount', { count: 1 }), '1 song');
      assert.equal(I18N.t('discover.modal.songCount', { count: 21 }), '21 songs');
    }
  });

  test('a language tag the runtime refuses reads by the English rule', async () => {
    const I18N = await inLang('not a tag!', { files: { 'not a tag!.json': { k: { one: '{{count}} A', few: '{{count}} F', other: '{{count}} B' } } } });
    assert.deepEqual([1, 3].map((n) => I18N.t('k', { count: n })), ['1 A', '3 B']);
  });
});

describe('t(): interpolation is one pass', () => {
  test('a param\'s value is text: a title holding {{b}}, a layout\'s {{ARTIST}}/{{ALBUM}}', async () => {
    const I18N = await inLang('en');
    assert.equal(I18N.t('{{a}} / {{b}}', { a: 'title with {{b}}', b: 'X' }), 'title with {{b}} / X');
    assert.equal(I18N.t('{{b}} / {{a}}', { a: 'title with {{b}}', b: 'X' }), 'X / title with {{b}}', 'whatever the params\' order');
    assert.equal(I18N.t('Into {{layout}}', { layout: '{{ARTIST}}/{{ALBUM}}', ARTIST: 'Boukmanflow', ALBUM: 'Tapes' }), 'Into {{ARTIST}}/{{ALBUM}}');
    assert.equal(I18N.t('{{title}}', { title: '{{title}}' }), '{{title}}');
  });

  test('$-patterns are text; every occurrence is filled; a placeholder with no param stays', async () => {
    const I18N = await inLang('en');
    assert.equal(I18N.t('because {{title}}', { title: "Money $' Talks $& $$ $1" }), "because Money $' Talks $& $$ $1");
    assert.equal(I18N.t('{{n}} of {{m}}, {{n}} again', { n: 2, m: 3 }), '2 of 3, 2 again');
    assert.equal(I18N.t('{{n}} of {{m}}', { n: 2 }), '2 of {{m}}');
    assert.equal(I18N.t('{{ n }} of {{n}}', { n: 2 }), '{{ n }} of 2', 'no spaces inside the braces');
    assert.equal(I18N.t('{{toString}} {{constructor}}', {}), '{{toString}} {{constructor}}', 'only the params\' own names');
    assert.equal(I18N.t('{{a}}|{{b}}|{{c}}', { a: 0, b: null, c: undefined }), '0|null|undefined');
  });

  test('a plural form and its other params fill in the same pass', async () => {
    const en = await inLang('en');
    assert.deepEqual(EN['discover.modal.dest.folderCount'], { one: '1 folder', other: '{{count}} folders' }, 'en text this test reads');
    assert.equal(en.t('discover.modal.dest.folderCount', { count: 4 }), '4 folders');
    const ru = await inLang('ru', { files: { 'ru.json': { k: { one: '{{count}} трек «{{title}}»', few: '{{count}} трека «{{title}}»', many: '{{count}} треков «{{title}}»', other: '{{count}} трека «{{title}}»' } } } });
    assert.equal(ru.t('k', { title: '{{count}}', count: 22 }), '22 трека «{{count}}»');
  });

  test('a param\'s name is never a pattern: "(" does not throw, "a." does not fill {{ab}}, a name is word characters', async () => {
    // The old fill built a RegExp from each param's name: "(" threw
    // "Unterminated group" out of t(), "a." matched {{ab}} and {{a!}}.
    const I18N = await inLang('en');
    assert.equal(I18N.t('{{a}}', { '(': 1, a: 2 }), '2');
    assert.equal(I18N.t('{{a}} {{ab}}', { 'a.': 1 }), '{{a}} {{ab}}');
    assert.equal(I18N.t('{{a}} {{a.b}} {{a-b}}', { a: 1, 'a.b': 2, 'a-b': 3, '.*': 4 }), '1 {{a.b}} {{a-b}}');
    assert.equal(I18N.t('{{A_1}} {{9}}', { A_1: 'x', 9: 'y' }), 'x y');
  });
});

describe('translatePage()', () => {
  // An element as translatePage() reads it: its attributes and its text.
  const element = (attrs, text) => {
    const a = { ...attrs };
    return { textContent: text, attrs: a, getAttribute: (n) => (hasOwn(a, n) ? a[n] : null), setAttribute: (n, v) => { a[n] = String(v); } };
  };

  test('a string fills textContent, or the one attribute data-i18n-attr names; an English fallback too; a missing, empty or plural key leaves the element as written', async () => {
    const files = {
      'en.json': { 'k.text': 'Hello', 'k.attr': 'Search…', 'k.enOnly': 'English only', 'k.empty': 'Blank in Russian', 'k.plural': { one: '{{count}} day', other: '{{count}} days' } },
      'ru.json': { 'k.text': 'Привет', 'k.attr': 'Поиск…', 'k.empty': '', 'k.plural': { one: '{{count}} день', few: '{{count}} дня', many: '{{count}} дней', other: '{{count}} дня' } },
    };
    const els = {
      text: element({ 'data-i18n': 'k.text' }, 'Hello'),
      attr: element({ 'data-i18n': 'k.attr', 'data-i18n-attr': 'placeholder', placeholder: 'Search…' }, ''),
      enOnly: element({ 'data-i18n': 'k.enOnly' }, 'inline'),
      empty: element({ 'data-i18n': 'k.empty' }, 'inline'),
      missing: element({ 'data-i18n': 'k.nowhere' }, 'Inline English'),
      plural: element({ 'data-i18n': 'k.plural' }, 'Days'),
    };
    const I18N = loadI18n({ files, elements: Object.values(els) });
    await I18N.loadLanguage('ru'); // translatePage() runs at the end of every load
    assert.equal(els.text.textContent, 'Привет');
    assert.equal(els.attr.attrs.placeholder, 'Поиск…');
    assert.equal(els.attr.textContent, '', 'an attribute key leaves the text alone');
    assert.equal(els.enOnly.textContent, 'English only');
    assert.equal(els.empty.textContent, 'Blank in Russian');
    assert.equal(els.missing.textContent, 'Inline English');
    assert.equal(els.plural.textContent, 'Days');
    await I18N.loadLanguage('en');
    assert.equal(els.text.textContent, 'Hello');
    assert.equal(els.attr.attrs.placeholder, 'Search…');
  });
});
