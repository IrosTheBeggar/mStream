// Music Map (Atlas), docs/music-map-plan.md section 4. The pure core (decoders, view, grid, placers,
// palette, DJ trail, highlight and states reducers), then the DOM/canvas controller (mount). UMD like
// alpha/discovery-page.js. Map units: the unit square (u16 / 65535 on the wire, y down); screen: CSS px
// on the plate. view {cx, cy, z}; plate {w, h}; bounds {x, y, w, h}; box {x0, y0, x1, y1}.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.MUSICMAP = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const U16 = 65535, ZOOM_MIN = 1, ZOOM_MAX = 40, BAND_TOWNS = 1.8, BAND_DEEP = 5, TRAIL_MAX_ZOOM = 1.05;
  const RASTER_ABOVE = 5000, VISIBLE_PART_MIN = 12, REVALIDATE_MS = 30000, fz = Object.freeze;
  const DOT_R = fz([1.5, 2.2, 3.6]);
  const TRAIL = fz({ max: 6, gapMs: 30 * 60000, quickSkipMs: 30000, from: 0.35, to: 0.9 });
  const COLORS = fz({ page: '#1e2228', sea: '#171a1f', plateEdge: '#2a2f37', lit: '#f5f7fa', ring: '#e6e8ec', pin: '#fa832b', control: '#2d333b', controlEdge: '#444c56', title: '#e6e8ec' });
  const ALPHA = fz({ dot: 0.88, dim: 0.26, placeDim: 0.25, landDim: 0.45, ring: 0.75, ringDim: 0.25, coast: 0.85, unplayed: 0.4, pinHalo: 0.22 });
  const SIZE = fz({ lit: 4.2, litEdge: 1.5, reticleDot: 5, reticleRing: 10, trail: 2.4, trailSkip: 1.2, ringPad: 2.6, litRing: 7.2, titleGap: 4.5, title: 12, town: 12.5, badge: 8, pinHalo: 8, hitMouse: 8, hitTouch: 22 });
  // marks.skip codes (a mark replaces the dot; higher wins) and ringOf's answers.
  const MARK = fz({ none: 0, trail: 1, lit: 2, selected: 3, pin: 4 }), RING = fz({ none: 0, normal: 1, dim: 2, white: 3 });
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isObj = (v) => !!v && typeof v === 'object';
  const strip = (p) => (typeof p === 'string' && p ? p.replace(/^\/+/, '') : null);
  const put = (o, k, v) => Object.assign({}, o, { [k]: v });
  const fail = (code, msg) => Object.assign(new Error(msg), { code });

  // -- decoders (plan 3.8.9). Errors carry code 'format' or 'corrupt'.
  function b64ToBytes(s) {
    if (s instanceof Uint8Array) { return s; }
    if (typeof s !== 'string') { return null; }
    if (typeof Uint8Array.fromBase64 === 'function') { try { return Uint8Array.fromBase64(s); } catch (_e) { return null; } }
    let bin;
    try { bin = atob(s); } catch (_e) { return null; }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  }
  const aligned = (u8, k) => (u8.byteOffset % k ? u8.slice() : u8);
  // cols-v1 -> typed views on one buffer: no per-point work.
  function decodePoints(p) {
    if (!isObj(p) || p.format !== 'cols-v1') { throw fail('format', 'points: unknown format'); }
    const n = p.n, raw = Number.isInteger(n) && n >= 0 ? b64ToBytes(p.data || '') : null;
    if (!raw || raw.length !== 11 * n) { throw fail('corrupt', 'points: length does not match n'); }
    const b = aligned(raw, 4), v = (T, k) => new T(b.buffer, b.byteOffset + k * n, n);
    return { n, ids: v(Uint32Array, 0), x: v(Uint16Array, 4), y: v(Uint16Array, 6), r0: v(Uint8Array, 8), r1: v(Uint8Array, 9), flags: v(Uint8Array, 10) };
  }
  // land-v1 -> [coast, mid, high] of rings, each a Uint16Array view [x0, y0, x1, y1, ...].
  function decodeLand(data) {
    const raw = b64ToBytes(data);
    if (!raw || raw.length % 2) { throw fail('corrupt', 'land-v1: bytes left over'); }
    const b = aligned(raw, 2), w = new Uint16Array(b.buffer, b.byteOffset, b.length >> 1), levels = [];
    let k = 0;
    for (let l = 0; l < 3; l++) {
      const rings = [];
      for (let r = k < w.length ? w[k++] : -1; r !== 0; r--) {
        const vc = r > 0 && k < w.length ? w[k++] : 0;
        if (vc < 3 || k + 2 * vc > w.length) { throw fail('corrupt', 'land-v1: truncated'); }
        rings.push(w.subarray(k, k += 2 * vc));
      }
      levels.push(rings);
    }
    if (k !== w.length) { throw fail('corrupt', 'land-v1: bytes left over'); }
    return levels;
  }
  // Rings onto a Path2D or context as closed sub-paths, times k; fill 'evenodd'.
  function traceRings(p, rings, k) {
    for (const r of rings) {
      p.moveTo(r[0] * k, r[1] * k);
      for (let j = 2; j < r.length; j += 2) { p.lineTo(r[j] * k, r[j + 1] * k); }
      p.closePath();
    }
    return p;
  }
  function decodeBitset(data, n) {
    const u8 = b64ToBytes(data);
    if (!u8 || u8.length !== (n + 7) >> 3) { throw fail('corrupt', 'bitset: length does not match n'); }
    return u8;
  }
  const bitAt = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;
  function decodePlays(data, n) {
    const u8 = b64ToBytes(data);
    if (!u8 || u8.length !== n) { throw fail('corrupt', 'plays: length does not match n'); }
    return u8;
  }
  // A representative id's index (binary search), or -1.
  function findId(map, id) {
    for (let lo = 0, hi = map && typeof id === 'number' ? map.n - 1 : -1; lo <= hi;) {
      const mid = (lo + hi) >> 1, v = map.ids[mid];
      if (v === id) { return mid; }
      if (v < id) { lo = mid + 1; } else { hi = mid - 1; }
    }
    return -1;
  }
  // A ready GET /map body -> {ok, map} | {ok: false, reason: 'state' | 'format' (as 403) | 'corrupt'}.
  function decodeMap(body) {
    if (!isObj(body) || body.state !== 'ready') { return { ok: false, reason: 'state' }; }
    const lay = body.layout || {}, model = body.model || {};
    if (lay.landFormat !== 'land-v1' || !isObj(body.points) || body.points.format !== 'cols-v1') { return { ok: false, reason: 'format' }; }
    let map;
    try { map = decodePoints(body.points); } catch (e) { return { ok: false, reason: e.code }; }
    Object.assign(map, {
      rev: body.rev ?? null, model: { id: model.id ?? null, version: model.version ?? null }, layout: { id: lay.id ?? null, frame: lay.frame ?? null, aspect: lay.aspect ?? 1 },
      regions: [], byKey: new Map(), province: new Array(256).fill(null), town: new Array(256).fill(null), pal: new Array(256).fill(paletteFor(null)),
    });
    for (const r of Array.isArray(body.regions) ? body.regions : []) {
      if (!isObj(r) || typeof r.key !== 'string' || !(r.level === 0 || r.level === 1) || !(Number.isInteger(r.id) && r.id >= 0 && r.id < 255)) { continue; }
      let land = null;
      try { land = r.level || !r.land ? null : decodeLand(r.land); } catch (_e) { land = null; }
      const a = r.anchor || [], hue = Number.isFinite(r.hue) ? r.hue : null;
      const reg = { key: r.key, level: r.level, id: r.id, parent: r.parent ?? null, label: typeof r.label === 'string' && r.label.trim() ? r.label : null,
        hue, ax: (a[0] ?? U16 / 2) / U16, ay: (a[1] ?? U16 / 2) / U16, size: r.size | 0, land, pal: paletteFor(hue) };
      map.regions.push(reg);
      map.byKey.set(reg.key, reg);
      if (reg.level) { map.town[reg.id] = reg; } else { map.province[reg.id] = reg; map.pal[reg.id] = reg.pal; }
    }
    return { ok: true, map };
  }
  // -> {ok, layer, bits | plays, moods} | {ok: false, reason: 'stale' | 'noMoods' (hide Filters) | 'corrupt'}.
  function decodeOverlay(body, map) {
    if (!isObj(body) || !map) { return { ok: false, reason: 'corrupt' }; }
    if (body.rev !== map.rev || body.n !== map.n) { return { ok: false, reason: 'stale' }; }
    try {
      if (body.layer === 'plays') { return { ok: true, layer: 'plays', plays: decodePlays(body.data, map.n) }; }
      if (body.layer === 'mood') {
        return 'moods' in body && body.data != null ? { ok: true, layer: 'mood', moods: body.moods, bits: decodeBitset(body.data, map.n) } : { ok: false, reason: 'noMoods' };
      }
    } catch (_e) { /* corrupt */ }
    return { ok: false, reason: 'corrupt' };
  }

  // -- view: screen = map * s + t; zoom 1 fits the shorter side less 24 px; 1..40; 20 % stays in view.
  const baseScale = (plate) => Math.max(1, Math.min(plate.w, plate.h) - 24);
  const wholeMap = () => ({ cx: 0.5, cy: 0.5, z: 1 });
  function viewTransform(v, plate) { const s = baseScale(plate) * v.z; return { s, tx: plate.w / 2 - v.cx * s, ty: plate.h / 2 - v.cy * s }; }
  function toMap(v, plate, sx, sy) { const T = viewTransform(v, plate); return [(sx - T.tx) / T.s, (sy - T.ty) / T.s]; }
  function clampView(v, plate) {
    const z = clamp(v.z || 1, ZOOM_MIN, ZOOM_MAX), s = baseScale(plate) * z;
    const axis = (c, half) => { const k = 0.2 * Math.min(2 * half, 1); return clamp(Number.isFinite(c) ? c : 0.5, k - half, 1 - k + half); };
    return { cx: axis(v.cx, plate.w / 2 / s), cy: axis(v.cy, plate.h / 2 / s), z };
  }
  function zoomAt(v, plate, factor, sx, sy) {
    const s0 = baseScale(plate) * v.z, z = clamp(v.z * factor, ZOOM_MIN, ZOOM_MAX), s1 = baseScale(plate) * z, dx = sx - plate.w / 2, dy = sy - plate.h / 2;
    return clampView({ cx: v.cx + dx / s0 - dx / s1, cy: v.cy + dy / s0 - dy / s1, z }, plate);
  }
  function panBy(v, plate, dx, dy) { const s = baseScale(plate) * v.z; return clampView({ cx: v.cx - dx / s, cy: v.cy - dy / s, z: v.z }, plate); }
  function visibleRect(v, plate) {
    const s = baseScale(plate) * v.z, hw = plate.w / 2 / s, hh = plate.h / 2 / s;
    return { x0: v.cx - hw, y0: v.cy - hh, x1: v.cx + hw, y1: v.cy + hh };
  }
  // The view framing box b in the plate less inset {top, right, bottom, left} and pad, zoom in [min, max].
  function fitBounds(plate, b, o = {}) {
    const ins = o.inset || {}, pad = o.pad ?? 32, l = (ins.left || 0) + pad, t = (ins.top || 0) + pad;
    const aw = Math.max(1, plate.w - l - (ins.right || 0) - pad), ah = Math.max(1, plate.h - t - (ins.bottom || 0) - pad);
    const lo = Math.max(ZOOM_MIN, o.min || 0), hi = Math.max(lo, Math.min(ZOOM_MAX, o.max || ZOOM_MAX));
    const z = clamp(Math.min(aw / Math.max(b.x1 - b.x0, 1e-9), ah / Math.max(b.y1 - b.y0, 1e-9)) / baseScale(plate), lo, hi), s = baseScale(plate) * z;
    return clampView({ cx: (b.x0 + b.x1) / 2 - (l + aw / 2 - plate.w / 2) / s, cy: (b.y0 + b.y1) / 2 - (t + ah / 2 - plate.h / 2) / s, z }, plate);
  }
  function boundsOf(map, indices) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of indices) {
      if (!(i >= 0 && i < map.n)) { continue; }
      const x = map.x[i] / U16, y = map.y[i] / U16;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }
  const lerpView = (a, b, t) => ({ cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, z: a.z * Math.pow(b.z / a.z, t) });
  const centreOn = (v, plate, mx, my) => clampView({ cx: mx, cy: my, z: v.z }, plate);
  // The least pan bringing (mx, my) into the middle frac of the plate (Follow); v when already in.
  function keepInView(v, plate, mx, my, frac) {
    const T = viewTransform(v, plate), f = (1 - (frac || 0.6)) / 2;
    const edge = (p, size) => (p < size * f ? p - size * f : p > size * (1 - f) ? p - size * (1 - f) : 0);
    const ex = edge(mx * T.s + T.tx, plate.w), ey = edge(my * T.s + T.ty, plate.h);
    return ex || ey ? clampView({ cx: v.cx + ex / T.s, cy: v.cy + ey / T.s, z: v.z }, plate) : v;
  }
  // Bands (dir-A 2.6): 0 provinces (1.5 px), 1 towns (2.2), 2 towns (3.6).
  const bandOf = (z) => (z >= BAND_DEEP ? 2 : z >= BAND_TOWNS ? 1 : 0);
  const dotRadius = (z) => DOT_R[bandOf(z)];
  const useRaster = (nInView) => nInView > RASTER_ABOVE;

  // -- grid index: G x G cells, CSR (cell c = items[start[c] .. start[c + 1]), in id order).
  const cellOf = (m, G) => clamp(Math.floor(m * G), 0, G - 1);
  function buildGrid(map) {
    const n = map ? map.n : 0, G = clamp(Math.ceil(Math.sqrt(n / 2)), 1, 1024);
    const start = new Uint32Array(G * G + 1), cell = new Uint32Array(n), items = new Uint32Array(n);
    for (let i = 0; i < n; i++) { start[(cell[i] = cellOf(map.y[i] / U16, G) * G + cellOf(map.x[i] / U16, G)) + 1]++; }
    for (let c = 0; c < G * G; c++) { start[c + 1] += start[c]; }
    const at = start.slice(0, G * G);
    for (let i = 0; i < n; i++) { items[at[cell[i]]++] = i; }
    return { G, start, items };
  }
  function scan(grid, r, fn) {
    const G = grid.G, x0 = cellOf(r.x0, G), x1 = cellOf(r.x1, G);
    for (let cy = cellOf(r.y0, G), y1 = cellOf(r.y1, G); cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let k = grid.start[cy * G + cx], e = grid.start[cy * G + cx + 1]; k < e; k++) { fn(grid.items[k]); }
      }
    }
  }
  // The nearest point within map distance r that accept(i) takes, ties to the lower index; -1.
  function nearest(grid, map, mx, my, r, accept) {
    let best = -1, bd = r * r;
    scan(grid, { x0: mx - r, x1: mx + r, y0: my - r, y1: my + r }, (i) => {
      const dx = map.x[i] / U16 - mx, dy = map.y[i] / U16 - my, d = dx * dx + dy * dy;
      if ((d < bd || (d === bd && (best < 0 || i < best))) && (!accept || accept(i))) { best = i; bd = d; }
    });
    return best;
  }
  function forEachInRect(grid, map, r, fn) {
    const X0 = r.x0 * U16, X1 = r.x1 * U16, Y0 = r.y0 * U16, Y1 = r.y1 * U16;
    scan(grid, r, (i) => { if (map.x[i] >= X0 && map.x[i] <= X1 && map.y[i] >= Y0 && map.y[i] <= Y1) { fn(i); } });
  }
  function countInRect(grid, map, r) { let n = 0; forEachInRect(grid, map, r, () => { n++; }); return n; }
  // Per region id, the points in rect r and their x / y sums (n0 sx0 sy0 provinces, n1 sx1 sy1 towns).
  function regionStats(grid, map, r) {
    const s = { total: 0, n0: new Uint32Array(256), n1: new Uint32Array(256), sx0: new Float64Array(256), sy0: new Float64Array(256), sx1: new Float64Array(256), sy1: new Float64Array(256) };
    forEachInRect(grid, map, r, (i) => {
      const x = map.x[i] / U16, y = map.y[i] / U16, a = map.r0[i], b = map.r1[i];
      s.total++; s.n0[a]++; s.sx0[a] += x; s.sy0[a] += y; s.n1[b]++; s.sx1[b] += x; s.sy1[b] += y;
    });
    return s;
  }

  // -- placers (from the Atlas boards' build.mjs). measure(text, item) -> px.
  const boxOf = (cx, cy, w, h) => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 });
  const overlaps = (a, b, p = 0) => !(a.x1 + p <= b.x0 || b.x1 + p <= a.x0 || a.y1 + p <= b.y0 || b.y1 + p <= a.y0);
  const circleBox = (x, y, r) => ({ x0: x - r, x1: x + r, y0: y - r, y1: y + r });
  const rectBox = (rc, p = 0) => ({ x0: rc.x - p, x1: rc.x + rc.w + p, y0: rc.y - p, y1: rc.y + rc.h + p });
  const pinBox = (x, y) => ({ x0: x - 10, x1: x + 10, y0: y - 26, y1: y + 6 });
  // Provinces below 1.8, towns from 1.8, not label null: at the anchor (then the in-view centroid cx, cy),
  // or at the in-view centroid when the anchor is off the plate and >= 12 songs are in view.
  function nameCandidates(map, view, plate, stats, selectedKey) {
    const L = bandOf(view.z) ? 1 : 0, T = viewTransform(view, plate), out = [];
    for (const r of map.regions) {
      const n = stats['n' + L][r.id], ax = r.ax * T.s + T.tx, ay = r.ay * T.s + T.ty;
      if (r.level !== L || r.label === null) { continue; }
      let x = ax, y = ay, cx = null, cy = null;
      if (n > 0) { cx = (stats['sx' + L][r.id] / n) * T.s + T.tx; cy = (stats['sy' + L][r.id] / n) * T.s + T.ty; }
      if (!(ax >= 0 && ax <= plate.w && ay >= 0 && ay <= plate.h)) {
        if (n < VISIBLE_PART_MIN) { continue; }
        x = cx; y = cy; cx = cy = null;
      }
      out.push({ key: r.key, level: L, id: r.id, label: r.label, text: L ? r.label : r.label.toUpperCase(), x, y, cx, cy,
        size: L ? SIZE.town : r.size >= 400 ? 13 : r.size >= 60 ? 12 : 11, selected: r.key === selectedKey, rsize: r.size });
    }
    return out.sort((a, b) => (b.selected - a.selected) || (b.rsize - a.rsize));
  }
  const NUDGES = [[0, 0], [0, -0.9], [0, 0.9], [0.35, -0.6], [-0.35, -0.6], [0.35, 0.6], [-0.35, 0.6], [0, -1.7], [0, 1.7], [0.6, 0], [-0.6, 0]];
  // The anchor, the centroid, then 10 nudges: the first spot clear of obstacles and earlier names, or none.
  function placeNames(cands, obstacles, bounds, measure) {
    const placed = [];
    for (const c of cands) {
      const w = measure(c.text, c), h = c.size * 1.25, lo = bounds.x + w / 2 + 4, hi = bounds.x + bounds.w - w / 2 - 4;
      const top = bounds.y + h / 2 + 2, bot = bounds.y + bounds.h - h / 2 - 2;
      const tries = [[c.x, c.y]].concat(c.cx != null ? [[c.cx, c.cy]] : [], NUDGES.slice(1).map((d) => [c.x + d[0] * w, c.y + d[1] * h]));
      for (let k = 0; lo <= hi && top <= bot && k < tries.length; k++) {
        const x = clamp(tries[k][0], lo, hi), y = clamp(tries[k][1], top, bot), b = boxOf(x, y, w + 6, h + 2);
        if (!obstacles.some((q) => overlaps(b, q)) && !placed.some((p) => overlaps(b, p.box, 4))) {
          placed.push(Object.assign({}, c, { x, y, w, h, box: b, moved: k > 0 }));
          break;
        }
      }
    }
    return placed;
  }
  // Neighbour titles: right first, then left, else left out; most titles, then fewest on the left.
  function placeTitles(items, obstacles, bounds, measure) {
    const n = items.length, rOf = (it) => (it.ring ? SIZE.litRing : SIZE.lit), dots = items.map((it) => circleBox(it.x, it.y, rOf(it) + 1.5));
    const opt = items.map((it, i) => ['right', 'left'].map((side) => {
      const w = measure(it.text, it), off = rOf(it) + SIZE.titleGap, y = it.y + 4.3, x0 = side === 'right' ? it.x + off : it.x - off - w;
      const b = { x0: x0 - 1.5, x1: x0 + w + 1.5, y0: y - 10.5, y1: y + 4.1 };
      return b.x0 >= bounds.x + 4 && b.x1 <= bounds.x + bounds.w - 4 && b.y0 >= bounds.y + 4 && b.y1 <= bounds.y + bounds.h - 4
        && !obstacles.some((q) => overlaps(b, q)) && !dots.some((d, j) => j !== i && overlaps(b, d)) && { side, x: side === 'right' ? x0 : x0 + w, y, box: b };
    }).filter(Boolean));
    let best = null, bestCost = Infinity, nodes = 0;
    const pick = new Array(n).fill(null);
    const dfs = (i, cost) => {
      if (cost >= bestCost || ++nodes > 20000) { return; }
      if (i === n) { bestCost = cost; best = pick.slice(); return; }
      for (const c of opt[i]) {
        if (pick.some((p, j) => j < i && p && overlaps(c.box, p.box))) { continue; }
        pick[i] = c; dfs(i + 1, cost + (c.side === 'left')); pick[i] = null;
      }
      dfs(i + 1, cost + 100);
    };
    dfs(0, 0);
    return best || pick;
  }
  // Path badges: ~15 px from the stop, away from its neighbours; greedy, then branch and bound per cluster.
  function placeBadges(stops, o = {}) {
    const B = o.bounds, hard = o.hard || [], maxNodes = o.maxNodes || 2000, R = SIZE.badge;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), clash = (p, c) => dist(p, c) < 2 * R + 1.5, out = stops.map(() => null);
    const near = stops.map((s, i) => stops.map((_, j) => j).filter((j) => j !== i && dist(s, stops[j]) < 100));
    const cands = stops.map((s, i) => {
      let wx = 0, wy = 0, wt = 0, pref = null;
      for (const j of near[i]) { const t = stops[j], w = Math.exp(-(dist(s, t) ** 2) / 450); wx += w * t.x; wy += w * t.y; wt += w; }
      if (wt >= 1e-9 && Math.hypot(s.x - wx / wt, s.y - wy / wt) >= 1e-6) { pref = Math.atan2(s.y - wy / wt, s.x - wx / wt); }
      const list = [];
      for (let rad = 15; rad <= 40; rad += 2.5) {
        for (let a = 0; a < 36; a++) {
          const th = (a * Math.PI) / 18, p = { x: s.x + rad * Math.cos(th), y: s.y + rad * Math.sin(th) }, box = circleBox(p.x, p.y, R + 1);
          if ((B && (box.x0 < B.x + 3 || box.x1 > B.x + B.w - 3 || box.y0 < B.y + 3 || box.y1 > B.y + B.h - 3))
            || near[i].some((j) => dist(p, stops[j]) < R + 6.45) || hard.some((q) => overlaps(box, q))) { continue; }
          let dOther = Infinity, d = pref === null ? 0 : Math.abs(th - pref) % (2 * Math.PI);
          for (const j of near[i]) { if (dist(stops[j], s) >= 6) { dOther = Math.min(dOther, dist(p, stops[j])); } }
          d = d > Math.PI ? 2 * Math.PI - d : d;
          list.push({ x: p.x, y: p.y, cost: rad + 0.08 * Math.max(0, rad - 15) ** 2 + 2 * Math.max(0, rad - dOther + 2) + 14 * d });
        }
      }
      return list.sort((p, q) => p.cost - q.cost).slice(0, 48);
    });
    const root = stops.map((_, i) => i), find = (i) => (root[i] === i ? i : (root[i] = find(root[i]))), groups = new Map();
    near.forEach((l, i) => l.forEach((j) => { root[find(i)] = find(j); }));
    stops.forEach((_, i) => { groups.set(find(i), (groups.get(find(i)) || []).concat(i)); });
    for (const members of groups.values()) {
      const greedy = [], pick = [];
      let gCost = 0, nodes = 0;
      for (const i of members.slice().sort((a, b) => cands[a].length - cands[b].length)) {
        const c = cands[i].find((q) => !greedy.some((g) => clash(g[1], q)));
        if (c) { greedy.push([i, c]); gCost += c.cost; }
      }
      let best = greedy.length === members.length ? greedy : null, bestCost = best ? gCost : Infinity;
      const dfs = (open, fits, acc) => {
        if (++nodes > maxNodes || fits.some((f) => !f.length)) { return; }
        if (!open.length) { if (acc < bestCost) { bestCost = acc; best = pick.slice(); } return; }
        let lb = acc, k = 0;
        fits.forEach((f, m) => { lb += f[0].cost; if (f.length < fits[k].length) { k = m; } });
        for (const c of fits[k]) {
          if (lb - fits[k][0].cost + c.cost >= bestCost || nodes > maxNodes) { break; }
          pick.push([open[k], c]);
          dfs(open.filter((_, m) => m !== k), fits.filter((_, m) => m !== k).map((f) => f.filter((q) => !clash(c, q))), acc + c.cost);
          pick.pop();
        }
      };
      dfs(members, members.map((i) => cands[i]), 0);
      for (const [i, c] of best || greedy) { out[i] = { x: c.x, y: c.y }; }
    }
    return out;
  }

  // -- palette (dir-A 2.3, lib.mjs without NUDGE). mix: t = the share of a.
  const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(c01(v) * 255).toString(16).padStart(2, '0')).join('');
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const unit = (hex) => hexRgb(hex).map((v) => v / 255);
  function oklch(L, C, h) {
    const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return toHex([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((x) => (x = c01(x)) <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }
  function mix(a, b, t) { const A = unit(a), B = unit(b); return toHex(A.map((v, i) => v * t + B[i] * (1 - t))); }
  function luminance(hex) {
    const c = unit(hex).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  const PALETTES = new Map();
  // Hue (null: neutral) -> dot, name, nameDim (>= 4.5:1), coast, mid, high, edge, dotRgb, nameRgb.
  function paletteFor(hue) {
    const h = Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : null, sea = COLORS.sea;
    if (!PALETTES.has(h)) {
      const k = h === null ? 0 : 1, dot = oklch(0.78, 0.115 * k, h || 0), name = oklch(0.88, 0.075 * k, h || 0);
      let a = 0.55, nameDim = mix(name, sea, a);
      while (contrast(nameDim, sea) < 4.5 && a < 1) { a = Math.round(a * 100 + 1) / 100; nameDim = mix(name, sea, a); }
      PALETTES.set(h, fz({ hue: h, dot, name, nameDim, coast: mix(dot, sea, 0.12), mid: mix(dot, sea, 0.19), high: mix(dot, sea, 0.27), edge: mix(dot, sea, 0.42), dotRgb: hexRgb(dot), nameRgb: hexRgb(name) }));
    }
    return PALETTES.get(h);
  }
  const heatShare = (plays, max) => (plays > 0 && max > 0 ? 0.4 * Math.sqrt(Math.min(1, plays / max)) : 0);
  const meta = (row, k) => (row && isObj(row.metadata) && typeof row.metadata[k] === 'string' ? row.metadata[k].trim() : '');
  const songTitle = (row) => meta(row, 'title') || String((row && row.filepath) || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const songName = (row) => songTitle(row) + (meta(row, 'artist') ? ' · ' + meta(row, 'artist') : '');

  // -- the DJ trail (plan 4.5): history (this tab's session) plus the ring, newest first, peers dropped.
  function mergePlays(history, ring, sessionId) {
    const seen = new Set(), out = [], ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
    for (const [list, strict] of [[ring, false], [history, true]]) {
      for (const e of Array.isArray(list) ? list : []) {
        if (!isObj(e) || (sessionId && (strict || e.sessionId) && e.sessionId !== sessionId) || e.origin === 'peer' || e.peerId != null || e.federated || e.federation || e.peer) { continue; }
        const path = strip((isObj(e.track) && e.track.filepath) || e.filePath || e.filepath), start = ms(e.startedAt), end = ms(e.endedAt);
        const id = e.id != null ? String(e.id) : null, played = Number.isFinite(e.playedMs) ? e.playedMs : 0;
        if (!path || !Number.isFinite(start) || seen.has(id)) { continue; }
        if (id) { seen.add(id); }
        out.push({ id, path, startMs: start, endMs: Number.isFinite(end) ? end : start + played, playedMs: played, outcome: e.outcome || null, source: e.source || null });
      }
    }
    return out.sort((a, b) => b.startMs - a.startMs);
  }
  // Back from now playing: stop at a gap over 30 min or a play that was not an Auto DJ pick.
  function walkTrail(plays, o, visit) {
    const now = strip(o.nowPath);
    let prev = Number.isFinite(o.nowMs) ? o.nowMs : Infinity;
    for (const p of plays || []) {
      if (prev - p.endMs > (o.gapMs ?? TRAIL.gapMs)) { return; }
      prev = p.startMs;
      if (p.path !== now && ((o.djOnly !== false && p.source !== 'autodj') || visit(p) === false)) { return; }
    }
  }
  function trailRun(plays, opts) { const out = []; walkTrail(plays, opts || {}, (p) => { out.push(p.path); }); return out; }
  // Up to 6 picks, oldest first; idOf(path) null = no dot (skipped, not counted).
  function foldTrail(plays, opts) {
    const o = opts || {}, picks = [];
    walkTrail(plays, o, (p) => {
      const id = o.idOf ? o.idOf(p.path) : null;
      if (o.idOf && id == null) { return true; }
      picks.push({ path: p.path, id, quickSkip: p.outcome === 'skipped' && p.playedMs < TRAIL.quickSkipMs, startMs: p.startMs });
      return picks.length < (o.max || TRAIL.max);
    });
    return picks.reverse().map((t, i, a) => Object.assign(t, { alpha: a.length < 2 ? TRAIL.to : TRAIL.from + ((TRAIL.to - TRAIL.from) * i) / (a.length - 1) }));
  }

  // -- songs with no dot (plan 4.4.1)
  const pinIndex = (map, nowId) => (nowId == null ? -1 : findId(map, nowId));
  function pathStops(map, rows) {
    return (rows || []).map((r, k) => ({ num: k + 1, index: r && r.id != null ? findId(map, r.id) : -1, id: r && r.id })).filter((s) => s.index >= 0);
  }
  function followView(v, plate, map, idx, follow) {
    return follow && map && idx >= 0 && idx < map.n ? keepInView(v, plate, map.x[idx] / U16, map.y[idx] / U16, 0.6) : null;
  }

  // -- one highlight at a time (plan 4.4, section F). kind none | song | place | path | search; seq drops
  // stale answers; armed = a Sonic Path end pick. Actions: selectSong neighbours selectPlace placeMix path
  // searchQuery search searchBusy clear arm disarm follow userView resolved; a no-op returns the same object.
  function initHighlight() {
    return { kind: 'none', song: null, place: null, path: null, search: null, q: '', qSeq: 0, armed: null, follow: false, seq: 0 };
  }
  const NONE = { kind: 'none', song: null, place: null, path: null, search: null };
  const rowOf = (r) => (isObj(r) ? { id: typeof r.id === 'number' ? r.id : null, filepath: strip(r.filepath), metadata: isObj(r.metadata) ? r.metadata : null } : null);
  function reduceHighlight(s, a) {
    if (!a) { return s; }
    const seq = s.seq + 1, ans = isObj(a.answer) ? a.answer : null, ids = a.ids || [], idAt = (k) => (typeof ids[k] === 'number' ? ids[k] : null);
    const next = (o) => Object.assign({}, s, o), fresh = (o) => Object.assign({}, s, NONE, { seq, follow: false }, o);
    switch (a.type) {
      case 'selectSong': {
        const row = rowOf(a.song);
        return row && row.id !== null ? fresh({ kind: 'song', song: Object.assign(row, { neighbours: null, notAnalyzed: false }) }) : s;
      }
      case 'neighbours': {
        if (s.kind !== 'song' || a.seq !== s.seq || !ans) { return s; }
        const seed = rowOf(ans.seed) || {}, song = Object.assign({}, s.song, { notAnalyzed: ans.notAnalyzed === true });
        song.neighbours = (ans.neighbours || []).map(rowOf).filter((r) => r && r.id !== null);
        if (seed.id === song.id) { song.filepath = song.filepath || seed.filepath; song.metadata = song.metadata || seed.metadata; }
        return next({ song });
      }
      case 'selectPlace': {
        const r = a.region;
        return isObj(r) && typeof r.key === 'string' && r.label ? fresh({ kind: 'place', place: { key: r.key, label: r.label, level: r.level === 1 ? 1 : 0, answer: null } }) : s;
      }
      case 'placeMix': return s.kind === 'place' && a.seq === s.seq && ans ? next({ place: put(s.place, 'answer', ans) }) : s;
      case 'path': return fresh({ kind: 'path', path: { title: a.title || '', rows: (a.rows || []).map(rowOf).filter(Boolean) }, armed: null });
      case 'searchQuery': {
        const q = typeof a.q === 'string' && a.q.trim().length >= 2 ? a.q.trim() : '';
        if (!q && s.kind === 'search') { return fresh({ q: '', qSeq: seq, follow: s.follow }); }
        return q === s.q && s.qSeq === s.seq ? s : next({ q, qSeq: s.seq });
      }
      case 'search': {
        if (!s.q || a.q !== s.q || s.qSeq !== s.seq || !ans) { return s; }
        const hits = (ans.ids || []).filter((v) => typeof v === 'number');
        return fresh({ kind: 'search', search: { q: s.q, ids: hits, best: typeof ans.best === 'number' ? ans.best : null, capped: ans.capped === true }, qSeq: seq, follow: hits.length ? false : s.follow });
      }
      case 'clear': return s.kind === 'none' && !s.armed ? s : fresh({ armed: null, follow: s.follow });
      case 'arm': return rowOf(a.start) ? next({ armed: { start: rowOf(a.start) } }) : s;
      case 'disarm': return s.armed ? next({ armed: null }) : s;
      case 'follow': return !!a.on === s.follow ? s : next({ follow: !!a.on });
      case 'userView': return s.follow ? next({ follow: false }) : s;
      case 'resolved':
        if (a.kind === 'song' && s.kind === 'song') { return idAt(0) === null ? fresh({ follow: s.follow }) : next({ seq, song: Object.assign({}, s.song, { id: idAt(0), neighbours: null, notAnalyzed: false }) }); }
        return a.kind === 'path' && s.kind === 'path' ? next({ path: put(s.path, 'rows', s.path.rows.map((r, k) => put(r, 'id', idAt(k)))) }) : s;
      default: return s;
    }
  }
  // After a new rev: a song by id else filepath, a place by key, a path row by row.
  function reconcileHighlight(s, map) {
    const keep = { state: s, lookup: null }, look = (f) => ({ state: s, lookup: { kind: s.kind, filepaths: f } });
    const cleared = { state: Object.assign({}, s, NONE, { seq: s.seq + 1 }), lookup: null }, r = map && s.place && map.byKey.get(s.place.key);
    if (!map || s.kind === 'none' || s.kind === 'search') { return keep; }
    if (s.kind === 'song') { return findId(map, s.song.id) >= 0 ? keep : s.song.filepath ? look([s.song.filepath]) : cleared; }
    if (s.kind === 'path') { return look(s.path.rows.map((row) => row.filepath)); }
    if (!r || r.label === null) { return cleared; }
    return r.label === s.place.label && r.level === s.place.level ? keep : { state: put(s, 'place', Object.assign({}, s.place, { label: r.label, level: r.level })), lookup: null };
  }
  const trailVisible = (s, zoom) => (zoom ?? 1) <= TRAIL_MAX_ZOOM && s.kind === 'none' && !s.armed;
  // ctx {zoom, nowId, trail, mood} -> {skip (MARK per dot), dim (1 = dimmed) | null, dimAlpha, pin, selected,
  // lit [{index, id, num}], trail [{index, quickSkip, alpha}], province, town, rings}. prev lends its buffers.
  function deriveMarks(s, map, ctx, prev) {
    const c = ctx || {}, n = map ? map.n : 0, buf = (b) => (b && b.length === n ? b.fill(0) : new Uint8Array(n));
    const m = { n, skip: buf(prev && prev.skip), dim: null, dimAlpha: ALPHA.dim, pin: -1, selected: -1, lit: [], trail: [], province: -1, town: -1, rings: (c.zoom || 1) >= BAND_TOWNS };
    const mark = (i, code) => { if (i >= 0 && m.skip[i] < code) { m.skip[i] = code; } };
    const dimBy = (f) => { m.dim = buf(prev && prev.dim); for (let i = 0; i < n; i++) { m.dim[i] = f(i); } };
    const lit = (i, id, num) => { if (i >= 0 && i !== m.selected) { m.lit.push({ index: i, id, num }); mark(i, MARK.lit); } };
    if (!n) { return m; }
    if (trailVisible(s, c.zoom)) {
      for (const t of c.trail || []) { const i = findId(map, t.id); if (i >= 0) { m.trail.push({ index: i, quickSkip: !!t.quickSkip, alpha: t.alpha }); mark(i, MARK.trail); } }
    }
    if (s.kind === 'song' || s.kind === 'path' || (s.kind === 'search' && s.search.ids.length)) { dimBy(() => 1); }
    if (s.kind === 'song') {
      m.selected = findId(map, s.song.id);
      for (const r of s.song.neighbours || []) { lit(findId(map, r.id), r.id, null); }
      mark(m.selected, MARK.selected);
    } else if (s.kind === 'path') {
      for (const st of pathStops(map, s.path.rows)) { lit(st.index, st.id, st.num); }
    } else if (s.kind === 'search' && m.dim) {
      for (const id of s.search.ids) { const i = findId(map, id); if (i >= 0) { m.dim[i] = 0; } }
    } else if (s.kind === 'place') {
      const r = map.byKey.get(s.place.key), col = r && (r.level ? map.r1 : map.r0);
      if (r) { dimBy((i) => (col[i] === r.id ? 0 : 1)); m.dimAlpha = ALPHA.placeDim; m[r.level ? 'town' : 'province'] = r.id; }
    } else if (c.mood && c.mood.length === (n + 7) >> 3) {
      dimBy((i) => 1 - bitAt(c.mood, i));
    }
    mark(m.pin = pinIndex(map, c.nowId), MARK.pin);
    if (m.pin >= 0 && m.dim) { m.dim[m.pin] = 0; }
    return m;
  }
  function ringOf(m, map, i) {
    const k = m.skip[i];
    return !m.rings || !(map.flags[i] & 1) ? RING.none : k === MARK.lit ? RING.white : k ? RING.none : m.dim && m.dim[i] ? RING.dim : RING.normal;
  }

  // -- states (plan 4.6): each call returns a new state whose effects are what this event asks for.
  // status idle | loading | building | failed | empty | ready | disabled (sticky). Effects: fetchMap,
  // fetchOverlay {layer, seq}, schedule {at}, cancelSchedule, disable, resetView, reconcile, clearSelection,
  // hideHeat, hideFilters. s409[layer]: 0, 1 refetch then retry, 2 retried, 3 held; s404: 0, 1, 2 tried.
  const LAYERS = ['mood', 'plays'], ZERO = fz({ mood: 0, plays: 0 }), NO_OVERLAY = fz({ mood: null, plays: null });
  function initStates() {
    return { status: 'idle', map: null, rev: null, heat: true, filters: true, want: { mood: null, plays: false }, overlay: NO_OVERLAY, seq: ZERO, s409: ZERO, s404: 0, revalidateAt: null, effects: [] };
  }
  function reduceStates(prev, ev) {
    const st = Object.assign({}, prev, { effects: [] }), go = (d, o) => st.effects.push(Object.assign({ do: d }, o));
    if (!ev || st.status === 'disabled') { return st; }
    const L = ev.layer, a = ev.answer;
    const set = (k, v) => { st[k] = put(st[k], L, v); };
    const fetch = (k) => {
      if (st.status === 'ready' && st.map.n && (k === 'mood' ? st.want.mood && st.filters : st.want.plays && st.heat)) { go('fetchOverlay', { layer: k, seq: st.seq[k] }); }
    };
    const disable = () => { Object.assign(st, { status: 'disabled', map: null, overlay: NO_OVERLAY, revalidateAt: null }); go('disable'); return st; };
    const schedule = () => { st.revalidateAt = (ev.nowMs || 0) + REVALIDATE_MS; go('schedule', { at: st.revalidateAt }); };
    switch (ev.type) {
      case 'open': if (!st.map) { st.status = 'loading'; } go('fetchMap'); return st;
      case 'revalidate': go('fetchMap'); return st;
      case 'tick': if (st.status === 'building' && st.revalidateAt != null && ev.nowMs >= st.revalidateAt) { st.revalidateAt = null; go('fetchMap'); } return st;
      case 'close': st.revalidateAt = null; go('cancelSchedule'); return st;
      case 'notFound': st.s404 = st.s404 ? 2 : 1; go(st.s404 === 1 ? 'fetchMap' : 'clearSelection'); return st;
      case 'found': st.s404 = 0; return st;
      case 'userAction': return Object.assign(st, { s404: 0, s409: ZERO });
      case 'wantOverlay':
        if (!LAYERS.includes(L)) { return st; }
        set('want', L === 'plays' ? !!ev.on : isObj(ev.moods) && Object.keys(ev.moods).length ? ev.moods : null);
        set('overlay', null); set('seq', st.seq[L] + 1); set('s409', 0); fetch(L);
        return st;
      case 'overlayAnswer': {
        if (!LAYERS.includes(L) || ev.seq !== st.seq[L] || !st.map) { return st; }
        if (isObj(a) && a.disabled) {
          if (L === 'mood') { return disable(); }
          st.heat = false; set('want', false); set('overlay', null); go('hideHeat');
          return st;
        }
        if (isObj(a) && a.stale) {
          set('s409', st.s409[L] ? 3 : 1); set('overlay', null);
          if (st.s409[L] === 1) { go('fetchMap'); }
          return st;
        }
        const d = isObj(a) ? decodeOverlay(a, st.map) : {};
        if (d.reason === 'stale') { return st; }
        if (L === 'mood' && d.reason === 'noMoods') { st.filters = false; set('want', null); set('overlay', null); go('hideFilters'); return st; }
        set('overlay', d.layer !== L ? null : d.bits ? { bits: d.bits, moods: d.moods } : d.plays);
        return st;
      }
      case 'mapAnswer': {
        const had = st.map, retry = LAYERS.filter((k) => st.s409[k] === 1), after404 = st.s404 === 1;
        const done = (all) => {
          st.s409 = retry.length ? Object.assign({}, st.s409, ...retry.map((k) => ({ [k]: 2 }))) : ZERO;
          if (after404) { st.s404 = 2; go('clearSelection'); }
          if (st.status === 'ready') { for (const k of LAYERS) { if (all || retry.includes(k) || (!retry.length && !st.overlay[k])) { fetch(k); } } }
          return st;
        };
        if (isObj(a) && a.disabled) { return disable(); }
        if (!isObj(a)) { if (!had) { st.status = 'failed'; } return done(false); }
        if (a.notModified) { if (st.status === 'building') { schedule(); } return done(false); }
        if (a.state !== 'ready') {
          Object.assign(st, { status: a.state === 'building' || a.state === 'empty' ? a.state : 'failed', map: null, rev: a.rev ?? null, overlay: NO_OVERLAY, revalidateAt: null });
          if (st.status === 'building') { schedule(); }
          return done(false);
        }
        const d = had && a.rev === had.rev && (a.layout || {}).landFormat === 'land-v1' && (a.points || {}).format === 'cols-v1' ? null : decodeMap(a);
        if (!d) { return done(false); }
        if (!d.ok && d.reason === 'format') { return disable(); }
        Object.assign(st, d.ok ? { status: 'ready', map: d.map, rev: d.map.rev, overlay: NO_OVERLAY, revalidateAt: null } : { status: 'failed', map: null });
        if (d.ok && had && (had.layout.frame !== d.map.layout.frame || had.model.id !== d.map.model.id)) { go('resetView'); }
        if (d.ok && had) { go('reconcile'); }
        return done(true);
      }
      default: return st;
    }
  }

  // ==== CONTROLLER: the DOM and canvas half (plan 4.2 to 4.4, 4.7). Everything above is pure.
  // mount(host, deps) uses only deps (the contract above m.js mapPanel) and host.ownerDocument.defaultView's
  // globals; it returns {update(state), destroy()}. update({view, highlight}) sets either; it answers a snapshot.
  const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", TAU = 2 * Math.PI, HEAT = new Map();
  const SA = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const svg = (p, s = 18, a = SA) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" ${a} aria-hidden="true">${p}</svg>`;
  const P = (p) => `<path d="${p}"/>`, O = (r, a = '') => `<circle cx="12" cy="12" r="${r}"${a}/>`;
  const IC = {   // the boards' icons (A-W2, A-W4)
    follow: svg(O(7) + O(2.5, ' fill="currentColor" stroke="none"') + P('M12 2v3M12 19v3M2 12h3M19 12h3')), in: svg(P('M12 5v14M5 12h14')), out: svg(P('M5 12h14')),
    x: svg(P('M6 6l12 12M18 6L6 18')), chev: svg(P('M9 6l6 6-6 6')), play: svg(P('M7 5l12 7-12 7z'), 16, 'fill="currentColor"'),
    queue: svg(P('M6 6l6 6-6 6M13 6l6 6-6 6'), 16, SA.replace('"2"', '"2.5"')), dj: svg(O(9) + P('M12 12l5-4') + O(1.5), 16),
    path: svg(P('M6 3v9a3 3 0 0 0 6 0V9a3 3 0 0 1 6 0v12'), 16), save: svg(P('M5 3h11l3 3v15H5z') + P('M8 3v5h7V3M8 21v-7h8v7'), 16),
    glyph: svg(O(10, ' fill="none" stroke="#f5f7fa" stroke-width="3"') + O(4.4, ' fill="#f5f7fa"'), 12, 'class="mmap-card-glyph"'),
  };
  const heatCol = (p, q) => { const k = p.hue + ':' + q; if (!HEAT.has(k)) { HEAT.set(k, mix(p.name, p.dot, q)); } return HEAT.get(k); };
  const find = (box, key) => key && Array.from(box.querySelectorAll('[data-mm]')).find((n) => n.getAttribute('data-mm') === key);
  const rect = (e, p) => rectBox({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }, p);
  function mount(host, deps) {
    const d = deps, doc = host.ownerDocument, win = doc.defaultView, t = d.t, esc = (s) => d.escapeHtml(s == null ? '' : String(s)), al = (k) => ` aria-label="${esc(t(k))}"`;
    const btn = (cls, mm, inner, more = '') => `<button type="button" class="${cls}" data-mm="${mm}"${more}>${inner}</button>`;
    let st = initStates(), hl = initHighlight(), view = wholeMap(), drawn = view, plate = { w: 0, h: 0 }, dpr = 1, map = null, grid = null, marks = null, land = [], badges = [], trail = [];
    let hist = null, nowPath = strip(d.nowPlaying.path()), nowId = null, raf = 0, full = 1, lay = 1, moving = 0, ease = null, gone = 0, timer = 0, wt = 0, busy = 0, swallow = 0;
    let cardH = '', stateH = null, layH = null, opener = null, placeReq = null, tipId = null, img = null, rc = null, mq = null, drag = null;
    const rows = new Map(), ids = new Map(), pend = new Map(), ptrs = new Map(), root = doc.createElement('div');
    root.className = 'mmap mmap-plate';
    root.tabIndex = -1;
    root.innerHTML = `<canvas class="mmap-canvas" role="img"${al('map.label')}></canvas><div class="mmap-ctrls">${btn('mmap-ctrl', 'c:follow', IC.follow, ' aria-pressed="false"' + al('map.follow'))}`
      + `<div class="mmap-zoom" role="group"${al('map.zoom')}>${btn('', 'c:in', IC.in, al('map.zoomIn'))}<span class="mmap-zoom-div" aria-hidden="true"></span>${btn('', 'c:out', IC.out, al('map.zoomOut'))}</div></div>`
      + `${btn('mmap-chevron super-hide', 'c:pin', IC.chev)}<div class="mmap-layer"></div><div class="mmap-tip super-hide"></div><div></div><div class="mmap-state"></div><div class="dm-sr" role="status"></div>`;
    host.appendChild(root);
    const [cv, ctrls, chev, layer, tip, cardBox, stateBox, live] = Array.from(root.children), ctx = cv.getContext('2d'), cache = doc.createElement('canvas'), cc = cache.getContext('2d');
    const P2 = () => new win.Path2D(), keyOf = (el) => (el ? el.getAttribute('data-mm') : null), focus = (el) => el && el.focus({ preventScroll: true }), tf = () => viewTransform(view, plate);
    const xy = (i, T) => [(map.x[i] / U16) * T.s + T.tx, (map.y[i] / U16) * T.s + T.ty], inPlate = ([x, y]) => x >= 0 && y >= 0 && x <= plate.w && y <= plate.h;
    layer.style.transformOrigin = '0 0';

    // -- size and DPR (a ResizeObserver, a resolution query), a pause at 0 x 0, one rAF, eased moves
    function resize() {
      const w = root.clientWidth, h = root.clientHeight, r = win.devicePixelRatio || 1;
      if (w === plate.w && h === plate.h && r === dpr) { return; }
      plate = { w, h }; dpr = r;
      if (w && h) { for (const c of [cv, cache]) { c.width = Math.round(w * r); c.height = Math.round(h * r); } view = clampView(view, plate); redraw(1); }
    }
    function watchDpr() {
      if (mq) { mq.removeEventListener('change', watchDpr); resize(); }
      mq = win.matchMedia && win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
      if (mq) { mq.addEventListener('change', watchDpr); }
    }
    function redraw(f) { if (f) { full = lay = 1; } if (!raf && !gone) { raf = win.requestAnimationFrame(frame); } }
    function frame(ts) {
      raf = 0;
      if (gone || !plate.w || !plate.h) { return; }
      if (ease) {
        const k = Math.min(1, (ts - (ease.t0 = ease.t0 ?? ts)) / 300);
        view = k < 1 ? lerpView(ease.a, ease.b, k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) ** 2) : ease.b;
        if (k < 1) { redraw(); } else { ease = null; full = lay = 1; }
      }
      if (map && full && !moving) { draw(); }
      if (lay && !moving && !ease) { lay = 0; layout(); }
      compose();
    }
    const goTo = (v) => { if (v && plate.w) { if (d.reducedMotion()) { ease = null; view = v; redraw(1); } else { ease = { a: view, b: v }; redraw(); } } };

    // -- the cached layer: land (even-odd terraces), songs (a raster above 5,000 in view, else vectors), recent rings
    function draw() {
      full = 0; drawn = view;
      const T = tf(), s = T.s, c = cc, W = cache.width, H = cache.height, r = dotRadius(view.z), rr = r + SIZE.ringPad, heat = st.overlay.plays, v = visibleRect(view, plate), m = r / s;
      const list = [], groups = new Map(), rp = [0, P2(), P2()];
      marks = deriveMarks(hl, map, { zoom: view.z, nowId, trail, mood: st.overlay.mood && st.overlay.mood.bits }, marks);
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); c.setTransform(dpr * s, 0, 0, dpr * s, dpr * T.tx, dpr * T.ty); c.lineWidth = 1 / s;
      for (const k of [0, 1, 2]) {
        for (const l of land) {
          c.globalAlpha = marks.province < 0 || l.id === marks.province ? 1 : ALPHA.landDim; c.fillStyle = l.pal[['coast', 'mid', 'high'][k]]; c.fill(l.p[k], 'evenodd');
          if (!k) { c.strokeStyle = l.pal.edge; c.stroke(l.p[0]); }
        }
      }
      forEachInRect(grid, map, { x0: v.x0 - m, y0: v.y0 - m, x1: v.x1 + m, y1: v.y1 + m }, (i) => { if (!marks.skip[i]) { list.push(i); } });
      let max = 0;
      if (heat) { for (const i of list) { max = Math.max(max, heat[i]); } }
      const ras = useRaster(list.length), b = Math.max(1, Math.round(2 * dpr));
      if (ras && !(img && img.width === W && img.height === H)) { img = c.createImageData(W, H); rc = doc.createElement('canvas'); rc.width = W; rc.height = H; }
      const px = ras && new Uint32Array(img.data.buffer);
      if (px) { px.fill(0); }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const i of ras ? Uint32Array.from(list).sort() : list) {   // a raster in id order
        const n = heat ? heat[i] : 1, q = heat && n ? Math.round(heatShare(n, max) * 20) : 0, f = marks.dim && marks.dim[i] ? 1 : n ? 0 : 2, key = map.r0[i] * 32 + q * 3 + f;
        const x = (map.x[i] / U16) * s + T.tx, y = (map.y[i] / U16) * s + T.ty, ring = marks.rings ? rp[ringOf(marks, map, i)] : 0;
        let g = groups.get(key);
        if (!g) {   // one style per province, heat step (40 % x sqrt share, in twentieths) and dim / unplayed state
          const p = map.pal[map.r0[i]], col = q ? heatCol(p, q / 20) : p.dot, a = [ALPHA.dot, marks.dimAlpha, ALPHA.unplayed][f], [R, G, B] = hexRgb(col);
          groups.set(key, g = { col, a, p: ras ? null : P2(), u: ((Math.round(a * 255) << 24) | (B << 16) | (G << 8) | R) >>> 0 });
        }
        if (ras) {
          const x0 = Math.round(dpr * x - b / 2), y0 = Math.round(dpr * y - b / 2);
          for (let yy = Math.max(0, y0); yy < Math.min(H, y0 + b); yy++) { px.fill(g.u, yy * W + Math.max(0, x0), yy * W + Math.min(W, x0 + b)); }
        } else { g.p.moveTo(x + r, y); g.p.arc(x, y, r, 0, TAU); }
        if (ring) { ring.moveTo(x + rr, y); ring.arc(x, y, rr, 0, TAU); }   // RING.normal and RING.dim
      }
      if (px) { rc.getContext('2d').putImageData(img, 0, 0); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(rc, 0, 0); c.setTransform(dpr, 0, 0, dpr, 0, 0); }
      for (const g of px ? [] : groups.values()) { c.globalAlpha = g.a; c.fillStyle = g.col; c.fill(g.p); }
      c.lineWidth = 1; c.strokeStyle = COLORS.ring; c.globalAlpha = ALPHA.ring; c.stroke(rp[RING.normal]); c.globalAlpha = ALPHA.ringDim; c.stroke(rp[RING.dim]); c.globalAlpha = 1;
    }
    // -- every frame: the cached layer under the gesture's delta, then the province outline, trail, lit songs, reticle, pin, badges
    function compose() {
      const T = tf(), D = viewTransform(drawn, plate), k = T.s / D.s, ox = T.tx - D.tx * k, oy = T.ty - D.ty * k, c = ctx, K = COLORS;
      let off = null;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
      layer.style.transform = k === 1 && !ox && !oy ? '' : `matrix(${k},0,0,${k},${ox},${oy})`;
      if (map && marks) {
        const dot = ([x, y], r, fill, line, w, a) => { c.globalAlpha = a || 1; c.beginPath(); c.arc(x, y, r, 0, TAU); if (fill) { c.fillStyle = fill; c.fill(); } if (line) { c.lineWidth = w; c.strokeStyle = line; c.stroke(); } };
        const pr = land.find((l) => l.id === marks.province), pin = marks.pin >= 0 && xy(marks.pin, T);
        c.setTransform(k, 0, 0, k, dpr * ox, dpr * oy); c.drawImage(cache, 0, 0);
        if (pr) { c.setTransform(dpr * T.s, 0, 0, dpr * T.s, dpr * T.tx, dpr * T.ty); c.globalAlpha = ALPHA.coast; c.strokeStyle = K.lit; c.lineWidth = 2 / T.s; c.stroke(pr.p[0]); }
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (const m of marks.trail) { dot(xy(m.index, T), SIZE.trail, !m.quickSkip && K.pin, m.quickSkip && K.pin, SIZE.trailSkip, m.alpha); }
        for (const m of marks.lit) { const p = xy(m.index, T); dot(p, SIZE.lit, K.lit, K.sea, SIZE.litEdge); if (ringOf(marks, map, m.index) === RING.white) { dot(p, SIZE.litRing, 0, K.lit, 1); } }
        if (marks.selected >= 0) { const p = xy(marks.selected, T); dot(p, SIZE.reticleRing, 0, K.lit, 2); dot(p, SIZE.reticleDot, K.lit); }
        if (pin && !inPlate(pin)) { off = pin; } else if (pin) {   // the 16 x 23 teardrop, its halo and its hole
          const [x, y] = pin;
          dot(pin, SIZE.pinHalo, K.pin, 0, 0, ALPHA.pinHalo);
          c.globalAlpha = 1; c.beginPath(); c.moveTo(x, y); c.bezierCurveTo(x - 3, y - 6, x - 8, y - 10, x - 8, y - 15); c.arc(x, y - 15, 8, Math.PI, TAU); c.bezierCurveTo(x + 8, y - 10, x + 3, y - 6, x, y); c.closePath();
          c.fillStyle = K.pin; c.fill(); c.lineJoin = 'round'; c.lineWidth = 1.5; c.strokeStyle = K.sea; c.stroke(); dot([x, y - 15], 3, K.sea);
        }
        c.font = `700 10px ${SANS}`; c.textAlign = 'center';
        for (const b of badges) { const [x, y] = xy(b.index, T); dot([x + b.dx, y + b.dy], SIZE.badge, K.control); c.fillStyle = '#ffffff'; c.fillText(b.num, x + b.dx, y + b.dy + 3.6); }
        c.globalAlpha = 1;
      }
      if (!off && doc.activeElement === chev) { focus(root); }   // pressed, then hidden: the keyboard stays on the plate
      chev.classList.toggle('super-hide', !off);
      if (off) {   // the pin off screen: a chevron on the plate's edge pointing at it, kept clear of the controls and the card
        const ce = cardBox.firstElementChild, x = clamp(off[0], 22, plate.w - 22), under = ce && x + 16 > ce.offsetLeft && x - 16 < ce.offsetLeft + ce.offsetWidth;
        const y = clamp(off[1], x > plate.w - 70 ? ctrls.offsetTop + ctrls.offsetHeight + 22 : 22, under ? ce.offsetTop - 22 : plate.h - 22);
        chev.style.left = x - 16 + 'px'; chev.style.top = y - 16 + 'px'; chev.firstElementChild.style.transform = `rotate(${Math.atan2(off[1] - y, off[0] - x)}rad)`;
        chev.setAttribute('aria-label', t('map.goToNowPlaying', { title: d.nowPlaying.title() }));
      }
    }
    // -- the button layer: names (clear of the controls, card, pin, selection, trail, stops, badges and titles), lit songs, titles
    const measure = (s, c) => {
      const L = c ? c.level : null;
      ctx.font = L === 0 ? `700 ${c.size}px Jura, ${SANS}` : L ? `italic 500 12.5px ${SANS}` : `500 12px ${SANS}`;
      return ctx.measureText(s).width + (L === 0 ? 0.16 * c.size * s.length : 0);
    };
    function layout() {
      const was = doc.activeElement, key = was && layer.contains(was) ? keyOf(was) : null;
      let html = '';
      badges = [];
      if (map && marks && st.status === 'ready') {
        const T = tf(), B = { x: 0, y: 0, w: plate.w, h: plate.h }, R = hl.kind === 'song' ? hl.song.neighbours || [] : hl.kind === 'path' ? hl.path.rows : [], el = cardBox.firstElementChild;
        const row = (id) => R.find((r) => r.id === id) || rows.get(id) || {}, at = (i, r) => circleBox(...xy(i, T), r);
        const hard = [rect(ctrls, 4)].concat(el ? rect(el, 6) : [], marks.pin >= 0 ? pinBox(...xy(marks.pin, T)) : []), sel = marks.selected >= 0 ? [at(marks.selected, 12)] : [];
        const lits = marks.lit.map((l) => { const [x, y] = xy(l.index, T); return Object.assign({ x, y, text: songTitle(row(l.id)), ring: ringOf(marks, map, l.index) === RING.white }, l); }).filter((l) => inPlate([l.x, l.y]));
        if (hl.kind === 'path') { placeBadges(lits, { bounds: B, hard }).forEach((b, k) => { if (b) { badges.push({ index: lits[k].index, num: lits[k].num, dx: b.x - lits[k].x, dy: b.y - lits[k].y }); } }); }
        const items = hl.kind === 'song' ? lits.filter((l) => l.text) : [];
        const titles = placeTitles(items, hard.concat(sel), B, measure).map((p, k) => p && Object.assign(p, { id: items[k].id, text: items[k].text })).filter(Boolean);
        const obs = hard.concat(sel, marks.trail.map((m) => at(m.index, SIZE.trail + 1)), lits.map((l) => at(l.index, SIZE.lit + 1)), badges.map((b) => circleBox(xy(b.index, T)[0] + b.dx, xy(b.index, T)[1] + b.dy, SIZE.badge)), titles.map((p) => p.box));
        html = placeNames(nameCandidates(map, view, plate, regionStats(grid, map, visibleRect(view, plate)), hl.kind === 'place' ? hl.place.key : null), obs, B, measure).map((c) => {
          const r = map.byKey.get(c.key), dim = marks.province >= 0 && !c.selected && (r.level ? r.parent : r.id) !== marks.province;
          return btn('mmap-name mmap-name-' + (r.level ? 't' : 'p'), 'r:' + esc(c.key), esc(c.label), ` aria-pressed="${c.selected}" style="left:${c.x}px;top:${c.y}px;transform:translate(-50%,-50%);`
            + `${r.level ? '' : `font-size:${c.size}px;`}color:${c.selected ? COLORS.lit : dim ? r.pal.nameDim : r.pal.name}"`);
        }).join('') + lits.map((l) => btn('mmap-song', 's:' + l.id, '', ` aria-label="${esc(songName(row(l.id)))}" style="left:${l.x - 9}px;top:${l.y - 9}px;width:18px;height:18px"`)).join('')
          + titles.map((p) => btn('mmap-title', 't:' + p.id, esc(p.text), ` tabindex="-1" title="${esc(songName(row(p.id)))}" style="left:${p.x}px;top:${p.y - 10}px${p.side === 'left' ? ';transform:translateX(-100%)' : ''}"`)).join('');
      }
      if (html !== layH) { layer.innerHTML = layH = html; if (key) { focus(find(layer, key) || root); } }
    }

    // -- the card (A-W2's song card; A-W4's path card, which a place shares) and one highlight at a time
    function card() {
      const pill = (v, k, icon, pri) => btn('mmap-pill' + (pri ? ' mmap-pill-pri' : ''), 'v:' + v, icon + esc(t(k))), s = hl.song, play = pill('play', 'map.play', IC.play, 1);
      const box = (cls, name, title, sub, glyph, verbs) => `<div class="mmap-card mmap-card-${cls}" role="group" aria-label="${esc(name)}"><div class="mmap-card-head"><div class="mmap-card-text"><div class="mmap-card-line">${glyph}`
        + `<span class="mmap-card-title">${esc(title)}</span></div>${sub ? `<div class="mmap-card-sub">${esc(sub)}</div>` : ''}</div>${btn('mmap-close', 'x:', IC.x, al('modal.close'))}</div><div class="mmap-verbs">${verbs}</div></div>`;
      const all = play + pill('all', 'map.queueAll', IC.queue) + pill('save', 'map.saveAsPlaylist', IC.save);
      return hl.kind === 'song' && s.filepath ? box('song', songTitle(s), songTitle(s), meta(s, 'artist') || meta(s, 'album'), IC.glyph, play + pill('queue', 'map.queue', IC.queue) + pill('dj', 'map.autoDj', IC.dj)
        + pill('path', 'map.sonicPath', IC.path) + btn('mmap-pill mmap-pill-icon pop-f', 'v:menu', d.verbs.songMenuGlyph, ` data-file_location="${esc(s.filepath)}"${al('map.songMenu')}`))
        : hl.kind === 'place' ? box('place', hl.place.label, hl.place.label, '', '', all + pill('dj', 'map.autoDj', IC.dj)) : hl.kind === 'path' ? box('path', t('map.sonicPath'), hl.path.title, '', '', all) : '';
    }
    function show(first) {   // the card and Follow after a highlight change; first: a card the user opened (focus to its first verb)
      const html = card(), changed = html !== cardH, key = changed && cardBox.contains(doc.activeElement) ? keyOf(doc.activeElement) : null;
      ctrls.firstElementChild.setAttribute('aria-pressed', hl.follow);
      if (changed) { cardBox.innerHTML = cardH = html; }
      focus(first ? cardBox.querySelector('.mmap-verbs button') : key && (find(cardBox, key) || root));
      redraw(1);
    }
    function apply(a, first) {
      const prev = hl;
      hl = reduceHighlight(hl, a);
      if (hl !== prev) { show(first); }
      return hl !== prev;
    }
    function clear() {   // the sea, Esc or the card's ×: focus back to the opener (a key, or the search field), else the plate
      const back = opener !== null || cardBox.contains(doc.activeElement), o = typeof opener === 'string' ? find(root, opener) : opener;
      opener = null;
      if (hl.armed && d.capture.mine()) { d.capture.cancel(); }
      apply({ type: 'clear' });
      if (back) { focus(o); if (!o || doc.activeElement !== o) { focus(root); } }
    }
    const say = (s) => { live.textContent = s; };
    const ok = (a, seq) => !!a && !gone && hl.seq === seq && (dispatch({ type: a.notFound ? 'notFound' : 'found' }), !a.notFound);
    const remember = (r) => { if (r && typeof r.id === 'number') { rows.delete(r.id); rows.set(r.id, r); if (rows.size > 500) { rows.delete(rows.keys().next().value); } } return r; };
    function rowById(id) {   // the tooltip's and the card's row: an LRU of 500, else POST /map/tracks {ids}; null: no such song, undefined: no answer
      if (rows.has(id)) { return Promise.resolve(remember(rows.get(id))); }
      if (!pend.has(id)) { pend.set(id, d.api.tracks({ ids: [id] }).then((a) => { pend.delete(id); return a && Array.isArray(a.tracks) ? remember(a.tracks[0]) || null : undefined; })); }
      return pend.get(id);
    }
    async function lookup(paths) {   // filepaths -> representative ids (null: no dot), kept until the map changes
      const p = paths.slice(0, 500), a = await d.api.tracks({ filepaths: p });
      if (a && Array.isArray(a.ids)) { p.forEach((f, k) => ids.set(f, typeof a.ids[k] === 'number' ? a.ids[k] : null)); }
    }
    function frameOn(idx, min) {
      const b = boundsOf(map, idx), c = cardBox.firstElementChild;
      if (b) { goTo(fitBounds(plate, b, { min, max: 6, inset: { right: 64, bottom: c ? c.offsetHeight + 12 : 0 } })); }
    }
    async function pickSong(id, el) {   // a dot, a lit song, a title or search's best; an armed pick takes it first
      const row = map && (await rowById(id));
      if (gone || !map) { return; }
      if (d.capture.armed()) { if (row) { d.capture.answer(row); } return; }
      if (!row) { if (row === null) { dispatch({ type: 'notFound' }); } return; }   // no answer (a network blip): the tap is dropped
      opener = el && !root.contains(el) ? el : keyOf(el); apply({ type: 'selectSong', song: row }, 1); say(songName(row)); neighbours();
    }
    async function neighbours() {   // the card's 8 lit, named neighbours, framed between zoom 1.8 and 6
      const seq = hl.seq, id = hl.song.id, a = await d.api.neighbours(id);
      if (!ok(a, seq)) { return; }
      [a.seed].concat(a.neighbours || []).forEach(remember);
      apply({ type: 'neighbours', seq, answer: a });
      frameOn([id].concat(hl.song.neighbours.map((r) => r.id)).map((i) => findId(map, i)), BAND_TOWNS);
    }
    async function pickPlace(key, el) {   // the place card; its anchor eases clear of the card
      const r = map && map.byKey.get(key), T = tf();
      if (!r || !r.label) { return; }
      if (hl.kind === 'place' && hl.place.key === key) { clear(); return; }
      opener = keyOf(el); apply({ type: 'selectPlace', region: r }, 1); say(r.label);
      const seq = hl.seq, c = cardBox.firstElementChild, ay = r.ay * T.s + T.ty;
      if (c && overlaps(circleBox(r.ax * T.s + T.tx, ay, 12), rect(c, 6))) { goTo(panBy(view, plate, 0, c.offsetTop - 30 - ay)); }
      mix(key, seq);
    }
    async function mix(key, seq) {   // the place's mix (POST /map/region); a verb asks again when the answer failed
      const a = await (placeReq = d.api.region(key));
      if (ok(a, seq)) { [a.centre].concat(a.songs || []).forEach(remember); apply({ type: 'placeMix', seq, answer: a }); }
      return a;
    }
    async function onPath(res) {   // the map's own Sonic Path pick, answered: numbered stops, framed, the path card
      const list = ((res && res.rows) || []).filter((r) => r && r.filepath).slice(0, 500), a = list.length ? await d.api.tracks({ filepaths: list.map((r) => r.filepath) }) : null;
      if (gone) { return; }
      if (!res) { apply({ type: 'disarm' }); return; }
      const title = t('map.pathTitle', { start: songTitle(res.start), end: songTitle(res.end) });
      opener = null;
      apply({ type: 'path', title, rows: list.map((r, k) => Object.assign({}, r, { id: a && a.ids && typeof a.ids[k] === 'number' ? a.ids[k] : null })) }, 1);
      say(title);
      if (map) { frameOn(pathStops(map, hl.path.rows).map((p) => p.index), 1); }
    }
    async function verb(v, el) {   // place and path verbs fetch the mix first, then make one synchronous call
      const s = hl.kind === 'song' && hl.song, seq = hl.seq;
      if (v === 'menu') { d.verbs.songMenu(el); } else if (s && v === 'path') { apply({ type: 'arm', start: s }); d.verbs.sonicPath(s, { onPath, onCancel: () => apply({ type: 'disarm' }) }); }
      else if (s) { d.verbs[{ play: 'play', queue: 'queue', dj: 'autoDj' }[v]](s); } else if (hl.kind === 'path' || hl.kind === 'place') {
        let a = hl.kind === 'path' ? { songs: hl.path.rows } : hl.place.answer || (await placeReq);
        if (!(a && a.songs) && hl.kind === 'place' && hl.seq === seq) { a = await mix(hl.place.key, seq); }
        if (a && a.songs && !gone && hl.seq === seq) { if (v === 'dj') { d.verbs.autoDj(a.centre); } else { d.verbs[{ play: 'playAll', all: 'queueAll', save: 'saveAsPlaylist' }[v]](a.songs); } }
      }
    }
    async function ask(q) { const a = await d.api.search(q); return !gone && !!a && !a.busy && apply({ type: 'search', q, answer: a }); }
    async function search(q, enter) {   // the head's field: debounced 300 ms by m.js; Enter selects best (or answers an armed pick), the field its opener
      const from = enter ? doc.activeElement : null;
      apply({ type: 'searchQuery', q });
      const s = hl.q, has = () => hl.kind === 'search' && hl.search.q === s;
      if (s && !has() && (await ask(s)) && hl.search.ids.length && hl.search.ids.length <= 2000) { frameOn(hl.search.ids.map((id) => findId(map, id)), 1); }
      if (enter && s && has() && hl.search.best !== null) { pickSong(hl.search.best, from); }
    }
    const userView = () => { ease = null; apply({ type: 'userView' }); };
    const followNow = () => { const v = map && followView(view, plate, map, pinIndex(map, nowId), hl.follow); if (v && v !== view) { goTo(v); } };
    function control(v) {
      if (v === 'follow') { apply({ type: 'follow', on: !hl.follow }); followNow(); }
      else if (v === 'in' || v === 'out') { userView(); view = zoomAt(view, plate, v === 'in' ? 1.5 : 1 / 1.5, plate.w / 2, plate.h / 2); redraw(1); }
      else if (v === 'pin' && marks && marks.pin >= 0) { goTo(centreOn(view, plate, map.x[marks.pin] / U16, map.y[marks.pin] / U16)); }
      else if (v === 'retry') { dispatch({ type: 'userAction' }); dispatch({ type: 'revalidate' }); }
    }

    // -- now playing (the pin, Follow) and the DJ trail (plan 4.5): history once per open, a re-fold per song
    async function onNow(path) {
      nowPath = strip(path);
      if (nowPath && map && !ids.has(nowPath)) { await lookup([nowPath]); }
      if (gone) { return; }
      nowId = map && nowPath ? ids.get(nowPath) ?? null : null;
      redraw(1); followNow(); refreshTrail();
    }
    async function refreshTrail() {
      // the 30-minute gap counts back from now playing's start (its elapsed or paused time is no gap)
      const plays = mergePlays(hist, d.trail.recentPlays(), d.trail.sessionId()), o = { nowPath, nowMs: d.nowPlaying.startedAt() || Date.now() }, need = trailRun(plays, o).filter((p) => !ids.has(p));
      if (map && need.length) { await lookup(need); }
      if (map && !gone) { trail = foldTrail(plays, Object.assign(o, { idOf: (p) => ids.get(p) ?? null })); redraw(1); }
    }

    // -- states (plan 4.6): reduceStates, then the effects it asks for
    function dispatch(ev) {
      if (gone) { return; }
      st = reduceStates(st, ev);
      if (st.map !== map) {
        map = st.map; grid = map && buildGrid(map); marks = null; ids.clear();
        land = map ? map.regions.filter((r) => r.land).map((r) => ({ id: r.id, pal: r.pal, p: r.land.map((rings) => traceRings(P2(), rings, 1 / U16)) })) : [];
        if (map) { onNow(nowPath); } else { apply({ type: 'clear' }); }
      }
      for (const e of st.effects) { effect(e); }
      const s = st.status, html = s === 'building' || s === 'loading' ? d.spinnerHtml : s === 'empty' ? `<div class="mmap-line">${esc(t('map.empty'))}</div>`
        : s === 'failed' ? `<div class="mmap-line">${esc(t('map.failed'))}</div>${btn('mmap-pill', 'c:retry', esc(t('dpage.verb.tryAgain')))}` : '';
      const a = doc.activeElement, lost = (html !== stateH && stateBox.contains(a)) || (ctrls.contains(a) && !(map && map.n));   // Try again (or a control) gone
      if (html !== stateH) { stateBox.innerHTML = stateH = html; stateBox.classList.toggle('super-hide', !html); }
      ctrls.classList.toggle('super-hide', !map || !map.n);
      if (lost) { focus(root); }
      redraw(1);
    }
    function effect(e) {
      const go = (ev) => dispatch(Object.assign({ nowMs: Date.now() }, ev)), x = e.do;
      if (x === 'fetchMap') {   // one GET /map at a time (the HTTP cache revalidates it); once more when asked meanwhile
        if (busy) { busy = 2; return; }
        busy = 1;
        d.api.map().then((a) => { const again = busy > 1; busy = 0; go({ type: 'mapAnswer', answer: a }); if (again) { effect(e); } });
      } else if (x === 'fetchOverlay') {
        d.api.overlay(e.layer, st.rev, e.layer === 'mood' ? st.want.mood : null).then((a) => go({ type: 'overlayAnswer', layer: e.layer, seq: e.seq, answer: a }));
      } else if (x === 'schedule' || x === 'cancelSchedule') {
        win.clearTimeout(timer);
        if (x === 'schedule') { timer = win.setTimeout(() => { if (d.visible.now()) { go({ type: 'tick' }); } }, Math.max(0, e.at - Date.now()) + 5); }
      } else if (x === 'reconcile') {   // a new rev: the song by its dot, else its filepath; the place by key; the path row by row
        const r = reconcileHighlight(hl, map);
        hl = r.state; show();
        if (r.lookup) { d.api.tracks({ filepaths: r.lookup.filepaths.slice(0, 500) }).then((a) => { if (a && apply({ type: 'resolved', kind: r.lookup.kind, ids: a.ids || [] }) && hl.kind === 'song') { neighbours(); } }); }
        else if (hl.kind === 'search') { ask(hl.q); }
      } else if (x === 'resetView') { ease = null; view = wholeMap(); }
      else if (x === 'clearSelection') { clear(); }
      else { ({ disable: d.disable, hideHeat: d.head.hidePlaysHeat, hideFilters: () => d.head.showFilters(false) })[x](); }
    }

    // -- input: drag pans, two pointers pinch, a tap selects within 8 px (22 by touch), the wheel zooms (on the sea
    // or a name); keys; the tooltip on a dot or a lit song's button (hover, focus)
    const pos = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    const hideTip = () => { tipId = null; tip.classList.add('super-hide'); };
    const near = (p, px, okI) => { const m = toMap(view, plate, p.x, p.y); return nearest(grid, map, m[0], m[1], px / tf().s, okI); };
    const sea = (el) => !(el && el.closest && el.closest('.mmap-card, .mmap-ctrls, .mmap-chevron, .mmap-state'));   // the drawing or a name on it
    const grab = (e) => { try { cv.setPointerCapture(e.pointerId); } catch (_e) { /* not a live pointer */ } };
    function hover(p, el) {   // the canvas: a dot from zoom 1.8, a lit one or a search hit; a lit song's button: its song
      const s = el !== cv && el && el.closest ? el.closest('.mmap-song') : null, lit = (j) => marks.skip[j] >= MARK.lit || (hl.kind === 'search' && !!marks.dim && !marks.dim[j]);
      const i = !map || !marks || moving || ease ? -1 : s ? findId(map, Number(keyOf(s).slice(2))) : el === cv ? near(p, SIZE.hitMouse, (j) => view.z >= BAND_TOWNS || lit(j)) : -1, id = i >= 0 ? map.ids[i] : null;
      cv.style.cursor = id === null ? '' : 'pointer';
      if (id === null) { hideTip(); return; }
      tipId = id;
      rowById(id).then((r) => {
        if (tipId !== id || !r || gone) { return; }
        const [x, y] = xy(i, tf());
        tip.textContent = songName(r); tip.classList.remove('super-hide');
        tip.style.left = Math.max(4, Math.min(x + 12, plate.w - tip.offsetWidth - 4)) + 'px'; tip.style.top = Math.max(4, y - 32) + 'px';
      });
    }
    function onDown(e) {   // a press on a name is the map's once it moves (until then, the name's click)
      swallow = 0;
      if (e.button > 0 || !map || !sea(e.target)) { return; }
      if (e.target === cv) { grab(e); }
      ptrs.set(e.pointerId, pos(e)); ease = null; hideTip();
      drag = { v: view, at: new Map(ptrs), moved: ptrs.size > 1, touch: e.pointerType !== 'mouse', cv: e.target === cv };
    }
    function onMove(e) {
      if (!ptrs.has(e.pointerId)) { if (!e.buttons) { hover(pos(e), e.target); } return; }
      ptrs.set(e.pointerId, pos(e));
      const [a, b] = Array.from(ptrs.values()), [a0, b0] = Array.from(drag.at.values()), mid = (u, w) => (w ? { x: (u.x + w.x) / 2, y: (u.y + w.y) / 2 } : u), m = mid(a, b), m0 = mid(a0, b0);
      if (!drag.moved && Math.hypot(a.x - a0.x, a.y - a0.y) < 4) { return; }
      if (!drag.moved) { drag.moved = true; userView(); grab(e); }
      view = panBy(drag.v, plate, m.x - m0.x, m.y - m0.y);
      if (b && b0) { view = zoomAt(view, plate, Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, Math.hypot(a0.x - b0.x, a0.y - b0.y)), m.x, m.y); }
      moving = 1; redraw();
    }
    function onUp(e) {
      if (!ptrs.delete(e.pointerId)) { return; }
      const was = drag;
      drag = ptrs.size ? { v: view, at: new Map(ptrs), moved: true } : null;
      if (drag) { return; }
      const i = !was.moved && was.cv && e.type === 'pointerup' ? near(pos(e), was.touch ? SIZE.hitTouch : SIZE.hitMouse) : -2;
      if (i >= 0) { pickSong(map.ids[i], null); } else if (i === -1 && (hl.kind !== 'none' || hl.armed)) { clear(); }
      swallow = was.moved && !was.cv ? 1 : 0;   // a drag from a name: not the name's click
      if (moving) { moving = 0; redraw(1); }
    }
    function onWheel(e) {   // zoom about the cursor; ctrl+wheel is the page zoom and Chromium's trackpad pinch
      if (!map || !sea(e.target)) { return; }
      e.preventDefault(); hideTip(); userView();
      const p = pos(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      view = zoomAt(view, plate, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y); moving = 1; redraw();
      win.clearTimeout(wt); wt = win.setTimeout(() => { moving = 0; redraw(1); }, 160);
    }
    function onKey(e) {   // + = - zoom (x 1.5), the arrows pan 10 %, Esc clears: stopped here, the player's hotkeys (vp.js) get the rest
      const k = e.key, f = k === '+' || k === '=' ? 1.5 : k === '-' ? 1 / 1.5 : 0, dir = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k], own = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === 'Escape' && (hl.kind !== 'none' || hl.armed)) { own(); clear(); return; }
      if (!map || e.ctrlKey || e.metaKey || e.altKey || (!f && !dir)) { return; }
      own(); userView();
      view = f ? zoomAt(view, plate, f, plate.w / 2, plate.h / 2) : panBy(view, plate, dir[0] * 0.1 * plate.w, dir[1] * 0.1 * plate.h); redraw(1);
    }
    root.addEventListener('click', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-mm]') : null, k = keyOf(el) || '', v = k.slice(2);
      if (swallow && e.detail) { swallow = 0; return; }
      if (!el || !root.contains(el)) { return; }
      if (k[0] === 'c') { control(v); } else if (k[0] === 'r') { pickPlace(v, el); } else if (k[0] === 's' || k[0] === 't') { pickSong(Number(v), el); } else if (k[0] === 'v') { verb(v, el); } else if (k[0] === 'x') { clear(); }
    });
    root.addEventListener('keydown', onKey);
    for (const [ev, fn] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['pointerleave', hideTip], ['wheel', onWheel],
      ['focusin', (e) => hover(null, e.target)], ['focusout', hideTip]]) { root.addEventListener(ev, fn, { passive: false }); }
    const want = (ev) => { dispatch({ type: 'userAction' }); dispatch(ev); };
    const subs = [d.head.onSearch((q) => search(q)), d.head.onSearchEnter((q) => search(q, 1)), d.head.onPlaysHeat((on) => want({ type: 'wantOverlay', layer: 'plays', on })),
      d.moods.subscribe((m) => want({ type: 'wantOverlay', layer: 'mood', moods: m })), d.nowPlaying.subscribe(onNow), d.visible.subscribe(() => dispatch({ type: 'revalidate' }))];
    const ro = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
    if (ro) { ro.observe(root); }
    watchDpr(); resize();
    if (doc.fonts && doc.fonts.load) { doc.fonts.load('700 13px Jura').then(() => redraw(1), () => {}); }
    if (d.moods.available()) { dispatch({ type: 'wantOverlay', layer: 'mood', moods: d.moods.filter() }); }
    dispatch({ type: 'open' });
    d.trail.history().then((a) => { hist = a && Array.isArray(a.items) ? a.items : null; refreshTrail(); });
    return {
      update(s) {
        if (s && s.view) { ease = null; view = clampView(s.view, plate); redraw(1); }
        if (s && s.highlight) { apply(s.highlight); }
        return { states: st, view, highlight: hl, marks };
      },
      destroy() {
        if (gone) { return; }
        gone = 1; win.cancelAnimationFrame(raf); win.clearTimeout(timer); win.clearTimeout(wt);
        if (ro) { ro.disconnect(); }
        if (mq) { mq.removeEventListener('change', watchDpr); }
        for (const u of subs) { if (typeof u === 'function') { u(); } }
        root.remove();
      },
    };
  }
  // ==== end of the controller

  return {
    ZOOM_MIN, ZOOM_MAX, BAND_TOWNS, BAND_DEEP, TRAIL_MAX_ZOOM, RASTER_ABOVE, VISIBLE_PART_MIN, REVALIDATE_MS, DOT_R, TRAIL, COLORS, ALPHA, SIZE, MARK, RING,
    b64ToBytes, decodePoints, decodeLand, traceRings, decodeBitset, bitAt, decodePlays, findId, decodeMap, decodeOverlay,
    baseScale, wholeMap, viewTransform, toMap, clampView, zoomAt, panBy, visibleRect, fitBounds, boundsOf, lerpView, centreOn, keepInView,
    bandOf, dotRadius, useRaster, buildGrid, nearest, forEachInRect, countInRect, regionStats,
    boxOf, overlaps, circleBox, rectBox, pinBox, nameCandidates, placeNames, placeTitles, placeBadges,
    oklch, mix, contrast, hexRgb, paletteFor, heatShare, songTitle, songName, mergePlays, trailRun, foldTrail, pinIndex, pathStops, followView,
    initHighlight, reduceHighlight, reconcileHighlight, trailVisible, deriveMarks, ringOf, initStates, reduceStates, mount,
  };
}));
