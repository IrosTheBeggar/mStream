/**
 * /server-remote serves webapp/index.html with the browser player swapped for
 * the server-audio client (src/api/server-playback.js
 * rewriteIndexForServerAudio).
 *
 * Every step of that rewrite is an exact-string or regex match against the
 * committed index.html, and a miss is silent: the page still renders, just
 * with the wrong player or a stray script. Three replacements had been
 * no-ops for months after the visualizer scripts left index.html. This pins
 * the rewrite to the REAL index.html so markup drift fails here instead of
 * on somebody's remote.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteIndexForServerAudio } from '../../src/api/server-playback.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, '..', '..', 'webapp', 'index.html'), 'utf8');

describe('rewriteIndexForServerAudio', () => {
  const out = rewriteIndexForServerAudio(indexHtml);

  test('swaps the browser player for the server-audio client, flag first', () => {
    assert.ok(indexHtml.includes('assets/js/mstream.player.js'), 'index.html must load the browser player');
    assert.ok(!out.includes('assets/js/mstream.player.js'), 'the browser player must be gone');
    const flag = out.indexOf('var serverAudioMode = true');
    const client = out.indexOf('assets/js/mstream.server-audio.js');
    assert.ok(flag > 0, 'serverAudioMode must be set');
    assert.ok(client > flag, 'the client script must load after the flag is set');
  });

  test('drops the scripts that have no role in server-audio mode', () => {
    for (const src of ['assets/js/mstream.jukebox.js', 'assets/js/lib/qr.js', 'assets/js/t.js']) {
      assert.ok(indexHtml.includes(src), `${src} must exist in index.html for the strip to mean anything`);
      assert.ok(!out.includes(src), `${src} must be stripped`);
    }
  });

  test('replaces the visualizer button with the Server Audio badge', () => {
    assert.ok(indexHtml.includes('v-on:click="fadeOverlay"'), 'index.html must carry the visualizer button');
    assert.ok(!out.includes('v-on:click="fadeOverlay"'), 'the visualizer button must be gone');
    assert.ok(out.includes('>Server Audio</span>'), 'the badge must take its place');
  });

  test('leaves everything else alone', () => {
    // The sidebar items this mode hides stay in the markup — the client's
    // injected CSS owns hiding them, so the server must not strip them.
    for (const panel of ['autoDjPanel', 'setupTranscodePanel', 'setupJukeboxPanel']) {
      assert.ok(out.includes(`changeView(${panel}`), `${panel} sidebar item must survive the rewrite`);
    }
    assert.equal(rewriteIndexForServerAudio('<html></html>'), '<html></html>', 'no anchors, no change');
    assert.equal(rewriteIndexForServerAudio(indexHtml), out, 'pure function of its input');
  });
});
