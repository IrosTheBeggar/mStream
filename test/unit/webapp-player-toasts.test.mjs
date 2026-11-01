// mstream.player.js's toasts that name outside words. iziToast inserts a
// toast's title and message as markup, so a name that is not ours (Last.fm's
// similar artists, a track's artist tag) must reach it as text. The player
// file also runs on the shared-playlist page, which has no m.js — it escapes
// with its own _escapeToastText.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const EN = require('../../webapp/locales/en.json');
const SRC = readFileSync(new URL('../../webapp/assets/js/mstream.player.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const I18N_SRC = readFileSync(new URL('../../webapp/assets/js/i18n.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const I18N = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', `${I18N_SRC}\nreturn I18N;`)(
  {}, { querySelector: () => null, querySelectorAll: () => [] }, { getItem: () => null, setItem: () => {} }, { language: 'en' },
  () => Promise.resolve({ json: () => Promise.resolve(EN) }));
await I18N.loadLanguage('en');
const tEn = I18N.t;

// A function of the player module (two-space indent), as its source.
function playerFn(name) {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, `mstream.player.js no longer defines ${name}() — update this test`);
  const end = SRC.indexOf('\n  }\n', start);
  return SRC.slice(start + 1, end + '\n  }'.length);
}

const strip = (cache) => {
  const toasts = [];
  const show = new Function('AUTODJ', 'iziToast', 't', '_autoDjSimilarCache',
    `${playerFn('_escapeToastText')}\n${playerFn('_showSimilarArtistsInfoStrip')}\nreturn _showSimilarArtistsInfoStrip;`)(
    { state: { similar: true } }, { info: (o) => toasts.push(o) }, tEn, cache);
  show();
  return toasts;
};

describe('Auto DJ\'s similar-artists toast (mstream.player.js)', () => {
  test('the artists\' names reach the toast as text', () => {
    const toasts = strip({ sourceArtist: '<b>Mo</b>', artists: ['<img src=x onerror="alert(1)">', 'Nova & Co'] });
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, tEn('autoDJ.similarInfoTitle'));
    assert.equal(toasts[0].message, 'Picked something close to &lt;b&gt;Mo&lt;/b&gt;. Considered: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;, Nova &amp; Co.');
    assert.ok(!/[<>]/.test(toasts[0].message));
  });

  test('more than five: the count line, as text too', () => {
    const toasts = strip({ sourceArtist: 'Mo', artists: ['A', 'B', 'C', 'D', '<i>E</i>', 'F', 'G'] });
    assert.equal(toasts[0].message, 'Picked something close to Mo. Considered: A, B, C, D, &lt;i&gt;E&lt;/i&gt; (+2 more).');
  });

  test('plain names read as they did', () => {
    const toasts = strip({ sourceArtist: 'Mo', artists: ['Nova'] });
    assert.equal(toasts[0].message, 'Picked something close to Mo. Considered: Nova.');
  });
});
