/**
 * Lyrics provider library — hermetic unit tests.
 *
 * Providers are exercised through the injectable HTTP client (_setHttpClient),
 * so nothing here touches the real LRCLib / NetEase / Kugou APIs. The KRC
 * decoder is round-tripped against an inverse-encoded fixture.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { LYRICS_PROVIDERS, decodeKrc, krcToLrc, _setHttpClient, _isBlockedAddress, _defaultHttpGet } from '../../src/db/lyrics-lookup-lib.js';

const { lrclib, netease, kugou } = LYRICS_PROVIDERS;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Inverse of decodeKrc: KRC text → krc1 base64 payload.
const KRC_KEY = Buffer.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);
function encodeKrc(text) {
  const comp = zlib.deflateSync(Buffer.from(text, 'utf8'));
  const xored = Buffer.allocUnsafe(comp.length);
  for (let i = 0; i < comp.length; i++) { xored[i] = comp[i] ^ KRC_KEY[i & 15]; }
  return Buffer.concat([Buffer.from('krc1'), xored]).toString('base64');
}

afterEach(() => _setHttpClient(null)); // restore the real client

// ── KRC decoder ──────────────────────────────────────────────────────────────
test('decodeKrc round-trips a krc1 payload', () => {
  const text = '[ti:T]\n[0,1000]<0,500,0>Hi <500,500,0>there';
  assert.equal(decodeKrc(encodeKrc(text)), text);
});
test('decodeKrc rejects a non-krc1 payload', () => {
  assert.throws(() => decodeKrc(b64('nope!!')), /not a krc1/);
});
test('krcToLrc collapses word timings to line-level LRC', () => {
  const lrc = krcToLrc('[ti:Song]\n[language:eyJ9]\n[1500,800]<0,400,0>hello <400,400,0>world');
  assert.match(lrc, /\[ti:Song\]/);
  assert.doesNotMatch(lrc, /language/);            // translation blob dropped
  assert.match(lrc, /\[00:01\.50\]hello world/);   // line stamp, words concatenated, tags stripped
});

// ── LRCLib ───────────────────────────────────────────────────────────────────
test('lrclib: 200 synced → hit', async () => {
  _setHttpClient(async () => ({ status: 200, body: { syncedLyrics: '[00:01.00]hi', plainLyrics: 'hi' } }));
  const r = await lrclib('A', 'B', 100);
  assert.equal(r.source, 'lrclib');
  assert.equal(r.syncedLrc, '[00:01.00]hi');
});
test('lrclib: 404 both attempts → null', async () => {
  _setHttpClient(async () => ({ status: 404, body: null }));
  assert.equal(await lrclib('A', 'B', 100), null);
});
test('lrclib: 5xx → throws (transient)', async () => {
  _setHttpClient(async () => ({ status: 503, body: null }));
  await assert.rejects(() => lrclib('A', 'B', 0));
});
test('lrclib: exact-duration miss falls through to fuzzy', async () => {
  let calls = 0;
  _setHttpClient(async (url) => {
    calls++;
    if (url.includes('duration=')) { return { status: 404, body: null }; }
    return { status: 200, body: { syncedLyrics: '[00:02.00]x' } };
  });
  const r = await lrclib('A', 'B', 200);
  assert.equal(calls, 2);
  assert.equal(r.syncedLrc, '[00:02.00]x');
});

// ── NetEase ──────────────────────────────────────────────────────────────────
test('netease: search → lyric → hit', async () => {
  _setHttpClient(async (url) => {
    if (url.includes('/search/get')) { return { status: 200, body: { code: 200, result: { songs: [{ id: 42, duration: 100000 }] } } }; }
    if (url.includes('/song/lyric')) { return { status: 200, body: { lrc: { lyric: '[00:01.00]hello' } } }; }
    return { status: 404, body: null };
  });
  const r = await netease('A', 'B', 100);
  assert.equal(r.source, 'netease');
  assert.match(r.syncedLrc, /hello/);
});
test('netease: pureMusic → null', async () => {
  _setHttpClient(async (url) => {
    if (url.includes('/search/get')) { return { status: 200, body: { code: 200, result: { songs: [{ id: 1 }] } } }; }
    return { status: 200, body: { pureMusic: true, lrc: { lyric: '[00:00.00]instrumental' } } };
  });
  assert.equal(await netease('A', 'B', 0), null);
});
test('netease: -462 gate → throws (transient)', async () => {
  _setHttpClient(async () => ({ status: 200, body: { code: -462 } }));
  await assert.rejects(() => netease('A', 'B', 0));
});
test('netease: strips the [by:] watermark line', async () => {
  _setHttpClient(async (url) => {
    if (url.includes('/search/get')) { return { status: 200, body: { code: 200, result: { songs: [{ id: 1 }] } } }; }
    return { status: 200, body: { lrc: { lyric: '[by:99Lrc.net]\n[00:01.00]real line' } } };
  });
  const r = await netease('A', 'B', 0);
  assert.doesNotMatch(r.syncedLrc, /99Lrc/);
  assert.match(r.syncedLrc, /real line/);
});

// ── Kugou ────────────────────────────────────────────────────────────────────
test('kugou: search → candidate → download(fmt=lrc) → hit', async () => {
  _setHttpClient(async (url) => {
    if (url.includes('/search/song')) { return { status: 200, body: { data: { info: [{ hash: 'H', duration: 100 }] } } }; }
    if (url.includes('lyrics.kugou.com/search')) { return { status: 200, body: { status: 200, candidates: [{ id: 'i', accesskey: 'k' }] } }; }
    if (url.includes('/download')) { return { status: 200, body: { content: b64('[00:01.00]kugou line') } }; }
    return { status: 404, body: null };
  });
  const r = await kugou('A', 'B', 100);
  assert.equal(r.source, 'kugou');
  assert.match(r.syncedLrc, /kugou line/);
});
test('kugou: empty search info → null', async () => {
  _setHttpClient(async () => ({ status: 200, body: { data: { info: [] } } }));
  assert.equal(await kugou('A', 'B', 0), null);
});
test('kugou: no candidates → null', async () => {
  _setHttpClient(async (url) => {
    if (url.includes('/search/song')) { return { status: 200, body: { data: { info: [{ hash: 'H', duration: 1 }] } } }; }
    return { status: 200, body: { status: 200, candidates: [] } };
  });
  assert.equal(await kugou('A', 'B', 0), null);
});

// ── SSRF guard (real HTTP client) ────────────────────────────────────────────
test('isBlockedAddress flags non-public addresses', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
  ];
  for (const ip of blocked) { assert.equal(_isBlockedAddress(ip), true, `${ip} should be blocked`); }
});

test('isBlockedAddress allows public addresses', () => {
  const ok = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'];
  for (const ip of ok) { assert.equal(_isBlockedAddress(ip), false, `${ip} should be allowed`); }
});

test('defaultHttpGet refuses a redirect-style internal IP literal (SSRF)', async () => {
  await assert.rejects(_defaultHttpGet('http://169.254.169.254/latest/meta-data/'),
    /non-public address/);
});

test('defaultHttpGet refuses a non-http(s) scheme', async () => {
  await assert.rejects(_defaultHttpGet('file:///etc/passwd'), /non-http/);
});
