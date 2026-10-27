/**
 * webapp/locales/*.json — the Peer Recommendations page's strings: every
 * key the page adds (visible and a11y) carries its exact English value in
 * en.json and a translation in each of the 11 other locale files with the
 * same {{params}} (the admin's turn-on form among them, which takes none),
 * and the Discover keys the page reuses (the nav row, the config bar, the
 * seeds, the scan-pending card) are translated too, so the bar never stays
 * English beside translated page text. Server-drawn text (a peer's label
 * and monogram, a preview's attribution) is never a key.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALES = ['de', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'zh'];
const load = (lang) => JSON.parse(readFileSync(new URL(`../../webapp/locales/${lang}.json`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const EN = load('en');
const FILES = Object.fromEntries(LOCALES.map((lang) => [lang, load(lang)]));

// The page's own keys, with their English values (the plan's complete list).
const NEW = {
  'nav.peerRecs': 'Peer Recommendations',
  'panel.peerRecs': 'Peer Recommendations',
  'peerRecs.all': 'All',
  'peerRecs.adding': 'Adding…',
  'peerRecs.tryAgain': 'Try again',
  'peerRecs.noRoom': 'No room',
  'peerRecs.noPeers': 'No peers yet',
  'peerRecs.nothingNew': 'Nothing new',
  'peerRecs.preview': 'Preview',
  'peerRecs.previewAll': 'Preview all',
  'peerRecs.copyList': 'Copy list',
  'peerRecs.copied': 'Copied',
  'peerRecs.getIt': 'Get it…',
  'peerRecs.copy': 'Copy',
  'peerRecs.noPreview': 'No preview',
  'peerRecs.a11y.peers': 'Peers',
  'peerRecs.a11y.add': 'Add {{name}}',
  'peerRecs.a11y.adding': '{{name}}: Adding…',
  'peerRecs.a11y.failed': '{{name}}: Try again',
  'peerRecs.a11y.noRoom': '{{name}}: No room',
  'peerRecs.a11y.previewSong': 'Preview {{title}}',
  'peerRecs.a11y.pauseSong': 'Pause preview of {{title}}',
  'peerRecs.a11y.play': 'Play preview',
  'peerRecs.a11y.pause': 'Pause preview',
  'peerRecs.a11y.next': 'Next preview',
  'peerRecs.a11y.close': 'Close preview',
  'peerRecs.a11y.position': 'Preview position',
};

// The turn-on form an admin sees while the network is off (W7): no {{params}}.
const TURN_ON = {
  'peerRecs.turnOn.shares': "Shares your library's metadata, never its audio, on the public discovery network, with this server's name and description.",
  'peerRecs.turnOn.collection': 'Also turns on discovery data collection.',
  'peerRecs.turnOn.name': 'Server name',
  'peerRecs.turnOn.description': 'Description',
  'peerRecs.turnOn.button': 'Turn on',
  'peerRecs.turnOn.busy': 'Turning on…',
  'peerRecs.turnOn.unavailable': "The discovery network isn't available on this platform.",
  'peerRecs.turnOn.nameNotSaved': "The network is on, but the server name wasn't saved.",
  'peerRecs.turnOn.descriptionNotSaved': "The network is on, but the description wasn't saved.",
};

// The Discover keys the page draws: listed exactly, or by a prefix.
const REUSED = [
  'nav.discover', 'panel.discover', 'dpage.basedOnLast', 'dpage.bar.', 'dpage.window.', 'dpage.seeds.',
  'dpage.verb.newSeeds', 'dpage.verb.checkAgain', 'dpage.verb.tryAgain', 'dpage.verb.adminEnrichment',
  'dpage.state.loading', 'dpage.state.scanPending', 'dpage.state.scanPendingBody', 'dpage.state.seedsListedAnyway',
];
const REUSED_KEYS = Object.keys(EN).filter((k) => REUSED.some((r) => (r.endsWith('.') ? k.startsWith(r) : k === r)));

// The {{params}} a value fills, across every plural form of an object value.
function params(val) {
  const forms = typeof val === 'string' ? [val] : Object.values(val);
  const out = new Set();
  for (const f of forms) { for (const m of f.matchAll(/\{\{(\w+)\}\}/g)) { out.add(m[1]); } }
  return [...out].sort();
}

function assertTranslated(lang, key) {
  const val = FILES[lang][key];
  assert.ok(val !== undefined, `${lang}.json: ${key} missing`);
  if (typeof EN[key] === 'string') {
    assert.equal(typeof val, 'string', `${lang}.json: ${key} is a string`);
    assert.ok(val.trim(), `${lang}.json: ${key} is not empty`);
  } else {
    assert.ok(val && typeof val.one === 'string' && typeof val.other === 'string', `${lang}.json: ${key} has one and other`);
    for (const f of Object.values(val)) { assert.ok(typeof f === 'string' && f.trim(), `${lang}.json: ${key} forms are text`); }
  }
  assert.deepEqual(params(val), params(EN[key]), `${lang}.json: ${key} fills the same {{params}}`);
}

describe('Peer Recommendations strings', () => {
  test('en.json: every new key with its English value', () => {
    for (const [key, text] of Object.entries(NEW)) { assert.equal(EN[key], text, key); }
  });

  test('en.json: the peerRecs namespace holds the listed keys and nothing else', () => {
    const own = Object.keys(EN).filter((k) => k.startsWith('peerRecs.'));
    const listed = [...Object.keys(NEW), ...Object.keys(TURN_ON)].filter((k) => k.startsWith('peerRecs.'));
    assert.deepEqual(own.sort(), listed.sort());
  });

  test('the nav and panel rows sit beside Discover in en.json', () => {
    const keys = Object.keys(EN);
    assert.equal(keys.indexOf('nav.peerRecs'), keys.indexOf('nav.discover') + 1);
    assert.equal(keys.indexOf('panel.peerRecs'), keys.indexOf('panel.discover') + 1);
  });

  for (const lang of LOCALES) {
    test(`${lang}.json: every new key, translated, with matching {{params}}`, () => {
      for (const key of Object.keys(NEW)) { assertTranslated(lang, key); }
    });
  }
});

describe('the turn-on form', () => {
  test('en.json: every key with its English value', () => {
    for (const [key, text] of Object.entries(TURN_ON)) { assert.equal(EN[key], text, key); }
  });

  for (const lang of ['en', ...LOCALES]) {
    test(`${lang}.json: every key, non-empty text, no {{params}}`, () => {
      const file = lang === 'en' ? EN : FILES[lang];
      for (const key of Object.keys(TURN_ON)) {
        const val = file[key];
        assert.equal(typeof val, 'string', `${lang}.json: ${key} is a string`);
        assert.ok(val.trim(), `${lang}.json: ${key} is not empty`);
        assert.ok(!val.includes('{{'), `${lang}.json: ${key} takes no params`);
      }
    });
  }

  for (const lang of LOCALES) {
    test(`${lang}.json: translated, one ellipsis character`, () => {
      for (const key of Object.keys(TURN_ON)) {
        const val = FILES[lang][key];
        if (key !== 'peerRecs.turnOn.description') { assert.notEqual(val, EN[key], `${lang}.json: ${key} is translated`); }
        assert.ok(!val.includes('...'), `${lang}.json: ${key} uses …`);
      }
      assert.ok(FILES[lang]['peerRecs.turnOn.busy'].endsWith('…'), `${lang}.json: busy ends in …`);
    });
  }
});

describe('the Discover keys the page reuses', () => {
  test('the list resolves to keys en.json has', () => {
    for (const r of REUSED) {
      assert.ok(REUSED_KEYS.some((k) => (r.endsWith('.') ? k.startsWith(r) : k === r)), `${r} in en.json`);
    }
    assert.ok(REUSED_KEYS.length >= 30, 'the bar, the window and the seeds');
  });

  for (const lang of LOCALES) {
    test(`${lang}.json: translated, with matching {{params}}`, () => {
      for (const key of REUSED_KEYS) { assertTranslated(lang, key); }
    });
  }
});

describe('every locale file stays a subset of en.json', () => {
  for (const lang of LOCALES) {
    test(`${lang}.json: no key en.json lacks, in en.json's order`, () => {
      const order = Object.keys(EN);
      const keys = Object.keys(FILES[lang]);
      for (const k of keys) { assert.ok(order.includes(k), `${lang}.json: ${k} is not an en.json key`); }
      const at = keys.map((k) => order.indexOf(k));
      assert.deepEqual(at, [...at].sort((a, b) => a - b), `${lang}.json follows en.json's order`);
    });
  }
});

test('server-drawn text is never a key: no attribution, label or monogram value', () => {
  for (const file of [EN, ...Object.values(FILES)]) {
    for (const [key, val] of Object.entries(file)) {
      if (!key.startsWith('peerRecs.')) { continue; }
      assert.ok(!/Deezer|iTunes|courtesy|monogram/i.test(JSON.stringify(val)), key);
    }
  }
});
