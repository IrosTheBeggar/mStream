/**
 * webapp/alpha/music-map.js: the Music Map's pure core, on node
 * (docs/music-map-plan.md section 4.11). The decoders are held to the
 * server's own encoders (src/db/map-lib.js), the shared land fixture
 * (test/fixtures/map/land-v1.json) and real answers captured from a Phase 1
 * server on the demo library (test/fixtures/map/live-demo.json). Then the
 * view math, the semantic bands and LOD, the grid index, the name, title and
 * badge placers (Atlas board scenarios), the palette against the dir-A table,
 * the DJ trail fold, the no-dot rules, the highlight reducer with the marks it
 * derives, and the states reducer of section 4.6. No timing assertions: the
 * decode budget is held by asserting the columns are views on one buffer.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as L from '../../src/db/map-lib.js';

const require = createRequire(import.meta.url);
const M = require('../../webapp/alpha/music-map.js');
const SOURCE_PATH = new URL('../../webapp/alpha/music-map.js', import.meta.url);
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const LAND = JSON.parse(readFileSync(new URL('../fixtures/map/land-v1.json', import.meta.url), 'utf8'));
const LIVE = JSON.parse(readFileSync(new URL('../fixtures/map/live-demo.json', import.meta.url), 'utf8'));

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const PLATE = { w: 656, h: 663 };
const BOUNDS = { x: 0, y: 0, w: 656, h: 663 };

// mulberry32: deterministic synthetic data.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A GET /map 200 body from plain points through the server's encoder.
// points: [{id, x, y (map units), r0, r1, recent}]; regions as the server sends them.
function body({ points = [], regions = [], rev = 'r1', frame = 1, model = 'effnet-discogs', state = 'ready' } = {}) {
  const sorted = points.slice().sort((a, b) => a.id - b.id);
  const cols = {
    ids: sorted.map((p) => p.id),
    x: sorted.map((p) => L.quantU16(p.x)),
    y: sorted.map((p) => L.quantU16(p.y)),
    region0: sorted.map((p) => p.r0 ?? 255),
    region1: sorted.map((p) => p.r1 ?? 255),
    flags: sorted.map((p) => (p.recent ? 1 : 0)),
  };
  return {
    state,
    model: { id: model, version: '1' },
    rev,
    layout: { id: 7, method: 'umap', frame, aspect: 1, landFormat: 'land-v1' },
    regions,
    points: { n: sorted.length, format: 'cols-v1', data: b64(L.encodePointsColsV1(cols)) },
  };
}
const EMPTY_LAND = b64(L.encodeLandV1([[], [], []]));
const province = (id, label, hue, anchor, size, extra = {}) => Object.assign(
  { key: `g:${label}`, level: 0, id, parent: null, label, hue, anchor: anchor.map(L.quantU16), size, land: EMPTY_LAND }, extra);
const town = (id, parent, label, hue, anchor, size) => ({ key: `t:${id}`, level: 1, id, parent, label, hue, anchor: anchor.map(L.quantU16), size });
const mapOf = (b) => { const d = M.decodeMap(b); assert.ok(d.ok, d.reason); return d.map; };

// The boards' width estimate (build.mjs textWidth): province names are
// upper-case Jura with 0.16 em tracking, towns italic, titles 12 px.
function approx(text, c = {}) {
  const caps = c.level === 0, size = c.size || 12;
  let w = 0;
  for (const ch of caps ? String(text).toUpperCase() : String(text)) {
    let k = 0.56;
    if (/[A-Z]/.test(ch)) { k = 0.66; } else if (/[mwMW]/.test(ch)) { k = 0.82; } else if (/[iljI.,'!|]/.test(ch)) { k = 0.28; } else if (ch === ' ') { k = 0.3; } else if (/[a-z0-9]/.test(ch)) { k = 0.54; }
    w += (k + (caps ? 0.16 : 0)) * size;
  }
  return c.level === 1 ? w * 0.98 : w;
}
// Even-odd point-in-rings, independent of the module.
function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) { inside = !inside; }
    }
  }
  return inside;
}
const hit = (a, b, pad = 0) => !(a.x1 + pad <= b.x0 || b.x1 + pad <= a.x0 || a.y1 + pad <= b.y0 || b.y1 + pad <= a.y0);
const inBounds = (b, pad = 0) => b.x0 >= BOUNDS.x + pad - 1e-9 && b.y0 >= BOUNDS.y + pad - 1e-9 && b.x1 <= BOUNDS.w - pad + 1e-9 && b.y1 <= BOUNDS.h - pad + 1e-9;

describe('module', () => {
  test('UMD: module.exports on node, window.MUSICMAP in a browser', () => {
    for (const k of ['decodeMap', 'reduceHighlight', 'reduceStates', 'foldTrail', 'placeNames', 'paletteFor', 'mount']) {
      assert.equal(typeof M[k], 'function', k);
    }
    const self = {};
    vm.runInNewContext(SOURCE, { self });
    assert.equal(typeof self.MUSICMAP.decodeMap, 'function');
    assert.equal(typeof self.MUSICMAP.mount, 'function');
  });

  // Plan 4.8 budgets the module at 80 KB, loaded eagerly like its siblings (discovery-page.js and
  // auto-dj.js are about 67-69 KB). The core is about 40 KB and the controller about 36 KB.
  test('the whole module, controller included, stays under 80 KB (plan 4.8)', () => {
    assert.ok(Buffer.byteLength(SOURCE) < 80 * 1024, `${Buffer.byteLength(SOURCE)} bytes`);
  });
});

describe('decoders', () => {
  test('cols-v1 decodes what the server encodes, as views on one buffer (no per-point copy)', () => {
    const r = rng(1);
    const n = 100000;
    const ids = [];
    for (let i = 0, id = 0; i < n; i++) { id += 1 + Math.floor(r() * 3); ids.push(id); }
    const cols = {
      ids,
      x: ids.map(() => Math.floor(r() * 65536)),
      y: ids.map(() => Math.floor(r() * 65536)),
      region0: ids.map(() => Math.floor(r() * 256)),
      region1: ids.map(() => Math.floor(r() * 256)),
      flags: ids.map(() => (r() < 0.1 ? 1 : 0)),
    };
    const p = M.decodePoints({ n, format: 'cols-v1', data: b64(L.encodePointsColsV1(cols)) });
    assert.equal(p.n, n);
    assert.ok(p.ids instanceof Uint32Array && p.x instanceof Uint16Array && p.y instanceof Uint16Array);
    assert.ok(p.r0 instanceof Uint8Array && p.r1 instanceof Uint8Array && p.flags instanceof Uint8Array);
    for (const k of ['x', 'y', 'r0', 'r1', 'flags']) { assert.equal(p[k].buffer, p.ids.buffer, `${k} shares the buffer`); }
    assert.deepEqual([p.ids.byteOffset, p.x.byteOffset, p.y.byteOffset, p.r0.byteOffset, p.r1.byteOffset, p.flags.byteOffset].map((o) => o - p.ids.byteOffset),
      [0, 4 * n, 6 * n, 8 * n, 9 * n, 10 * n]);
    assert.equal(p.ids.buffer.byteLength, 11 * n);
    for (let i = 0; i < n; i += 997) {
      assert.equal(p.ids[i], cols.ids[i]);
      assert.equal(p.x[i], cols.x[i]);
      assert.equal(p.y[i], cols.y[i]);
      assert.equal(p.r0[i], cols.region0[i]);
      assert.equal(p.r1[i], cols.region1[i]);
      assert.equal(p.flags[i], cols.flags[i]);
    }
    assert.equal(M.findId(p, cols.ids[54321]), 54321);
    assert.equal(M.findId(p, cols.ids[54321] + 0.5), -1);
    assert.equal(M.findId(p, 0), -1);
  });

  test('the atob fallback decodes the same bytes when Uint8Array.fromBase64 is missing', () => {
    const data = b64(Uint8Array.from([0, 1, 2, 250, 251, 252, 253]));
    const fast = M.b64ToBytes(data);
    const saved = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
    try {
      if (saved) { delete Uint8Array.fromBase64; }
      assert.equal(typeof Uint8Array.fromBase64, 'undefined');
      const slow = M.b64ToBytes(data);
      assert.deepEqual(Array.from(slow), Array.from(fast));
      assert.equal(slow.byteOffset, 0);
      assert.equal(M.b64ToBytes('not base64 !!'), null);
    } finally {
      if (saved) { Object.defineProperty(Uint8Array, 'fromBase64', saved); }
    }
    assert.deepEqual(Array.from(fast), [0, 1, 2, 250, 251, 252, 253]);
    assert.equal(M.b64ToBytes(42), null);
  });

  test('a real payload from the live server decodes (the demo library)', () => {
    const d = M.decodeMap(LIVE.map);
    assert.ok(d.ok);
    const map = d.map;
    assert.equal(map.n, 104);
    assert.equal(map.rev, LIVE.map.rev);
    assert.equal(map.model.id, 'effnet-discogs');
    assert.equal(map.layout.frame, LIVE.map.layout.frame);
    // The same columns as the server's decoder reads from the same bytes.
    const ref = L.decodePointsColsV1(new Uint8Array(Buffer.from(LIVE.map.points.data, 'base64')), 104);
    assert.deepEqual(Array.from(map.ids), Array.from(ref.ids));
    assert.deepEqual(Array.from(map.x), Array.from(ref.x));
    assert.deepEqual(Array.from(map.r1), Array.from(ref.region1));
    for (let i = 1; i < map.n; i++) { assert.ok(map.ids[i] > map.ids[i - 1], 'ids ascending'); }
    assert.equal(map.regions.length, 8);
    const provinces = map.regions.filter((r) => r.level === 0);
    assert.deepEqual(provinces.map((r) => r.label), ['Hip Hop', 'Rock', 'Electronic']);
    for (const p of provinces) {
      assert.equal(p.land.length, 3, 'three terraces');
      assert.ok(p.land[0].length >= 1, 'a coast ring');
      for (const level of p.land) { for (const ring of level) { assert.ok(ring instanceof Uint16Array && ring.length >= 6 && ring.length % 2 === 0); } }
      assert.equal(map.province[p.id], p);
      assert.equal(map.pal[p.id], M.paletteFor(p.hue));
      assert.ok(p.ax >= 0 && p.ax <= 1 && p.ay >= 0 && p.ay <= 1);
    }
    assert.equal(map.byKey.get('t:1').label, 'Jazzy Hip-Hop');
    assert.equal(map.town[1].parent, 0);
    // Every dot of this library belongs to one of the three provinces.
    for (let i = 0; i < map.n; i++) { assert.ok(map.province[map.r0[i]], `dot ${i} has a province`); }
    assert.equal(map.pal[200], M.paletteFor(null), 'no province: the neutral palette');
  });

  test('the live overlays decode against the live map', () => {
    const map = mapOf(LIVE.map);
    const all = M.decodeOverlay(LIVE.overlays.moodAll, map);
    assert.ok(all.ok);
    assert.equal(all.layer, 'mood');
    assert.equal(all.bits.length, 13);
    for (let i = 0; i < 104; i++) { assert.equal(M.bitAt(all.bits, i), 1); }
    const happy = M.decodeOverlay(LIVE.overlays.moodHappy, map);
    assert.ok(happy.ok);
    assert.deepEqual(happy.moods, { valence: 'happy' });
    let on = 0;
    for (let i = 0; i < 104; i++) { on += M.bitAt(happy.bits, i); }
    assert.ok(on > 0 && on < 104);
    const plays = M.decodeOverlay(LIVE.overlays.plays, map);
    assert.ok(plays.ok);
    assert.equal(plays.plays.length, 104);
    assert.equal(M.decodeOverlay(Object.assign({}, LIVE.overlays.plays, { rev: 'other' }), map).reason, 'stale');
    assert.equal(M.decodeOverlay(Object.assign({}, LIVE.overlays.plays, { n: 103 }), map).reason, 'stale');
    assert.equal(M.decodeOverlay({ rev: map.rev, layer: 'mood', n: 104 }, map).reason, 'noMoods');
    assert.equal(M.decodeOverlay(Object.assign({}, LIVE.overlays.plays, { data: 'AAAA' }), map).reason, 'corrupt');
  });

  test('the mood bitset is LSB-first, as the server encodes it', () => {
    const want = (i) => i % 3 === 0 || i === 12;
    const bits = M.decodeBitset(b64(L.encodeBitset(13, want)), 13);
    assert.equal(bits.length, 2);
    for (let i = 0; i < 13; i++) { assert.equal(M.bitAt(bits, i), want(i) ? 1 : 0, `bit ${i}`); }
    assert.equal(M.decodeBitset('', 0).length, 0);
  });

  test('land-v1: the shared fixture decodes to its levels and fills even-odd as recorded', () => {
    const levels = M.decodeLand(LAND.bytes);
    const names = ['coast', 'mid', 'high'];
    assert.deepEqual(levels.map((rings) => rings.map((r) => Array.from(r))), names.map((k) => LAND.levels[k]));
    names.forEach((name, l) => {
      LAND.probes.forEach((py, j) => {
        LAND.probes.forEach((px, i) => {
          assert.equal(inRings(levels[l], px, py) ? '1' : '0', LAND.inside[name][j][i], `${name} at (${px}, ${py})`);
        });
      });
    });
    // Views, not copies.
    assert.ok(levels[0].every((r) => r.buffer === levels[0][0].buffer));
    // traceRings lays closed sub-paths in the units it is given.
    const calls = [];
    M.traceRings({ moveTo: (x, y) => calls.push(['M', x, y]), lineTo: (x, y) => calls.push(['L', x, y]), closePath: () => calls.push(['Z']) }, levels[1], 1 / 65535);
    assert.deepEqual(calls.map((c) => c[0]).join(''), 'MLLLZ');
    assert.equal(calls[0][1], 9000 / 65535);
  });

  test('truncated or padded blobs are rejected; unknown formats are reported as such', () => {
    const bytes = new Uint8Array(Buffer.from(LAND.bytes, 'base64'));
    for (let cut = 0; cut < bytes.length; cut++) {
      assert.throws(() => M.decodeLand(b64(bytes.subarray(0, cut))), (e) => e.code === 'corrupt', `cut at ${cut}`);
    }
    const padded = new Uint8Array(bytes.length + 2);
    padded.set(bytes);
    assert.throws(() => M.decodeLand(b64(padded)), (e) => e.code === 'corrupt');
    const odd = new Uint8Array(bytes.length + 1);
    odd.set(bytes);
    assert.throws(() => M.decodeLand(b64(odd)), (e) => e.code === 'corrupt');
    // A ring of two vertices.
    const two = new Uint8Array(new Uint16Array([1, 2, 0, 0, 5, 5, 0, 0]).buffer);
    assert.throws(() => M.decodeLand(b64(two)), (e) => e.code === 'corrupt');
    assert.deepEqual(M.decodeLand(EMPTY_LAND), [[], [], []]);

    const good = body({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }, { id: 2, x: 0.25, y: 0.75, r0: 0 }] });
    const raw = Buffer.from(good.points.data, 'base64');
    for (const data of [b64(raw.subarray(0, 21)), b64(Buffer.concat([raw, Buffer.from([0])]))]) {
      assert.throws(() => M.decodePoints({ n: 2, format: 'cols-v1', data }), (e) => e.code === 'corrupt');
      assert.deepEqual(M.decodeMap(Object.assign({}, good, { points: { n: 2, format: 'cols-v1', data } })), { ok: false, reason: 'corrupt' });
    }
    assert.throws(() => M.decodePoints({ n: 2, format: 'cols-v2', data: good.points.data }), (e) => e.code === 'format');
    assert.equal(M.decodeMap(Object.assign({}, good, { points: Object.assign({}, good.points, { format: 'cols-v2' }) })).reason, 'format');
    assert.equal(M.decodeMap(Object.assign({}, good, { layout: Object.assign({}, good.layout, { landFormat: 'land-v2' }) })).reason, 'format');
    assert.equal(M.decodeMap({ state: 'building', layout: null, regions: [], points: { n: 0, format: 'cols-v1', data: '' } }).reason, 'state');
    assert.throws(() => M.decodeBitset(b64(new Uint8Array(3)), 13), (e) => e.code === 'corrupt');
    assert.throws(() => M.decodePlays(b64(new Uint8Array(12)), 13), (e) => e.code === 'corrupt');
    // A province whose land does not decode keeps its dots and loses only the land.
    const broken = body({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }], regions: [province(0, 'Rock', 290, [0.5, 0.5], 1, { land: b64(bytes.subarray(0, 9)) })] });
    const m = mapOf(broken);
    assert.equal(m.regions[0].land, null);
    assert.equal(m.n, 1);
  });

  test('ready with no visible dots decodes to an empty map', () => {
    const m = mapOf(body({ points: [] }));
    assert.equal(m.n, 0);
    assert.equal(m.ids.length, 0);
    assert.deepEqual(m.regions, []);
  });
});

describe('view math', () => {
  test('zoom 1: the unit square fits the shorter side less 24 px, centred', () => {
    const v = M.wholeMap();
    const T = M.viewTransform(v, PLATE);
    assert.equal(T.s, 656 - 24);
    assert.deepEqual([T.tx, T.ty], [12, (663 - 632) / 2]);
    assert.equal(M.baseScale({ w: 900, h: 400 }), 376);
    assert.deepEqual(M.toMap(v, PLATE, 12, 15.5), [0, 0]);
  });

  test('zooming about a point keeps that point fixed', () => {
    const r = rng(2);
    let v = M.wholeMap();
    for (let k = 0; k < 40; k++) {
      const sx = 150 + r() * 350, sy = 150 + r() * 350, factor = 0.6 + r() * 1.4;
      const before = M.toMap(v, PLATE, sx, sy);
      const next = M.zoomAt(v, PLATE, factor, sx, sy);
      if (next.z > 1.05 && next.z < 39) {
        const after = M.toMap(next, PLATE, sx, sy);
        assert.ok(Math.abs(after[0] - before[0]) < 1e-9 && Math.abs(after[1] - before[1]) < 1e-9, `step ${k}`);
      }
      v = next;
    }
  });

  test('the zoom stays within 1 to 40', () => {
    assert.equal(M.zoomAt(M.wholeMap(), PLATE, 1000, 300, 300).z, 40);
    assert.equal(M.zoomAt({ cx: 0.3, cy: 0.3, z: 3 }, PLATE, 0.001, 300, 300).z, 1);
    assert.equal(M.clampView({ cx: 0.5, cy: 0.5, z: 0.2 }, PLATE).z, 1);
  });

  test('the pan clamp keeps at least 20 % of the map in view', () => {
    const covered = (v) => {
      const r = M.visibleRect(v, PLATE);
      const ox = Math.min(r.x1, 1) - Math.max(r.x0, 0), oy = Math.min(r.y1, 1) - Math.max(r.y0, 0);
      return [ox / Math.min(r.x1 - r.x0, 1), oy / Math.min(r.y1 - r.y0, 1)];
    };
    for (const z of [1, 2, 6, 40]) {
      for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, -1e6]]) {
        const v = M.panBy({ cx: 0.5, cy: 0.5, z }, PLATE, dx, dy);
        const [fx, fy] = covered(v);
        assert.ok(fx >= 0.2 - 1e-9 && fy >= 0.2 - 1e-9, `z ${z}: ${fx.toFixed(3)} ${fy.toFixed(3)}`);
      }
    }
    // A small pan inside the limits is not clamped.
    const v = M.panBy(M.wholeMap(), PLATE, 30, -20);
    assert.ok(Math.abs(v.cx - (0.5 - 30 / 632)) < 1e-12 && Math.abs(v.cy - (0.5 + 20 / 632)) < 1e-12);
  });

  test('fitBounds frames a box inside the plate less its inset, within the zoom range', () => {
    const b = { x0: 0.2, y0: 0.3, x1: 0.26, y1: 0.33 };
    const inset = { bottom: 120, right: 56 };
    const v = M.fitBounds(PLATE, b, { min: 1.8, max: 6, inset });
    assert.ok(v.z >= 1.8 && v.z <= 6);
    const T = M.viewTransform(v, PLATE);
    const sx0 = b.x0 * T.s + T.tx, sx1 = b.x1 * T.s + T.tx, sy0 = b.y0 * T.s + T.ty, sy1 = b.y1 * T.s + T.ty;
    assert.ok(sx0 >= 32 - 1e-6 && sx1 <= 656 - 56 - 32 + 1e-6 && sy0 >= 32 - 1e-6 && sy1 <= 663 - 120 - 32 + 1e-6);
    // A wide box zooms only as far as it fits: 0.8 of the map in 592 px (656 less 2 x 32).
    const wide = M.fitBounds(PLATE, { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }, { min: 1, max: 6 });
    assert.ok(Math.abs(wide.z - 592 / 0.8 / 632) < 1e-12);
    assert.equal(M.fitBounds(PLATE, { x0: 0, y0: 0, x1: 1, y1: 1 }, { min: 1, max: 6 }).z, 1, 'never below 1');
    // One point: the max zoom, centred.
    const one = M.fitBounds(PLATE, { x0: 0.4, y0: 0.4, x1: 0.4, y1: 0.4 }, { min: 1.8, max: 6 });
    assert.equal(one.z, 6);
    assert.ok(Math.abs(one.cx - 0.4) < 1e-12 && Math.abs(one.cy - 0.4) < 1e-12);
    const map = mapOf(body({ points: [{ id: 1, x: 0.1, y: 0.2 }, { id: 2, x: 0.3, y: 0.15 }, { id: 3, x: 0.2, y: 0.4 }] }));
    const bb = M.boundsOf(map, [0, 2, 9]);
    assert.ok(Math.abs(bb.x0 - 0.1) < 1e-4 && Math.abs(bb.y1 - 0.4) < 1e-4 && Math.abs(bb.x1 - 0.2) < 1e-4);
    assert.equal(M.boundsOf(map, []), null);
  });

  test('keepInView (Follow) moves the least to bring a point into the middle 60 %', () => {
    const v = M.wholeMap();
    assert.equal(M.keepInView(v, PLATE, 0.5, 0.5), v, 'already inside: the same view');
    const z = { cx: 0.5, cy: 0.5, z: 4 };
    const next = M.keepInView(z, PLATE, 0.9, 0.5);
    assert.equal(next.z, 4);
    const T = M.viewTransform(next, PLATE);
    assert.ok(Math.abs(0.9 * T.s + T.tx - 656 * 0.8) < 1e-6, 'lands on the box edge');
    const mid = M.lerpView(v, z, 0.5);
    assert.ok(Math.abs(mid.z - 2) < 1e-12);
    assert.deepEqual(M.centreOn(z, PLATE, 0.3, 0.6), { cx: 0.3, cy: 0.6, z: 4 });
  });

  test('semantic bands at 1.8 and 5, dot radius per band, raster above 5,000 dots in view', () => {
    assert.deepEqual([1, 1.79, 1.8, 4.99, 5, 40].map(M.bandOf), [0, 0, 1, 1, 2, 2]);
    assert.deepEqual([1, 2, 6].map(M.dotRadius), [1.5, 2.2, 3.6]);
    assert.equal(M.useRaster(5000), false);
    assert.equal(M.useRaster(5001), true);
    assert.equal(M.BAND_TOWNS, 1.8);
    assert.equal(M.BAND_DEEP, 5);
  });
});

describe('grid index', () => {
  const r = rng(3);
  const points = [];
  for (let i = 0; i < 5000; i++) { points.push({ id: 10 + i * 2, x: r() ** 1.5, y: r(), r0: i % 3, r1: i % 7 }); }
  const map = mapOf(body({ points }));
  const grid = M.buildGrid(map);
  const X = (i) => map.x[i] / 65535, Y = (i) => map.y[i] / 65535;

  test('nearest within a radius matches a brute-force scan', () => {
    for (let k = 0; k < 300; k++) {
      const mx = r() * 1.1 - 0.05, my = r() * 1.1 - 0.05, rad = 0.002 + r() * 0.03;
      let best = -1, bd = rad * rad;
      for (let i = 0; i < map.n; i++) {
        const d = (X(i) - mx) ** 2 + (Y(i) - my) ** 2;
        if (d < bd || (d === bd && best < 0)) { best = i; bd = d; }
      }
      assert.equal(M.nearest(grid, map, mx, my, rad), best, `query ${k}`);
    }
    const target = 1234;
    const odd = M.nearest(grid, map, X(target), Y(target), 0.05, (i) => i % 2 === 1);
    assert.ok(odd % 2 === 1);
    assert.equal(M.nearest(grid, map, X(target), Y(target), 1e-6), target);
    assert.equal(M.nearest(grid, map, 5, 5, 0.01), -1);
  });

  test('counts and region sums in a rect match a brute-force scan', () => {
    for (let k = 0; k < 50; k++) {
      const x0 = r() - 0.2, y0 = r() - 0.2, rect = { x0, y0, x1: x0 + r() * 0.5, y1: y0 + r() * 0.5 };
      const inside = [];
      for (let i = 0; i < map.n; i++) {
        if (map.x[i] >= rect.x0 * 65535 && map.x[i] <= rect.x1 * 65535 && map.y[i] >= rect.y0 * 65535 && map.y[i] <= rect.y1 * 65535) { inside.push(i); }
      }
      assert.equal(M.countInRect(grid, map, rect), inside.length);
      const s = M.regionStats(grid, map, rect);
      assert.equal(s.total, inside.length);
      assert.equal(s.n0[1], inside.filter((i) => map.r0[i] === 1).length);
      const sx = inside.filter((i) => map.r1[i] === 4).reduce((a, i) => a + X(i), 0);
      assert.ok(Math.abs(s.sx1[4] - sx) < 1e-9);
    }
    const seen = new Set();
    M.forEachInRect(grid, map, { x0: 0, y0: 0, x1: 1, y1: 1 }, (i) => seen.add(i));
    assert.equal(seen.size, map.n);
  });

  test('an empty map builds an empty grid', () => {
    const g = M.buildGrid(mapOf(body({ points: [] })));
    assert.equal(g.G, 1);
    assert.equal(M.nearest(g, mapOf(body({ points: [] })), 0.5, 0.5, 1), -1);
  });
});

describe('name placer', () => {
  // Three provinces and their towns on a 656 x 663 plate.
  const pts = [];
  const r = rng(4);
  const blob = (n, cx, cy, r0, r1, id0) => { for (let i = 0; i < n; i++) { pts.push({ id: id0 + i, x: cx + (r() - 0.5) * 0.12, y: cy + (r() - 0.5) * 0.12, r0, r1 }); } };
  blob(450, 0.3, 0.3, 0, 0, 1);
  blob(80, 0.7, 0.35, 1, 1, 1000);
  blob(30, 0.5, 0.75, 2, 2, 2000);
  const regions = [
    province(0, 'Hip Hop', 180, [0.3, 0.3], 450), province(1, 'Rock', 290, [0.7, 0.35], 80), province(2, 'Electronic', 255, [0.5, 0.75], 30),
    town(0, 0, 'Jazzy Hip-Hop', 180, [0.3, 0.3], 450), town(1, 1, 'Alternative Rock', 290, [0.7, 0.35], 80), town(2, 2, null, 255, [0.5, 0.75], 30),
    province(3, null, 10, [0.9, 0.9], 5),
  ];
  const map = mapOf(body({ points: pts, regions }));
  const grid = M.buildGrid(map);
  const cands = (view, sel) => M.nameCandidates(map, view, PLATE, M.regionStats(grid, map, M.visibleRect(view, PLATE)), sel);

  test('provinces below 1.8, towns from 1.8; no name for label null; larger first, sized by visible size', () => {
    const c0 = cands(M.wholeMap());
    assert.deepEqual(c0.map((c) => c.text), ['HIP HOP', 'ROCK', 'ELECTRONIC']);
    assert.deepEqual(c0.map((c) => c.size), [13, 12, 11]);
    assert.ok(c0.every((c) => c.level === 0));
    const c1 = cands({ cx: 0.5, cy: 0.5, z: 1.8 });
    assert.deepEqual(c1.map((c) => c.label), ['Jazzy Hip-Hop', 'Alternative Rock']);
    assert.ok(c1.every((c) => c.level === 1 && c.size === 12.5));
    assert.equal(cands(M.wholeMap(), 'g:Electronic')[0].key, 'g:Electronic', 'the selected name first');
  });

  test('placed names never overlap each other, the obstacles or the bounds', () => {
    const obstacles = [M.rectBox({ x: 604, y: 12, w: 40, h: 128 }, 4), M.pinBox(200, 200), M.rectBox({ x: 12, y: 555, w: 420, h: 96 }, 6)];
    for (const view of [M.wholeMap(), { cx: 0.3, cy: 0.3, z: 2 }, { cx: 0.55, cy: 0.5, z: 1.3 }]) {
      const placed = M.placeNames(cands(view), obstacles, BOUNDS, approx);
      assert.ok(placed.length > 0);
      for (const p of placed) {
        assert.ok(inBounds(p.box, 0), p.text);
        for (const o of obstacles) { assert.ok(!hit(p.box, o), `${p.text} on an obstacle`); }
        for (const q of placed) { if (q !== p) { assert.ok(!hit(p.box, q.box, 4), `${p.text} on ${q.text}`); } }
      }
    }
  });

  test('a name whose anchor spot is taken tries the centroid first, then the nudges', () => {
    const c = { key: 'g:X', level: 0, text: 'ROCK', size: 12, x: 300, y: 300, cx: 420, cy: 200 };
    const block = [M.boxOf(300, 300, 60, 30)];
    const [p] = M.placeNames([c], block, BOUNDS, approx);
    assert.deepEqual([p.x, p.y, p.moved], [420, 200, true], 'the centroid');
    const blockBoth = block.concat([M.boxOf(420, 200, 60, 30)]);
    const [q] = M.placeNames([c], blockBoth, BOUNDS, approx);
    assert.ok(q.moved && !(q.x === 420 && q.y === 200) && !hit(q.box, blockBoth[0]), 'a nudge');
    const [free] = M.placeNames([c], [], BOUNDS, approx);
    assert.deepEqual([free.x, free.y, free.moved], [300, 300, false]);
  });

  test('a name with no free spot is skipped', () => {
    const c = { key: 'g:X', level: 0, text: 'ROCK', size: 12, x: 300, y: 300, cx: 310, cy: 290 };
    assert.deepEqual(M.placeNames([c], [{ x0: -10, y0: -10, x1: 700, y1: 700 }], BOUNDS, approx), []);
    assert.deepEqual(M.placeNames([Object.assign({}, c, { text: 'X'.repeat(200) })], [], BOUNDS, approx), [], 'wider than the plate');
  });

  test('the visible-part rule: an off-plate anchor needs 12 songs in view, then sits at their centroid', () => {
    const vp = [];
    for (let i = 0; i < 12; i++) { vp.push({ id: 1 + i, x: 0.48 + (i % 4) * 0.01, y: 0.5 + Math.floor(i / 4) * 0.01, r0: 0, r1: 255 }); }
    const regs = [province(0, 'Jazz', 10, [0.02, 0.02], 12)];
    const view = { cx: 0.5, cy: 0.5, z: 1.79 };
    const run = (points) => {
      const m = mapOf(body({ points, regions: regs }));
      const g = M.buildGrid(m);
      return M.nameCandidates(m, view, PLATE, M.regionStats(g, m, M.visibleRect(view, PLATE)));
    };
    const [c] = run(vp);
    const T = M.viewTransform(view, PLATE);
    const cx = vp.reduce((a, p) => a + L.quantU16(p.x) / 65535, 0) / 12;
    assert.ok(Math.abs(c.x - (cx * T.s + T.tx)) < 1e-6, 'at the centroid of the songs in view');
    assert.equal(c.cx, null, 'no second centroid try');
    assert.deepEqual(run(vp.slice(1)), [], '11 songs in view: no name');
  });
});

describe('neighbour titles and path badges (Atlas boards)', () => {
  // A-W2: Hi Kick and its 8 neighbours, in plate px (page minus 252, 152).
  const SEL = { x: 408.3, y: 322.3 };
  const NB = [
    ['Drawn to you', 432.1, 362.6], ['TRAILBLAZERS', 482.8, 252.8], ['Trouble in paradise', 405.2, 387.2], ['Todays Agenda', 407.5, 415.2],
    ['Does she not', 419.8, 379.5], ['NewRapCity', 406.3, 352.6], ['Better Days', 362.6, 370.7], ['Goodbye 78', 430.5, 402.5, true],
  ].map(([text, x, y, ring]) => ({ text, x, y, ring: !!ring }));
  const CONTROLS = [M.rectBox({ x: 604, y: 12, w: 40, h: 40 }, 4), M.rectBox({ x: 604, y: 60, w: 40, h: 80 }, 4), M.rectBox({ x: 604, y: 148, w: 40, h: 40 }, 4)];
  const W2_OBS = [M.boxOf(SEL.x, SEL.y, 24, 24), M.rectBox({ x: 12, y: 547, w: 506, h: 104 }, 6), M.pinBox(244.3, 51.2), ...CONTROLS];

  test('all 8 W2 titles fit beside their dots, right first, clear of everything', () => {
    const placed = M.placeTitles(NB, W2_OBS, BOUNDS, approx);
    assert.equal(placed.filter(Boolean).length, 8);
    placed.forEach((p, i) => {
      const nb = NB[i];
      const off = (nb.ring ? 7.2 : 4.2) + 4.5;
      assert.ok(inBounds(p.box, 4));
      assert.ok(Math.abs(p.x - (p.side === 'right' ? nb.x + off : nb.x - off)) < 1e-9, `${nb.text} sits 4.5 px past its dot`);
      for (const o of W2_OBS) { assert.ok(!hit(p.box, o), `${nb.text} on an obstacle`); }
      NB.forEach((q, j) => {
        if (j === i) { return; }
        const r = (q.ring ? 7.2 : 4.2) + 1.5;
        assert.ok(!hit(p.box, M.circleBox(q.x, q.y, r)), `${nb.text} on ${q.text}'s dot`);
        assert.ok(!hit(p.box, placed[j].box), `${nb.text} on ${q.text}'s title`);
      });
    });
    // Right first: as few on the left as any assignment that fits (a brute force over all 2^8 sides).
    const box = (nb, side) => {
      const w = approx(nb.text), off = (nb.ring ? 7.2 : 4.2) + 4.5, base = nb.y + 4.3, x0 = side ? nb.x - off - w : nb.x + off;
      return { x0: x0 - 1.5, x1: x0 + w + 1.5, y0: base - 10.5, y1: base + 4.1 };
    };
    let fewest = Infinity;
    for (let mask = 0; mask < 256; mask++) {
      const bs = NB.map((nb, i) => box(nb, (mask >> i) & 1));
      const ok = bs.every((b, i) => inBounds(b, 4) && !W2_OBS.some((o) => hit(b, o))
        && NB.every((q, j) => j === i || !hit(b, M.circleBox(q.x, q.y, (q.ring ? 7.2 : 4.2) + 1.5)))
        && bs.every((c, j) => j >= i || !hit(b, c)));
      if (ok) { fewest = Math.min(fewest, NB.filter((_, i) => (mask >> i) & 1).length); }
    }
    assert.equal(placed.filter((p) => p.side === 'left').length, fewest);
    // Goodbye 78 is recent: its title sits past the white ring.
    assert.ok(Math.abs(Math.abs(placed[7].x - NB[7].x) - 11.7) < 1e-9);
  });

  test('a title with no room on either side is left out; the others stay', () => {
    const items = [{ text: 'Left alone', x: 300, y: 300 }, { text: 'Boxed in', x: 300, y: 500 }];
    const placed = M.placeTitles(items, [M.boxOf(300, 500, 400, 40)], BOUNDS, approx);
    assert.equal(placed[0].side, 'right');
    assert.equal(placed[1], null);
    assert.deepEqual(M.placeTitles([], [], BOUNDS, approx), []);
  });

  // A-W4: ten stops in two tight runs, the path card docked bottom-left.
  const STOPS = [[192.6, 138.5], [198.7, 143], [196.9, 140.2], [192.9, 133.5], [215.6, 176.6], [549.1, 624.4], [541.4, 611.4], [550.2, 622.5], [538.8, 617.5], [549.6, 623.5]]
    .map(([x, y]) => ({ x, y }));
  const W4_HARD = [M.rectBox({ x: 12, y: 555, w: 420, h: 96 }, 8), M.pinBox(165.6, 88.3), ...CONTROLS];

  test('W4: every stop gets a badge, and no badge touches another, a stop, the pin, the card or the controls', () => {
    const badges = M.placeBadges(STOPS, { bounds: BOUNDS, hard: W4_HARD });
    assert.equal(badges.filter(Boolean).length, 10);
    badges.forEach((b, i) => {
      const own = Math.hypot(b.x - STOPS[i].x, b.y - STOPS[i].y);
      assert.ok(own >= 14.45 && own <= 40 + 1e-9, `badge ${i + 1} sits ${own.toFixed(1)} px from its stop`);
      STOPS.forEach((s) => { assert.ok(Math.hypot(b.x - s.x, b.y - s.y) >= 8 + 4.2 + 2.25 - 1e-9, `badge ${i + 1} on a stop`); });
      badges.forEach((c, j) => { if (j !== i) { assert.ok(Math.hypot(b.x - c.x, b.y - c.y) >= 17.5 - 1e-9, `badges ${i + 1} and ${j + 1} touch`); } });
      for (const o of W4_HARD) { assert.ok(!hit(M.circleBox(b.x, b.y, 9), o), `badge ${i + 1} on a hard box`); }
      assert.ok(inBounds(M.circleBox(b.x, b.y, 9), 3));
    });
    // A lone stop's badge sits about 15 px away.
    const [one] = M.placeBadges([{ x: 300, y: 300 }], { bounds: BOUNDS });
    assert.equal(Math.round(Math.hypot(one.x - 300, one.y - 300)), 15);
  });

  test('a stop with no room for a badge gets none; the rest still place', () => {
    const badges = M.placeBadges([{ x: 300, y: 300 }, { x: 100, y: 600 }], { bounds: BOUNDS, hard: [M.boxOf(300, 300, 200, 200)] });
    assert.equal(badges[0], null);
    assert.ok(badges[1]);
    assert.deepEqual(M.placeBadges([], { bounds: BOUNDS }), []);
  });
});

describe('palette', () => {
  // dir-A 2.3 for the hues lib.mjs did not nudge: [hue, dot, name, coast, mid, high, edge].
  const TABLE = [
    [290, '#b6abfc', '#d6d0ff', '#2a2b3a', '#353649', '#42415b', '#5a577c'],
    [180, '#52cfba', '#a0e8d9', '#1e3032', '#223c3c', '#274b49', '#306660'],
    [255, '#84baff', '#b7dbff', '#242d3a', '#2c384a', '#34455b', '#455d7d'],
    [10, '#f798a7', '#ffc4cc', '#32292f', '#423239', '#533c44', '#754f58'],
    [315, '#d3a1ea', '#ebc9fa', '#2e2a37', '#3b3446', '#4a3e56', '#665374'],
    [148, '#82cc8d', '#b7e6bc', '#242f2c', '#2b3c34', '#344a3d', '#44654d'],
    [345, '#ec99c8', '#fdc4e3', '#312933', '#3f323f', '#513c4d', '#704f66'],
  ];
  test('hue 180 gives dot #52cfba; every un-nudged hue matches the dir-A table, land mixes included', () => {
    assert.equal(M.paletteFor(180).dot, '#52cfba');
    for (const [hue, dot, name, coast, mid, high, edge] of TABLE) {
      const p = M.paletteFor(hue);
      assert.deepEqual([p.dot, p.name, p.coast, p.mid, p.high, p.edge], [dot, name, coast, mid, high, edge], `hue ${hue}`);
    }
    assert.deepEqual(M.paletteFor(180).dotRgb, [0x52, 0xcf, 0xba]);
    assert.equal(M.paletteFor(540), M.paletteFor(180), 'hues wrap');
  });

  test('names keep 4.5:1 on the sea #171a1f at every hue, dimmed names too', () => {
    for (let h = 0; h < 360; h++) {
      const p = M.paletteFor(h);
      assert.ok(M.contrast(p.name, '#171a1f') >= 4.5, `name ${h}`);
      assert.ok(M.contrast(p.nameDim, '#171a1f') >= 4.5, `dimmed name ${h}`);
      assert.ok(M.contrast(p.nameDim, '#171a1f') < M.contrast(p.name, '#171a1f'), `dimmed name ${h} is dimmer`);
    }
    // The dim is a 55 % mix, raised a point at a time only as far as 4.5:1 needs.
    const raised = [];
    for (const h of [0, 10, 90, 180, 255, 290]) {
      const p = M.paletteFor(h);
      let a = 0.55;
      while (M.contrast(M.mix(p.name, '#171a1f', a), '#171a1f') < 4.5) { a = Math.round(a * 100 + 1) / 100; }
      assert.equal(p.nameDim, M.mix(p.name, '#171a1f', a), `hue ${h}`);
      raised.push(a);
    }
    assert.equal(raised[3], 0.55, 'hue 180 keeps 4.5:1 at 55 %');
    assert.ok(raised[1] > 0.55 && raised[1] < 0.7, 'hue 10 needs a little more');
  });

  test('the neutral palette for dots with no province, and the fixed colours of 4.3', () => {
    const n = M.paletteFor(null);
    assert.ok(n.dotRgb[0] === n.dotRgb[1] && n.dotRgb[1] === n.dotRgb[2]);
    assert.deepEqual(
      [M.COLORS.page, M.COLORS.sea, M.COLORS.lit, M.COLORS.ring, M.COLORS.pin, M.COLORS.control, M.COLORS.controlEdge, M.COLORS.plateEdge],
      ['#1e2228', '#171a1f', '#f5f7fa', '#e6e8ec', '#fa832b', '#2d333b', '#444c56', '#2a2f37']);
    assert.equal(M.mix('#ffffff', '#000000', 0.5), '#808080');
    assert.deepEqual(M.hexRgb('#fa832b'), [250, 131, 43]);
  });

  test('plays heat: up to 40 % toward the name colour, by the square root of the share', () => {
    assert.equal(M.heatShare(0, 10), 0);
    assert.equal(M.heatShare(10, 10), 0.4);
    assert.ok(Math.abs(M.heatShare(1, 4) - 0.2) < 1e-12);
    assert.equal(M.heatShare(5, 0), 0);
    assert.equal(M.ALPHA.unplayed, 0.4);
  });
});

describe('the DJ trail (foldTrail)', () => {
  const SID = 'tab-1';
  const T0 = Date.parse('2026-11-03T10:00:00.000Z');
  const MIN = 60000;
  // A history item (newest first on the wire) and a ring play.
  const hist = (id, path, startMin, lenMin, o = {}) => Object.assign({
    id, startedAt: new Date(T0 + startMin * MIN).toISOString(), endedAt: new Date(T0 + (startMin + lenMin) * MIN).toISOString(),
    playedMs: lenMin * MIN, outcome: 'completed', source: 'autodj', sessionId: SID, origin: 'local', peerId: null, track: { filepath: path, metadata: {} },
  }, o);
  const ring = (id, path, startMin, lenMin, o = {}) => Object.assign({
    id, filePath: '/' + path, startedAt: new Date(T0 + startMin * MIN).toISOString(), endedAt: new Date(T0 + (startMin + lenMin) * MIN).toISOString(),
    playedMs: lenMin * MIN, outcome: 'completed', source: 'autodj', sessionId: SID, pauseCount: 0,
  }, o);
  const ids = new Map();
  const idOf = (p) => (ids.has(p) ? ids.get(p) : 100 + p.length);
  const fold = (history, rings, o = {}) => M.foldTrail(M.mergePlays(history, rings, SID), Object.assign({ nowPath: 'now.mp3', nowMs: T0 + 60 * MIN, idOf }, o));

  test('the 6 picks before now playing, oldest first, alpha .35 to .90', () => {
    const h = [];
    for (let k = 0; k < 9; k++) { h.push(hist(`e${k}`, `s${k}.mp3`, 15 + k * 5, 5)); }
    const t = fold(h.reverse(), []);
    assert.deepEqual(t.map((x) => x.path), ['s3.mp3', 's4.mp3', 's5.mp3', 's6.mp3', 's7.mp3', 's8.mp3']);
    assert.deepEqual(t.map((x) => Math.round(x.alpha * 100)), [35, 46, 57, 68, 79, 90]);
    assert.ok(t.every((x) => x.id === idOf(x.path)));
  });

  test('only this tab\'s session; stop at a gap over 30 minutes', () => {
    const h = [hist('a', 'a.mp3', 50, 5), hist('b', 'b.mp3', 45, 5, { sessionId: 'other-tab' }), hist('c', 'c.mp3', 40, 5), hist('d', 'd.mp3', 0, 5)];
    assert.deepEqual(fold(h, []).map((x) => x.path), ['c.mp3', 'a.mp3'], 'd ends 35 minutes before c starts');
    assert.deepEqual(fold([hist('a', 'a.mp3', 10, 5)], []), [], 'a gap between now playing and the last play');
    assert.deepEqual(fold([hist('a', 'a.mp3', 25, 5)], []).length, 1, 'exactly 30 minutes is not a gap over 30');
  });

  test('stop at the first play that was not an Auto DJ pick (decision 2)', () => {
    const h = [hist('a', 'a.mp3', 55, 5), hist('b', 'b.mp3', 50, 5, { source: 'manual' }), hist('c', 'c.mp3', 45, 5)];
    assert.deepEqual(fold(h, []).map((x) => x.path), ['a.mp3']);
    assert.deepEqual(fold(h, [], { djOnly: false }).map((x) => x.path), ['c.mp3', 'b.mp3', 'a.mp3']);
    assert.deepEqual(fold([hist('s', 's.mp3', 55, 5, { source: 'shuffle' })], []), []);
  });

  test('quick skip = skipped under 30 s', () => {
    const h = [
      hist('a', 'a.mp3', 59, 0.4, { outcome: 'skipped', playedMs: 29999 }),
      hist('b', 'b.mp3', 58, 0.6, { outcome: 'skipped', playedMs: 30000 }),
      hist('c', 'c.mp3', 57, 0.4, { outcome: 'completed', playedMs: 20000 }),
    ];
    assert.deepEqual(fold(h, []).map((x) => [x.path, x.quickSkip]), [['c.mp3', false], ['b.mp3', false], ['a.mp3', true]]);
  });

  test('a connected server\'s plays are dropped; the unposted plays of the ring are merged once', () => {
    const h = [hist('a', 'a.mp3', 50, 5), hist('p', 'peer.mp3', 45, 5, { origin: 'peer', peerId: 3 }), hist('c', 'c.mp3', 40, 5)];
    // The ring marks a connected server's song with federated (m.js deps.trail.recentPlays); peerId and federation too.
    const r = [ring('z', 'z.mp3', 55, 5), ring('a', 'a.mp3', 50, 5), ring('q', 'q.mp3', 53, 1, { peerId: 2 }), ring('f', 'f.mp3', 54, 1, { federation: true }),
      ring('g', 'g.mp3', 52, 1, { federated: true })];
    assert.deepEqual(fold(h, r).map((x) => x.path), ['c.mp3', 'a.mp3', 'z.mp3']);
    const merged = M.mergePlays(h, r, SID);
    assert.equal(merged.filter((p) => p.id === 'a').length, 1);
    assert.equal(merged[0].path, 'z.mp3', 'a leading slash is dropped');
  });

  test('the 403 fallback: no history, the ring alone', () => {
    const r = [ring('x', 'x.mp3', 50, 5), ring('y', 'y.mp3', 55, 5)];
    assert.deepEqual(fold(null, r).map((x) => x.path), ['x.mp3', 'y.mp3']);
    assert.deepEqual(fold(null, null), []);
    // A ring play without a sessionId is still this page's.
    assert.equal(fold(null, [ring('w', 'w.mp3', 55, 5, { sessionId: undefined })]).length, 1);
  });

  test('songs with no dot are skipped and do not count toward the 6 (4.4.1)', () => {
    const h = [];
    for (let k = 0; k < 9; k++) { h.push(hist(`e${k}`, `s${k}.mp3`, 15 + k * 5, 5)); }
    ids.set('s8.mp3', null).set('s6.mp3', null);
    try {
      const t = fold(h.reverse(), []);
      assert.deepEqual(t.map((x) => x.path), ['s1.mp3', 's2.mp3', 's3.mp3', 's4.mp3', 's5.mp3', 's7.mp3']);
      // The paths to resolve first: the whole run, newest first.
      assert.deepEqual(M.trailRun(M.mergePlays(h, [], SID), { nowPath: 'now.mp3', nowMs: T0 + 60 * MIN }).length, 9);
    } finally { ids.clear(); }
  });

  test('now playing\'s own earlier plays are passed over', () => {
    const h = [hist('a', 'now.mp3', 55, 5), hist('b', 'b.mp3', 50, 5)];
    assert.deepEqual(fold(h, [], { nowPath: '/now.mp3' }).map((x) => x.path), ['b.mp3']);
  });
});

describe('songs with no dot (4.4.1)', () => {
  const map = mapOf(body({ points: [{ id: 5, x: 0.2, y: 0.2, r0: 0 }, { id: 9, x: 0.8, y: 0.8, r0: 0 }, { id: 12, x: 0.5, y: 0.5, r0: 0 }] }));

  test('no dot: no pin, no MARK.pin', () => {
    assert.equal(M.pinIndex(map, null), -1);
    assert.equal(M.pinIndex(map, 7), -1);
    assert.equal(M.pinIndex(map, 9), 1);
    const m = M.deriveMarks(M.initHighlight(), map, { zoom: 1, nowId: 7 });
    assert.equal(m.pin, -1);
    assert.ok(m.skip.every((k) => k !== M.MARK.pin));
  });

  test('Follow stays pressed through a song with no dot and resumes on the next placed song', () => {
    let s = M.reduceHighlight(M.initHighlight(), { type: 'follow', on: true });
    const v = { cx: 0.2, cy: 0.2, z: 4 };
    assert.equal(M.followView(v, PLATE, map, M.pinIndex(map, 7), s.follow), null);
    assert.equal(s.follow, true);
    const next = M.followView(v, PLATE, map, M.pinIndex(map, 9), s.follow);
    const T = M.viewTransform(next, PLATE);
    const sx = (map.x[1] / 65535) * T.s + T.tx;
    assert.ok(sx >= 656 * 0.2 - 1e-6 && sx <= 656 * 0.8 + 1e-6);
    s = M.reduceHighlight(s, { type: 'userView' });
    assert.equal(s.follow, false);
    assert.equal(M.followView(v, PLATE, map, 1, s.follow), null);
  });

  test('path badges keep the journey\'s own numbers; stops with no dot are not lit', () => {
    const rows = [{ id: 5 }, { id: null }, { id: 9 }, { id: 404 }, { id: 12 }];
    assert.deepEqual(M.pathStops(map, rows), [{ num: 1, index: 0, id: 5 }, { num: 3, index: 1, id: 9 }, { num: 5, index: 2, id: 12 }]);
    const s = M.reduceHighlight(M.initHighlight(), { type: 'path', title: 'A to B', rows: rows.map((r, k) => ({ id: r.id, filepath: `p${k}.mp3` })) });
    const m = M.deriveMarks(s, map, { zoom: 1 });
    assert.deepEqual(m.lit.map((l) => l.num), [1, 3, 5]);
    assert.equal(s.path.rows.length, 5, 'the card still lists the whole journey');
  });

  test('selections are re-resolved by dot (id) and key after a refetch', () => {
    const song = M.reduceHighlight(M.initHighlight(), { type: 'selectSong', song: { id: 9, filepath: 'a/b.mp3', metadata: { title: 'B' } } });
    assert.deepEqual(M.reconcileHighlight(song, map), { state: song, lookup: null }, 'the id is still a representative');
    const moved = mapOf(body({ points: [{ id: 3, x: 0.8, y: 0.8 }, { id: 5, x: 0.2, y: 0.2 }] }));
    const r = M.reconcileHighlight(song, moved);
    assert.deepEqual(r.lookup, { kind: 'song', filepaths: ['a/b.mp3'] });
    const back = M.reduceHighlight(r.state, { type: 'resolved', kind: 'song', ids: [3] });
    assert.equal(back.song.id, 3);
    assert.equal(back.song.neighbours, null, 'neighbours are asked again');
    assert.ok(back.seq > song.seq, 'answers for the old id are dropped');
    assert.equal(M.reduceHighlight(r.state, { type: 'resolved', kind: 'song', ids: [null] }).kind, 'none', 'gone: cleared');

    const regs = [province(0, 'Rock', 290, [0.5, 0.5], 3)];
    const m1 = mapOf(body({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }], regions: regs }));
    const place = M.reduceHighlight(M.initHighlight(), { type: 'selectPlace', region: m1.byKey.get('g:Rock') });
    assert.equal(M.reconcileHighlight(place, m1).state, place);
    const renamed = mapOf(body({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }], regions: [province(4, 'Rock and Roll', 290, [0.5, 0.5], 3, { key: 'g:Rock' })] }));
    assert.equal(M.reconcileHighlight(place, renamed).state.place.label, 'Rock and Roll');
    assert.equal(M.reconcileHighlight(place, mapOf(body({ points: [] }))).state.kind, 'none', 'the key is gone');
    const unlabelled = mapOf(body({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }], regions: [province(0, null, 290, [0.5, 0.5], 3, { key: 'g:Rock' })] }));
    assert.equal(M.reconcileHighlight(place, unlabelled).state.kind, 'none', 'no label, no card');

    const path = M.reduceHighlight(M.initHighlight(), { type: 'path', title: 't', rows: [{ id: 5, filepath: 'x.mp3' }, { id: null, filepath: 'y.mp3' }] });
    const pr = M.reconcileHighlight(path, moved);
    assert.deepEqual(pr.lookup, { kind: 'path', filepaths: ['x.mp3', 'y.mp3'] });
    assert.deepEqual(M.reduceHighlight(path, { type: 'resolved', kind: 'path', ids: [null, 3] }).path.rows.map((x) => x.id), [null, 3]);
  });
});

describe('one highlight at a time (the highlight reducer, section F)', () => {
  const regions = [province(0, 'Hip Hop', 180, [0.3, 0.3], 3), province(1, 'Rock', 290, [0.7, 0.7], 2), town(0, 0, 'Jazzy Hip-Hop', 180, [0.3, 0.3], 2)];
  const map = mapOf(body({
    regions,
    points: [
      { id: 1, x: 0.3, y: 0.3, r0: 0, r1: 0 }, { id: 2, x: 0.31, y: 0.3, r0: 0, r1: 0, recent: true }, { id: 3, x: 0.29, y: 0.31, r0: 0, r1: 255, recent: true },
      { id: 4, x: 0.7, y: 0.7, r0: 1, r1: 255, recent: true }, { id: 5, x: 0.71, y: 0.7, r0: 1, r1: 255 },
    ],
  }));
  const at = (id) => M.findId(map, id);
  const row = (id) => ({ id, filepath: `x/${id}.mp3`, metadata: { title: `T${id}`, artist: 'A' } });
  const trail = [{ id: 4, quickSkip: false, alpha: 0.35 }, { id: 5, quickSkip: true, alpha: 0.9 }];
  const mood = Uint8Array.from([0b10110]);   // songs 1, 2 and 4 (indices 1, 2, 4) pass

  test('nothing selected: the trail shows at whole-map zoom, the mood mask dims, now playing stays', () => {
    const s = M.initHighlight();
    const m = M.deriveMarks(s, map, { zoom: 1, nowId: 1, trail, mood });
    assert.deepEqual(m.trail.map((t) => [t.index, t.quickSkip]), [[at(4), false], [at(5), true]]);
    assert.equal(m.skip[at(4)], M.MARK.trail);
    assert.equal(m.skip[at(1)], M.MARK.pin);
    assert.equal(m.pin, at(1));
    assert.deepEqual(Array.from(m.dim), [0, 0, 0, 1, 0], 'the mood mask dims song 4; the pin (song 1) never dims');
    assert.equal(m.dimAlpha, 0.26);
    assert.equal(M.deriveMarks(s, map, { zoom: 1.06, trail }).trail.length, 0, 'not above zoom 1.05');
    assert.equal(M.deriveMarks(s, map, { zoom: 1, trail }).dim, null, 'no mood filter: nothing dims');
  });

  test('a song selection: reticle, lit neighbours replace their dots, all else dims, the trail hides, Follow turns off', () => {
    let s = M.reduceHighlight(M.initHighlight(), { type: 'follow', on: true });
    s = M.reduceHighlight(s, { type: 'selectSong', song: { id: 1 } });
    assert.equal(s.kind, 'song');
    assert.equal(s.follow, false);
    const stale = M.reduceHighlight(s, { type: 'neighbours', seq: s.seq - 1, answer: { seed: row(1), neighbours: [row(2)] } });
    assert.equal(stale, s, 'an answer for an older selection is dropped');
    s = M.reduceHighlight(s, { type: 'neighbours', seq: s.seq, answer: { seed: row(1), notAnalyzed: false, neighbours: [row(2), row(3), row(1)] } });
    assert.equal(s.song.metadata.title, 'T1', 'the seed fills the card');
    const m = M.deriveMarks(s, map, { zoom: 2, nowId: 5, trail, mood });
    assert.equal(m.selected, at(1));
    assert.deepEqual(m.lit.map((l) => l.id), [2, 3], 'the seed itself is not lit');
    assert.deepEqual([m.skip[at(1)], m.skip[at(2)], m.skip[at(3)], m.skip[at(4)], m.skip[at(5)]], [M.MARK.selected, M.MARK.lit, M.MARK.lit, 0, M.MARK.pin]);
    assert.deepEqual(Array.from(m.dim), [1, 1, 1, 1, 0], 'everything dims but the pin; the selection overrides the mood dim');
    assert.equal(m.trail.length, 0);
    assert.ok(!M.trailVisible(s, 1));
  });

  test('a notAnalyzed seed opens its card with nothing lit', () => {
    let s = M.reduceHighlight(M.initHighlight(), { type: 'selectSong', song: { id: 3 } });
    s = M.reduceHighlight(s, { type: 'neighbours', seq: s.seq, answer: { seed: row(3), notAnalyzed: true, neighbours: [] } });
    assert.equal(s.song.notAnalyzed, true);
    assert.deepEqual(M.deriveMarks(s, map, { zoom: 2 }).lit, []);
  });

  test('recent rings: from zoom 1.8, dimmed at 25 %, none under the selection, the pin or a trail stop, white on a lit song', () => {
    const none = M.initHighlight();
    const low = M.deriveMarks(none, map, { zoom: 1.79 });
    assert.equal(M.ringOf(low, map, at(2)), M.RING.none, 'never below 1.8');
    const high = M.deriveMarks(none, map, { zoom: 1.8, nowId: 4 });
    assert.equal(M.ringOf(high, map, at(2)), M.RING.normal);
    assert.equal(M.ringOf(high, map, at(1)), M.RING.none, 'not recent');
    assert.equal(M.ringOf(high, map, at(4)), M.RING.none, 'not on now playing');
    let s = M.reduceHighlight(none, { type: 'selectSong', song: { id: 2 } });
    s = M.reduceHighlight(s, { type: 'neighbours', seq: s.seq, answer: { neighbours: [row(3)] } });
    const m = M.deriveMarks(s, map, { zoom: 3, nowId: 1 });
    assert.equal(M.ringOf(m, map, at(2)), M.RING.none, 'not on the selected song');
    assert.equal(M.ringOf(m, map, at(3)), M.RING.white, 'a lit recent neighbour keeps a white ring');
    assert.equal(M.ringOf(m, map, at(4)), M.RING.dim, 'a dimmed context ring');
    // A trail stop never carries a ring (the trail shows only at 1.05, below 1.8).
    const trailOnly = M.deriveMarks(none, map, { zoom: 1, trail });
    assert.equal(M.ringOf(Object.assign({}, trailOnly, { rings: true }), map, at(4)), M.RING.none);
  });

  test('a place: dots outside dim to 25 %, a province dims the other land and names; a town does not', () => {
    const s = M.reduceHighlight(M.initHighlight(), { type: 'selectPlace', region: map.byKey.get('g:Rock') });
    assert.equal(s.kind, 'place');
    const m = M.deriveMarks(s, map, { zoom: 1, mood, trail });
    assert.equal(m.province, 1);
    assert.equal(m.town, -1);
    assert.equal(m.dimAlpha, 0.25);
    assert.deepEqual(Array.from(m.dim), [1, 1, 1, 0, 0]);
    assert.equal(m.trail.length, 0);
    const t = M.deriveMarks(M.reduceHighlight(s, { type: 'selectPlace', region: map.byKey.get('t:0') }), map, { zoom: 2 });
    assert.deepEqual([t.town, t.province], [0, -1]);
    assert.deepEqual(Array.from(t.dim), [0, 0, 1, 1, 1]);
    assert.equal(M.reduceHighlight(s, { type: 'selectPlace', region: { key: 'g:X', label: null } }), s, 'no label: no place card');
    let p = M.reduceHighlight(s, { type: 'placeMix', seq: s.seq, answer: { centre: row(4), songs: [row(4), row(5)] } });
    assert.equal(p.place.answer.songs.length, 2);
    p = M.reduceHighlight(p, { type: 'placeMix', seq: s.seq - 1, answer: { songs: [] } });
    assert.equal(p.place.answer.songs.length, 2, 'a stale mix is dropped');
  });

  test('search: matches stay, the rest dims; zero matches dim nothing; a 429 keeps the highlight; clearing the field clears', () => {
    let s = M.reduceHighlight(M.initHighlight(), { type: 'follow', on: true });
    s = M.reduceHighlight(s, { type: 'searchQuery', q: 'hi' });
    const old = M.reduceHighlight(s, { type: 'search', q: 'h', answer: { ids: [1], best: 1, capped: false } });
    assert.equal(old, s, 'an answer for another query is dropped');
    s = M.reduceHighlight(s, { type: 'search', q: 'hi', answer: { ids: [2, 4], best: 4, capped: true } });
    assert.equal(s.kind, 'search');
    assert.deepEqual([s.search.best, s.search.capped, s.follow], [4, true, false]);
    const m = M.deriveMarks(s, map, { zoom: 1, mood, trail });
    assert.deepEqual(Array.from(m.dim), [1, 0, 1, 0, 1]);
    assert.deepEqual(m.lit, [], 'search matches are not lit marks');
    assert.equal(m.trail.length, 0, 'a search hides the trail');
    assert.equal(M.reduceHighlight(s, { type: 'searchBusy' }), s, 'a 429 keeps the previous highlight');
    let z = M.reduceHighlight(s, { type: 'searchQuery', q: 'zzzz' });
    z = M.reduceHighlight(z, { type: 'search', q: 'zzzz', answer: LIVE.search.zzzz });
    assert.equal(z.kind, 'search');
    assert.equal(M.deriveMarks(z, map, { zoom: 1 }).dim, null, 'zero matches: nothing dimmed');
    const cleared = M.reduceHighlight(s, { type: 'searchQuery', q: ' ' });
    assert.equal(cleared.kind, 'none');
    // A selection made while a query was in flight wins over its answer.
    let race = M.reduceHighlight(M.initHighlight(), { type: 'searchQuery', q: 'the' });
    race = M.reduceHighlight(race, { type: 'selectSong', song: { id: 1 } });
    assert.equal(M.reduceHighlight(race, { type: 'search', q: 'the', answer: LIVE.search.the }), race);
  });

  test('one at a time: each selection replaces the last; clear brings the trail back; Esc drops an armed pick', () => {
    let s = M.reduceHighlight(M.initHighlight(), { type: 'selectSong', song: row(1) });
    s = M.reduceHighlight(s, { type: 'arm', start: row(1) });
    assert.equal(s.armed.start.id, 1);
    assert.equal(s.kind, 'song', 'arming keeps the song card');
    s = M.reduceHighlight(s, { type: 'searchQuery', q: 'the' });
    s = M.reduceHighlight(s, { type: 'search', q: 'the', answer: { ids: [4], best: 4 } });
    assert.equal(s.armed.start.id, 1, 'a search keeps the armed pick (Enter answers it)');
    assert.ok(!M.trailVisible(M.reduceHighlight(M.initHighlight(), { type: 'arm', start: row(1) }), 1), 'an armed pick hides the trail');
    s = M.reduceHighlight(s, { type: 'path', title: 'T1 to T4', rows: [row(1), row(4)] });
    assert.deepEqual([s.kind, s.armed, s.song, s.search], ['path', null, null, null]);
    s = M.reduceHighlight(s, { type: 'selectPlace', region: map.byKey.get('g:Hip Hop') });
    assert.deepEqual([s.kind, s.path], ['place', null]);
    s = M.reduceHighlight(s, { type: 'clear' });
    assert.equal(s.kind, 'none');
    assert.ok(M.trailVisible(s, 1));
    assert.equal(M.reduceHighlight(s, { type: 'clear' }), s, 'clearing nothing changes nothing');
    const armed = M.reduceHighlight(M.reduceHighlight(M.initHighlight(), { type: 'selectSong', song: row(1) }), { type: 'arm', start: row(1) });
    assert.equal(M.reduceHighlight(armed, { type: 'clear' }).armed, null);
    assert.equal(M.reduceHighlight(armed, { type: 'disarm' }).kind, 'song');
    assert.equal(M.reduceHighlight(M.initHighlight(), { type: 'selectSong', song: { filepath: 'no-id.mp3' } }).kind, 'none');
  });

  test('overlay marks replace their dots in every highlight (the reducer\'s dot mask)', () => {
    const path = M.reduceHighlight(M.initHighlight(), { type: 'path', title: 't', rows: [row(2), row(4)] });
    const m = M.deriveMarks(path, map, { zoom: 1, nowId: 4 });
    assert.deepEqual(Array.from(m.skip), [0, M.MARK.lit, 0, M.MARK.pin, 0], 'a path stop under the pin: the pin wins');
    assert.deepEqual(m.lit.map((l) => l.num), [1, 2]);
    // The buffers are reused when n is unchanged.
    const again = M.deriveMarks(path, map, { zoom: 1 }, m);
    assert.equal(again.skip, m.skip);
    assert.deepEqual(Array.from(again.skip), [0, M.MARK.lit, 0, M.MARK.lit, 0]);
  });

  test('rows: Title and Title . Artist from metadata, the file name when untitled', () => {
    assert.equal(M.songTitle(row(1)), 'T1');
    assert.equal(M.songName(row(1)), 'T1 · A');
    assert.equal(M.songTitle({ filepath: 'demo/Artist/Song name.mp3' }), 'Song name');
    assert.equal(M.songName({ filepath: 'a/b.flac', metadata: { title: ' ', artist: '' } }), 'b');
  });
});

describe('states (section 4.6)', () => {
  const ready = (o = {}) => body(Object.assign({ points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }, { id: 2, x: 0.6, y: 0.5, r0: 0 }], regions: [province(0, 'Rock', 290, [0.5, 0.5], 2)] }, o));
  const fx = (st) => st.effects.map((e) => e.do);
  const run = (events, st = M.initStates()) => events.reduce((s, e) => M.reduceStates(s, e), st);
  const loaded = (o) => run([{ type: 'open' }, { type: 'mapAnswer', answer: ready(o), nowMs: 0 }]);

  test('open, then ready', () => {
    const s0 = M.reduceStates(M.initStates(), { type: 'open' });
    assert.equal(s0.status, 'loading');
    assert.deepEqual(fx(s0), ['fetchMap']);
    const s1 = M.reduceStates(s0, { type: 'mapAnswer', answer: ready(), nowMs: 0 });
    assert.equal(s1.status, 'ready');
    assert.equal(s1.map.n, 2);
    assert.equal(s1.rev, 'r1');
    assert.deepEqual(fx(s1), [], 'nothing wanted yet');
    const live = run([{ type: 'open' }, { type: 'mapAnswer', answer: LIVE.map, nowMs: 0 }]);
    assert.equal(live.status, 'ready');
    assert.equal(live.map.n, 104);
  });

  test('building: a spinner state, revalidated every 30 s', () => {
    const b = run([{ type: 'open' }, { type: 'mapAnswer', answer: { state: 'building', rev: 'b1', layout: null, regions: [], points: { n: 0, format: 'cols-v1', data: '' } }, nowMs: 1000 }]);
    assert.equal(b.status, 'building');
    assert.deepEqual(b.effects, [{ do: 'schedule', at: 31000 }]);
    assert.deepEqual(fx(M.reduceStates(b, { type: 'tick', nowMs: 30999 })), []);
    const due = M.reduceStates(b, { type: 'tick', nowMs: 31000 });
    assert.deepEqual(fx(due), ['fetchMap']);
    assert.deepEqual(fx(M.reduceStates(due, { type: 'tick', nowMs: 32000 })), [], 'one fetch per due time');
    const still = M.reduceStates(due, { type: 'mapAnswer', answer: { notModified: true }, nowMs: 31500 });
    assert.deepEqual(still.effects, [{ do: 'schedule', at: 61500 }], 'a 304 while building schedules the next look');
    const done = M.reduceStates(still, { type: 'mapAnswer', answer: ready(), nowMs: 62000 });
    assert.equal(done.status, 'ready');
    assert.equal(done.revalidateAt, null);
    assert.deepEqual(fx(M.reduceStates(done, { type: 'close' })), ['cancelSchedule']);
  });

  test('failed and empty; a network error is failed, unless a map is already up', () => {
    const empty = { rev: 'e', layout: null, regions: [], points: { n: 0, format: 'cols-v1', data: '' } };
    assert.equal(run([{ type: 'open' }, { type: 'mapAnswer', answer: Object.assign({ state: 'failed' }, empty) }]).status, 'failed');
    assert.equal(run([{ type: 'open' }, { type: 'mapAnswer', answer: Object.assign({ state: 'empty' }, empty) }]).status, 'empty');
    assert.equal(run([{ type: 'open' }, { type: 'mapAnswer', answer: null }]).status, 'failed');
    const up = M.reduceStates(loaded(), { type: 'mapAnswer', answer: null });
    assert.equal(up.status, 'ready');
    assert.equal(up.map.n, 2, 'a failed revalidation keeps the map');
    const retry = M.reduceStates(run([{ type: 'open' }, { type: 'mapAnswer', answer: null }]), { type: 'revalidate' });
    assert.deepEqual(fx(retry), ['fetchMap'], 'Try again');
  });

  test('ready with no dots: the plate alone, no overlay asked', () => {
    let s = run([{ type: 'open' }, { type: 'mapAnswer', answer: body({ points: [] }) }]);
    assert.equal(s.status, 'ready');
    assert.equal(s.map.n, 0);
    s = M.reduceStates(s, { type: 'wantOverlay', layer: 'plays', on: true });
    assert.deepEqual(fx(s), []);
  });

  test('a 403 disables the map for the session; so does an unknown format; a corrupt payload is failed', () => {
    const off = run([{ type: 'open' }, { type: 'mapAnswer', answer: { disabled: true } }]);
    assert.equal(off.status, 'disabled');
    assert.deepEqual(fx(off), ['disable']);
    assert.deepEqual(fx(M.reduceStates(off, { type: 'open' })), [], 'sticky');
    assert.equal(M.reduceStates(off, { type: 'mapAnswer', answer: ready() }).status, 'disabled');
    const v2 = ready();
    v2.points.format = 'cols-v2';
    const fmt = run([{ type: 'open' }, { type: 'mapAnswer', answer: v2 }]);
    assert.deepEqual([fmt.status, fx(fmt)], ['disabled', ['disable']]);
    const land2 = ready();
    land2.layout.landFormat = 'land-v2';
    assert.equal(M.reduceStates(loaded(), { type: 'mapAnswer', answer: land2 }).status, 'disabled');
    const bad = ready();
    bad.points.data = bad.points.data.slice(0, 8);
    assert.equal(run([{ type: 'open' }, { type: 'mapAnswer', answer: bad }]).status, 'failed');
    assert.equal(M.reduceStates(loaded(), { type: 'overlayAnswer', layer: 'mood', seq: 0, answer: { disabled: true } }).status, 'disabled');
  });

  test('a frame or model change resets the view; a new rev re-resolves the selection; the same rev changes nothing', () => {
    const s = loaded();
    assert.deepEqual(fx(M.reduceStates(s, { type: 'mapAnswer', answer: ready({ rev: 'r2', frame: 2 }) })), ['resetView', 'reconcile']);
    assert.deepEqual(fx(M.reduceStates(s, { type: 'mapAnswer', answer: ready({ rev: 'r2', model: 'other' }) })), ['resetView', 'reconcile']);
    assert.deepEqual(fx(M.reduceStates(s, { type: 'mapAnswer', answer: ready({ rev: 'r2' }) })), ['reconcile']);
    const same = M.reduceStates(s, { type: 'mapAnswer', answer: ready() });
    assert.deepEqual(fx(same), []);
    assert.equal(same.map, s.map, 'the decoded map is kept');
    assert.equal(M.reduceStates(s, { type: 'mapAnswer', answer: { notModified: true } }).map, s.map);
  });

  test('a 409 on an overlay: one refetch and one retry, then hold until a user action or a revalidation', () => {
    let s = M.reduceStates(loaded(), { type: 'wantOverlay', layer: 'plays', on: true });
    assert.deepEqual(s.effects, [{ do: 'fetchOverlay', layer: 'plays', seq: 1 }]);
    s = M.reduceStates(s, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { stale: true } });
    assert.deepEqual(fx(s), ['fetchMap'], 'refetch GET /map once');
    s = M.reduceStates(s, { type: 'mapAnswer', answer: { notModified: true } });
    assert.deepEqual(s.effects, [{ do: 'fetchOverlay', layer: 'plays', seq: 1 }], 'then retry the overlay once');
    s = M.reduceStates(s, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { stale: true } });
    assert.deepEqual(fx(s), [], 'still 409: hold');
    assert.equal(s.overlay.plays, null);
    const acted = M.reduceStates(s, { type: 'userAction' });
    assert.deepEqual(fx(M.reduceStates(acted, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { stale: true } })), ['fetchMap'], 'a user action lifts the hold');
    const revalidated = M.reduceStates(s, { type: 'mapAnswer', answer: { notModified: true } });
    assert.deepEqual(revalidated.effects, [{ do: 'fetchOverlay', layer: 'plays', seq: 1 }], 'a revalidation asks again');
    // A refetch that brings a new rev asks every wanted overlay for it.
    let n = M.reduceStates(loaded(), { type: 'wantOverlay', layer: 'plays', on: true });
    n = M.reduceStates(n, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { stale: true } });
    n = M.reduceStates(n, { type: 'mapAnswer', answer: ready({ rev: 'r2' }) });
    assert.deepEqual(n.effects, [{ do: 'reconcile' }, { do: 'fetchOverlay', layer: 'plays', seq: 1 }]);
    const good = { rev: 'r2', layer: 'plays', n: 2, data: b64(Uint8Array.from([0, 7])) };
    n = M.reduceStates(n, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: good });
    assert.deepEqual(Array.from(n.overlay.plays), [0, 7]);
    const late = M.reduceStates(n, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { rev: 'r1', layer: 'plays', n: 2, data: b64(Uint8Array.from([9, 9])) } });
    assert.deepEqual(Array.from(late.overlay.plays), [0, 7], 'a late answer for the old rev is ignored');
  });

  test('a 404 on region or neighbours: one refetch, then clear the selection', () => {
    let s = M.reduceStates(loaded(), { type: 'notFound' });
    assert.deepEqual(fx(s), ['fetchMap']);
    s = M.reduceStates(s, { type: 'mapAnswer', answer: { notModified: true } });
    assert.deepEqual(fx(s), ['clearSelection']);
    s = M.reduceStates(s, { type: 'notFound' });
    assert.deepEqual(fx(s), ['clearSelection'], 'no second refetch');
    s = M.reduceStates(s, { type: 'found' });
    assert.deepEqual(fx(M.reduceStates(s, { type: 'notFound' })), ['fetchMap']);
    const failedRefetch = M.reduceStates(M.reduceStates(loaded(), { type: 'notFound' }), { type: 'mapAnswer', answer: null });
    assert.deepEqual(fx(failedRefetch), ['clearSelection'], 'cleared even when the refetch fails');
  });

  test('a 403 on the plays overlay hides Plays heat for the session; no scores hide Filters', () => {
    let s = M.reduceStates(loaded(), { type: 'wantOverlay', layer: 'plays', on: true });
    s = M.reduceStates(s, { type: 'overlayAnswer', layer: 'plays', seq: 1, answer: { disabled: true } });
    assert.deepEqual([s.status, s.heat, fx(s)], ['ready', false, ['hideHeat']]);
    assert.deepEqual(fx(M.reduceStates(s, { type: 'wantOverlay', layer: 'plays', on: true })), [], 'heat stays hidden');
    let m = M.reduceStates(loaded(), { type: 'wantOverlay', layer: 'mood', moods: { valence: 'happy' } });
    assert.deepEqual(m.effects, [{ do: 'fetchOverlay', layer: 'mood', seq: 1 }]);
    m = M.reduceStates(m, { type: 'overlayAnswer', layer: 'mood', seq: 1, answer: { rev: 'r1', layer: 'mood', n: 2 } });
    assert.deepEqual([m.filters, fx(m)], [false, ['hideFilters']]);
  });

  test('mood overlay answers: kept for the current filter only; a cleared filter asks nothing', () => {
    let s = M.reduceStates(loaded(), { type: 'wantOverlay', layer: 'mood', moods: { valence: 'happy' } });
    s = M.reduceStates(s, { type: 'wantOverlay', layer: 'mood', moods: { energy: 'relaxed' } });
    assert.deepEqual(s.effects, [{ do: 'fetchOverlay', layer: 'mood', seq: 2 }]);
    const answer = { rev: 'r1', layer: 'mood', n: 2, moods: { valence: 'happy' }, data: b64(Uint8Array.from([1])) };
    assert.equal(M.reduceStates(s, { type: 'overlayAnswer', layer: 'mood', seq: 1, answer }).overlay.mood, null, 'the older filter\'s answer is dropped');
    s = M.reduceStates(s, { type: 'overlayAnswer', layer: 'mood', seq: 2, answer: Object.assign({}, answer, { moods: { energy: 'relaxed' } }) });
    assert.equal(M.bitAt(s.overlay.mood.bits, 0), 1);
    s = M.reduceStates(s, { type: 'wantOverlay', layer: 'mood', moods: {} });
    assert.deepEqual([fx(s), s.overlay.mood, s.want.mood], [[], null, null]);
  });

  test('a search 429 keeps the highlight: no state change, no effect', () => {
    const s = loaded();
    assert.deepEqual(fx(M.reduceStates(s, { type: 'searchBusy' })), []);
    const h = M.reduceHighlight(M.reduceHighlight(M.initHighlight(), { type: 'searchQuery', q: 'the' }), { type: 'search', q: 'the', answer: LIVE.search.the });
    assert.equal(M.reduceHighlight(h, { type: 'searchBusy' }), h);
    assert.deepEqual(h.search.ids, LIVE.search.the.ids);
    assert.equal(h.search.best, LIVE.search.the.best);
  });
});

// ---------------------------------------------------------------------------
// The controller (mount) on a fake DOM: no browser harness exists (plan 4.11),
// so a small stand-in carries what mount() touches — elements parsed from its
// markup, simple selectors, bubbling events, a 2D context that records its
// calls, Path2D, rAF and timers run by hand, and the panel's deps (m.js's
// contract) answering from the live fixture. The plate is 656 x 663 (A-W2);
// the controls and the card sit where spa.css puts them.
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ENTITY[k]);
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
class FakePath {
  constructor() { this.ops = []; }
  moveTo(...a) { this.ops.push(['moveTo', ...a]); }
  lineTo(...a) { this.ops.push(['lineTo', ...a]); }
  arc(...a) { this.ops.push(['arc', ...a]); }
  closePath() { this.ops.push(['closePath']); }
  get arcs() { return this.ops.filter((o) => o[0] === 'arc'); }
}
function fakeContext() {
  const state = { ops: [] };
  return new Proxy(state, {
    get(o, k) {
      if (k in o) { return o[k]; }
      if (k === 'measureText') { return (s) => ({ width: String(s).length * 7 }); }
      if (k === 'createImageData') { return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }); }
      return (...args) => { o.ops.push([k, ...args]); };
    },
    set(o, k, v) { o[k] = v; o.ops.push(['=' + String(k), v]); return true; },
  });
}
const compound = (e, c) => {
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(c);
  if (!m) { throw new Error(`selector ${c}`); }
  const cls = e.className.split(/\s+/);
  if ((m[1] && e.tagName !== m[1].toUpperCase()) || (m[2] && !m[2].slice(1).split('.').every((k) => cls.includes(k)))) { return false; }
  return [...m[3].matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every((a) => e.getAttribute(a[1]) !== null && (a[2] === undefined || e.getAttribute(a[1]) === a[2]));
};
function matches(e, sel) {
  if (sel.includes(',')) { return sel.split(',').some((one) => matches(e, one.trim())); }
  const parts = sel.match(/(?:[^\s[]+|\[[^\]]*\])+/g);
  if (!compound(e, parts.pop())) { return false; }
  for (let a = e.parentNode; parts.length && a instanceof El; a = a.parentNode) { if (compound(a, parts[parts.length - 1])) { parts.pop(); } }
  return !parts.length;
}
class El {
  constructor(doc, tag) { Object.assign(this, { ownerDocument: doc, tagName: tag.toUpperCase(), attrs: new Map(), nodes: [], parentNode: null, style: {}, listeners: {}, html: '' }); }
  get children() { return this.nodes.filter((n) => n instanceof El); }
  get firstElementChild() { return this.children[0] || null; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
    const api = {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) { el.className = list().concat(c).join(' '); } },
      remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
      toggle: (c, on) => { if (on === undefined ? !list().includes(c) : on) { api.add(c); } else { api.remove(c); } },
    };
    return api;
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? (this.tagName === 'BUTTON' ? 0 : -1)); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  appendChild(c) { c.remove(); c.parentNode = this; this.nodes.push(c); return c; }
  remove() { if (this.parentNode) { this.parentNode.nodes = this.parentNode.nodes.filter((n) => n !== this); this.parentNode = null; } }
  get innerHTML() { return this.html; }
  set innerHTML(html) {
    for (const c of this.children) { c.parentNode = null; }
    this.nodes = [];
    this.html = String(html);
    let cur = this;
    for (const m of this.html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
      if (m[5] !== undefined) { cur.nodes.push(unescape(m[5])); continue; }
      if (m[1]) { cur = cur.parentNode; continue; }
      const el = new El(this.ownerDocument, m[2]);
      for (const a of m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) { el.attrs.set(a[1], a[2] === undefined ? '' : unescape(a[2])); }
      cur.appendChild(el);
      if (!m[4]) { cur = el; }
    }
  }
  get textContent() { return this.nodes.map((n) => (n instanceof El ? n.textContent : n)).join(''); }
  set textContent(v) { this.innerHTML = ''; this.nodes = [String(v)]; }
  contains(e) { for (; e; e = e.parentNode) { if (e === this) { return true; } } return false; }
  querySelectorAll(sel) {
    const out = [], walk = (e) => { for (const c of e.children) { if (matches(c, sel)) { out.push(c); } walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let e = this; e instanceof El; e = e.parentNode) { if (matches(e, sel)) { return e; } } return null; }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  // layout stand-ins: the plate's size; the controls' column and the card where spa.css lays them out
  get clientWidth() { return this.classList.contains('mmap-plate') ? this.ownerDocument.size.w : 0; }
  get clientHeight() { return this.classList.contains('mmap-plate') ? this.ownerDocument.size.h : 0; }
  box() {
    const { w, h } = this.ownerDocument.size;
    if (this.classList.contains('mmap-ctrls')) { return [w - 52, 12, 40, 128]; }
    if (this.classList.contains('mmap-card')) { return [12, h - 116, this.classList.contains('mmap-card-song') ? 506 : 420, 104]; }
    return [0, 0, 0, 0];
  }
  get offsetLeft() { return this.box()[0]; }
  get offsetTop() { return this.box()[1]; }
  get offsetWidth() { return this.box()[2]; }
  get offsetHeight() { return this.box()[3]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext() { return this.ctx || (this.ctx = fakeContext()); }
  setPointerCapture() {}
}
function fakeDom(size = { w: 656, h: 663 }) {
  let seq = 0, clock = 0;
  const frames = new Map(), timers = new Map(), canvases = [];
  const win = {
    devicePixelRatio: 1, Path2D: FakePath, observers: [],
    requestAnimationFrame: (fn) => { frames.set(++seq, fn); return seq; },
    cancelAnimationFrame: (k) => { frames.delete(k); },
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: clock + (ms || 0) }); return seq; },
    clearTimeout: (k) => { timers.delete(k); },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; win.observers.push(this); } observe() {} disconnect() { this.off = true; } },
  };
  const doc = { defaultView: win, activeElement: null, size, createElement: (tag) => { const el = new El(doc, tag); if (tag === 'canvas') { canvases.push(el); } return el; } };
  return {
    win, doc, canvases, host: new El(doc, 'div'),
    frame(ts) { const due = [...frames.values()]; frames.clear(); for (const fn of due) { fn(ts ?? (clock += 16)); } return due.length; },
    pending: () => frames.size,
    advance(ms) { clock += ms; for (const [k, tm] of [...timers]) { if (tm.at <= clock) { timers.delete(k); tm.fn(); } } },
    timers: () => timers.size,
  };
}
// An event bubbling from el to the root of its tree (and on to `beyond`, a stand-in for window, unless stopped).
function fire(el, type, props = {}, beyond = null) {
  const ev = Object.assign({ type, target: el, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, props);
  for (let e = el; e && !ev.stopped; e = e.parentNode) { for (const fn of (e.listeners[type] || []).slice()) { fn.call(e, ev); } }
  if (beyond && !ev.stopped) { beyond(ev); }
  return ev;
}
const settle = async (n = 8) => { for (let k = 0; k < n; k++) { await new Promise((r) => setImmediate(r)); } };
const rowFor = (id) => ({ id, filepath: `demo/${id}.mp3`, metadata: { title: `Song ${id}`, artist: 'Artist' } });
const idOfPath = (f) => { const m = /^\/?demo\/(\d+)\.mp3$/.exec(f); return m ? Number(m[1]) : null; };
// The panel's deps (m.js mapDeps), answering from the live fixture; every call is logged.
function fakeDeps(o = {}) {
  const calls = [], subs = {}, log = (...a) => { calls.push(a); };
  const on = (k) => (fn) => { (subs[k] = subs[k] || new Set()).add(fn); return () => { subs[k].delete(fn); }; };
  const api = Object.assign({
    map: () => LIVE.map,
    overlay: (layer) => (layer === 'plays' ? LIVE.overlays.plays : LIVE.overlays.moodHappy),
    tracks: (b) => (b.ids ? { tracks: b.ids.map((id) => (o.rows && o.rows[id]) || rowFor(id)) } : { ids: b.filepaths.map(idOfPath) }),
    search: (q) => LIVE.search[q] || { ids: [], best: null, capped: false },
    region: (key) => ({ region: { key, level: 0, label: key }, centre: rowFor(14), songs: [14, 39, 86].map(rowFor) }),
    neighbours: (id) => ({ seed: rowFor(id), notAnalyzed: false, capped: false, neighbours: [27, 40, 39, 14, 36, 13, 42, 94].filter((n) => n !== id).map(rowFor) }),
  }, o.api);
  const d = {
    t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k),
    escapeHtml,
    spinnerHtml: '<svg class="spinner"></svg>',
    reducedMotion: () => o.reduced !== false,
    generation: () => 1,
    live: () => true,
    disable: () => log('disable'),
    api: Object.fromEntries(Object.entries(api).map(([k, f]) => [k, (...a) => { log('api.' + k, ...a); return Promise.resolve(f(...a)); }])),
    head: { onSearch: on('search'), onSearchEnter: on('enter'), onPlaysHeat: on('heat'), setPlaysHeat: (v) => log('setPlaysHeat', v), hidePlaysHeat: () => log('hidePlaysHeat'), showFilters: (v) => log('showFilters', v) },
    moods: { available: () => !!o.moods, filter: () => o.filter || null, subscribe: on('moods') },
    nowPlaying: { path: () => o.now ?? null, title: () => 'Now', startedAt: () => o.startedAt ?? null, subscribe: on('now') },
    trail: { sessionId: () => 'S', recentPlays: () => o.ring || [], history: () => { log('history'); return Promise.resolve(o.history ?? null); } },
    capture: { armed: () => !!o.armed, mine: () => o.armed === 'mine', answer: (row) => { log('answer', row.filepath); o.armed = false; return true; }, cancel: () => { log('cancel'); if (o.armed === 'mine') { o.armed = false; } } },
    verbs: {
      play: (r) => log('play', r.filepath), queue: (r) => log('queue', r.filepath), autoDj: (r) => log('autoDj', r.filepath),
      songMenuGlyph: '<svg class="pop-f"><path class="pop-f" d="M0 0"/></svg>', songMenu: (el) => log('songMenu', el.getAttribute('data-file_location')),
      sonicPath: (start, cbs) => { log('sonicPath', start.filepath); o.pick = cbs; o.armed = 'mine'; },
      playAll: (rows) => log('playAll', rows.map((r) => r.filepath)), queueAll: (rows) => log('queueAll', rows.map((r) => r.filepath)), saveAsPlaylist: (rows) => log('saveAsPlaylist', rows.map((r) => r.filepath)),
    },
    visible: { now: () => true, subscribe: on('visible') },
  };
  return { d, calls, subs, o, emit: (k, v) => { for (const fn of [...(subs[k] || [])]) { fn(v); } }, count: (k) => calls.filter((c) => c[0] === k).length, last: (k) => calls.filter((c) => c[0] === k).pop() };
}
// A mounted map: the plate measured, the map answered, one frame drawn.
async function mounted(o = {}) {
  const dom = fakeDom(o.size), deps = fakeDeps(o);
  dom.win.devicePixelRatio = o.dpr || 1;
  const inst = M.mount(dom.host, deps.d);
  for (const ob of dom.win.observers) { ob.fn([]); }
  await settle();
  dom.frame();
  const root = dom.host.firstElementChild, snap = () => inst.update();
  const h = Object.assign({ inst, root, snap, deps, cv: root.querySelector('canvas') }, dom, deps);
  h.cache = () => dom.canvases[0].ctx;
  h.at = (id) => { const s = snap(), map = s.states.map, i = M.findId(map, id), T = M.viewTransform(s.view, dom.doc.size); return [map.x[i] / 65535 * T.s + T.tx, map.y[i] / 65535 * T.s + T.ty]; };
  h.tap = (id, pointerType = 'mouse') => {
    const [x, y] = Array.isArray(id) ? id : h.at(id), e = { pointerId: 1, pointerType, button: 0, clientX: x, clientY: y };
    fire(h.cv, 'pointerdown', Object.assign({ buttons: 1 }, e));
    fire(h.cv, 'pointerup', Object.assign({ buttons: 0 }, e));
  };
  h.click = (key) => { const el = root.querySelectorAll('[data-mm]').find((n) => n.getAttribute('data-mm') === key); assert.ok(el, `no [data-mm="${key}"]`); fire(el, 'click'); return el; };
  h.mm = (box = root) => box.querySelectorAll('[data-mm]').map((n) => n.getAttribute('data-mm'));
  h.layer = () => root.querySelector('.mmap-layer');
  h.card = () => root.querySelector('.mmap-card');
  h.live = () => root.querySelector('.dm-sr').textContent;
  h.focused = () => (dom.doc.activeElement ? dom.doc.activeElement.getAttribute('data-mm') || dom.doc.activeElement.className : null);
  return h;
}
const arcsOf = (ops) => ops.filter((o) => o[0] === 'fill' && o[1] instanceof FakePath && o[2] !== 'evenodd').reduce((n, o) => n + o[1].arcs.length, 0);
// The calls of the last draw on a context (each draw starts with clearRect).
const lastOps = (ctx) => ctx.ops.slice(ctx.ops.map((o) => o[0]).lastIndexOf('clearRect'));
// The canvas calls since `from`, each with the style in force: [method, args, {fillStyle, strokeStyle, globalAlpha, lineWidth}].
function styled(ctx, from = 0) {
  const s = {}, out = [];
  ctx.ops.forEach((o, k) => { if (o[0][0] === '=') { s[o[0].slice(1)] = o[1]; } else if (k >= from) { out.push([o[0], o.slice(1), Object.assign({}, s)]); } });
  return out;
}
const lastFrame = (ctx) => styled(ctx, ctx.ops.map((o) => o[0]).lastIndexOf('clearRect'));

describe('the controller: mount(host, deps) on a fake DOM (plan 4.3 to 4.7)', () => {
  test('the plate: a role=img drawing, Follow and the Zoom group, one live region; loading shows a spinner and no text', () => {
    const dom = fakeDom(), deps = fakeDeps({ api: { map: () => new Promise(() => {}) } });
    M.mount(dom.host, deps.d);
    const root = dom.host.firstElementChild;
    assert.equal(root.className, 'mmap mmap-plate');
    assert.equal(root.tabIndex, -1, 'the plate takes focus back when an opener is gone');
    const cv = root.querySelector('canvas.mmap-canvas');
    assert.deepEqual([cv.getAttribute('role'), cv.getAttribute('aria-label')], ['img', 'map.label']);
    const follow = root.querySelector('.mmap-ctrls .mmap-ctrl');
    assert.deepEqual([follow.getAttribute('data-mm'), follow.getAttribute('aria-pressed'), follow.getAttribute('aria-label')], ['c:follow', 'false', 'map.follow']);
    const zoom = root.querySelector('.mmap-zoom');
    assert.deepEqual([zoom.getAttribute('role'), zoom.getAttribute('aria-label')], ['group', 'map.zoom']);
    assert.deepEqual(zoom.querySelectorAll('button').map((b) => b.getAttribute('aria-label')), ['map.zoomIn', 'map.zoomOut']);
    const live = root.querySelectorAll('.dm-sr');
    assert.equal(live.length, 1);
    assert.equal(live[0].getAttribute('role'), 'status');
    assert.ok(root.querySelector('.mmap-state .spinner'));
    assert.equal(root.querySelector('.mmap-state').textContent, '', 'no text while loading');
    assert.ok(root.querySelector('.mmap-chevron').classList.contains('super-hide'));
    assert.ok(root.querySelector('.mmap-ctrls').classList.contains('super-hide'), 'no controls before a map');
    assert.equal(deps.count('api.map'), 1);
    assert.equal(deps.count('history'), 1, 'the trail\'s history, once per open');
    // Tab order: the controls, the chevron, the names and lit songs, the card
    assert.deepEqual(root.children.map((c) => c.className), ['mmap-canvas', 'mmap-ctrls super-hide', 'mmap-chevron super-hide', 'mmap-layer', 'mmap-tip super-hide', '', 'mmap-state', 'dm-sr']);
  });

  test('ready: land filled even-odd per terrace, one vector dot per song, province names as buttons; the plate pauses at 0 x 0', async () => {
    const h = await mounted();
    assert.equal(h.snap().states.status, 'ready');
    const ops = h.cache().ops;
    const land = ops.filter((o) => o[0] === 'fill' && o[2] === 'evenodd');
    assert.equal(land.length, 9, '3 provinces x coast, mid, high');
    assert.equal(arcsOf(lastOps(h.cache())), LIVE.map.points.n, 'every song is a dot (nothing selected, nothing playing)');
    assert.equal(ops.filter((o) => o[0] === 'putImageData').length, 0, 'vectors under 5,000 dots in view');
    const fills = lastFrame(h.cache()).filter((o) => o[0] === 'fill' && o[1][1] !== 'evenodd');
    assert.ok(fills.every((o) => o[2].globalAlpha === 0.88), 'dots at 88 %');
    assert.deepEqual(h.mm(h.layer()).sort(), ['r:g:Electronic', 'r:g:Hip Hop', 'r:g:Rock'], 'provinces below zoom 1.8');
    const rock = h.layer().querySelectorAll('button').find((b) => b.getAttribute('data-mm') === 'r:g:Rock');
    assert.equal(rock.className, 'mmap-name mmap-name-p');
    assert.equal(rock.getAttribute('aria-pressed'), 'false');
    assert.equal(rock.textContent, 'Rock', 'the label (CSS upper-cases provinces)');
    assert.match(rock.getAttribute('style'), /font-size:11px;color:#[0-9a-f]{6}/, 'small provinces at 11 px in their name colour');
    assert.ok(!h.root.querySelector('.mmap-ctrls').classList.contains('super-hide'));
    assert.ok(h.root.querySelector('.mmap-state').classList.contains('super-hide'));
    h.inst.update({ view: { cx: 0.5, cy: 0.5, z: 2 } });
    h.frame();
    assert.ok(h.mm(h.layer()).length > 0 && h.mm(h.layer()).every((k) => k.startsWith('r:t:')), 'towns from zoom 1.8');
    assert.ok(h.layer().querySelectorAll('button').every((b) => b.className === 'mmap-name mmap-name-t'));
    h.doc.size = { w: 0, h: 0 };
    for (const ob of h.win.observers) { ob.fn([]); }
    h.inst.update({ view: { cx: 0.4, cy: 0.5, z: 2 } });
    const before = h.cache().ops.length;
    h.frame();
    assert.equal(h.cache().ops.length, before, 'nothing drawn at 0 x 0 (the column hidden behind the phone tab)');
  });

  test('states: building is a spinner revalidated every 30 s; empty and failed are one line; failed tries again; 403 disables; no dots is the plate alone', async () => {
    const realNow = Date.now;
    let now = 1e12;
    Date.now = () => now;
    try {
      const building = { state: 'building', rev: 'b', layout: null, regions: [], points: { n: 0, format: 'cols-v1', data: '' } };
      const answers = [building, building, LIVE.map];
      const h = await mounted({ api: { map: () => answers.shift() } });
      assert.equal(h.snap().states.status, 'building');
      assert.ok(h.root.querySelector('.mmap-state .spinner'));
      assert.equal(h.root.querySelector('.mmap-state').textContent, '');
      now += 30010; h.advance(30010); await settle();
      assert.equal(h.count('api.map'), 2, 'revalidated after 30 s');
      now += 30010; h.advance(30010); await settle();
      assert.equal(h.snap().states.status, 'ready');
      assert.ok(h.root.querySelector('.mmap-state').classList.contains('super-hide'));
    } finally { Date.now = realNow; }
    const empty = await mounted({ api: { map: () => ({ state: 'empty', rev: 'e', layout: null, regions: [], points: { n: 0, format: 'cols-v1', data: '' } }) } });
    assert.equal(empty.root.querySelector('.mmap-state').textContent, 'map.empty');
    assert.equal(empty.root.querySelectorAll('.mmap-state button').length, 0);
    const failed = await mounted({ api: { map: () => null } });
    assert.equal(failed.root.querySelector('.mmap-line').textContent, 'map.failed');
    const retry = failed.root.querySelector('.mmap-state .mmap-pill');
    assert.deepEqual([retry.getAttribute('data-mm'), retry.textContent], ['c:retry', 'dpage.verb.tryAgain']);
    fire(retry, 'click');
    assert.equal(failed.count('api.map'), 2, 'Try again revalidates');
    const off = await mounted({ api: { map: () => ({ disabled: true }) } });
    assert.equal(off.count('disable'), 1);
    assert.equal(off.snap().states.status, 'disabled');
    const odd = await mounted({ api: { map: () => Object.assign({}, LIVE.map, { points: Object.assign({}, LIVE.map.points, { format: 'cols-v9' }) }) } });
    assert.equal(odd.count('disable'), 1, 'an unknown format is a 403 for the session');
    const none = await mounted({ api: { map: () => body({ points: [], regions: [] }) } });
    assert.equal(none.snap().states.status, 'ready');
    assert.ok(none.root.querySelector('.mmap-state').classList.contains('super-hide'), 'no line');
    assert.ok(none.root.querySelector('.mmap-ctrls').classList.contains('super-hide'), 'the plate alone');
  });

  test('a dot: its card (A-W2), 8 lit and named neighbours, the live region, focus on Play, framed between zoom 1.8 and 6', async () => {
    const h = await mounted();
    h.tap(75);
    await settle();
    assert.deepEqual(h.last('api.tracks'), ['api.tracks', { ids: [75] }], 'the card\'s row, by id');
    assert.deepEqual(h.last('api.neighbours'), ['api.neighbours', 75]);
    const card = h.card();
    assert.deepEqual([card.className, card.getAttribute('role'), card.getAttribute('aria-label')], ['mmap-card mmap-card-song', 'group', 'Song 75']);
    assert.ok(card.querySelector('.mmap-card-line svg.mmap-card-glyph'), 'the reticle glyph on the title row');
    assert.equal(card.querySelector('.mmap-card-title').textContent, 'Song 75');
    assert.equal(card.querySelector('.mmap-card-sub').textContent, 'Artist');
    assert.equal(card.querySelector('.mmap-close').getAttribute('aria-label'), 'modal.close');
    assert.deepEqual(h.mm(card.querySelector('.mmap-verbs')), ['v:play', 'v:queue', 'v:dj', 'v:path', 'v:menu']);
    assert.deepEqual(card.querySelectorAll('.mmap-verbs button').slice(0, 4).map((b) => b.textContent), ['map.play', 'map.queue', 'map.autoDj', 'map.sonicPath']);
    const menu = card.querySelector('[data-mm="v:menu"]');
    assert.ok(menu.classList.contains('pop-f') && menu.classList.contains('mmap-pill-icon'));
    assert.deepEqual([menu.getAttribute('data-file_location'), menu.getAttribute('aria-label')], ['demo/75.mp3', 'map.songMenu']);
    assert.ok(card.querySelector('.mmap-pill-pri').getAttribute('data-mm') === 'v:play', 'Play is the orange pill');
    assert.equal(h.focused(), 'v:play', 'focus moves to the card\'s first verb');
    assert.equal(h.live(), 'Song 75 · Artist');
    const s = h.snap();
    assert.ok(s.view.z >= 1.8 && s.view.z <= 6, `framed at ${s.view.z}`);
    h.frame();
    const lit = h.snap().marks.lit.map((l) => l.id);
    assert.deepEqual(lit, [27, 40, 39, 14, 36, 13, 42, 94]);
    const songs = h.layer().querySelectorAll('.mmap-song'), titles = h.layer().querySelectorAll('.mmap-title');
    assert.ok(songs.length >= 1 && songs.every((b) => /^Song \d+ · Artist$/.test(b.getAttribute('aria-label'))), 'lit songs are buttons named Title · Artist');
    assert.ok(titles.length >= 1 && titles.every((b) => b.getAttribute('tabindex') === '-1' && /^Song \d+$/.test(b.textContent)), 'titles name them');
    const order = h.mm(h.layer()), firstSong = order.findIndex((k) => k.startsWith('s:'));
    assert.ok(order.slice(0, firstSong).every((k) => k.startsWith('r:')) && firstSong > 0, 'names before lit songs in Tab order');
    const main = lastFrame(h.cv.getContext());
    assert.ok(main.some((o) => o[0] === 'arc' && o[1][2] === M.SIZE.reticleRing) && main.some((o) => o[0] === 'arc' && o[1][2] === M.SIZE.reticleDot), 'the reticle');
    assert.equal(main.filter((o) => o[0] === 'arc' && o[1][2] === M.SIZE.lit).length, songs.length, 'one white mark per lit song in view');
    const now = h.snap(), map = now.states.map, v = M.visibleRect(now.view, h.doc.size), pad = M.dotRadius(now.view.z) / M.viewTransform(now.view, h.doc.size).s;
    let inView = 0;
    M.forEachInRect(M.buildGrid(map), map, { x0: v.x0 - pad, y0: v.y0 - pad, x1: v.x1 + pad, y1: v.y1 + pad }, (i) => { inView += now.marks.skip[i] ? 0 : 1; });
    assert.equal(arcsOf(lastOps(h.cache())), inView, 'only the dots in view are drawn');
    assert.ok([now.marks.selected].concat(now.marks.lit.map((l) => l.index)).every((i) => now.marks.skip[i] > 0), 'the selection and its lit neighbours replace their dots');
    fire(titles[0], 'click');
    await settle();
    assert.equal(h.snap().highlight.song.id, Number(titles[0].getAttribute('data-mm').slice(2)), 'a title selects its song');
  });

  test('reduced motion jumps; otherwise the frame eases over 300 ms to the same view', async () => {
    const jump = await mounted();
    jump.tap(75); await settle();
    const target = jump.snap().view;
    const h = await mounted({ reduced: false });
    const start = h.snap().view;
    h.tap(75); await settle();
    assert.deepEqual(h.snap().view, start, 'not moved before a frame');
    h.frame(1000); h.frame(1150);
    const mid = h.snap().view;
    assert.ok(mid.z > start.z && mid.z < target.z, 'part way');
    h.frame(1300); h.frame(1316);
    assert.deepEqual(h.snap().view, target);
  });

  test('Esc and Close clear the selection: focus goes back to the opener, else to the plate; the sea clears too', async () => {
    const h = await mounted();
    const name = h.click('r:g:Rock');
    await settle();
    assert.equal(h.card().className, 'mmap-card mmap-card-place');
    assert.deepEqual([h.card().getAttribute('role'), h.card().getAttribute('aria-label')], ['group', 'Rock']);
    assert.equal(h.live(), 'Rock');
    assert.equal(h.focused(), 'v:play');
    fire(h.doc.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(h.snap().highlight.kind, 'none');
    assert.equal(h.card(), null);
    assert.equal(h.focused(), 'r:g:Rock', 'back to the name that opened it');
    assert.ok(h.doc.activeElement === name);
    h.tap(75); await settle();
    h.click('x:');
    assert.equal(h.snap().highlight.kind, 'none');
    assert.ok(h.doc.activeElement === h.root, 'no opener: the plate');
    h.tap(75); await settle();
    h.tap([3, 3]);
    assert.equal(h.snap().highlight.kind, 'none', 'a tap on the sea clears');
  });

  test('a place: the card waits for the mix, then Play replaces the queue once; Queue all, Save, Auto DJ on the centre; a province dims the other land', async () => {
    let release;
    const h = await mounted({ api: { region: (key) => new Promise((r) => { release = () => r({ region: { key, level: 0, label: 'Rock' }, centre: rowFor(34), songs: [34, 2, 30].map(rowFor) }); }) } });
    h.click('r:g:Rock');
    await settle();
    h.click('v:play');
    await settle();
    assert.equal(h.count('playAll'), 0, 'nothing plays before the mix');
    release();
    await settle();
    assert.deepEqual(h.calls.filter((c) => c[0] === 'playAll'), [['playAll', ['demo/34.mp3', 'demo/2.mp3', 'demo/30.mp3']]]);
    h.click('v:all'); h.click('v:save'); h.click('v:dj');
    await settle();
    assert.deepEqual([h.last('queueAll')[1].length, h.last('saveAsPlaylist')[1].length, h.last('autoDj')[1]], [3, 3, 'demo/34.mp3']);
    h.frame();
    const m = h.snap().marks;
    assert.equal(m.province, 1);
    assert.equal(m.dimAlpha, M.ALPHA.placeDim);
    const land = lastFrame(h.cache()).filter((o) => o[0] === 'fill' && o[1][1] === 'evenodd').map((o) => o[2].globalAlpha);
    assert.deepEqual(land.filter((a) => a === M.ALPHA.landDim).length, 6, 'the two other provinces\' terraces at 45 %');
    const rock = h.layer().querySelectorAll('.mmap-name').find((b) => b.getAttribute('data-mm') === 'r:g:Rock');
    assert.equal(rock.getAttribute('aria-pressed'), 'true');
    assert.match(rock.getAttribute('style'), /color:#f5f7fa/, 'its own name turns white');
    const coast = styled(h.cv.getContext()).filter((o) => o[0] === 'stroke' && o[2].strokeStyle === M.COLORS.lit && o[2].globalAlpha === M.ALPHA.coast);
    assert.equal(coast.length >= 1, true, 'its coast stroked white at 85 %');
    assert.deepEqual(h.card().querySelectorAll('.mmap-verbs button').map((b) => b.textContent), ['map.play', 'map.queueAll', 'map.saveAsPlaylist', 'map.autoDj']);
  });

  test('search: matches stay and the rest dims; Enter selects best (or answers an armed pick); zero matches dim nothing; a 429 keeps the highlight', async () => {
    const h = await mounted();
    h.emit('search', 'the');
    await settle();
    const s = h.snap();
    assert.equal(s.highlight.kind, 'search');
    assert.deepEqual(s.highlight.search.ids, LIVE.search.the.ids);
    h.frame();
    assert.equal(Array.from(h.snap().marks.dim).filter(Boolean).length, LIVE.map.points.n - LIVE.search.the.ids.length);
    h.emit('enter', 'the');
    await settle();
    assert.equal(h.count('api.search'), 1, 'Enter uses the answer on screen');
    assert.equal(h.snap().highlight.song.id, LIVE.search.the.best);
    assert.equal(h.focused(), 'v:play');
    h.emit('search', 'zzzz');
    await settle(); h.frame();
    assert.equal(h.snap().highlight.kind, 'search');
    assert.equal(h.snap().marks.dim, null, 'zero matches: nothing dims');
    const busy = await mounted({ api: { search: (q) => (q === 'the' ? LIVE.search.the : { busy: true }) } });
    busy.emit('search', 'the'); await settle();
    busy.emit('search', 'them'); await settle();
    assert.deepEqual(busy.snap().highlight.search.ids, LIVE.search.the.ids, 'a 429 keeps the previous highlight');
    busy.emit('search', '');
    assert.equal(busy.snap().highlight.kind, 'none', 'clearing the field clears');
    const armed = await mounted({ armed: true });
    armed.emit('enter', 'the');
    await settle();
    assert.deepEqual(armed.last('answer'), ['answer', `demo/${LIVE.search.the.best}.mp3`]);
    assert.equal(armed.snap().highlight.kind, 'search', 'the pick took the song; nothing selected');
  });

  test('a capture armed by another panel takes the next dot first', async () => {
    const h = await mounted({ armed: true });
    h.tap(75);
    await settle();
    assert.deepEqual(h.last('answer'), ['answer', 'demo/75.mp3']);
    assert.equal(h.snap().highlight.kind, 'none');
    assert.equal(h.count('api.neighbours'), 0);
  });

  test('Sonic Path: the card arms the end pick; the answer lights numbered stops with badges and no line, and the path card plays the whole journey', async () => {
    const h = await mounted();
    h.tap(75); await settle();
    h.click('v:path');
    assert.deepEqual(h.last('sonicPath'), ['sonicPath', 'demo/75.mp3']);
    assert.ok(h.snap().highlight.armed, 'armed: the trail stays hidden');
    const rows = [75, 54, 'gone', 62, 2].map((id) => (typeof id === 'number' ? rowFor(id) : { filepath: 'demo/none.mp3', metadata: { title: 'No dot' } }));
    h.o.pick.onPath({ start: rows[0], end: rows[4], rows, notAnalyzed: { start: false, end: false } });
    await settle();
    assert.deepEqual(h.last('api.tracks'), ['api.tracks', { filepaths: rows.map((r) => r.filepath) }]);
    const s = h.snap();
    assert.equal(s.highlight.kind, 'path');
    assert.equal(s.highlight.armed, null);
    assert.deepEqual([h.card().getAttribute('aria-label'), h.card().querySelector('.mmap-card-title').textContent], ['map.sonicPath', 'map.pathTitle {"start":"Song 75","end":"Song 2"}']);
    assert.equal(h.live(), 'map.pathTitle {"start":"Song 75","end":"Song 2"}');
    assert.deepEqual(h.card().querySelectorAll('.mmap-verbs button').map((b) => b.getAttribute('data-mm')), ['v:play', 'v:all', 'v:save'], 'no Auto DJ, no Sonic Path');
    h.inst.update({ view: { cx: 0.5, cy: 0.5, z: 1 } });
    h.frame();
    assert.deepEqual(h.snap().marks.lit.map((l) => [l.id, l.num]), [[75, 1], [54, 2], [62, 4], [2, 5]], 'stops keep the journey\'s numbers; the dot-less one is a gap');
    const main = lastFrame(h.cv.getContext());
    const numerals = main.filter((o) => o[0] === 'fillText').map((o) => String(o[1][0]));
    assert.deepEqual(numerals.sort(), ['1', '2', '4', '5'], 'a badge per stop in view');
    const discs = main.map((o, k) => [o, k]).filter(([o]) => o[0] === 'arc' && o[1][2] === M.SIZE.badge);
    assert.equal(discs.length, 4);
    assert.ok(discs.every(([, k]) => main[k + 1][0] === 'fill' && main[k + 1][2].fillStyle === M.COLORS.control), 'r 8 discs in #2d333b');
    assert.equal(main.filter((o) => o[0] === 'lineTo').length, 0, 'no line');
    assert.deepEqual(h.mm(h.layer()).filter((k) => k.startsWith('s:')), ['s:75', 's:54', 's:62', 's:2'], 'stops in path order');
    h.click('v:play');
    await settle();
    assert.deepEqual(h.last('playAll')[1], rows.map((r) => r.filepath), 'Play replaces the queue with the whole journey');
    const fail = await mounted();
    fail.tap(75); await settle(); fail.click('v:path');
    fail.o.pick.onPath(null);
    await settle();
    assert.equal(fail.snap().highlight.armed, null, 'a failed path drops the pick');
    assert.equal(fail.snap().highlight.kind, 'song');
  });

  test('Esc, Close or the sea while the map\'s own end pick waits drop the pick (and its banner); another panel\'s pick is never dropped', async () => {
    const h = await mounted();
    h.tap(75); await settle();
    h.click('v:path');
    assert.ok(h.snap().highlight.armed);
    fire(h.doc.activeElement || h.root, 'keydown', { key: 'Escape' });
    assert.equal(h.count('cancel'), 1, 'Esc: the pick goes');
    assert.equal(h.o.armed, false);
    assert.deepEqual([h.snap().highlight.kind, h.snap().highlight.armed], ['none', null]);
    h.tap(75); await settle();
    h.click('v:path');
    h.click('x:');
    assert.equal(h.count('cancel'), 2, 'the card\'s Close: the pick goes');
    h.tap(75); await settle();
    h.click('v:path');
    h.tap([3, 3]);
    assert.equal(h.count('cancel'), 3, 'a tap on the sea: the pick goes');
    assert.equal(h.snap().highlight.kind, 'none');
    // the banner's own Cancel already dropped it: the card just disarms
    h.tap(75); await settle();
    h.click('v:path');
    h.o.armed = false;
    h.o.pick.onCancel();
    assert.equal(h.snap().highlight.armed, null);
    assert.equal(h.snap().highlight.kind, 'song', 'the song stays selected');
    assert.equal(h.count('cancel'), 3);
    // another panel's pick: Esc clears the map's selection only
    const other = await mounted({ armed: true });
    other.click('r:g:Rock'); await settle();
    fire(other.doc.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(other.snap().highlight.kind, 'none');
    assert.equal(other.count('cancel'), 0);
    assert.equal(other.o.armed, true, 'still armed: the next dot answers it');
  });

  test('now playing: the pin and its off-plate chevron, Follow keeps it in view and turns off on a manual zoom, no dot no pin', async () => {
    const h = await mounted({ now: 'demo/75.mp3' });
    await settle(); h.frame();
    assert.deepEqual(h.calls.find((c) => c[0] === 'api.tracks'), ['api.tracks', { filepaths: ['demo/75.mp3'] }]);
    const pinAt = M.findId(h.snap().states.map, 75);
    assert.equal(h.snap().marks.pin, pinAt);
    const main = () => lastFrame(h.cv.getContext());
    assert.ok(main().some((o) => o[0] === 'bezierCurveTo' && o[2].fillStyle !== undefined), 'the teardrop');
    assert.ok(main().some((o) => o[0] === 'arc' && o[1][2] === M.SIZE.pinHalo), 'its halo');
    h.inst.update({ view: { cx: 0.1, cy: 0.9, z: 6 } });
    h.frame();
    const chev = h.root.querySelector('.mmap-chevron');
    assert.ok(!chev.classList.contains('super-hide'), 'off the plate: the chevron');
    assert.equal(chev.getAttribute('aria-label'), 'map.goToNowPlaying {"title":"Now"}');
    h.click('c:follow');
    assert.equal(h.root.querySelector('[data-mm="c:follow"]').getAttribute('aria-pressed'), 'true');
    h.frame();
    const [x, y] = h.at(75);
    assert.ok(x >= 0.2 * 656 - 1 && x <= 0.8 * 656 + 1 && y >= 0.2 * 663 - 1 && y <= 0.8 * 663 + 1, 'Follow keeps the pin in the middle 60 %');
    assert.equal(h.snap().view.z, 6, 'zoom unchanged');
    assert.ok(chev.classList.contains('super-hide'));
    h.emit('now', 'demo/none.mp3');
    await settle(); h.frame();
    assert.equal(h.snap().marks.pin, -1, 'no dot: no pin');
    assert.equal(h.snap().highlight.follow, true, 'Follow stays pressed');
    h.emit('now', 'demo/2.mp3');
    await settle(); h.frame();
    const [x2, y2] = h.at(2);
    assert.ok(x2 >= 0.2 * 656 - 1 && x2 <= 0.8 * 656 + 1 && y2 >= 0.2 * 663 - 1 && y2 <= 0.8 * 663 + 1, 'and resumes on the next placed song');
    fire(h.root, 'keydown', { key: '+' });
    assert.equal(h.snap().highlight.follow, false, 'a manual zoom turns Follow off');
    assert.equal(h.root.querySelector('[data-mm="c:follow"]').getAttribute('aria-pressed'), 'false');
  });

  test('the DJ trail: this session\'s Auto DJ picks at whole-map zoom, .35 to .90, quick skips hollow; any selection hides it', async () => {
    const t0 = Date.now() - 20 * 60000, at = (k) => new Date(t0 + k * 120000).toISOString();
    const play = (id, k, o = {}) => Object.assign({ id: `p${k}`, filePath: `/demo/${id}.mp3`, startedAt: at(k), endedAt: at(k + 0.9), playedMs: 100000, outcome: 'completed', source: 'autodj', sessionId: 'S' }, o);
    const history = { items: [play(2, 1), play(54, 2, { outcome: 'skipped', playedMs: 4000 }), play(62, 3)].reverse().map((p) => Object.assign({ track: { filepath: p.filePath.slice(1) } }, p)) };
    const ring = [play(65, 4), play(79, 5, { federated: true }), play(81, 6)].reverse();
    const h = await mounted({ now: 'demo/75.mp3', history, ring });
    await settle(); h.frame();
    const tr = h.snap().marks.trail;
    assert.deepEqual(tr.map((m) => h.snap().states.map.ids[m.index]), [2, 54, 62, 65, 81], 'oldest first; the connected server\'s play dropped');
    assert.deepEqual(tr.map((m) => m.quickSkip), [false, true, false, false, false]);
    const ops = lastFrame(h.cv.getContext()), at2 = ops.map((o, k) => [o, k]).filter(([o]) => o[0] === 'arc' && o[1][2] === M.SIZE.trail);
    assert.equal(at2.length, 5);
    assert.deepEqual(at2.map(([o]) => Math.round(o[2].globalAlpha * 100)), [35, 49, 63, 76, 90]);
    assert.deepEqual(at2.map(([, k]) => ops[k + 1][0]), ['fill', 'stroke', 'fill', 'fill', 'fill'], 'the quick skip is a hollow ring');
    assert.deepEqual([ops[at2[1][1] + 1][2].strokeStyle, ops[at2[1][1] + 1][2].lineWidth], [M.COLORS.pin, M.SIZE.trailSkip]);
    assert.ok(at2.every(([, k]) => (ops[k + 1][0] === 'fill' ? ops[k + 1][2].fillStyle : ops[k + 1][2].strokeStyle) === M.COLORS.pin));
    h.tap(75); await settle(); h.frame();
    assert.equal(h.snap().marks.trail.length, 0, 'a selection hides the trail');
    assert.equal(lastFrame(h.cv.getContext()).filter((o) => o[0] === 'arc' && o[1][2] === M.SIZE.trail).length, 0);
  });

  test('overlays: Plays heat asks the plays layer (a 403 hides it), Filters the mood mask; a 409 refetches the map once and retries once', async () => {
    const h = await mounted({ moods: true, filter: { valence: 'happy' } });
    assert.deepEqual(h.last('api.overlay'), ['api.overlay', 'mood', LIVE.map.rev, { valence: 'happy' }]);
    h.frame();
    assert.ok(h.snap().marks.dim, 'outside the mask dims');
    h.emit('heat', true);
    await settle();
    assert.deepEqual(h.last('api.overlay'), ['api.overlay', 'plays', LIVE.map.rev, null]);
    assert.ok(h.snap().states.overlay.plays);
    h.frame();
    const fills = lastFrame(h.cache()).filter((o) => o[0] === 'fill' && o[1][1] !== 'evenodd');
    assert.ok(fills.some((o) => o[2].globalAlpha === M.ALPHA.unplayed), 'unplayed dots at 40 %');
    const denied = await mounted({ api: { overlay: () => ({ disabled: true }) } });
    denied.emit('heat', true); await settle();
    assert.equal(denied.count('hidePlaysHeat'), 1);
    let stale = 0;
    const s409 = await mounted({ api: { overlay: () => { stale++; return { stale: true }; } } });
    s409.emit('heat', true); await settle(10);
    assert.deepEqual([stale, s409.count('api.map')], [2, 2], 'one refetch, one retry, then held');
    const noMoods = await mounted({ moods: true, filter: { valence: 'happy' }, api: { overlay: () => ({ rev: LIVE.map.rev, layer: 'mood', n: LIVE.map.points.n }) } });
    assert.deepEqual(noMoods.last('showFilters'), ['showFilters', false], 'no scores here: Filters hides');
  });

  test('gestures: the wheel zooms about the cursor on the cached layer, then one full redraw; drag pans; keys zoom and pan; all turn Follow off', async () => {
    const h = await mounted({ reduced: false });
    h.click('c:follow');
    const v0 = h.snap().view, p = [300, 200], before = M.toMap(v0, h.doc.size, p[0], p[1]);
    const ev = fire(h.cv, 'wheel', { clientX: p[0], clientY: p[1], deltaY: -200, deltaMode: 0 });
    assert.ok(ev.defaultPrevented, 'the page does not scroll or zoom');
    const v1 = h.snap().view, after = M.toMap(v1, h.doc.size, p[0], p[1]);
    assert.ok(v1.z > v0.z);
    assert.ok(Math.abs(after[0] - before[0]) < 1e-9 && Math.abs(after[1] - before[1]) < 1e-9, 'the point under the cursor stays');
    assert.equal(h.snap().highlight.follow, false);
    const land = () => h.cache().ops.filter((o) => o[0] === 'fill' && o[2] === 'evenodd').length, l0 = land();
    h.frame();
    assert.equal(land(), l0, 'during the gesture: the cached layer, no redraw');
    assert.match(h.layer().style.transform, /^matrix\(/, 'the names ride along');
    h.advance(200); h.frame();
    assert.equal(land(), l0 + 9, 'gesture end: one full redraw');
    assert.equal(h.layer().style.transform, '');
    fire(h.cv, 'pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100, clientY: 100 });
    fire(h.cv, 'pointermove', { pointerId: 3, pointerType: 'mouse', buttons: 1, clientX: 140, clientY: 130 });
    fire(h.cv, 'pointerup', { pointerId: 3, pointerType: 'mouse', button: 0, buttons: 0, clientX: 140, clientY: 130 });
    const v2 = h.snap().view, T = M.viewTransform(v1, h.doc.size);
    assert.ok(Math.abs((v1.cx - v2.cx) * T.s - 40) < 1e-6 && Math.abs((v1.cy - v2.cy) * T.s - 30) < 1e-6, 'drag pans by the pointer');
    assert.equal(h.snap().highlight.kind, 'none', 'a drag is not a tap');
    fire(h.root, 'keydown', { key: '+' });
    assert.ok(Math.abs(h.snap().view.z - v2.z * 1.5) < 1e-9, '+ zooms in x 1.5');
    fire(h.root, 'keydown', { key: '-' });
    assert.ok(Math.abs(h.snap().view.z - v2.z) < 1e-9, '- zooms out');
    fire(h.root, 'keydown', { key: 'ArrowRight' });
    assert.ok(h.snap().view.cx > v2.cx || h.snap().view.cx === M.clampView(h.snap().view, h.doc.size).cx);
    const pinch = await mounted();
    const z0 = pinch.snap().view.z;
    fire(pinch.cv, 'pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fire(pinch.cv, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, buttons: 1, clientX: 360, clientY: 300 });
    fire(pinch.cv, 'pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 420, clientY: 300 });
    assert.ok(Math.abs(pinch.snap().view.z - z0 * 2) < 1e-9, 'two pointers pinch');
  });

  test('a touch tap selects within 22 px, a mouse click within 8 px', async () => {
    const h = await mounted(), map = h.snap().states.map, grid = M.buildGrid(map);
    let best = -1, far = 0;   // the most isolated dot, centred at a zoom that puts its nearest neighbour 40 px away
    for (let i = 0; i < map.n; i++) {
      let nn = Infinity;
      for (let j = 0; j < map.n; j++) { if (j !== i) { nn = Math.min(nn, Math.hypot(map.x[i] - map.x[j], map.y[i] - map.y[j]) / 65535); } }
      if (nn > far) { far = nn; best = i; }
    }
    h.inst.update({ view: { cx: map.x[best] / 65535, cy: map.y[best] / 65535, z: Math.min(40, 40 / (far * M.baseScale(h.doc.size))) } });
    h.frame();
    const id = map.ids[best];
    assert.equal(M.nearest(grid, map, map.x[best] / 65535, map.y[best] / 65535, 30 / M.viewTransform(h.snap().view, h.doc.size).s, (j) => j !== best), -1, 'nothing else within 30 px');
    const [x, y] = h.at(id);
    h.tap([x + 15, y], 'mouse'); await settle();
    assert.equal(h.snap().highlight.kind, 'none', '15 px is too far for a mouse');
    h.tap([x + 15, y], 'touch'); await settle();
    assert.equal(h.snap().highlight.song.id, id);
  });

  test('a 404 on neighbours refetches the map once, then clears the selection', async () => {
    const h = await mounted({ api: { neighbours: () => ({ notFound: true }) } });
    h.tap(75); await settle(10);
    assert.equal(h.count('api.map'), 2);
    assert.equal(h.snap().highlight.kind, 'none');
  });

  test('titles, artists and labels go in as text, never as markup', async () => {
    const evil = '<img src=x onerror="boom">&"\'';
    const regions = [province(0, evil, 180, [0.5, 0.5], 2)];
    const h = await mounted({ rows: { 1: { id: 1, filepath: 'demo/1.mp3', metadata: { title: evil, artist: evil } } }, api: { map: () => body({ regions, points: [{ id: 1, x: 0.5, y: 0.5, r0: 0 }, { id: 2, x: 0.52, y: 0.5, r0: 0 }] }) } });
    const name = h.layer().querySelector('.mmap-name');
    assert.equal(name.textContent, evil);
    assert.equal(name.getAttribute('data-mm'), `r:g:${evil}`);
    h.tap(1); await settle();
    assert.equal(h.card().querySelector('.mmap-card-title').textContent, evil);
    assert.equal(h.card().getAttribute('aria-label'), evil);
    assert.equal(h.root.querySelectorAll('img').length, 0, 'nothing injected');
    assert.equal(h.live(), `${evil} · ${evil}`);
  });

  test('above 5,000 dots in view the songs are one ImageData raster, written in id order', async () => {
    const rnd = rng(5), points = [];
    for (let i = 0; i < 6000; i++) { points.push({ id: i + 1, x: 0.2 + rnd() * 0.6, y: 0.2 + rnd() * 0.6, r0: i % 2 }); }
    const h = await mounted({ api: { map: () => body({ points, regions: [province(0, 'A', 10, [0.3, 0.3], 3000), province(1, 'B', 200, [0.7, 0.7], 3000)] }) } });
    const ops = lastOps(h.cache());
    assert.equal(arcsOf(ops), 0, 'no vector dots');
    const put = h.canvases[1].ctx.ops.filter((o) => o[0] === 'putImageData');
    assert.equal(put.length, 1);
    const px = new Uint32Array(put[0][1].data.buffer);
    assert.ok(px.some((v) => v !== 0) && px.every((v) => v === 0 || v >>> 24 === Math.round(0.88 * 255)), 'dots at 88 %');
    assert.equal(ops.filter((o) => o[0] === 'drawImage' && o[1] === h.canvases[1]).length, 1);
  });

  test('DPR: the backing store is the CSS size times devicePixelRatio, drawn under setTransform(dpr)', async () => {
    const h = await mounted({ dpr: 2 });
    assert.deepEqual([h.cv.width, h.cv.height, h.canvases[0].width, h.canvases[0].height], [1312, 1326, 1312, 1326]);
    assert.ok(lastOps(h.cv.getContext()).some((o) => o[0] === 'setTransform' && o[1] === 2 && o[4] === 2 && o[5] === 0 && o[6] === 0));
    const T = M.viewTransform(h.snap().view, h.doc.size);
    assert.ok(lastOps(h.cache()).some((o) => o[0] === 'setTransform' && o[1] === 2 * T.s && o[5] === 2 * T.tx), 'land under the view transform, in device pixels');
  });

  test('recent rings: none at whole-map zoom, from 1.8 at r + 2.6 and 75 % (25 % dimmed), white on a lit recent neighbour', async () => {
    const points = [{ id: 1, x: 0.5, y: 0.5, r0: 0 }, { id: 2, x: 0.53, y: 0.5, r0: 0, recent: true }, { id: 3, x: 0.47, y: 0.5, r0: 0, recent: true }, { id: 4, x: 0.5, y: 0.53, r0: 0 }];
    const h = await mounted({ api: { map: () => body({ points, regions: [province(0, 'Rock', 290, [0.5, 0.45], 4)] }), neighbours: (id) => ({ seed: rowFor(id), notAnalyzed: false, neighbours: [rowFor(2)] }) } });
    const rings = () => lastFrame(h.cache()).filter((o) => o[0] === 'stroke' && o[2].strokeStyle === M.COLORS.ring).map((o) => [o[1][0].arcs.map((a) => a[3]), o[2].globalAlpha, o[2].strokeStyle, o[2].lineWidth]);
    assert.ok(rings().every((r) => r[0].length === 0), 'whole-map zoom: no rings');
    h.inst.update({ view: { cx: 0.5, cy: 0.5, z: 2 } });
    h.frame();
    assert.deepEqual(rings(), [[[2.2 + 2.6, 2.2 + 2.6], 0.75, M.COLORS.ring, 1], [[], 0.25, M.COLORS.ring, 1]]);
    h.tap(1); await settle(); h.frame();
    const r = M.dotRadius(h.snap().view.z) + 2.6;
    assert.deepEqual(rings(), [[[], 0.75, M.COLORS.ring, 1], [[r], 0.25, M.COLORS.ring, 1]], 'song 3 dims: its ring at 25 %');
    const white = lastFrame(h.cv.getContext()).map((o, k, all) => [o, all[k + 1]]).filter(([o]) => o[0] === 'arc' && o[1][2] === M.SIZE.litRing);
    assert.equal(white.length, 1, 'lit song 2 keeps its ring, in white');
    assert.deepEqual([white[0][1][0], white[0][1][2].strokeStyle, white[0][1][2].lineWidth], ['stroke', M.COLORS.lit, 1]);
  });

  test('destroy: no more frames or timers, subscriptions dropped, the plate removed; late answers are ignored', async () => {
    let late;
    const h = await mounted({ api: { neighbours: () => new Promise((r) => { late = r; }) } });
    h.tap(75); await settle();
    h.inst.update({ view: { cx: 0.4, cy: 0.4, z: 2 } });
    assert.ok(h.pending() > 0);
    h.inst.destroy();
    assert.equal(h.pending(), 0, 'the frame cancelled');
    assert.equal(h.host.children.length, 0, 'the plate is gone');
    assert.ok(h.win.observers.every((o) => o.off), 'ResizeObserver disconnected');
    assert.ok(Object.values(h.subs).every((s) => s.size === 0), 'deps subscriptions dropped');
    late({ seed: rowFor(75), neighbours: [rowFor(2)] });
    await settle();
    h.emit('now', 'demo/2.mp3');
    assert.equal(h.pending(), 0);
    h.inst.destroy();
  });

  // ---- the 2026-11-03 review (Phase 2): reachability, focus, failures
  test('the tooltip: a lit song\'s button on hover or focus (the button covers its dot), a search hit at whole-map zoom; none over a name or the card', async () => {
    const h = await mounted();
    h.tap(75); await settle(); h.frame();
    const tip = h.root.querySelector('.mmap-tip'), song = h.layer().querySelectorAll('.mmap-song')[0], id = Number(song.getAttribute('data-mm').slice(2));
    const move = (el, x = 1, y = 1) => fire(el, 'pointermove', { pointerId: 9, pointerType: 'mouse', buttons: 0, clientX: x, clientY: y });
    move(song); await settle();
    assert.ok(!tip.classList.contains('super-hide'), 'hovering a lit dot is hovering its button');
    assert.equal(tip.textContent, `Song ${id} · Artist`);
    assert.equal(tip.style.top, Math.max(4, h.at(id)[1] - 32) + 'px', 'beside the dot');
    move(h.card()); await settle();
    assert.ok(tip.classList.contains('super-hide'), 'not over the card');
    fire(song, 'focusin'); await settle();
    assert.equal(tip.textContent, `Song ${id} · Artist`, 'the keyboard on a lit song');
    assert.ok(!tip.classList.contains('super-hide'));
    fire(song, 'focusout');
    assert.ok(tip.classList.contains('super-hide'));
    const s = await mounted();
    s.emit('search', 'the'); await settle();
    s.inst.update({ view: { cx: 0.5, cy: 0.5, z: 1 } }); s.frame();
    const hit = LIVE.search.the.best, [x, y] = s.at(hit), stip = s.root.querySelector('.mmap-tip');
    move(s.cv, x, y); await settle();
    assert.ok(!stip.classList.contains('super-hide'), 'a search hit is lit: its tooltip below zoom 1.8');
    assert.ok(LIVE.search.the.ids.map((n) => `Song ${n} · Artist`).includes(stip.textContent));
    const plain = await mounted(), other = plain.snap().states.map.ids.find((n) => !LIVE.search.the.ids.includes(n));
    move(plain.cv, ...plain.at(other)); await settle();
    assert.ok(plain.root.querySelector('.mmap-tip').classList.contains('super-hide'), 'a plain dot below 1.8: none');
  });

  test('gestures from a name: the wheel zooms (never the page), a drag pans and is no click, a press that does not move is the name\'s click; the card is not the map', async () => {
    const h = await mounted();
    const name = (k = 'r:g:Rock') => h.layer().querySelectorAll('.mmap-name').find((b) => b.getAttribute('data-mm') === k);
    const z0 = h.snap().view.z;
    const wheel = fire(name(), 'wheel', { clientX: 300, clientY: 300, deltaY: -120, deltaMode: 0 });
    assert.ok(wheel.defaultPrevented && h.snap().view.z > z0, 'zoomed about the cursor');
    const pinch = fire(name(), 'wheel', { clientX: 300, clientY: 300, deltaY: -10, deltaMode: 0, ctrlKey: true });
    assert.ok(pinch.defaultPrevented, 'ctrl+wheel (a trackpad pinch) over a name: the map, not the page zoom');
    h.advance(200); h.frame();
    const n = name('r:t:3') || h.layer().querySelectorAll('.mmap-name')[0], v1 = h.snap().view, T = M.viewTransform(v1, h.doc.size);
    const p = (type, x, y, more = {}) => fire(n, type, Object.assign({ pointerId: 4, pointerType: 'touch', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }, more));
    p('pointerdown', 200, 200); p('pointermove', 240, 230); p('pointerup', 240, 230);
    fire(n, 'click', { detail: 1 });
    const v2 = h.snap().view;
    assert.ok(Math.abs((v1.cx - v2.cx) * T.s - 40) < 1e-6 && Math.abs((v1.cy - v2.cy) * T.s - 30) < 1e-6, 'a drag from a name pans');
    assert.equal(h.snap().highlight.kind, 'none', 'and the click it ends in is not the name\'s');
    h.frame();
    const again = name('r:t:3') || h.layer().querySelectorAll('.mmap-name')[0], key = again.getAttribute('data-mm'), [dx, dy] = h.at(75);
    fire(again, 'pointerdown', { pointerId: 5, pointerType: 'mouse', button: 0, buttons: 1, clientX: dx, clientY: dy });
    fire(again, 'pointerup', { pointerId: 5, pointerType: 'mouse', button: 0, buttons: 0, clientX: dx, clientY: dy });
    fire(again, 'click', { detail: 1 });
    await settle();
    assert.deepEqual([h.snap().highlight.kind, h.snap().highlight.place.key], ['place', key.slice(2)], 'a press that does not move: the name\'s click, no dot under it picked');
    const v3 = h.snap().view, card = fire(h.card(), 'wheel', { clientX: 100, clientY: 600, deltaY: -120, deltaMode: 0 });
    assert.ok(!card.defaultPrevented && h.snap().view === v3, 'the wheel over the card is not the map\'s');
  });

  test('a control that goes away under the keyboard hands it to the plate: the chevron once the pin is back, Try again once the map loads', async () => {
    const h = await mounted({ now: 'demo/75.mp3' });
    await settle(); h.frame();
    h.inst.update({ view: { cx: 0.1, cy: 0.9, z: 6 } }); h.frame();
    const chev = h.root.querySelector('.mmap-chevron');
    assert.ok(!chev.classList.contains('super-hide'));
    chev.focus();
    h.click('c:pin'); h.frame();
    assert.ok(chev.classList.contains('super-hide'), 'the pin is centred: the chevron goes');
    assert.ok(h.doc.activeElement === h.root, 'and the keyboard stays on the plate (the map\'s keys), never the page');
    const answers = [null, LIVE.map], f = await mounted({ api: { map: () => answers.shift() } });
    const retry = f.root.querySelector('.mmap-state .mmap-pill');
    retry.focus();
    fire(retry, 'click'); await settle();
    assert.equal(f.snap().states.status, 'ready');
    assert.equal(f.root.querySelectorAll('.mmap-state button').length, 0);
    assert.ok(f.doc.activeElement === f.root, 'Try again is gone: the plate');
  });

  test('a card opened by Enter in search: Esc or × sends the keyboard back to the field (the plate when the field is hidden)', async () => {
    const h = await mounted();
    const field = h.doc.createElement('input');
    field.focus();
    h.emit('enter', 'the'); await settle();
    assert.equal(h.snap().highlight.song.id, LIVE.search.the.best);
    assert.equal(h.focused(), 'v:play');
    fire(h.doc.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(h.snap().highlight.kind, 'none');
    assert.ok(h.doc.activeElement === field, 'back to the field, which still holds the query');
    field.focus();
    h.emit('enter', 'the'); await settle();
    h.click('x:');
    assert.ok(h.doc.activeElement === field, '× too');
    field.focus();
    h.emit('enter', 'the'); await settle();
    field.focus = () => {};   // closed meanwhile (display: none takes no focus)
    h.click('x:');
    assert.ok(h.doc.activeElement === h.root, 'the field hidden: the plate');
  });

  test('a tap whose lookup gets no answer (a network blip) is dropped and keeps the selection; a song the server no longer knows refetches the map', async () => {
    let fail = false;
    const h = await mounted({ api: { tracks: (b) => (fail ? null : b.ids ? { tracks: b.ids.map(rowFor) } : { ids: b.filepaths.map(idOfPath) }) } });
    h.tap(14); await settle();
    assert.equal(h.snap().highlight.song.id, 14);
    fail = true;
    h.tap(51); await settle(10);
    assert.equal(h.count('api.map'), 1, 'no refetch');
    assert.equal(h.snap().highlight.song.id, 14, 'the selection stays');
    assert.ok(h.card());
    fail = false;
    h.tap(51); await settle();
    assert.equal(h.snap().highlight.song.id, 51, 'the next tap asks again');
    const gone = await mounted({ api: { tracks: (b) => (b.ids ? { tracks: b.ids.map(() => null) } : { ids: [] }) } });
    gone.tap(51); await settle(10);
    assert.equal(gone.count('api.map'), 2, 'an explicit null: one refetch');
  });

  test('a place whose mix failed: each verb asks again, then acts on the answer, which is kept', async () => {
    let answer = null;
    const h = await mounted({ api: { region: () => answer } });
    h.click('r:g:Rock'); await settle();
    assert.equal(h.count('api.region'), 1);
    h.click('v:play'); await settle();
    assert.deepEqual([h.count('playAll'), h.count('api.region')], [0, 2], 'asked again on the press; still nothing to play');
    answer = { region: { key: 'g:Rock', level: 0, label: 'Rock' }, centre: rowFor(34), songs: [34, 2, 30].map(rowFor) };
    h.click('v:play'); await settle();
    assert.equal(h.count('api.region'), 3);
    assert.deepEqual(h.last('playAll')[1], ['demo/34.mp3', 'demo/2.mp3', 'demo/30.mp3']);
    h.click('v:dj'); await settle();
    assert.deepEqual([h.count('api.region'), h.last('autoDj')[1]], [3, 'demo/34.mp3'], 'kept once it came');
  });

  test('the off-screen chevron stays clear of the card: a pin below the view, over the card, sits above it', async () => {
    const h = await mounted({ now: 'demo/75.mp3' });
    await settle(); h.frame();
    h.click('r:g:Rock'); await settle();
    const map = h.snap().states.map, i = M.findId(map, 75), z = 6, s = M.baseScale(h.doc.size) * z;
    h.inst.update({ view: { cx: map.x[i] / 65535 - (200 - 656 / 2) / s, cy: map.y[i] / 65535 - (663 / 2 + 120) / s, z } });
    h.frame();
    const chev = h.root.querySelector('.mmap-chevron'), card = h.card(), [x] = h.at(75);
    assert.ok(Math.abs(x - 200) < 1 && h.at(75)[1] > 663, 'the pin below the plate, over the card\'s span');
    assert.ok(!chev.classList.contains('super-hide'));
    const top = parseFloat(chev.style.top);
    assert.ok(top + 32 <= card.offsetTop - 6, `above the card (${top} + 32 vs ${card.offsetTop})`);
    h.click('x:'); h.frame();
    assert.equal(parseFloat(chev.style.top), 663 - 22 - 16, 'no card: on the plate\'s edge');
  });

  test('the plate\'s own keys stop at the plate (the player never hears them); Space and the player\'s other keys go on', async () => {
    const h = await mounted(), heard = [], win = (ev) => heard.push(ev.key);
    for (const key of ['ArrowLeft', 'ArrowDown', '+', '=', '-']) {
      const ev = fire(h.root, 'keydown', { key }, win);
      assert.ok(ev.defaultPrevented && ev.stopped, key);
    }
    h.tap(75); await settle();
    assert.ok(fire(h.doc.activeElement, 'keydown', { key: 'Escape' }, win).stopped, 'Esc that clears');
    const space = fire(h.root, 'keydown', { key: ' ' }, win);
    assert.ok(!space.defaultPrevented && !space.stopped, 'Space: the player\'s play / pause');
    fire(h.root, 'keydown', { key: 'k' }, win);
    fire(h.root, 'keydown', { key: 'Escape' }, win);
    fire(h.root, 'keydown', { key: 'ArrowRight', ctrlKey: true }, win);
    assert.deepEqual(heard, [' ', 'k', 'Escape', 'ArrowRight'], 'nothing to clear, ctrl+arrow (next track): the player\'s');
  });

  test('the DJ trail\'s 30-minute gap counts back from now playing\'s start: a long song or a long pause keeps the trail', async () => {
    const t0 = Date.now() - 3 * 3600000, at = (k) => new Date(t0 + k * 120000).toISOString();
    const play = (id, k) => ({ id: `p${k}`, filePath: `/demo/${id}.mp3`, startedAt: at(k), endedAt: at(k + 0.9), playedMs: 100000, outcome: 'completed', source: 'autodj', sessionId: 'S' });
    const ring = [play(2, 1), play(54, 2), play(62, 3)].reverse();
    const h = await mounted({ now: 'demo/75.mp3', ring, startedAt: t0 + 3.95 * 120000 });
    await settle(); h.frame();
    assert.deepEqual(h.snap().marks.trail.map((m) => h.snap().states.map.ids[m.index]), [2, 54, 62], 'now playing started 3 hours ago, right after the last pick');
    const unknown = await mounted({ now: 'demo/75.mp3', ring });
    await settle(); unknown.frame();
    assert.equal(unknown.snap().marks.trail.length, 0, 'no start known: counted from now, 3 hours is a gap');
  });
});
