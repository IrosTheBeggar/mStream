# Music Map (Atlas): build plan

AudioMuse idea #5, Atlas direction. Final plan, 2026-11-02: the planner draft revised against three critiques (code truth, completeness, robustness and performance). §9 lists every change and every rejection. Nothing is implemented and no repository was changed.

**Paths.** Bare paths are relative to **W** = mStream `feat/music-map` at `94a45562` (v6.32.3). `S/` = `scratchpad/map`. `phone/…` = `S/phone` (mstream_music master 7fee2a85). `player/…` = `S/player` (mstream-terminal-player v0.15.1, 2659e27). Citations that came from a reader file say so (`S/plan/read-*.md §n`); every other `path:line` was re-read for this plan.

**Master moved after the branch was cut.** `origin/master` is now `54647827`: flow-order (#1112) merged on 2026-11-02. Phase 1 starts by rebasing `feat/music-map` onto it.
- Schema versions are unchanged there (mstream 80, discovery 4).
- Anchors the merge shifts: `src/server.js:640` → `:641`; `docs/openapi.yaml` `:2068` → `:2095`, `:3074` → `:3345`, `:5748` → `:6019`, `MoodFilter` `:1097` → `:1109`, `Unauthorized` `:1585` → `:1597`. Every other citation here is unaffected.
- It brings two helpers this plan reuses: `resolveFlowTracks(filepaths, user)` (`src/api/db.js`, right after `pullMetaDataBatch`) and `createConcurrencyGate` (`src/util/concurrency-gate.js`).

**House rules this plan is built around.** Commit and push only when the user asks. New webapp strings go in `webapp/locales/en.json` only. UI text stays minimal (no hints, counts or annotations). Never run `dart format` on the phone repo. The server ships first, because every client depends on it.

**Settled before this plan (not reopened).** Direction Atlas. Mood Compass's `moodTarget` and the mood lens are not in v1; the lens switch is v2. v1 scope = `S/connections.md` §D as corrected by `S/spec-fixes.md` and §F. Layout defaults = what the Atlas boards draw. Local library only: the map is hidden on peer views.

---

## 0. In one page

- **What ships in v1:** the Atlas sound map on all three clients, for the local library only.
  - Land and provinces come from generated genres; towns come from styles.
  - Selecting a song lights its 8 named neighbours.
  - Search flies to songs, artists and albums.
  - A tapped place gives Play / Queue all / Save / Auto DJ from here.
  - A Sonic path shows as numbered stops with no line.
  - Now playing is a pin, with Follow and the DJ trail.
  - Recent rings, mood-filter dims and a plays-heat toggle.
- **The server does all the geometry.**
  - A new forked worker, `src/db/map-layout.mjs` (role `map`), turns the embeddings into a layout: PCA-50, then UMAP (umap-js 1.4.0, exact pin) on at most nFitMax songs (a cap derived from the machine's memory), then kNN placement of the rest against that fit set.
  - It builds regions, keys, hues, place mixes and land rings.
  - It writes three map tables in discovery.db. They sit **beside** the versioned schema, not in a migration, so a rollback costs only the map (§3.2.1).
  - It writes a **double-buffered** per-track mirror in mstream.db V81: `track_map`, keyed by `(layout_id, track_id)`, plus a one-row `track_map_meta` pointer. A new generation is written in ≤ 2,000-row transactions and switched on by one tiny transaction (§3.2.2).
- **Six routes in `src/api/discovery-map.js`, plus one admin route.**
  - `GET /api/v1/discovery/map`: base64 binary columns, strong ETag.
  - `GET …/map/overlay`: a mood bitset or plays bytes.
  - `POST …/map/tracks`: ids ↔ filepaths.
  - `POST …/map/search`.
  - `POST …/map/region`: centre plus a mix.
  - `POST …/map/neighbours`.
  - The admin route is `POST /api/v1/admin/discovery/map/rebuild`.
  - The flag is `discoveryMap: 1`, on `/api/` features and on ping.
- **Phases.**
  1. Server: mStream PR 1.
  2. Webapp: mStream PR 2, stacked on PR 1.
  3. Phone: mstream_music PR.
  4. Terminal: a player PR, then a player release and the mStream pin bump.
- **Schema versions are free.** mstream V81 collides with nothing: master and every open branch are at 80. discovery.db stays at V4. Expected conflicts are textual only (§3.2.3).

---

## 1. Scope

### 1.1 Atlas v1

This is `S/connections.md` §D v1 scope as corrected by `S/spec-fixes.md` and §F, with Mood Compass removed.

1. **The sound map.** One layout per library, built from the active model's embeddings.
   - UMAP on PCA-50, started from PCA-2. Libraries under 50 songs use PCA-2 only.
   - Rotated near-square and flipped by a data-anchored rule.
   - Near-duplicates (cos ≥ 0.99) are collapsed into one dot.
   - Coloured by generated-genre province. Shaded land comes in three terraces plus a coast.
   - Two name levels: provinces (genre) at overview, towns (style) from zoom 1.8.
2. **Now playing.** A pin with an off-screen marker and Follow.
   - **The DJ trail** is the 6 picks before now playing, at whole-map zoom only, with quick skips hollow (§F Atlas).
   - It comes from each client's own local play record (§4.5, §5, §6). That replaces spec-fixes §9's server history, which the phone cannot serve because it posts no `sessionId` (`S/plan/read-clients.md` finding 3).
3. **Select a song.** A card with Play, Queue, Auto DJ, Sonic Path and the song menu. Its 8 neighbours are lit and named on the map (§F Atlas).
4. **Search to fly.** Title, artist and album matches light up, the rest dims, and the view frames them. Enter selects the best title match.
5. **Region tap.** Tapping a province or town name opens a place card: Play (replace the queue and start), Queue all, Save as playlist, and Auto DJ from here.
   - Auto DJ seeds on the place's single most central visible song (spec-fixes §5).
6. **Sonic path from map picks.** "Sonic Path" on the song card arms the end pick; the next dot answers it.
   - The stops are lit and numbered with badges at every zoom, with **no line** (A-W4).
   - A path card offers Play / Queue all / Save.
7. **Mood-filter dims** come from a server-evaluated mask, so they match `src/api/mood-filter.js` exactly.
   - **Recent rings** show from zoom 1.8 (spec-fixes §2; §F).
   - **A plays-heat toggle:** dot opacity only; the land is unchanged (§1.3).
8. **Local library only.** The map is hidden on peer views and never on the federation allowlist.

### 1.2 v2 and later

- **v2:**
  - free lasso (web, phone) and box select (terminal). This is settled by §D, not a user decision: the region route takes no polygon, and v2 can add it with no server change (a client-side 2-D walk plus the existing lookup);
  - the lens switch, Mood Compass's `moodTarget` and the mood lens;
  - the DJ pool, drift steering and the multi-path Auto DJ anchor;
  - less-like-this halos (after PR #1108);
  - playlists and Discover seeds on the map;
  - network ghosts;
  - artist names at the deepest zoom;
  - skips and rating overlays;
  - land per visibility set (restricted users);
  - plays-weighted land (re-terracing);
  - an offline map on the phone (in v1 the phone's disk cache saves bandwidth only, §5);
  - an admin "Rebuild map" button;
  - umap-js memory work (a CSR port);
  - a coarse IVF index for Pi placement;
  - a WebGL renderer.
- **Later:**
  - federation satellites;
  - the key wheel and the genre ring;
  - tiles (only above 200–500k tracks);
  - a fixed learned projection (the only way two servers could share one map).

### 1.3 Defaults taken for the open layout questions (not reopened)

| Question | Default | Evidence |
|---|---|---|
| Web placement | The map sits in the page beside the Now Playing column, in `#browser`, with Now Playing in `#playlist`. While the map is open at ≥1200 px, `body.map-open` sets the board's split, 56.7 % / 43.3 % (680/520 at 1440). Below 1200 px the split stays 50/50 | `S/canvas/project/Main.dc.html`: `section[aria-label=Map]` `flex:1 1 560px` beside `section[aria-label="Now playing"]` `flex:1 1 400px`. Real split: `S/plan/read-webapp.md` §1.3 |
| Web toolbar | The map draws its own head host `#map-head`, following Discover's `#dpage-head` (`webapp/index.html:874-877`). It holds Search, Filters, a spacer, then Plays heat. There is no Back button: the board's Back would be inert at a root panel (`m.js` `onBackButton` returns when `programState.length < 2`, `S/plan/read-webapp.md` §1.4) | Main/A-W2 toolbars |
| Web map controls | Follow, then a Zoom group (+ over −). The board's Lasso button is v2 (§1.2) | Main, A-W2, A-W3, A-W4 controls |
| Web side-nav order | Discover, Peer Recommendations (#1088, in flight), Map, Rated. `#nav-map` is inserted directly above Rated, so the hunk rebases whichever of the two lands first (§3.2.3) | Main draws Map between Discover and Rated; #1088 puts Peer Recs right after Discover |
| Phone layout | A frame on the home browser stack. The app bar, the sub-bar and **the mini-player stay**. Every sheet (place, song, path) is **in-body and not modal** | A-P1/A-P2 markup: mini-player `top:736px; height:102px`; sheet `top:576px; height:180px`; Follow at `top:554px` |
| Phone song card | **An in-body song sheet**, built like A-P2's place sheet, instead of dir-A §3.3's modal track sheet. §F wins over direction docs: lit neighbours and their titles must stay tappable 44 pt buttons, and a modal barrier takes every tap. The existing track sheet is also scroll-controlled and already at its 9/16 cap with six actions. The song sheet's ⋯ opens the unchanged track sheet | `phone/lib/widgets/track_actions_sheet.dart:35-49`; `S/connections.md` §F "Hit targets", "Neighbours are named"; no board draws this state |
| Sonic path | Numbered stops with **no line**. Badges show at every zoom while a path is active. The view frames all stops | A-W4: 10 `r=8 #2d333b` badge discs, no `<polyline>`, no stroked path; §F Atlas |
| Plays heat vs land | Heat changes dot opacity (unplayed 40 %) and the terminal's ▀ step weights. The land is never recomputed on a client. This follows `S/connections.md` §A4 and §D step 7 ("clients never compute land") over dir-A §3.5's re-terracing | `S/plan/read-clients.md` §5 Q2 |
| Provinces | Level-0 regions are Discogs **genres**: towns are grouped by their majority genre. This is how the boards' 11 provinces were made (`S/make-mapdata.mjs:571-604`). A genre province's key is `g:<Genre>`, stable by construction. Jaccard matching (spec-fixes §4) keys towns, and provinces only when no genre exists | §3.5.5 |
| Place mix | Deterministic per layout: the same ≤50 songs on every tap. Farthest-point spread from the most central song, then a nearest-neighbour walk, in PCA-50 | dir-A §3.1 |
| Terminal map pick | A capture variant the map owns (like `TasteSeed`), so Esc and [X] keep the user in the Map room | `S/plan/read-clients.md` finding 7 |
| Terminal ground | On truecolor and 256-colour tiers without OSC 11 ownership, the field paints its own ground plate `#12131c`, as the web paints its plate. The named-ANSI floor keeps the terminal's background | `S/plan/read-clients.md` §2.7 |
| Auto DJ folder filter | `ignoreVPaths` (the webapp's Auto DJ folder preference, `m.js:185-193`) does not apply to the map. The map is every library the user can see | — |
| Jukebox sessions | They may read the map, but get 403 on the plays overlay, which is history-derived, as `discovery-taste.js:557` refuses them | — |

### 1.4 Decisions for the user (short, real)

1. **Restricted users.** Recommended: drop provinces and towns that have no visible song (per request) and keep the library-wide coast shapes of the rest. A user who sees part of a province sees its whole outline, but no names, counts or songs from libraries they cannot see. The alternative, land per visibility set, waits for v2.
2. **What the DJ trail counts.** Recommended: Auto DJ picks only (`source === 'autodj'`), as the boards say ("the DJ's last 6 picks"). The trail stops at the first play that was not a DJ pick. The alternative is every play in the session.
3. **"Auto DJ from here" on the web turns sonic mode on and keeps it on.** `AUTODJ.setState({sonicEnabled:true})` persists as the user's preference (`webapp/alpha/auto-dj.js:620-635`); the phone already does this. Recommended: accept.
4. **The phone's Light palette.** Recommended: force a dark sea inside the map body. The white marks vanish on `#E1E2E1`, and dots at L .78 read weakly there. The alternative is a light variant of the map.
5. **Double-tap zoom (phone) and double-click to play (terminal).** Recommended: drop both. Double-tap delays every single tap. Pinch on the phone, and Enter/`P` and `[▸]` in the terminal, already cover them.
6. **Empty and failure states.** Recommended: one short line for "nothing analysed yet" (`map.empty`), and one line plus Try again for a map that could not be built or loaded (`map.failed`); a spinner with no text while the first layout builds. The alternative is no text at all.

---

## 2. Architecture

```text
 discovery-backfill.mjs ──► discovery.db  discovery_tracks.embedding (f32le, L2, 1280-d)
        │ (embedding batches settle)                 ▲
        ▼                                            │ rowid-ordered reads
 task-queue.js  'map' task (ENRICHMENT_KINDS)        │
   triggers: settle (settled) · drain (mapEnqueuePending) · hash transitions applied
             · long-first-backfill early map · boot when scanInterval = 0 · admin rebuild
   guards:   never beside the hash-transition applier nor ahead of its ledger · one retry
             after a memory exit or an unexplained kill · 30-minute kill timer · off after
             3 failures in a row
        │ launchWorker('map', …)  (fork under Node; --mstream-worker=map under Bun)
        ▼
 map-layout.mjs (below-normal priority; memory budget re-checked before the fit)
   inventory (one snapshot) ─► PCA-50 (stored basis) ─► fit set = the nFitMax lowest hashes
   ─► UMAP / PCA-2 ─► kNN-place the rest against the fit set ─► rotate·flip·fitBox
   ─► near-dup dots ─► towns (k-means; warm on refit) ─► provinces (genres) ─► keys ─► hues
   ─► centrality + place mixes ─► land rings (400² KDE, byte-capped)
        │ writes, in this order:
        ├─► discovery.db map tables: map_layouts · map_points · map_regions (new layout 'building' → 'ready')
        ├─► mstream.db V81 track_map: the new generation, ≤ 2,000 rows per transaction (invisible)
        ├─► mstream.db track_map_meta: pointer flip + rev bump (one tiny transaction)
        └─► the old generation's mirror rows deleted in chunks; its discovery.db rows at the next run's start

 src/api/discovery-map.js (server process; never touches vectors except /neighbours)
   GET  /api/v1/discovery/map           pointer + base cache (paged scan of the generation) → per-visibility payload
   GET  /api/v1/discovery/map/overlay   mood: track_moods + moodPredicate → bitset · plays: user_metadata
   POST /api/v1/discovery/map/tracks    ids → lite rows · filepaths → representative ids (resolveFlowTracks)
   POST /api/v1/discovery/map/search    FTS/LIKE on artists, albums, titles → ids (concurrency-gated)
   POST /api/v1/discovery/map/region    centre (max centrality, visible) + mix (≤50, walk order)
   POST /api/v1/discovery/map/neighbours  in-memory similarity index → up to 8 distinct placed dots
        │  flag: features.discoveryMap / ping.discoveryMap (= 1)
        ▼
 webapp (canvas 2D)   ·   phone (CustomPainter in a browser frame)   ·   terminal GUI (▀ field)
 existing routes reused as they are: /discovery/local/path, /db/random-songs (similarTo),
 /playlist/save, /stats/history (webapp trail seed only)
```

**Where the truth lives.**

- **Positions** are keyed by `audio_hash` in discovery.db, so a moved file keeps its spot.
- **The mirror** carries `tracks.id` so that SQL can apply `libraryFilter` and JOIN `track_moods` and `user_metadata`.
- **The serving pointer** lives in mstream.db (`track_map_meta`: layout id, the discovery.db map epoch, a revision counter). A route reads the pointer and its generation's rows from one file.
- **Clients** only ever see representative track ids, u16 coordinates and per-layout region ids, plus stable region `key`s.

---

## 3. Phase 1: Server (mStream PR 1)

### 3.1 Files

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | Add `"umap-js": "1.4.0"` (exact) to `dependencies` (`package.json:61-80`) |
| `src/db/map-lib.js` (new) | Pure algorithms and codecs: no I/O, no umap-js, and no config state (§3.5) |
| `src/db/map-umap.js` (new) | The thin UMAP wrapper, the only importer of `umap-js` (§3.5.2) |
| `src/db/map-sync.js` (new) | `reconcileTrackMap(mainDb, ddb, layoutId, opts)`, chunked, an injectable core in the style of `reconcileModelMoods` (`src/db/mood-sync.js:53-108`) (§3.6) |
| `src/db/track-hashes.js` (new) | `tracksByCanonicalHash(mainDb)`, moved out of `src/db/genre-sync.js:75-84` so the worker can import it without the `manager.js` and `config.js` singletons. `genre-sync.js` re-exports it, so `mood-sync.js` keeps its import |
| `src/db/map-layout.mjs` (new) | The worker (§3.4) |
| `src/db/discovery-db.js` | `ensureMapTables()` run by `initDiscoveryDb` after the migrations (§3.2.1). `applyHashTransitionGroups` re-keys `map_points` (§3.7) |
| `src/db/schema.js` | V81: `track_map` and `track_map_meta` (§3.2.2) |
| `src/db/task-queue.js` | The `map` kind: enqueue, run, triggers, guards, status, gate (§3.3) |
| `src/db/discovery-similarity.js` | Export `libraryVersionNow()` and `absorbLibraryVersion(before, after)` (§3.6) |
| `src/util/worker-process.js` | `case 'map': await import('../db/map-layout.mjs'); break;` in `maybeRunWorker` (`:55-68`) |
| `src/state/config.js` | `scanOptions.musicMap` and `scanOptions.mapMaxFitTracks` (§3.3.6) |
| `src/api/discovery-map.js` (new) | Six routes, the caches and the state rule (§3.8) |
| `src/api/sync.js` | Add `export` to `matchesEtag` (`:96`), which is module-private today |
| `src/api/admin.js` | `POST /api/v1/admin/discovery/map/rebuild`, beside `collect-discovery-data` (`:544-556`) |
| `src/server.js` | `discoveryMapApi.setup(mstream)` right after `discoveryApi.setup(mstream)` (`:640`; `:641` on master) |
| `src/api/server-info.js`, `src/api/playlist.js` | The `discoveryMap` flag (§3.9) |
| `webapp/admin/index.js`, `webapp/alpha/scan-progress.js`, `webapp/locales/en.json` | The status row label, a hidden switch for the new pass, the `failing` badge reason (§3.10) |
| `docs/openapi.yaml` | The routes, components, flag and the scan-status pass enum (§3.11) |
| `.github/workflows/build-bun.yml` | A separate bundle smoke step for the worker role (§3.13) |
| `test/…`, `test/fixtures/map/` | §3.12, including the land-v1 fixture that Phases 3 and 4 consume |

#### 3.1.1 The dependency

- **The pin:** `umap-js@1.4.0`, exact, as `onnxruntime-web` is pinned (`package.json:76`). Upgrades get their own PR, because the stability tests are tied to the algorithm.
- **What comes with it** (`S/plan/read-server-runtime.md` §1.3), about 2.0 MB in `node_modules`, all CommonJS with no install scripts and no native code:
  - `ml-levenberg-marquardt` 2.1.1;
  - `ml-matrix` 6.15.1;
  - `is-any-array` 0.1.1 and 3.0.0 (two majors coexist);
  - `ml-array-max`, `ml-array-min` and `ml-array-rescale`, 2.0.0 each.
- **Licence.**
  - umap-js's `LICENSE` file and source headers are **Apache-2.0**; only its `package.json` says MIT. That was checked here: `S/bench/node_modules/umap-js/LICENSE` begins "Apache License Version 2.0" while `package.json` says `"license": "MIT"`.
  - The `ml-*` packages and `is-any-array` are MIT.
  - Apache-2.0 is GPL-3.0-compatible, and W already ships 14 Apache-2.0 production packages, so there is no new notice process.
  - Name it Apache-2.0 in the PR text.
- **Bundling.**
  - **No change to `scripts/build-bun.mjs`.** Bun's `--compile` embeds every statically reachable package; only `onnxruntime-node` is external (`scripts/build-bun.mjs:88`). umap-js adds about 227 KB per binary.
  - The lsio Alpine image, the npm tarball, the smoke Docker image and the demo droplet run `npm ci/install --omit=dev`. They take it from the lockfile with no image change (`S/plan/read-server-runtime.md` §1.3).
- **Server process stays lean.** `map-umap.js` is imported only by the worker, so the server process never loads umap-js.

### 3.2 Schema

#### 3.2.1 discovery.db: the map tables, beside the versioned schema

- **Why not a V5 migration.** A V5 discovery.db makes every older build turn discovery off entirely (`src/db/discovery-db.js:306-311`): Discover, sonic Auto DJ and the mood and genre syncs, all to protect a cache that the next pass rebuilds. Older builds ignore unknown tables, and the P2P export is an allowlist (`src/db/discovery-export.js:1-13`). Tables created beside the schema therefore cost a rollback only the map. `DISCOVERY_SCHEMA_VERSION` stays 4.
- **Mechanism.** `ensureMapTables(db)` in `discovery-db.js`, called by `initDiscoveryDb` right after `runMigrations(); seedMeta();` (`:219-220`). The server and the worker (which opens through `initDiscoveryDb(path)`) both get the tables.
  - `MAP_SCHEMA = 1` is a constant beside `DISCOVERY_SCHEMA_VERSION` (`:37`).
  - When `discovery_meta.map_schema` ≠ `MAP_SCHEMA`, one `BEGIN IMMEDIATE` transaction:
    1. `DROP TABLE IF EXISTS` the three map tables;
    2. deletes the `map_*` meta keys except `map_recent_after`;
    3. runs `MAP_TABLES_SQL`;
    4. sets `map_schema`, and sets `map_epoch` to 16 fresh random hex characters.
  - Otherwise it runs `MAP_TABLES_SQL` alone (every statement is `IF NOT EXISTS`).
  - A later change of table shape bumps `MAP_SCHEMA`. The tables are a cache, so "migrate" means drop them and let the next pass rebuild.
- **`map_epoch`** names this generation of map tables. The mirror's pointer copies it (§3.2.2). A pointer left from a deleted or replaced discovery.db, or from before a `MAP_SCHEMA` reset, is then never read against new layout ids. AUTOINCREMENT restarts after a DROP, so layout ids alone could repeat.
- **Foreign keys are never enabled in discovery.db** (`S/plan/read-server-data.md` §1.1), so every cleanup below is an explicit DELETE. A layout is always deleted in this order: its `map_points`, its `map_regions`, then its `map_layouts` row.

```sql
-- MAP_TABLES_SQL: the music map. Library-specific, rebuildable, never exported
-- (the P2P export is an allowlist: src/db/discovery-export.js). Created by
-- ensureMapTables(), not by a numbered migration (see above).
CREATE TABLE IF NOT EXISTS map_layouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  state         TEXT    NOT NULL CHECK (state IN ('building','ready')),
  model_id      TEXT    NOT NULL,           -- the layout's identity is (model_id, layoutVersion, dim)
  model_version TEXT,                       -- informational: discovery_meta.embedding_model_version at rebuild
  method        TEXT    NOT NULL CHECK (method IN ('umap','pca2')),
  params        TEXT    NOT NULL,           -- JSON {layoutVersion, nNeighbors, minDist, seed, epochs, learningRate, warmFrom, nFitMax, runtime}
  dim           INTEGER NOT NULL,           -- embedding dimension, read from the blobs (never from the model registry)
  k             INTEGER NOT NULL,           -- PCA components kept: min(50, dim, nSample − 1); 0 for a one-song library
  pca_mean      BLOB    NOT NULL,           -- dim × f32le
  pca_axes      BLOB    NOT NULL,           -- k × dim × f32le, row-major, sign-normalised
  affine        TEXT    NOT NULL,           -- JSON [a,b,c,d,e,f]: map = (a·rx + b·ry + c, d·rx + e·ry + f)
  frame         INTEGER NOT NULL,           -- bumps when the affine is re-fitted (clients reset their view)
  aspect        REAL    NOT NULL,           -- width / height of the fitted box
  land_levels   TEXT    NOT NULL,           -- JSON {sigma, coast, mid, high}
  n_fit         INTEGER NOT NULL,           -- points in the UMAP fit set (landmarks when n > nFitMax)
  n_points      INTEGER NOT NULL,           -- hashes placed
  dirty         INTEGER NOT NULL DEFAULT 0, -- 1 while a place run's point chunks are ahead of its region update
  created_at    INTEGER NOT NULL,           -- epoch ms
  fitted_at     INTEGER NOT NULL,           -- epoch ms of the last rebuild or warm refit in this lineage
  placed_at     INTEGER                     -- epoch ms of the last placement batch
);
-- A rowid table: rows are ~320 B (two 32-char hashes, pca at k × 4 = 200 B, scalars),
-- past SQLite's ~1/20-page guidance for WITHOUT ROWID tables.
CREATE TABLE IF NOT EXISTS map_points (
  id         INTEGER PRIMARY KEY,
  layout_id  INTEGER NOT NULL,
  audio_hash TEXT    NOT NULL,              -- canonical hash (= COALESCE(audio_hash, file_hash))
  dot        TEXT    NOT NULL,              -- opaque near-duplicate group label (§3.4.4 step 7); re-keys never touch it
  x          REAL    NOT NULL,              -- the DOT's position: every member of a group carries the group's values
  y          REAL    NOT NULL,              -- map units; [0,1] after fitBox, at most 0.02 outside after a warm refit
  placed     TEXT    NOT NULL CHECK (placed IN ('fit','knn','pca2')),   -- 'fit' = in the UMAP fit set (a landmark)
  region0    INTEGER NOT NULL,              -- per-layout province id 0..254 (the dot's)
  region1    INTEGER NOT NULL,              -- per-layout town id 0..254 (the dot's)
  central0   REAL    NOT NULL,              -- −‖z − mean(province)‖ in PCA space (higher = more central; the dot's)
  central1   REAL    NOT NULL,              -- the same against the town
  pca        BLOB    NOT NULL,              -- k × f32le, THIS member's own projection (saves re-reading 1280-d vectors)
  UNIQUE (layout_id, audio_hash)
);
CREATE INDEX IF NOT EXISTS idx_map_points_hash ON map_points(audio_hash);   -- hash-transition re-keys
CREATE TABLE IF NOT EXISTS map_regions (
  layout_id INTEGER NOT NULL,
  level     INTEGER NOT NULL CHECK (level IN (0,1)),
  id        INTEGER NOT NULL CHECK (id BETWEEN 0 AND 254),               -- fits the payload's u8 (255 = none)
  key       TEXT    NOT NULL,              -- stable across refits: 'g:<Genre>' | 't:<n>' | 'c:<n>'
  parent    INTEGER,                       -- province id, for a town
  label     TEXT,                          -- display name; NULL when no member has a style
  style     TEXT,                          -- raw 'Genre---Style' (town) or the genre (province)
  hue       INTEGER NOT NULL,              -- 0..359; towns carry their province's hue
  x REAL NOT NULL, y REAL NOT NULL,        -- town: k-means centre; province: centroid of its dots
  anchor_x  REAL NOT NULL, anchor_y REAL NOT NULL,
  extent    REAL NOT NULL,                 -- 80th-percentile member distance from the centroid
  size      INTEGER NOT NULL,              -- dots, library-wide
  mix       TEXT NOT NULL,                 -- JSON array of ≤ 64 dot labels in walk order
  land      BLOB,                          -- land-v1 (§3.8.9), provinces only
  PRIMARY KEY (layout_id, level, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_regions_key ON map_regions(layout_id, key);
```

**`discovery_meta` keys.**

- `map_schema`, `map_epoch`: above.
- `map_version`: a counter, bumped **in the same transaction** as any write to the serving layout's discovery.db rows (in practice, place-mode region updates). It is part of `rev` (§3.8.2).
- `map_recent_after`: the recent baseline. It is set once (§3.4.4 step 12), survives `MAP_SCHEMA` resets, and carries over across refits and model changes.
- `map_next_key`: the counter for new `t:`/`c:` keys.
- There is no `map_active_layout`: the serving pointer lives in mstream.db (§3.2.2).

`getMeta`/`setMeta` (`discovery-db.js:350-361`) are reused. **Map writes never touch `row_seq` or `index_epoch`.** They drive P2P auto-publish (`src/state/discovery-p2p.js:555-571`) and the similarity-index rebuild (`discovery-db.js:445-466`).

**Tests to update.** `test/db/discovery-db.test.mjs:85` pins the table list. It becomes `['discovery_lookups','discovery_meta','discovery_tracks','map_layouts','map_points','map_regions']`. The version assertions are unchanged, because the version stays 4 (`:79-80`, `:354-363`).

**Downgrade.** Older builds open the file and ignore the map tables. A downgrade is still blocked by V81 on mstream.db (§3.2.2, §7.5).

#### 3.2.2 mstream.db V81

- **Mechanism:**
  - `export const SCHEMA_V81` after `SCHEMA_V80` (`src/db/schema.js:3380-3392`);
  - `{ version: 81, sql: SCHEMA_V81 }` after `:3702`;
  - `SCHEMA_VERSION = 81` (`:107`), with a changelog line above it (`:104-106` style).
- **No `rescanRequired`. No scanner-contract bump:** `SCANNER_SCHEMA_CONTRACT` stays 73 (`schema.js:109-117`). Both scanners compare against the version passed at spawn.
- **The runner** is `src/db/manager.js:245-347` (`BEGIN IMMEDIATE`). The test twin, `test/helpers/apply-migrations.mjs`, picks the migration up automatically.

```sql
-- SCHEMA_V81: the music map's per-track mirror of discovery.db map_points,
-- written only by the map worker through src/db/map-sync.js, so routes can
-- apply libraryFilter and JOIN track_moods / user_metadata in one query.
-- Double-buffered: at most two generations (layout_id) coexist — the one
-- track_map_meta.active_layout serves, and during a rebuild the next one,
-- written in short chunks while invisible and switched on by one tiny
-- transaction. The scanners rewrite track rows and know nothing of this; a
-- deleted track takes its rows along. A future tracks table-swap migration
-- must back up and restore it like every REFERENCES tracks(id) child
-- (V24's pattern, schema.js:779-805).
CREATE TABLE IF NOT EXISTS track_map (
  layout_id INTEGER NOT NULL,              -- the discovery.db layout this generation mirrors
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  hash      TEXT    NOT NULL,              -- this track's canonical hash (= user_metadata.track_hash)
  dot       TEXT    NOT NULL,              -- the dot's group label (copies and near-duplicates share it)
  x         INTEGER NOT NULL,              -- u16: round(clamp(dot.x, 0, 1) × 65535)
  y         INTEGER NOT NULL,
  region0   INTEGER NOT NULL,              -- the dot's
  region1   INTEGER NOT NULL,
  central0  REAL    NOT NULL,              -- the dot's
  central1  REAL    NOT NULL,
  PRIMARY KEY (layout_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_track_map_track ON track_map(track_id);                    -- the FK cascade
CREATE INDEX IF NOT EXISTS idx_track_map_dot   ON track_map(layout_id, dot);
CREATE INDEX IF NOT EXISTS idx_track_map_hash  ON track_map(layout_id, hash);
CREATE INDEX IF NOT EXISTS idx_track_map_r0    ON track_map(layout_id, region0, central0);
CREATE INDEX IF NOT EXISTS idx_track_map_r1    ON track_map(layout_id, region1, central1);
-- The switch. One row. Routes read it, then filter track_map on active_layout.
CREATE TABLE IF NOT EXISTS track_map_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  active_layout INTEGER,                   -- the serving generation; NULL = none
  map_epoch     TEXT,                      -- discovery_meta.map_epoch of the tables that layout lives in
  rev           INTEGER NOT NULL DEFAULT 0,-- bumped by every transaction that changes the serving generation
  added_max     TEXT                       -- MAX(tracks.created_at) over the serving generation
);
INSERT OR IGNORE INTO track_map_meta (id) VALUES (1);
```

**Why each part.**

- **Two generations instead of one big transaction.** A rebuild or refit changes every row's `layout_id`; one 100k-row transaction would hold mstream.db's write lock for seconds on Pi or NAS storage (the 110 ms figure in `S/plan/read-server-data.md` §4.3 is in-memory on M-series). The server's writes are synchronous node:sqlite calls with `busy_timeout` 5000 (`src/db/manager.js:81`), so its event loop would stall, then fail with "database is locked". Under the DELETE-journal fallback (`src/db/journal-mode.js:1-27`) readers would block too. The house rule is short write transactions (`src/db/scanner.mjs:1701-1710`).
- **`track_map_meta`** is the switch: the flip is one tiny transaction, and the routes filter on the pointer.
- **`rev`** moves in the same transaction as the rows it describes (§3.8.2).
- **`map_epoch`** ties the pointer to the discovery.db map tables (§3.2.1).
- **`added_max`** lets the ETag ignore the calendar day unless some song can be recent (§3.8.2).
- **`idx_track_map_track`**: without it, every track delete scans `track_map` to cascade.
- **`hash`** lets the plays overlay and `/neighbours` drive from a hash without the `COALESCE` join that defeats both hash indexes (`src/api/discovery.js:114-127`).
- **`dot`** is what the payload groups by; the region indexes serve "most central visible member" with one ordered index walk.

**Downgrade.** As with every migration, an older build refuses to boot on a V81 file (`manager.js:257-262`). That is the house norm, and the next release carries other migrations anyway.

#### 3.2.3 Collisions with in-flight work (checked 2026-11-02)

| Branch / PR | Head | mstream / discovery | Overlapping files |
|---|---|---|---|
| flow-order (#1112) | merged: master `54647827` | 80 / 4 | Now on master: rebase first. Its `flowOrder: 1` sits beside the new flag in `buildFeatures`, the ping, the server-info test and openapi |
| `origin/feat/autodj-less-like` (PR #1108) | `78cb4aff` | 80 / 4 | ping, `buildFeatures`, `docs/openapi.yaml`, the server-info test |
| `origin/claude/peer-recommendations-discovery-9872be` (PR #1086) | `78190a1f` | 80 / 4 | ping, `buildFeatures` (`discoveryTaste: 3`), `docs/openapi.yaml`, `src/api/admin.js` (hunks near `:721-800` and `:1165-1232`; the rebuild route goes beside `:544-556`, clear of them) |
| `origin/claude/peer-recs-webapp` (PR #1088, stacked on #1086) | `4526d8ba` | 80 / 4 | The same server files, plus all four of Phase 2's insertion points: `#nav-peer-recs` after Discover (`webapp/index.html` hunk at `:613`), `alpha/peer-recs.js` before `vp.js` (`:1511`), a hide call in `setBrowserRootPanel` (m.js hunk at `:425`) and `PANELS_BY_STATE.peerRecs` (`:7482`). It grows `m.js` by 1,451 lines |
| `origin/claude/linux-bundle-glibc-floor` | `2e29d95a` | 80 / 4 | `src/db/task-queue.js:134-365` (binary detection; hunks at `:134`, `:168`, `:242`, `:290`, `:337`), away from the hooks used here |
| Local worktree `xenodochial-dubinsky-10907c` (`feat/flow-webapp`) | `54647827` + uncommitted edits | — | `m.js`, `vp.js`, `spa.css`, `index.html`, `en.json`, `mstream.player.js`, `api.js`: Phase 2's files |

- No branch or worktree carries a V81.
- Expect textual conflicts only. Whichever lands second rebases.
- **Phase 2 anchors every insertion on a neighbour both sides keep:** `#nav-map` directly above the Rated item; `music-map.js` directly above `vp.js`; `mapHide` appended after the existing hide calls in `setBrowserRootPanel`; `map` appended to `PANELS_BY_STATE`. The side-nav order is settled as Discover, Peer Recs, Map, Rated.
- If another migration lands first, renumber V81 at rebase time. That is the standard procedure.

### 3.3 Queue wiring (`src/db/task-queue.js`)

#### 3.3.1 The kind

- **The list:** `'map'` joins `ENRICHMENT_KINDS` (`:477`), placed after `'discovery'`: `['waveform','albumart','lyrics','discovery','map','audioanalysis','acoustid']`.
- **What that gives for free:**
  - it never counts against "drained" (`:730-733`);
  - it never reports `isScanning` (`:2973-2981`);
  - it gets a status registry entry (`:479-534`) and appears in `GET /api/v1/scan/status` (`src/api/scan.js:56-75`).
- **Tests that pin the list order:** `test/integration/scan-status.test.mjs:94` (the title becomes "all seven passes") and `test/integration/enrichment-status.test.mjs:38` (`KINDS`).
- **The rest of the wiring:**
  - `nextTask` gains `else if (candidate.task === 'map') { runMapTask(candidate); }` (`:459-466`);
  - `enrichmentGate` gains `case 'map'` (`:3009-3057`): `off('config')` unless `collectDiscoveryData === true && musicMap !== false`; `off('failing')` while the failure latch is set (§3.3.4); else `on`;
  - no coverage builder: `coverage` is `null` for the pass (`src/api/scan.js:72` already maps a missing pass to `null`).

#### 3.3.2 Enqueue

```js
const MAP_SCRIPT_PATH = path.join(__dirname, './map-layout.mjs');
const MAP_RUN_TIMEOUT_MS = Number(process.env.MSTREAM_TEST_MAP_TIMEOUT_MS) || 30 * 60 * 1000;
let mapFitCapLatched = null;      // halved after a memory-guard exit or an unexplained kill; cleared on restart
let mapRetryUsed = false;         // that retry happens once per boot
let mapFailures = 0;              // consecutive failed passes; the third latches the pass off
let mapPassFailing = false;       // the latch: off until restart or an admin rebuild
let mapEnqueuePending = false;    // set at a drain that ran the model syncs; cleared only when a map pass is enqueued
let mapAfterTransitions = null;   // { force, settled, reason } of a map pass that waited for the hash-transition applier

// New helper: the check addDiscoveryTask inlines (:2080-2081). No such function exists today.
function discoveryQueuedOrActive() {
  return activeTask?.kind === 'discovery' || taskQueue.some((t) => t.task === 'discovery');
}

// Scans are the hash-transition ledger's only writers (the rust and JS scanners); runScan counts them.
let scansStarted = 0;

// Rows the applier has not consumed: a scan wrote them and its drain has not run yet (every close
// handler dispatches the next task before it drains; a queued scan keeps the drain away), or the
// last apply failed. A map worker then would take the re-keyed songs for gone ones (§3.7).
function hashTransitionsPending() {
  try { return !!db.getDB()?.prepare('SELECT 1 FROM hash_transitions LIMIT 1').get(); }
  catch (err) { winston.warn(`Music map: could not read the hash-transition ledger: ${err.message}`); return false; }
}

// Whether a pass waits for the applier (which enqueues it when it finishes): the applier is running,
// or a ledger is waiting for it. When nothing but enrichment passes is queued or running and no map
// worker runs, no drain may be coming, so the applier starts here. Every pass waits for an attempt of
// its own: a failure lets past only the pass that waited for that attempt (`pastFailedLedger`, the
// scansStarted count at its start), and only while no scan has started since.
function mapWaitsForTransitions(pastFailedLedger = null) {
  if (hashTransitionsInFlight) { return true; }
  if (pastFailedLedger === scansStarted) { return false; }
  if (!hashTransitionsPending()) { return false; }
  if (activeTask?.kind !== 'map' && queueDrained()) { applyHashTransitions(); }
  return true;
}

export function maybeEnqueueMap(reason, { force = null, settled = false, pastFailedLedger = null } = {}) {
  const o = config.program.scanOptions;
  if (o.collectDiscoveryData !== true || o.musicMap === false || mapPassFailing) { return; }
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!ddb) { return; }
  if (!force) {
    try {   // nothing mapped and nothing to map → no fork (keeps test servers and empty installs quiet)
      const embedded = ddb.prepare('SELECT 1 FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? LIMIT 1').get(o.discoveryModel);
      const mirrored = db.getDB()?.prepare('SELECT 1 FROM track_map LIMIT 1').get();
      if (!embedded && !mirrored) { return; }
    } catch (err) { winston.warn('Music map pre-check failed; skipping enqueue', { stack: err }); return; }
  }
  // Never beside the hash-transition applier, nor ahead of a ledger it has yet to apply (§3.7).
  if (mapWaitsForTransitions(pastFailedLedger)) {
    mapAfterTransitions = { ...mergeMapOptions(mapAfterTransitions, { force, settled }), reason: mapAfterTransitions?.reason ?? reason };
    return;
  }
  addMapTask(reason, force, settled, pastFailedLedger);
}
// Two requests folded into one: an admin rebuild or a settle is never lost.
function mergeMapOptions(a, b) { return { force: a?.force || b?.force || null, settled: !!(a?.settled || b?.settled) }; }
function addMapTask(reason, force, settled, pastFailedLedger = null) {
  const pastFailed = Number.isInteger(pastFailedLedger) ? { pastFailedLedger } : {};   // kept when it folds into a queued pass
  const queued = taskQueue.find((t) => t.task === 'map');   // at most one queued pass; it takes on a stronger request
  if (queued) { Object.assign(queued, mergeMapOptions(queued, { force, settled }), pastFailed); return; }
  taskQueue.push({ task: 'map', id: nanoid(8), reason, ...mergeMapOptions(null, { force, settled }), ...pastFailed });
  reportEnrichment('map', { state: 'queued' });   // one queued behind a running pass is allowed
  nextTask();
}
```

The pre-check is index-only: the partial index `idx_discovery_tracks_embedded_model_mood` (`discovery-db.js:168-174`) serves the first probe.

#### 3.3.3 Triggers

1. **Settle.** In `runDiscoveryTask`'s `closeOnce`, inside the block that runs `runModelSyncs('after embedding pass')` (`:2236-2244`): `mapEnqueuePending = false; maybeEnqueueMap('after embedding pass', { settled: true });`.
   - `settled` tells the worker the embedding backlog is drained, which is what lets a model switch rebuild (§3.4.2).
   - This also fires after a catalogue-fill-only pass. The worker then runs in mirror mode, which is cheap.
2. **Drain.**
   - In `checkQueueDrainedSideEffectsInner`, where `anyScansChanged || bootModelSyncPending` runs the model syncs (`:752-755`), also set `mapEnqueuePending = true`.
   - After the discovery enqueue (`:828-831`): `if (mapEnqueuePending && !discoveryQueuedOrActive()) { mapEnqueuePending = false; maybeEnqueueMap('on queue drain'); }`.
   - When discovery work was queued, the flag waits for that pass. Its settle consumes it (item 1). A discovery pass that ends without settling (a non-zero exit or a signal) enqueues the map from its own `closeOnce`: `if (mapEnqueuePending && (code !== 0 || signal)) { mapEnqueuePending = false; maybeEnqueueMap('after a failed embedding pass'); }`. The drain's mirror refresh is never lost.
   - This covers moved files (a new id with the same hash) and upgrades into the map (the first drain after boot).
3. **Hash transitions.** `applyHashTransitionsInner` returns `{ moved, failed }`: whether any discovery row or map point moved, and whether the apply threw (the ledger then stays). `applyHashTransitions` (`:569-577`) reads `scansStarted` before it starts, and after its `finally` clears the in-flight flag: `if (moved || mapAfterTransitions) { const deferred = mapAfterTransitions || {}; mapAfterTransitions = null; maybeEnqueueMap(moved ? 'after hash transitions' : deferred.reason, { ...deferred, pastFailedLedger: failed ? scansBefore : null }); }`. The mirror's `hash` values must follow (§3.7). After a failed apply the pass that waited runs past the ledger, so a ledger that keeps failing never holds the map back; the next pass waits for an attempt of its own (§3.3.2 `mapWaitsForTransitions`).
4. **A long first backfill.** In `closeOnce`'s `hitCap` branch (`:2228-2230`), after `maybeEnqueueDiscovery()`, call `maybeEnqueueMapEarly()`.
   - It wraps its counts in try/catch (warn and return). `closeOnce` has none, and a throw from a child 'close' handler is an uncaught exception that takes down the server (`:452-456`).
   - It enqueues when either holds:
     - no ready layout of **any** model exists (the pointer is NULL and discovery.db has no ready layout), and at least **1,000** current-model rows are embedded (`SELECT COUNT(*) … WHERE embedding IS NOT NULL AND model_id = ?`, index-only);
     - the serving layout belongs to the active model, its `n_points < 0.7 ×` embedded, **and** `max(fitted_at, placed_at)` is at least 24 h old.
   - A model switch never fires it (§3.4.2). This closes the first-map-latency gap (`S/plan/read-server-data.md` §3.4).
5. **Boot with `scanInterval = 0`.** There is no boot scan, so there is no boot drain (`:3161-3187`). In that `setTimeout`, when `!pendingRescan && scanInterval === 0`, call `maybeEnqueueMap('at boot')`.
6. **Admin.** `POST /api/v1/admin/discovery/map/rebuild` clears the failure latch (`mapPassFailing = false; mapFailures = 0`), then calls `maybeEnqueueMap('admin', { force: 'rebuild' })`.

**No new timer.** The daily `scanInterval` chain (scan → embed → settle) is the nightly cadence (`S/plan/read-server-runtime.md` §4.4). The worker decides fit vs place from the data (§3.4.2).

#### 3.3.4 Run

`runMapTask(taskObj)` is a copy of `runDiscoveryTask`'s shape (`:2087-2248`):

1. **Gate and dispatch guard.**
   - `reportEnrichment('map', {state:'idle', progress:null})`. Re-check the gate and return if it is off.
   - `if (mapWaitsForTransitions(taskObj.pastFailedLedger)) { park it in mapAfterTransitions; return; }` (§3.3.2): the applier may have started since the enqueue, or a scan may have left it a ledger since (close handlers dispatch before they drain). The applier enqueues the pass when it finishes; `nextTask` already loops past synchronous no-ops (`:449-467`).
2. **Payload** (small; the Windows argv cap is 32,767 characters). `mapPayload(o, mapFitCapLatched, taskObj)` is a pure function, exported for tests:

   ```js
   const cap = Math.min(o.mapMaxFitTracks ?? Infinity, mapFitCapLatched ?? Infinity);
   return {
     discoveryDbPath: discoveryDb.discoveryDbPath(),
     libraryDbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
     model: o.discoveryModel,
     expectedSchemaVersion: SCHEMA_VERSION,
     parentRssBytes: process.memoryUsage().rss,
     budgetSec: 120,
     settled: !!taskObj.settled,
     // JSON.stringify turns Infinity into null (it drops only undefined), and the
     // worker's Joi rejects null, so the optional keys are added only when set.
     ...(Number.isFinite(cap) ? { maxFitTracks: cap } : {}),
     ...(taskObj.force ? { force: taskObj.force } : {}),
   };
   ```

3. **Launch.** `const forked = launchWorker('map', MAP_SCRIPT_PATH, JSON.stringify(payload));`. The role must be a **string literal**: `test/unit/worker-role-parity.test.mjs:29-35` finds roles with a regex.
4. **Bookkeeping:**
   - the boot reaper pidfile, `writeScannerPidfile(dbDir, forked.pid, process.execPath, 'js', workerReaperMarker('map', MAP_SCRIPT_PATH))`, because the worker writes both DBs;
   - `const killFn = () => { observers.killedByUs = true; try { forked.kill(); } catch (_) {} };` then `addToKillQueue(killFn)`. The kill queue (shutdown) is the only caller of an enrichment `killFn` today (`:2678` is backups);
   - `observers.timer = setTimeout(() => { observers.timedOut = true; killFn(); }, MAP_RUN_TIMEOUT_MS)`;
   - `observers.libVersionBefore = sim.libraryVersionNow()` (§3.6);
   - `activeTask = { kind: 'map', taskObj, child: forked, killFn, observers }`;
   - `reportEnrichment('map', {state:'running'})`.
5. **stdout events through `bufferLines`** (`:414-436`):
   - `mapProgress {phase, attempted, total}` → `reportEnrichment('map', {progress:{attempted,total}})`, logged at info per phase. The `fit` phase's first event carries `total = |F|`; record it as `observers.fitSize`;
   - `mapComplete {...}` → `observers.completeEvt`, logged as one info line (§3.4.7);
   - `error {message, nFitTried?}` → `observers.errorEvt`, `winston.error`.
   - stderr goes through `logWorkerStderr('Music map', line)` (`:401-413`).
6. **`closeOnce(code, signal)`.** `classifyMapExit({code, signal, killedByUs, timedOut, errorEvt, fitSize})` is pure and exported for tests:
   - `clearTimeout(observers.timer)`; clear the pidfile and remove the kill-queue entry;
   - `finishEnrichment('map', code, signal, completeEvt)`;
   - on exit 0: `mapFailures = 0`; `sim.absorbLibraryVersion(observers.libVersionBefore, sim.libraryVersionNow())` (§3.6); with `hitCap`, `maybeEnqueueMap('more to place')`;
   - **exit 5 (memory guard), or a death that neither the kill queue nor the timer caused** (a signal, such as the kernel's OOM killer, or on Windows an NTSTATUS exit code ≥ `0xC0000000`, read as `runDiscoveryTask` reads crashes, `:2189-2190`): `mapFitCapLatched = Math.max(1000, Math.floor((errorEvt?.nFitTried ?? fitSize ?? 2000) / 2))` and a warn. The first time per boot, set `mapRetryUsed` and `maybeEnqueueMap('retry with a smaller fit')`; after that it counts as a failure;
   - **exit 3:** warn "library schema changed under it" (the same text pattern as `:2200`); not counted;
   - **a deliberate kill** (`killedByUs` without `timedOut`): nothing;
   - **anything else** (exit 1, the timeout, a second guard exit): `mapFailures += 1`. The third in a row sets `mapPassFailing = true` and logs an error (§3.4.7);
   - then `nextTask(); checkQueueDrainedSideEffects();`.

#### 3.3.5 Scheduling facts the plan relies on

- The queue is strictly serial (`:27-60`), so scans wait while a map pass runs. That is bounded: a fit takes at most nFitMax points, placement batches are budgeted (§3.4.6), and the parent kills a run at 30 minutes.
- The hash-transition applier runs in the server process at drain, fire-and-forget (`:800`), or from `mapWaitsForTransitions` when no drain may be coming. The guards in §3.3.2 and §3.3.4 keep a map worker from overlapping it or running ahead of its ledger, and the drain skips the applier while a map task is active (§3.7).

#### 3.3.6 Config (`src/state/config.js`, beside `discoveryPerRun` at `:224`)

```js
// The music map (src/db/map-layout.mjs): a layout of the analysed songs for
// /api/v1/discovery/map. Needs collectDiscoveryData; false stops the pass and
// answers the map routes 403 (the rollback lever — data is kept).
musicMap: Joi.boolean().default(true),
// Cap on the songs one map fit holds in memory (the rest are placed by kNN).
// Unset = derived from the machine's memory (map-lib.js mapFitBudget).
mapMaxFitTracks: Joi.number().integer().min(1000).max(20000).optional(),
```

These are config-file only in v1: no admin UI, and so no new strings. Config validation uses `allowUnknown: true` (`:1136`), so both keys are inert on older builds.

### 3.4 The worker: `src/db/map-layout.mjs` (role `map`)

#### 3.4.1 Contract

It copies the `discovery-backfill.mjs` header and validation pattern (`:38-53`, `:75-136`, `:140-166`).

- **Input** is the last argv element: JSON validated by Joi.

  ```js
  Joi.object({
    discoveryDbPath: Joi.string().required(),
    libraryDbPath: Joi.string().required(),
    model: Joi.string().required(),                    // the configured id; the worker never imports the model registry
    expectedSchemaVersion: Joi.number().integer().required(),
    parentRssBytes: Joi.number().integer().min(0).required(),
    maxFitTracks: Joi.number().integer().min(FIT_FLOOR).max(20000).optional(),   // FIT_FLOOR = 1000 (test knob below)
    force: Joi.string().valid('rebuild').optional(),
    settled: Joi.boolean().default(false),
    budgetSec: Joi.number().integer().min(1).max(3600).default(120),
  })
  ```

  - On failure it prints `Invalid JSON Input` to stderr and exits 1. The bundle smoke greps for that line (§3.13).
- **winston** is configured to stderr at warn and above (`:77-79`).
- **Priority.** `try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}` (`S/plan/read-server-runtime.md` §4.3). It works on Node 26 and Bun 1.4, and needs no privilege on Linux.
- **Databases:**
  - discovery.db opens through `initDiscoveryDb(cfg.discoveryDbPath)` (`discovery-db.js:207-228`): `busy_timeout`, migrations, `ensureMapTables`, journal mode inherited;
  - mstream.db opens as a **separate** `new DatabaseSync(cfg.libraryDbPath)` with `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000`, the mstream.db worker pattern (`src/db/audio-analysis-backfill.mjs:131-137`);
  - the schema guard: `PRAGMA user_version === expectedSchemaVersion`, else exit 3.
- **Imports.** The worker needs no config state: it never reads `config.program`. (`discovery-db.js` imports `config.js` at load, `:32`; that is harmless and already true of `discovery-backfill.mjs`.) No `manager.js`, no `genre-sync.js` (§3.5.5 parses genre tags itself) and no `discovery-features-lib.js`. The driver comes from `src/db/sqlite-driver.js` (node:sqlite or the bun:sqlite shim). The shim has no `iterate()` and no named parameters (`src/db/bun-sqlite-adapter.js:1-9`), so every read is keyset-paged with positional parameters.
- **Dimension.** It is read from the blobs: `length(embedding) / 4` of the first current-model row. Rows of another length are skipped, as the similarity index does (`src/db/discovery-similarity.js:260-264`). It never comes from `EMBEDDING_MODELS`: `test-fake` declares 8 there (`src/db/discovery-features-lib.js:159-162`), while tests seed other sizes.
- **stdout events**, one JSON object per line:
  - `{event:'mapProgress', phase:'inventory'|'pca'|'fit'|'place'|'regions'|'land'|'write'|'mirror', attempted, total}`;
  - `{event:'mapComplete', mode, layoutId, method, fitted, placed, removed, dots, regions, nFitTried, ms, peakRssMB, hitCap}`;
  - `{event:'error', message, nFitTried?}`, always followed by a non-zero exit. A memory-guard exit always carries `nFitTried`.
- **Exit codes:** 0 done; 1 fatal (bad input, DB open, an algorithm throw); 3 library schema guard; 5 memory guard.
- **Test seams** (environment variables, following the `MSTREAM_TEST_*` precedent in `src/`; inert unless set):
  - `MSTREAM_TEST_MAP_HOLD=<phase>`: block at the start of that phase until killed, so tests kill at exact points;
  - `MSTREAM_TEST_MAP_RELEASE=<file>`: with the hold, the hold ends once that file exists, so a test can act while the worker waits and then let it go on;
  - `MSTREAM_TEST_MAP_NOW_MS`: replaces `Date.now()` in the mode decision;
  - `MSTREAM_TEST_MAP_PLACE_MAX`: replaces `placeMax`;
  - `MSTREAM_TEST_MAP_FIT_FLOOR`: lowers `FIT_FLOOR`;
  - `MSTREAM_TEST_MAP_FORCE_GUARD`: trips the memory guard at the fit;
  - the parent's kill timer reads `MSTREAM_TEST_MAP_TIMEOUT_MS` (§3.3.2).

#### 3.4.2 Modes (decided from the data, first match wins)

**The sets.**

- L = canonical hashes present in `tracks`.
- U = hashes with a current-model embedding (`discovery_tracks WHERE embedding IS NOT NULL AND model_id = ?`) **∩** L.
- S = the serving layout, found at recovery (§3.4.3).
- P = hashes with a point in S. new = U \ P. **gone = P \ L**: only songs that left the library. A point whose song is still in the library stays even when its embedding row has moved to another model or vanished, because its position and stored `pca` are enough. That is what lets an old model's layout keep serving.

| Mode | When | What it does |
|---|---|---|
| `empty` | U is empty, and no ready layout of any model has a point in L | Delete every layout and every mirror generation, in chunks; pointer NULL; `rev` bump |
| `mirror` (switch pending) | S.model_id ≠ the active model, and none of: `settled`; \|U\| ≥ 0.9 × \|P ∩ L\|; `force === 'rebuild'` with \|U\| > 0 | Reconcile S's generation only. S keeps serving; nothing is placed or refitted, because new-model vectors cannot be projected into S |
| `rebuild` | Any of: no S and \|U\| > 0; S.model_id ≠ model (the switch is settled); `params.layoutVersion ≠ MAP_LAYOUT_VERSION`; S.dim ≠ the blobs' dim; `force === 'rebuild'` with \|U\| > 0; S.method ≠ the method \|U\| asks for (pca2 below 50, umap from 50); S.method = pca2 and (new > 0 or gone > 0); **\|new\| ≥ \|P\|** (the library more than doubled) | New PCA basis, cold fit, new layout id, `frame = previous + 1` |
| `refit` (warm) | S.method = umap, and either fewer than `KNN_PLACE_K` (10) of S's landmarks are still in the library (at any age), **or** now − fitted_at ≥ 6 h and any of: new ≥ 0.15·\|P\|; gone ≥ 0.15·\|P\|; at least 0.15·n_fit of S's landmarks have left since the fit; now − fitted_at ≥ 24 h and new ≥ max(25, 0.02·\|P\|) | Warm UMAP over the capped fit set, new layout id, the same basis and keys |
| `place` | `new > 0` or `gone > 0` or S.dirty = 1 | kNN-place up to `placeMax` new hashes against S's fit set, prune gone ones, recompute changed regions, in S |
| `mirror` | Otherwise | Reconcile S's generation only |

- **A rebuild always needs |U| > 0.** When a row would rebuild with no current-model vectors (a settled switch whose re-embed produced none), the run reconciles S instead.
- **Thresholds count against |P|**, all placed points, not `n_fit`. With landmarks, `n_fit` is a fixed cap (11k of 100k, say), and a refit rewrites every mirror row, so refits should follow real change in the library. Between refits, new songs are placed by kNN.
- **Landmarks that leave count against `n_fit`.** A place run prunes gone points, landmarks included, and nothing but a fit replaces them, so a library that rotates slowly (each pass under every per-pass threshold) would erode the fit set until nothing was left to place against. The inventory counts S's landmarks still in L (`nFitLive`; `n_fit` is written as the landmarks a fit stored). At least 15 % of them gone since the fit is the gone rule counted cumulatively: a refit, after the usual 6 h. Fewer than 10 left, one placement's neighbours, refits at once: the 6 h gate only paces refits that follow real change, and a warm refit keeps the basis, the keys and the surviving songs' positions where a rebuild would reshuffle them. A layout with no landmarks at all (none of the rules leaves one) refits, and places, against every point instead of failing.
- **The constant.** `MAP_LAYOUT_VERSION = 1` (in `map-lib.js`). Bumping it forces one rebuild everywhere, the same pattern as the mood-head version pin (`S/plan/read-server-data.md` §1.7).
- **Model change.** A switch only enqueues discovery (`src/api/admin.js:574-582`), and the embedding worker then re-embeds every row pinned to another model (`src/db/discovery-backfill.mjs:233`), in capped batches, over hours or days.
  - The old model's layout **keeps serving** through switch-pending `mirror` runs (the second row). The `model` block in `GET /map` says which model it is.
  - The new model's rebuild comes at the settle after the re-embed (`settled`, §3.3.3 item 1), or earlier, once at least 90 % of S's songs have new-model vectors; any pass that happens to run checks that. It never comes from the early rule (§3.3.3 item 4).
  - An admin rebuild during the switch builds from the new-model vectors so far. With none yet, it does nothing.
  - Keys, hues and the recent baseline carry over: keys are matched by `audio_hash` membership, which is model-independent, and genre keys hold by construction.
  - This is a deliberate rule. Moods are not dropped either (`S/plan/read-server-data.md` §7.2).
- **Small libraries.** \|U\| < 50 builds with pca2, and any change rebuilds (it takes milliseconds); crossing 50 in either direction rebuilds with the other method. umap-js throws when n ≤ nNeighbors (`umap-js/dist/umap.js:164`; probed: "Not enough data points (15)…"), so the worker also asserts \|F\| > 15 before any UMAP fit.

#### 3.4.3 Recovery at start (crash safety)

1. Delete every `map_layouts` row with `state='building'` (points, regions, then the row). Then delete orphans in chunks of 5,000: `DELETE FROM map_points WHERE layout_id NOT IN (SELECT id FROM map_layouts)`, and the same for `map_regions`.
2. Read the pointer from `track_map_meta`. It is **valid** when its `map_epoch` equals `discovery_meta.map_epoch` and `active_layout` names a ready layout.
3. **S** = the valid pointer's layout. Without one, S = the newest ready layout: this adopts a layout after an mstream.db restore or a map-table reset, and the run writes its generation and flips the pointer (§3.4.4 steps 11–12). Without either, there is no S.
4. Delete ready layouts other than S. The previous layout survives a flip until this step, so a route that read the old pointer can still read its regions.
5. If the pointer was invalid, set it NULL first (a `rev` bump). Then delete mirror rows whose `layout_id ≠ S.id`, in chunks of 2,000. These are leftovers of a crash mid-write or mid-delete.

A crash between writing a new generation and flipping loses that run's work, never the serving map: the pointer still names the old layout, which wins at step 3.

#### 3.4.4 Steps and parameters

`Z` = PCA projections as a `Float32Array(n × k)` (200 B per track at k = 50). Rows are always sorted by `audio_hash` before anything order-sensitive. NN-descent and SGD sampling depend on row order, and SQLite's rowid order changes with deletes (`S/plan/read-server-runtime.md` §6).

**No spread arguments over point arrays.** `Math.min(...xs)` throws "Maximum call stack size exceeded" at 150,000 elements under Node 26 (checked here; Bun 1.4 survives 500k). make-mapdata's `fitBox` does exactly that (`S/make-mapdata.mjs:492-499`); lift it as loops.

1. **Inventory** (phase `inventory`), inside one read transaction on discovery.db (`BEGIN … COMMIT` around the reads, so one WAL snapshot).
   - U side: page `SELECT audio_hash FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? AND audio_hash > ? ORDER BY audio_hash LIMIT 5000` (index-only).
   - P side: S's `map_points`, keyset by `id`.
   - Read the library side once from mstream.db: `SELECT DISTINCT COALESCE(audio_hash, file_hash) FROM tracks WHERE audio_hash IS NOT NULL OR file_hash IS NOT NULL`.
   - The dim: `SELECT length(embedding) FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? LIMIT 1`, divided by 4.
   - Compute U, P, new and gone, then decide the mode.
2. **PCA** (phase `pca`).
   - **rebuild:**
     - the sample is the ≤ 5,000 **lowest `audio_hash`** members of U. The hash is uniform, so the sample is unbiased, deterministic, and barely changes as the library grows;
     - read their vectors (`embedding` BLOB → an aligned `Float32Array` copy, as `discovery-similarity.js:50-55` does);
     - `randomizedPCA(sample, k = min(50, dim, nSample − 1))` with the four fixes (§3.5.1);
     - store `pca_mean` and `pca_axes`;
     - then stream **all** current-model vectors **in rowid order**, `SELECT rowid, audio_hash, embedding FROM discovery_tracks NOT INDEXED WHERE rowid > ? AND embedding IS NOT NULL AND model_id = ? ORDER BY rowid LIMIT 2000`, keep the rows whose hash is in U, and project each into its hash-sorted slot of Z. Rowid order is sequential I/O. Hash order over 5 KB BLOBs, which overflow 4 KiB pages, is random I/O on SD cards and NAS disks (`S/plan/read-server-runtime.md` §5).
   - **refit / place / mirror:** Z for P comes from `map_points.pca`. For new hashes only, read their vectors in `IN` chunks of 500 and project them with the stored basis. Place runs never re-read the library's 1280-d vectors.
3. **Fit set and budget.**
   - `nFitMax = mapFitBudget({...})` (§3.4.6). Refits and placements use `min(nFitMax, S.params.nFitMax)`, so a passing change in the server's memory does not reshuffle the landmarks. Rebuilds use `nFitMax` and store it in `params`.
   - **F = the min(nFitMax, |U|) lowest-hash members of U, in every mode that fits.** It is a pure function of U and the cap: bounded by construction, an unbiased sample, and stable. As U grows, only hashes below the cut enter and the highest-hash landmarks leave, in proportion to the growth.
   - Before the fit, re-check the budget with live readings (§3.4.6). If `base + perPoint·|F|` no longer fits, emit `error {nFitTried: |F|}` and exit 5.
4. **Layout** (phase `fit`).
   - **pca2 (|U| < 50):** raw = (Z₀, Z₁). With n = 1 the map position is (0.5, 0.5), aspect 1, no rotation; with n = 2, raw = (Z₀, 0).
   - **rebuild with umap:**
     - `fitUmap(Frows, init = PCA-2 scaled by max-abs into ±10, {nNeighbors: 15, minDist: 0.5, seed: 42})`, which runs `initializeFit`, overwrites the init in place, then calls `step()` for the default epochs (500/400/300/200 by n);
     - progress every 25 epochs;
     - `await setImmediate` every 10 epochs so stdout flushes.
   - **refit:**
     - init for F members with a point in S = `inverse(affine)(x, y)`. It **must** be the raw coordinates: a warm start from [0,1] gives disparity 0.113 against 0.011 (`S/plan/read-server-runtime.md` §2.3);
     - init for the other F members = kNN raw placement against S's fit set (step 5);
     - `nEpochs: 150, learningRate: 0.3`;
     - then **Procrustes-align** the F members that had points onto their previous raw coordinates (rotation, uniform scale and translation; no reflection) and apply the transform to all new raw coordinates.
5. **kNN placement** (phase `place`).
   - **The rule:** k = min(10, |ref|) nearest in PCA space (squared Euclidean on Z, a bounded max-heap), weights `w = 1/(1e-6 + d²)`, raw = Σw·raw_ref / Σw.
   - **Jitter:** deterministic, at most 0.25 % of the raw span per axis, taken from the first 8 hex digits of the hash, so identical neighbour sets do not stack.
   - **The reference set is the layout's fit set** (`placed = 'fit'`), in every mode. A placement is then a pure function of the vector and the landmarks, whatever the batch boundaries, and the per-query cost stays bounded by nFitMax instead of growing with the library. Measured in the robustness review (Node, PCA-50, top-10 heap, M-series): 0.26 / 0.58 / 1.37 / 2.09 / 3.80 ms per query at 5k / 11k / 20k / 50k / 90k references.
   - **The cap:** at most `placeMax = 20,000` placements per run and at most `budgetSec`, checked every **100** placements. Anything left sets `hitCap` (the queue re-enqueues).
   - **S's points that are not in the new F are not re-placed in a refit.** They follow the **landmark displacement field**: new = old + Σw·(newL − oldL)/Σw over their 8 nearest landmarks by old 2-D position (a grid index), with `w = 1/(1e-6 + d²)`. A refit therefore finishes in one run with every point positioned.
6. **Rotate, flip and fit** (rebuild only).
   - **Rotate:** scan 0–177° in 3° steps and minimise `|ln aspect| + deg·1e-4` (`S/make-mapdata.mjs:477-489`). Spans below 1e-9 count as 1e-9.
   - **Flip:** negate x when `corr(Z₀, x) < 0`; negate y when `corr(Z₁, y) > 0`. Map y grows downward, so PC2 increases upward. This replaces make-mapdata's demo-artist flip (`:490`).
   - **fitBox:** margin 0.04, aspect kept (`:492-499`, without its implicit y flip and with loops). A zero-extent axis takes the other axis's scale; a single point is centred.
   - Compose rotation, flip and fitBox into `affine`, and store it with `aspect`.
   - **After a refit:** keep the stored affine. Re-fit fitBox only when more than 1 % of points fall outside [−0.02, 1.02]²; then `frame += 1`.
7. **Near-duplicate dots.**
   - **Candidates**, from three sources:
     - fitted pairs from the fit's kNN graph: `umap.knnIndices[i][j]` with `umap.knnDistances[i][j] ≤ 0.1415`. Those instance fields are set by `initializeFit` (`umap-js/dist/umap.js:171-174`; probed in this session: present, self at column 0 with distance 0);
     - placed↔landmark pairs from the placement kNN under the same bound;
     - placed↔placed pairs from a grid pass: bucket the pre-jitter raw positions of placed points on a grid of 0.5 % of the raw span, and check each cell's 3 × 3 neighbourhood in PCA-50 against 0.1415. Two near-identical vectors get near-identical neighbour sets and weights, so they land in the same or adjacent cells.
   - **Why 0.1415 loses nothing.** cos ≥ 0.99 ⇔ ‖a − b‖ ≤ 0.1414 for unit vectors, and a projection never lengthens a distance, so the PCA bound is an exact pre-filter.
   - **Verify** every candidate on the exact current-model 1280-d vectors (`SELECT audio_hash, embedding … WHERE audio_hash IN (…)`) against `MAP_NEAR_DUP = 0.99`. A unit test pins it equal to `NEAR_DUP` (`src/db/discovery-novelty.js:19`; that module imports `manager.js`, so the worker cannot import it).
   - **Union-find**, starting from the previous layout's groups whose members all still verify. A refit's fit graph covers landmarks only, so groups of placed members would otherwise split.
   - **Labels are opaque.** A group's `dot` is its smallest member hash when the group forms. It never changes while the group lives in a layout: re-keys (§3.7) and new members keep it; merging groups keep the smaller label. Rebuilds and refits recompute labels. A singleton's dot is its own hash at creation.
   - **Every member row of a group carries the group's** x, y, regions and centralities, taken from the label's member when the group forms. No row is special, so re-keying any member moves nothing. `pca` stays per member.
   - Regions, land, mixes and sizes count **dots** only.
8. **Regions** (phase `regions`; §3.5.5).
   - **rebuild:** towns by fresh k-means++, provinces by genre, keys by matching, hues by adjacency.
   - **refit:** towns by warm Lloyd from the previous towns' centres moved through the refit; provinces, keys and hues as for a rebuild.
   - **place:** new dots join the nearest existing town centre (`map_regions.x,y`). Regions are not re-clustered between refits.
   - Recompute `size`, anchors, centralities, and the mixes of every region whose membership changed.
9. **Land** (phase `land`; §3.5.8). It is recomputed whenever any dot was added, removed or moved, and when S.dirty = 1.
10. **Write** (phase `write`; discovery.db). Every transaction is `BEGIN IMMEDIATE` with its re-checks inside, and stays near 100 ms.
    - **rebuild/refit:**
      1. `INSERT map_layouts (state='building')`;
      2. `INSERT map_points` in transactions of 2,000 rows;
      3. `INSERT map_regions`;
      4. `UPDATE map_layouts SET state='ready'`.
    - **place:**
      1. set `dirty = 1` with the first chunk;
      2. insert new points and delete gone points in transactions of 2,000;
      3. then one transaction updates `map_regions`, sets `placed_at` and `n_points`, clears `dirty` and bumps `map_version`.
      A crash in between leaves `dirty = 1`, and the next run's `place` row recomputes regions and land from the points. So does a planned insert or prune that the re-checks below skipped: the regions were computed with a dot the points do not have, or without one they do, so `dirty` stays 1.
    - **Re-checks:** inserted hashes still exist in `discovery_tracks` (`IN` chunks of 500, inside the transaction); a gone hash is still absent from `tracks` (an indexed probe on mstream.db right before the transaction), and its point is deleted by id **and** the hash the inventory read, so a point the hash-transition applier re-keyed since then lives on under its new hash. A hash transition can land between runs (`S/plan/read-server-runtime.md` §8.3); the next run places the target.
11. **Mirror** (phase `mirror`): `reconcileTrackMap` (§3.6). The target generation is the new layout (rebuild, refit) or S.
12. **Flip** (rebuild, refit, or an adopted S): one tiny mstream.db transaction sets `track_map_meta` (`active_layout`, `map_epoch`, `rev + 1`, `added_max`). Then delete the other generations' mirror rows in chunks of 2,000. On the first ever ready layout, set `map_recent_after = (SELECT MAX(created_at) FROM tracks)`, read from mstream.db, if it is unset.
13. **Finish.** Emit `mapComplete` and exit 0. The previous layout's discovery.db rows go at the next run's start (§3.4.3 step 4).

#### 3.4.5 Write order, atomicity, cancellation

- **The order:**
  1. the new layout's rows, invisible while `building` and while no pointer names them;
  2. the new mirror generation, in chunks, invisible because routes filter on the pointer;
  3. the flip: pointer and `rev` in one transaction;
  4. the old generation's mirror rows, deleted in chunks;
  5. at the next run's start, the old layout's discovery.db rows.
- **Readers are always consistent.** A route reads the pointer and its generation's rows from mstream.db, validates them by re-reading the pointer and the row count (§3.8.2), and reads that layout's regions from discovery.db, which exist until the next run.
- **Place and mirror runs change the serving generation in place.** Each chunk is correct row by row, and each chunk's transaction bumps `rev`. A client sees at worst an intermediate state under its own correct ETag, then the final one.
- **Cancelling** is killing the process: the kill queue, the parent's 30-minute timer, or the boot reaper for an orphan. No cooperative cancel is needed. Recovery (§3.4.3) handles every interruption point.
- **Cross-file writes are not atomic in WAL mode** (`S/plan/read-server-data.md` §3.5). That is why the pointer carries `map_epoch` and the layout id.
- **FK safety.** Mirror inserts use `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM tracks WHERE id = ?) ON CONFLICT(layout_id, track_id) DO UPDATE …`, so a track deleted concurrently (an admin library removal) never aborts the transaction.

#### 3.4.6 Memory and time budgets

`mapFitBudget` (pure, injectable like `threadPolicy`, `src/db/embedding-runtime.js:62-77`):

```js
// Inputs: totalMemBytes = os.totalmem(); constrainedBytes = process.constrainedMemory?.() || 0
// (Node: 0 when unconstrained; Bun 1.4 returned os.totalmem() here, and its cgroup
// behaviour on Linux is unverified). On Linux the worker also reads, with the same
// code under both runtimes: /proc/meminfo MemAvailable; cgroup v2
// /sys/fs/cgroup/memory.max + memory.current, or v1 memory/memory.limit_in_bytes +
// memory.usage_in_bytes ("max" or a huge value = no limit). nEmbedded = current-model rows.
limit     = Math.min(totalMemBytes, cgroupLimitBytes || Infinity, constrainedBytes > 0 ? constrainedBytes : Infinity);
available = linux ? Math.min(memAvailableBytes, cgroupLimitBytes ? cgroupLimitBytes - cgroupUsageBytes : Infinity) : null;
indexRoom = 2 * nEmbedded * dim * 4;      // one similarity-index rebuild in the server, during the fit
budget    = Math.min(0.35 * limit, limit - parentRssBytes - 256 * MiB,
                     available === null ? Infinity : 0.6 * available - indexRoom);
perPoint  = runtime === 'bun' ? 120 * KiB : 55 * KiB;   base = runtime === 'bun' ? 100 * MiB : 150 * MiB;
nFitMax   = clamp(Math.floor((budget - base) / perPoint), FIT_FLOOR, 20000);
if (Number.isInteger(override)) nFitMax = Math.min(nFitMax, clamp(override, FIT_FLOOR, 20000));
```

- **The override caps, never raises.** `override` is `mapMaxFitTracks` or the queue's halved cap (§3.3.4), whichever is smaller. A fit above the derived size would fail the pre-fit check against this same budget anyway, so an override above it (the halved cap once a larger library has shrunk the budget, say) would turn every pass into a memory-guard exit.

- **Why it branches on the runtime.** Bun peaks at about twice Node's memory: 1.05–1.13 GB against 0.59 GB at 10k, and 2.30 GB against 1.12 GB at 20k. Every standalone bundle runs Bun (`S/plan/read-server-runtime.md` §4.1).
- **Why MemAvailable, the cgroup and the index headroom.**
  - `os.totalmem()` alone ignores everything else on the box, such as other containers on a NAS.
  - The map pass is enqueued by the settle that just published a new `index_epoch` (`task-queue.js:2236-2244`), so the server's next similarity request rebuilds its index while the fit runs. That rebuild holds the old matrix, the `.all()` rows, per-entry copies and the new matrix at once (`src/db/discovery-similarity.js:249-300`).
- **Resulting fit sizes under Bun**, with nothing else running and a small library: about 2.1k / 5.1k / 11.1k / 20k on 1 / 2 / 4 / 8 GB hosts. A big library's index headroom lowers them: a 100k library on a 4 GB Pi gets roughly 3–4k landmarks. Memory safety comes first (§8.2 Q4).
- **Do not use** `os.freemem()` or `process.availableMemory()`; they disagree wildly between runtimes. MemAvailable is read from `/proc` directly.
- **Memory guards.**
  - **Before the fit:** re-read the inputs. If `base + perPoint·|F| > budget`, exit 5 with `nFitTried = |F|`, before anything big is allocated. The dominant peak is inside umap-js's single synchronous `initializeFit` (Node RSS 574 MB at 10k and 2,909 MB at 50k, `S/bench/res-10k-umap.json`, `res-50k-umap.json`), where no check can run, so this pre-check is what covers it.
  - **Between phases and every 25 epochs:** `if (rss > budget + 64 MiB)`, emit `error {nFitTried}` and exit 5. The threshold is absolute; it no longer scales with |F|.
  - The queue halves the cap after an exit 5 or an unexplained kill, and retries once per boot (§3.3.4).
- **Time.**
  - A fit is bounded by nFitMax: about 15 s at 20k on an M3, an estimated 50–80 s on a Pi 4.
  - Placement is ≤ 20,000 per run under `budgetSec` (120 s), checked every 100 placements.
  - A first rebuild of 100k on a Pi is about 3–5 min plus vector I/O (estimated), then about four placement batches against the fit set.
  - Region k-means runs on ≤ nFitMax dots, with the rest assigned to the nearest centre. Land costs ≤ 0.5 s.
  - The parent kills a run at 30 minutes; three failed passes in a row stop the pass until restart or an admin rebuild (§3.3.4).

#### 3.4.7 Logging (parent side)

- **At start:** `Music map pass started (<reason>)`.
- **Per phase:** `Music map: <phase> <attempted>/<total>`.
- **On completion:** `Music map: <mode> (<method>) — <fitted> fitted, <placed> placed, <removed> removed, <dots> dots, <regions> regions in <ms> ms (peak <MB> MB)`.
- **On the memory guard or an unexplained kill:** warn `Music map pass stopped at its memory guard — retrying with a fit of <n> songs` (or `… was killed — …`).
- **On the timeout:** warn `Music map pass took longer than 30 minutes — stopped`.
- **On the failure latch:** error `Music map pass failed 3 times in a row — stopped until restart (an admin rebuild retries)`.
- **Anything else** goes through `logWorkerStderr`.

#### 3.4.8 Small libraries and no embeddings

- **0 dots:** mode `empty`; the route answers a non-ready state (§3.8.3).
- **1 dot:** map (0.5, 0.5), aspect 1.
- **1–49 dots:** `pca2`. Towns: K1 = max(1, min(n, round(√n / 2))). Provinces come from genres as usual, and land uses the σ formula (σ grows as n shrinks).
- **≥ 50 dots:** UMAP with nNeighbors 15 (|F| > 15 asserted).
- **test-fake (8-d, no style head)** exercises k = min(50, 8, n − 1) and the unlabelled-province fallback (§3.5.5).
- Every coordinate is finite; the 1- and 2-dot worker tests assert it.

### 3.5 `src/db/map-lib.js` (pure) and `src/db/map-umap.js`

Each item names its source to lift and the fixes it needs.

#### 3.5.1 PCA

- **Lift from:** `S/bench/lib.mjs:4-13` (`mulberry32`), `:96-156` (`orthonormalize`, `jacobiEigen`) and `:162-239` (`randomizedPCA`, `projectRows`).
- **Four fixes** (`S/plan/read-server-runtime.md` §3):
  1. clamp `k ≤ min(l, m − 1, d)`, so fewer than 60 rows no longer crash;
  2. sample without replacement: the lowest hashes (§3.4.4 step 2);
  3. normalise signs so each axis's largest-|component| is positive;
  4. a **Rademacher (±1) test matrix** from `mulberry32` instead of Box–Muller. The basis is then bit-identical across Node, Bun and platforms, which allows a golden PCA test. `jacobiEigen` uses only `+ − × ÷ √ abs sign`; the golden fixture itself must avoid `gaussian()`'s `Math.log`/`Math.cos` (`S/bench/lib.mjs:15-20`) to stay bit-identical under Bun.
- **Do not import `ml-pca` or `ml-matrix`.** `ml-pca` took 21 s at 2k.

#### 3.5.2 UMAP wrapper (`map-umap.js`)

```js
import { UMAP } from 'umap-js';                       // top-level static import (bundle smoke relies on it)
export function fitUmap(rows, init, { nNeighbors = 15, minDist = 0.5, seed = 42, nEpochs, learningRate, onEpoch }) → { raw: Float64Array(2n), knnIndices, knnDistances, epochs }
```

- Calls `new UMAP({ nComponents: 2, nNeighbors, minDist, random: mulberry32(seed), nEpochs, learningRate })`, then `initializeFit(rows)`, which returns the epoch count.
- Writes `init` **into** `getEmbedding()` rows. The array is aliased to the optimiser state (`umap.ts:890-894`; probed `getEmbedding() === u.embedding`). Assigning a new array would be silently ignored.
- Then runs `step()` × epochs.
- Same input, seed and runtime give the same bytes (probed: two seed-42 runs gave identical hashes; seed 7 differed).
- **Node and Bun diverge** (disparity 0.34 on 2k, `S/plan/read-server-runtime.md` §2.4), so tests assert properties.

#### 3.5.3 Geometry

- `rotateNearSquare`, `flipRule`, `fitBox`, `composeAffine`, `invertAffine`, with the zero-span guards of §3.4.4 step 6 and no spread arguments.
- `procrustes(A, B)` returns `{R, s, t}`: extend `S/bench/lib.mjs:320-340`, which only returns the score.
- `knnPlace` and `displacementField` (§3.4.4 step 5).
- `jitterFromHash`.

#### 3.5.4 Near-duplicates

- `gridCandidates(points, cell) → pairs` (§3.4.4 step 7).
- `groupNearDuplicates(candidatePairs, verify, previousGroups) → Map<hash, dot>` (union-find; labels as in §3.4.4 step 7).

#### 3.5.5 Regions, labels, keys and hues

- **Towns (level 1):**
  - **rebuild:** k-means++ on 2-D map positions of the fit set's dots, K1 = clamp(round(√n / 2), 2, 120), capped at n; 4 restarts seeded `mulberry32(300 + r)`, at most 100 Lloyd iterations, the minimum-inertia restart wins. This reproduces `KC = 22` at the dataset's 2,003 tracks (`S/make-mapdata.mjs:511`);
  - **refit:** warm Lloyd, at most 100 iterations, starting from the previous layout's town centres moved by the displacement field (§3.4.4 step 5). When K1 changes, add the extra centres by farthest point from the existing ones (ties by hash), or drop the smallest towns' centres. Fresh k-means++ restarts change the local optimum even when no point moves: the robustness review measured fresh k-means++ keeping 15 of 22 town keys after +10 % songs with no movement, against 22 of 22 for warm Lloyd (`S/mapdata.json`, 2,003 dots);
  - every dot goes to its nearest centre, and empty clusters are dropped.
- **Town label:** over the members' top style, parsed in `map-lib.js` from the raw `genre_tags` JSON: the first array element that is a string containing `---` (`'Genre---Style'`), junk-hardened like `parseGenreTags`. `parseGenreTags` itself (`src/db/genre-sync.js:45-70`) cannot be reused: its module imports `config.js` and `manager.js` (`:37-40`), and it returns deduped `{name, parent}` objects without the raw key `DISPLAY_STYLE` needs.
  - candidates are styles with share ≥ 0.15;
  - score = share × √lift, with lift = share / global share;
  - fallback: the most common style; null when no member has a style;
  - display = `DISPLAY_STYLE[style] ?? style.split('---')[1]`, with `DISPLAY_STYLE = {'Hip Hop---Instrumental':'Instrumental Hip-Hop', 'Hip Hop---Conscious':'Conscious Hip-Hop', 'Classical---Modern':'Modern Classical'}` (`S/make-mapdata.mjs:549-560`; §A3);
  - the town's genre = the majority of its members' top-style genres.
- **Provinces (level 0):**
  - towns grouped by genre, `key = 'g:' + genre`, label = `SHORT_GENRE[genre] ?? genre`, with `SHORT_GENRE = {'Funk / Soul':'Soul', 'Folk, World, & Country':'Folk', 'Stage & Screen':'Score'}` (`S/make-mapdata.mjs:547`);
  - a town with no genre joins the province of its nearest town (by centre) that has one;
  - **if no town has a genre** (test-fake, an untagged library), provinces = k-means on the town centres with K0 = clamp(round(K1/3), 1, 12), `label = null`, keys by Jaccard (`c:<n>`). Refits warm-start this clustering the same way as towns;
  - province ids are by size descending; town ids by (parent id, size descending), as `make-mapdata.mjs:595-604` does;
  - anchor = the member nearest the members' median (`anchorOf`, `:562-569`); a province uses its biggest town's anchor;
  - extent = the 80th-percentile distance (`extentOf`, `:570`).
  - Labels are data (Discogs names), not UI strings, so none go in en.json.
  - **A region with `label: null` gets no name button and no place card on any client** (§4.4.1).
- **Keys across refits** (spec-fixes §4):
  - towns, and unlabelled provinces, are matched to the previous layout's regions by Jaccard over member **hashes**: greedy on the largest overlap, one-to-one, kept at ≥ 0.5;
  - ties broken by overlap descending, then old key ascending, then new id ascending;
  - a matched region keeps its key and its label (unless the old label was null); a split keeps the key on the larger part;
  - unmatched regions get `t:<map_next_key++>` or `c:<…>`;
  - genre provinces keep `g:<genre>` by construction.
- **Hues (provinces):**
  - candidates every 5° on 0–355 **excluding 35–85** (61 candidates; the webapp accent `#fa832b` sits near 50°, the phone amber `#ffab00` near 70°);
  - adjacency = owner-grid neighbours at the coast level, or land masks within ⌈3σ·400⌉ cells of each other (a dilation test);
  - largest province first; keep the previous hue if it stays ≥ 60° from every assigned neighbour and no larger province took it; otherwise take the candidate that keeps ≥ 60° from the assigned neighbours (or comes closest), then maximise the minimum distance to every assigned hue, then take the smallest hue. The neighbour term is capped at 60°: maximising it outright gave every province that borders only the first one the opposite hue, so provinces with no shared coast shared a colour (the demo library's Rock and Electronic, both 180, found in the Phase 1 smoke);
  - towns inherit their province's hue;
  - **dir-A's per-province `NUDGE` table is not used** (`S/dir-A/lib.mjs:61-63`).

#### 3.5.6 Centrality and mixes

- `central0/1 = −‖z − mean_region(z)‖` in PCA space, per level.
- **Mix:** at most 64 dots per region:
  - all of them when the region is that small;
  - otherwise farthest-point sampling in PCA space from the most central dot;
  - ordered by a greedy nearest-neighbour walk from the most central dot;
  - ties broken by hash.
- **Cost:** about 1 s per run at 100k on an M3; only changed regions are recomputed in `place` runs.

#### 3.5.7 Recent baseline

- `map_recent_after` is set once (§3.4.4 step 12).
- The recent bit is computed at request time (§3.8.3).
- A fresh server rings nothing (spec-fixes §2).

#### 3.5.8 Land

- **Lift from** `S/dir-A/lib.mjs:87-215`: `landField`, `contours` (marching squares), `simplify`, `chaikin`, `ringArea` and `regionRings`. Replace its recursive slice-and-spread `dp` (`:166-180`) with an iterative one (an explicit stack of index ranges over one array).
- **Grid and kernel:**
  - N = 400;
  - σ = clamp(0.010 × (2000/n)^(1/6), 0.003, 0.04), where n = dots;
  - a KDE per province, cut off at 3σ.
- **Levels:**
  - coast = 0.45, a fraction of one song's peak, so every song stands on land;
  - mid = the 0.5th percentile and high = the 4th percentile of the total density at the dots' cells (spec-fixes §3);
  - guards that keep the terraces nested on tiny libraries: `mid = max(mid, 2·coast)` and `high = max(high, 1.25·mid)`. On the demo these reproduce 1.516 / 3.973 (`S/plan/read-server-runtime.md` §7).
- **Inside test:** `min(own_r − strongestOther, total − level)`.
- **Ring pipeline:**
  1. simplify ε 0.0007;
  2. Chaikin ×2;
  3. drop |area| < 1.2e-5;
  4. **one more DP pass at ε 3e-4**;
  5. normalise each ring (start at the smallest (x, y) vertex, positive area);
  6. quantise to u16;
  7. drop rings with fewer than 3 distinct vertices.
- **Caps.** At most 64 KB per province and 256 KB per layout. When over, raise the final DP ε by ×1.5 per step until the land fits. Assert every `ringCount` and `vertexCount` ≤ 65,535 before writing: `DataView.setUint16` wraps silently.
- **Store** per province as `land-v1` (§3.8.9). About 11–31 KB per layout (`S/plan/read-server-runtime.md` §7).
- **Clients fill even-odd** (canvas `'evenodd'`, Flutter `PathFillType.evenOdd`, the terminal's scanline parity).

#### 3.5.9 Codecs

`encodePointsColsV1`, `encodeLandV1`/`decodeLandV1`, `encodeBitset`, `quantU16`. Clients port the decoders. Every decoder checks the counts against the blob length and rejects a blob that does not end exactly at its last vertex.

### 3.6 The mirror: `src/db/map-sync.js`

```js
/** Reconcile track_map generation `layoutId` with discovery.db map_points (mstream.db writes; discovery.db reads). Singleton-free. */
export function reconcileTrackMap(mainDb, ddb, layoutId, { serving, chunk = 2000 }) → { tracks, written, removed }
```

1. **Read the points.** `SELECT audio_hash, dot, x, y, region0, region1, central0, central1 FROM map_points WHERE layout_id = ?`, keyset by `id`. Every member carries its dot's values (§3.4.4 step 7), so each hash maps straight to its row; there is no representative lookup to go stale.
2. **Read the tracks.** `tracksByCanonicalHash(mainDb)` (from `src/db/track-hashes.js`) gives hash → [track ids].
3. **Read the generation's existing rows.** `SELECT * FROM track_map WHERE layout_id = ?`, keyset by `track_id`.
4. **Diff.** The desired row per track: `{layout_id, track_id, hash, dot, x16, y16, region0, region1, central0, central1}`. Tracks whose hash has no point get **no row**: this is an exact mirror, unlike mood-sync's leave-alone rule (`S/plan/read-server-data.md` §4.2).
5. **Write** upserts and deletes in `BEGIN IMMEDIATE` transactions of at most `chunk` rows.
   - When the generation is the serving one (`serving: true`), each transaction also bumps `track_map_meta.rev`. A new generation's chunks do not: nothing reads them yet.
   - The last transaction also writes `added_max` (serving), or hands it to the flip (new generation).
   - When nothing differs it writes nothing, and `rev` does not move.

**Cost on the server's event loop: zero.** The worker runs it (option B in `S/plan/read-server-data.md` §4.3).

**The similarity index.** The worker's commits move the server connection's `PRAGMA data_version`. The index treats that as library drift (`src/db/discovery-similarity.js:236-247`) and answers with a full rebuild on the event loop after its 5-minute window (1.5–1.7 s at 25k on M-series, `:13-15`). The map pass absorbs its own writes instead:
- `libraryVersionNow()` returns the main connection's `data_version` (the existing private `libraryVersion()`, `:114-118`);
- `absorbLibraryVersion(before, after)` moves `cache.libVersion` to `after` only when it still equals `before`, that is, when no other writer committed first;
- `runMapTask` reads `before` at launch and calls it on exit 0 (§3.3.4). The queue is serial, so during the run the worker was the only other connection committing to mstream.db.
- The novelty identity cache (`src/db/discovery-novelty.js:59-80`) is left alone: its 60-second TTL already bounds it.

### 3.7 Hash transitions

- **Extend `applyHashTransitionGroups`** (`src/db/discovery-db.js:591-653`): inside the same transaction, per group and source, run
  `UPDATE OR IGNORE map_points SET audio_hash = ? WHERE audio_hash = ?`
  then `DELETE FROM map_points WHERE audio_hash = ?` (rows whose target already had a point in that layout).
  - It is index-backed by `idx_map_points_hash`, and covers both layouts that can exist (the serving one and the previous one).
  - **`dot` and `mix` are left alone.** Labels are opaque (§3.4.4 step 7), and every member carries its dot's values, so re-keying a group's label member, or a singleton's own hash, moves nothing and loses no track from the mirror.
  - No `publishIndexEpoch` is added for map rows.
- **Enqueue the follow-up.** When the applier finishes, it enqueues one map run (§3.3.3 item 3), which reconciles `track_map.hash`. The point keeps its position: no kNN re-placement and no jump.
- **The ordering hazard is avoided by guard, not by luck.** The applier runs fire-and-forget at drain (`task-queue.js:800`) and re-keys in 250-group chunks with `setImmediate` yields (`:630-636`). A map worker forked beside it, or ahead of a ledger it has yet to apply, would read the re-keyed songs as gone: their tracks carry the new hash while their points and vectors still carry the old one, so it would prune the points, and a later pass would re-place the songs by kNN. So:
  - `maybeEnqueueMap` and `runMapTask` park a pass while the applier runs or the ledger holds rows, and start the applier themselves when no drain may be coming (`mapWaitsForTransitions`, §3.3.2, §3.3.4). Every close handler dispatches the next task before it drains, and a queued scan keeps the drain away altogether, so the ledger check is what holds, not the in-flight flag alone;
  - the drain skips the applier while a map task is active; the map's own close drains again. (A pass let past a failed apply that waited behind another task is dispatched by that task's close, which drains right after.)
  - a ledger that fails to apply lets past only the pass that waited for that attempt, and only while no scan has started since (scans are the ledger's only writers): a ledger that keeps failing never holds the map back, and one failure, a passing `SQLITE_BUSY` say, never lets later passes past a ledger that would apply;
  - the worker deletes a gone point by id and the hash it read (§3.4.4 step 10), a backstop for a point re-keyed after its inventory.
- **The applier deletes only the rows it read**, by `(old_hash, new_hash)`, in one transaction. It is not a task, so a scan can be dispatched while it yields and commit more rows, or replace one in place (a chain step is `INSERT OR REPLACE`); an unconditional `DELETE FROM hash_transitions` would drop those unapplied, stranding their embeddings and making the next map pass take their songs for gone ones. They stay for the next drain.

### 3.8 Routes: `src/api/discovery-map.js`

#### 3.8.1 Common rules

- **Registration:** `setup(mstream)`, mounted after the auth wall, right after `discoveryApi.setup` (`src/server.js:640`; `:641` on master).
- **Gate (`requireMap(req)`):**
  - 403 `Discovery is disabled` when `collectDiscoveryData !== true`, when `musicMap === false`, or when `openDiscoveryDbIfExists()` is null. That is the same message as `requireIndex` (`src/api/discovery.js:66-78`), so probing cannot tell configuration from failure;
  - 403 `Discovery is disabled`, too, when no layout is serving, no current-model vector exists, and the discovery pass is off for an environment reason (`getEnrichmentStatus()`: discovery `disabledReason` `runtime-unavailable` or `no-ffmpeg`, `task-queue.js:3041-3045`). Nothing can be drawn on this install until that is fixed, so clients hide the map as for a disabled feature instead of promising one;
  - 403 `Forbidden` when `req.user.federation`. This is defence in depth: the routes are **never** added to `ALLOWED_EXACT` (`src/api/federation-auth.js:47-88`);
  - share tokens are already 401 at the wall.
- **No `requireIndex()` on the hot paths.** It builds the 1.5-s in-memory index (`S/plan/read-server-api.md` §1.4). Only `/neighbours` uses it.
- **The serving layout.** The pointer row in `track_map_meta`, valid when its `map_epoch` equals `discovery_meta.map_epoch` and its layout is ready in discovery.db. Every `track_map` query filters on `layout_id = pointer.active_layout`.
- **Visibility.** `libraryFilter(req.user)` (`src/api/db.js:186-226`) on every query that joins `tracks`. It is dropped when `coversAllLibraries`.
- **The representative id of a dot for a caller** = `MIN(t.id)` over the dot's visible tracks. It is the one identity every route returns, so clients join answers to the payload by id (binary search on the sorted id column).
- **Errors** follow the house style (`src/server.js:757-786`): `WebError(message, status)`, and Joi failures → 400 `{error}`.
- **Pure helpers, exported for tests:** `mapRev(parts)`, `mapState(inputs)`, `derivePayload(base, filter, recent)`.

#### 3.8.2 `rev`, ETag and the caches

```js
const p = mdb.prepare('SELECT active_layout, map_epoch, rev, added_max FROM track_map_meta WHERE id = 1').get();
const n = p.active_layout == null ? 0       // alone: a PK-prefix count, no MIN/MAX mixed in
  : mdb.prepare('SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(p.active_layout).n;
const cutoff = utcMidnightDaysAgo(30);       // 'YYYY-MM-DD HH:MM:SS', like tracks.created_at (schema.js:218)
const recentPart = p.added_max && p.added_max > (getMeta('map_recent_after') ?? '') && p.added_max > cutoff
  ? cutoff.slice(0, 10) : '-';
const rev = sha1(['m1', p.map_epoch ?? '-', p.active_layout ?? 0, p.rev, n, getMeta('map_version') ?? 0,
                  filter.params.join('.'), recentPart].join('|')).slice(0, 16);
```

- **Pattern:** `manifestRevision` (`src/api/sync.js:40-48`), never `PRAGMA data_version`. That counter is per connection, restarts with the process and ignores the server's own writes (`S/plan/read-server-data.md` §2.6).
- **What each part catches:**
  - `map_epoch`: a deleted or replaced discovery.db (the documented purge, `src/api/admin.js:541-543`) or a map-table reset. Layout ids alone could repeat, giving false 304s and overlays decoded against the wrong point order;
  - `active_layout` and `rev`: every worker write to the serving generation, moved in the same transaction as the rows;
  - `n`: cascaded deletes, since a removed track takes its row along with no worker write;
  - `map_version`: place-mode region updates in discovery.db, bumped in their own transaction;
  - the library ids: grant changes;
  - `recentPart`: the 30-day window, but only while some mirrored song is newer than both the baseline and the cutoff. A library with nothing new keeps its ETag across midnights; a plain UTC day would re-send 1.47 MB at 100k to every client daily, with compression off by default (`src/state/config.js:328-341`).
- **No per-user data in it.** Two users with the same visibility share bytes and an ETag.
- **A label older than its content heals itself.** The route reads `rev` first and the content after. If the worker commits in between, the content is newer than its label; any later request computes the new `rev`, so the next revalidation or overlay (409) refreshes it.
- **Base cache** (one entry per `(map_epoch, active_layout, rev, n)`): the serving generation's rows, independent of visibility.
  - Per track: `track_id`, `library_id`, `created_at` (parsed once to epoch seconds; the baseline and the cutoff are parsed the same way) and the dot's index. Per dot: `x`, `y`, `region0`, `region1`. Plus a dot-label → index `Map`. About 2 MB at 100k tracks.
  - Built by a keyset-paged scan, `SELECT m.track_id, t.library_id, t.created_at, m.dot, m.x, m.y, m.region0, m.region1 FROM track_map m JOIN tracks t ON t.id = m.track_id WHERE m.layout_id = ? AND m.track_id > ? ORDER BY m.track_id LIMIT 5000`, with a `setImmediate` between pages and the statement prepared once.
  - Afterwards the pointer and `n` are re-read. If either moved, the build is discarded and retried once (a worker writes in bursts, so the retry almost always lands).
  - Concurrent requests share one in-flight build.
  - This replaces the draft's single synchronous `GROUP BY` (120 ms query plus 27 ms encode at 100k on M-series, `S/plan/read-server-data.md` §4.3; roughly 0.7–1.5 s on a Pi, all on the event loop).
- **Payload cache** (LRU of 8, keyed by `rev`): `{body: string /* the serialised 200 JSON */, ids: Uint32Array, dotIndex: Uint32Array, n}`.
  - Derived from the base cache in one JS pass (about 10 ms at 100k): visible members only; the first visible member in track-id order is the representative; `added` = the members' minimum `created_at`.
  - A hit sends the string with no `JSON.stringify`. An evicted entry is re-derived from the base cache, never re-queried.

#### 3.8.3 `GET /api/v1/discovery/map`

- **Auth:** any account, public mode or jukebox. Gate as in §3.8.1.
- **Request:** no query in v1.
- **Headers:**
  - always `Cache-Control: private, no-cache` and `ETag: "<rev>"`;
  - when `If-None-Match` matches (`matchesEtag`, `src/api/sync.js:96-100`, newly exported), answer **304 before building anything**.

**200 body:**

```json
{
  "state": "ready",                       // 'ready' | 'building' | 'failed' | 'empty'
  "model": { "id": "effnet-discogs", "version": "1" },
  "rev": "3f9c0a1b2c4d5e6f",
  "layout": { "id": 7, "method": "umap", "frame": 2, "aspect": 1.021, "landFormat": "land-v1" },
  "regions": [
    { "key": "g:Hip Hop", "level": 0, "id": 1, "parent": null, "label": "Hip Hop", "hue": 180,
      "anchor": [22111, 13567], "size": 812, "land": "<base64 land-v1>" },
    { "key": "t:42", "level": 1, "id": 7, "parent": 1, "label": "Jazzy Hip-Hop", "hue": 180,
      "anchor": [30211, 9988], "size": 120 }
  ],
  "points": { "n": 94210, "format": "cols-v1", "data": "<base64>" }
}
```

**`state`** (`mapState`, from the pointer, `getEnrichmentStatus()` and one index-only probe):

- a valid serving layout exists → `ready`. A caller who sees none of it gets `points.n = 0` and no regions; clients draw the plate alone;
- no serving layout, and either a map pass is queued or running, or no map pass has finished since boot while current-model vectors exist → `building`;
- no serving layout, current-model vectors exist, and the last map pass this process lifetime did not complete (`lastRun.outcome ≠ 'completed'`), or the pass is latched off (`disabledReason: 'failing'`) → `failed`;
- otherwise → `empty`: nothing is analysed yet, and analysis can run here (the 403 rule in §3.8.1 covers installs where it cannot);
- the three non-ready states answer `layout: null`, `regions: []` and `points: {n: 0, format, data: ""}`.

**The payload** comes from the caches (§3.8.2):

- **Recent bit:** `added > map_recent_after && added > cutoff`, where cutoff = 00:00 UTC on (today − 30 days), formatted like `tracks.created_at` (`YYYY-MM-DD HH:MM:SS`, `schema.js:218`).
- **Regions:** read `map_regions WHERE layout_id = ?` for the pointer's layout. Set `size` to the **visible** dots per region (from the payload pass). **Drop** regions whose visible size is 0, and towns whose province was dropped (decision 1). `anchor` is u16; `land` (provinces only) is the stored land-v1 blob as base64.
- **Cost:** unmeasured for the paged scan. It reads the same rows as the measured `GROUP BY` without the grouping, in pages of a few milliseconds each, then a ~10 ms JS pass. The perf guards (§3.12) pin its shape.

#### 3.8.4 `GET /api/v1/discovery/map/overlay?layer=mood|plays&rev=<rev>[&moods=<MoodFilter JSON>]`

- **Joi (query):** `layer` valid `mood`/`plays`, required; `rev` a string of 1–32 characters, required; `moods` a string, optional.
- **409 `Map changed`** when `rev` is not the caller's current rev. The client refetches `GET /map` (ETag) and asks again, once (§4.6).
- The point order comes from the caller's payload-cache entry, re-derived from the base cache when evicted.
- **`mood`:**
  - parse with `parseMoodsQuery` (`src/api/mood-filter.js:98-108`; ≤ 512 characters, 400 otherwise), then `applicableMoods(moods)` (`:130-133`);
  - not ready → `{rev, layer, n}` (no `moods`, no `data`), and clients hide Filters;
  - otherwise one pass, `SELECT tm.track_id FROM track_moods tm WHERE ${moodPredicate(moods,'tm')}` (`:161-171`), builds a Set; bit i = `set.has(ids[i])`;
  - answer `{rev, layer:'mood', n, moods: echo, data: base64 bitset}`;
  - unscored songs are 0, so they dim, as they drop out of filtered lists;
  - a `null` filter gives all ones;
  - measured 10–44 ms and 12.5 KB at 100k (`S/plan/read-server-api.md` §2.5).
- **`plays`:**
  - 403 `Forbidden` without an account (`requireAccount` pattern, `src/api/stats.js:216-220`) and for jukebox sessions (`refuseJukebox` pattern, `src/api/discovery-plugin-jobs.js:83-88`);
  - `SELECT um.play_count AS plays, (SELECT m.dot FROM track_map m WHERE m.layout_id = ? AND m.hash = um.track_hash LIMIT 1) AS dot FROM user_metadata um WHERE um.user_id = ? AND um.play_count > 0`. Index seeks over the user's played rows (`idx_track_map_hash`; `user_metadata(user_id, play_count)` V61);
  - the dot label → its index in the caller's payload (dots the caller cannot see are skipped); sum per dot (near-duplicate members are summed); `data[i] = min(255, plays)`;
  - answer `{rev, layer:'plays', n, data: base64 u8[n]}`.

#### 3.8.5 `POST /api/v1/discovery/map/tracks`

- **Joi:** `{ ids: int[1..500] ≥ 1, filepaths: string[1..500] (≤ 4096 chars each) }`, `.xor('ids','filepaths')`, strict.
- **ids → `{tracks: [ {id, filepath, metadata} | null ]}`,** aligned with the input:
  1. `SELECT t.id FROM tracks t WHERE t.id IN (…) AND <filter>`, chunked by 500;
  2. `renderMetadataByIds(visibleIds, req.user)` (`src/api/db.js:427-456`) with `metadata = toLiteMetadata(...)`.
  - **The visibility intersection comes first.** `renderMetadataByIds` checks nothing (`S/plan/read-server-api.md` §4.3).
  - Unknown and invisible ids are both `null`, so they cannot be told apart.
- **filepaths → `{ids: [ representativeId | null ]}`,** aligned:
  1. `resolveFlowTracks(filepaths, req.user)` (`src/api/db.js` on master, from #1112): aligned `{id, hash, …} | null`, with the vpath and library checks (`getVPathInfo` strips a leading `/`, so both path forms work) and 500-pair row-value chunks;
  2. `SELECT track_id, dot FROM track_map WHERE layout_id = ? AND track_id IN (…)` (primary key);
  3. `SELECT m.dot, MIN(t.id) AS id FROM track_map m JOIN tracks t ON t.id = m.track_id WHERE m.layout_id = ? AND m.dot IN (…) AND <filter> GROUP BY m.dot`;
  - a path with no dot (not analysed, or not placed yet) is `null`. It is never a 404, because this is a batch.

#### 3.8.6 `POST /api/v1/discovery/map/search`

- **Joi:** `{ q: string trimmed 2..128 }`, strict.
- **A concurrency gate:** `createConcurrencyGate({ maxActive: 2, maxWaiting: 8 })` (`src/util/concurrency-gate.js` on master) → 429 past it. Clients debounce at 300 ms; this caps bursts.
- **How:** reuse `parseSearchQuery` and `buildFtsExpression` (`src/util/search-query.js:40`, `:100`) the way `runFtsSearch` does (`src/api/search.js:439-470`).
  - With `db.FTS5_AVAILABLE` (`src/db/manager.js:23`):
    - artists `fts_artists MATCH` (≤ 50), only from 3 characters;
    - albums `fts_albums MATCH` (≤ 100), only from 3 characters;
    - titles `fts_tracks MATCH` on `title`, `ORDER BY rank` (≤ 2,000).
  - Fall back to the `LIKE '%q%'` forms (`search.js:153-196`) on a parse refusal or `ERR_SQLITE_ERROR`, or always when FTS5 is missing.
- **Track set,** capped before any grouping: `WITH hits(id) AS (SELECT … artist tracks … UNION SELECT … album tracks … UNION SELECT … titles … LIMIT 20000)`, joined to `track_map` on the serving layout and `<filter>`, then dots, then representative ids.
- **Answer:** `{ids: [ascending, ≤ 5,000], best: id | null /* first visible title match with a dot */, capped: bool}`. `capped` is true when either cap cut.

#### 3.8.7 `POST /api/v1/discovery/map/region`

- **Joi:** `{ key: string 1..64, limit: int 1..50 = 50 }`.
- **Region:** found by `key` in the serving layout. Unknown → 404 `Region not found`.
- **centre:** `SELECT t.id FROM track_map m JOIN tracks t ON t.id = m.track_id WHERE m.layout_id = ? AND m.region0 = ? [AND m.region1 = ?] AND <filter> ORDER BY m.central{0|1} DESC, t.id LIMIT 1` (index `idx_track_map_r0`/`_r1`). None → 404 `Region not found` (a uniform answer).
- **songs:** the region's `mix` labels → visible representative ids (one `GROUP BY m.dot` query), in walk order, first `limit`. Fewer than `limit` → top up by centrality order. Then lite rows.
- **Answer:** `{region: {key, level, label}, centre: {id, filepath, metadata}, songs: [{id, filepath, metadata}]}`.
  - The rows queue without translation, as `discovery.js:2-4` promises: lite metadata like the similar and path routes.
  - Spec's `seeds` (8 medoids) waits for v2.

#### 3.8.8 `POST /api/v1/discovery/map/neighbours`

- **Joi:** `{ id: int ≥ 1, limit: int 1..16 = 8 }`.
- **How:**
  1. `requireIndex()`;
  2. resolve the id to a visible row and its dot in the serving layout, else 404 `Track not found`;
  3. canonical hash → `index.byHash`; missing → `{seed, notAnalyzed: true, neighbours: []}` (possible during a model switch, while the serving layout is the previous model's);
  4. `sim.rankTracks(index, seed.vec, canonHash, considerBudget(limit))` (`src/db/discovery-similarity.js:427-434`, `src/api/discovery.js:56-64`; 2,000 candidates at limit 8);
  5. in rank order, in chunks of 64 candidates: `SELECT hash, dot FROM track_map WHERE layout_id = ? AND hash IN (…)`. **Candidates with no dot are skipped** (embedded but not placed yet, or the serving layout is another model's). Then one batched representative query for the new dots: `SELECT m.dot, MIN(t.id) … WHERE m.layout_id = ? AND m.dot IN (…) AND <filter> GROUP BY m.dot`;
  6. skip the seed's dot, repeated dots and invisible dots; stop at `limit`. When the candidates run out first, answer what was found with `capped: true`.
- **Answer:** `{seed: {id, filepath, metadata}, notAnalyzed: false, capped: bool, neighbours: [{id, filepath, metadata, similarity /* 4 dp; clients don't show it */}]}`.
- **Why a map route rather than the similar route.** It saves two round trips per selection on three clients, it returns only placed songs, and it dedupes near-duplicates by dot. The similar route excludes only the seed's own hash (`discovery-similarity.js:427-433`).

#### 3.8.9 Byte layouts (all little-endian)

**`cols-v1` points** (n points sorted by id ascending, 11·n bytes):

| Offset | Type | Field |
|---|---|---|
| 0 | `u32[n]` | representative track id |
| 4n | `u16[n]` | x: map x × 65535 |
| 6n | `u16[n]` | y: map y × 65535 (down) |
| 8n | `u8[n]` | province id (255 = none) |
| 9n | `u8[n]` | town id (255 = none) |
| 10n | `u8[n]` | flags: bit 0 recent; bits 1–7 are 0 in v1 |

- Every column starts aligned to its element size. A decoder can view a fresh `ArrayBuffer` directly (`Uint32Array(buf, 0, n)`, `Uint16Array(buf, 4n, n)`, …; Dart `Uint32List.view`). All supported hosts are little-endian.
- **Size at 100k** (`S/plan/read-server-api.md` §8.3): 1.10 MB raw; 1.47 MB as base64 JSON (compression is off by default, `src/state/config.js:328-341`); about 635 KB gzipped when an operator turns compression on.
- **Delta-coded ids were rejected for v1.** They save 18 % raw but cost a decode loop in three languages.

**`land-v1`** (one blob per province):

```text
repeat 3 times (coast, mid, high):
  u16 ringCount
  repeat ringCount: u16 vertexCount (≥ 3), then vertexCount × (u16 x, u16 y)   // closed implicitly
```

Fill even-odd per terrace, in the order coast → mid → high. Decoders reject a blob whose counts run past its end or leave bytes over.

**Bitset:** ⌈n/8⌉ bytes. Point i is bit `(i & 7)` (LSB first) of byte `i >> 3`.

#### 3.8.10 Limits and statuses (all routes)

| Status | When |
|---|---|
| 400 | Joi |
| 401 | Wall |
| 403 | Disabled (feature off, no DB, `musicMap` off, or no layout and analysis cannot run here), a federation key, plays without an account, jukebox on plays |
| 404 | Region not found; Track not found (neighbours) |
| 409 | Overlay `rev` stale |
| 429 | Search past its concurrency gate |

- No rate limiter exists on master beyond the new gate. The limits are structural: 500 items per call, search expansion capped at 20,000 and answers at 5,000, mixes at 50.
- The 1 MB body cap (`config.js:898`) easily covers 500 paths.

### 3.9 Flag

- **`src/api/server-info.js` `buildFeatures()`:**
  ```js
  // The music map (api/discovery-map.js): an integer GENERATION like
  // discoveryTaste — a later format or body key ships as 2 and clients gate on
  // >= n; 0 when scanOptions.musicMap is off. A version fact: clients show the
  // map on `discovery === true && discoveryMap >= 1`, never on a peer; whether
  // a layout exists yet is the route's own answer (state).
  discoveryMap: config.program.scanOptions.musicMap === false ? 0 : 1,
  ```
  It goes after `discoveryTaste` (`:105`, the same line on master).
- **`src/api/playlist.js` ping:** add `discoveryMap: features.discoveryMap,` beside `discoveryTaste` (`:39`). The drift lock (`test/integration/api-server-info.test.mjs:219-238`) enforces parity.
- **Tests:** assert the value on both routes, beside `api-server-info.test.mjs:134-136`.

### 3.10 What an admin and a user see

- **`GET /api/v1/scan/status`** lists `{pass:'map', enabled, disabledReason, state, progress, lastRun:{outcome, hitCap, counts:{mode, method, fitted, placed, removed, dots, regions, ms, peakRssMB}}, coverage:null}`.
  - Every user can read it (`src/api/scan.js:40-56`). There are no library names in it.
- **Admin enrichment card** (`webapp/admin/index.js:2263-2268`, `:3074-3118`):
  - `passLabel` gains `map: t('map.pass')`;
  - the row's switch is wrapped in `v-if="p.pass !== 'map'"`, because the pass has no own toggle in v1. Without this, `togglePass('map')` would call `undefined.call(...)` and throw (`:3107-3116`);
  - `stateLabel`'s reason map (`:3136-3142`, hardcoded English like its neighbours) gains `'failing': 'stopped after repeated failures'`.
- **Webapp progress chip:** `webapp/alpha/scan-progress.js:24-31` `ENRICH_LABELS` gains `map`, resolved at render time as `t('map.pass')`.
- **en.json:** `"map.pass": "Music map"`. It is the only en.json string Phase 1 adds; Phase 2 adds the rest of the `map.*` group (§4.10).
- **The admin route** `POST /api/v1/admin/discovery/map/rebuild` (body `{}`; admin-only through the guard at `src/api/admin.js:128-135`) answers 403 `Discovery is disabled` when off, else clears the failure latch, enqueues with `force: 'rebuild'` and answers `{}`. It is documented in openapi, with no UI in v1.
- **Logs** as in §3.4.7.

### 3.11 API docs (`docs/openapi.yaml`)

- **Paths.** Add the six paths under the Discovery tag after `/api/v1/discovery/local/path` (`:3074-3128`; `:3345` on master, the model to copy), plus the admin route under its admin tag.
- **Components:** `DiscoveryMap`, `DiscoveryMapRegion`, `DiscoveryMapOverlay`, `DiscoveryMapTrackRow`. Reuse `MoodFilter` (`:1097`; `:1109` on master) and `responses.Unauthorized` (`:1585`; `:1597`).
- **ETag.** Document `If-None-Match`, `ETag` and 304 the way the sync manifest does (`:5748-5797`; `:6019` on master).
- **Byte layouts.** Put the `cols-v1`, `land-v1` and bitset layouts in the descriptions, verbatim from §3.8.9.
- **Flag.** Add `discoveryMap` to the `features` schema (`:1701-1790`) **and** the ping schema (`:1864-1935`), beside `discoveryTaste`.
- **Scan status.** The pass enum `enum: [waveform, albumart, lyrics, audioanalysis, discovery, acoustid]` (`:2068`; `:2095` on master) gains `map`, and so does the description that lists the passes just above it.
- **Lint.** Give every new operation a 4xx response, so `operation-4xx-response` does not grow; search documents its 429. **Seven** more `operation-operationId` warnings are expected (six map routes plus the admin route): house style has no operationIds, and warnings never fail the job.
- **Validate** with `npm run docs:api:validate` (`package.json:26-27`). The docs workflow runs only when the file changes (`.github/workflows/publish-api-docs.yml:3-12`).

### 3.12 Tests

No wall-clock assertions: every kill point and every time threshold is driven through the seams in §3.4.1, so the suite cannot flake on slow CI legs.

| File | What it proves |
|---|---|
| `test/unit/map-lib.test.mjs` (new) | **PCA:** axes orthonormal to 1e-9; variance non-increasing; n = 20 and n = 2 do not throw; a **golden basis hash** for the Rademacher fit on a fixed synthetic set built without `gaussian()` (bit-identical across runtimes). **Geometry:** affine round trip to 1e-9; the rotation angle minimises \|ln aspect\| among the scanned angles; the flip rule holds; n = 1 → (0.5, 0.5) and a zero-span axis stay finite; `fitBox` on 200,000 points does not throw. **Placement:** kNN placement is a convex combination; an exact duplicate lands on its twin within the jitter bound; jitter is deterministic; placing 1,000 points in one batch or in ten gives identical bytes (reference = the fit set). **Near-duplicates:** cos 0.995 → one dot, cos 0.98 → two; `MAP_NEAR_DUP === NEAR_DUP` (imported from `src/db/discovery-novelty.js`); the grid pass finds a placed↔placed pair; previous groups carry over; labels never change when a member is renamed. **Regions:** deterministic k-means; warm Lloyd keeps ≥ 95 % of town keys after +10 % songs on a 2,000-dot synthetic set; K1 + 1 adds exactly one centre; share×√lift picks the boards' style on a fixture; the raw top-style parse (junk JSON, non-strings, no `---`); `DISPLAY_STYLE`/`SHORT_GENRE` applied; genre provinces; the null-tag fallback; Jaccard identity, split, merge, new, and 0.49 vs 0.50. **Hues:** none in 35–85; neighbours ≥ 60° when satisfiable; a matched province keeps its hue. **Land:** every dot's cell ≥ coast; high ⊂ mid ⊂ coast (point-in-polygon on vertex samples); mid and high equal the guarded percentiles; ≤ 16 KB per province on the ×10 proxy; the caps raise ε until ≤ 64 KB per province and 256 KB per layout; counts ≤ 65,535; the iterative DP equals the recursive one on small rings; unchanged input → identical bytes. **Codecs:** cols-v1 offsets and alignment; bitset bit order; land-v1 round trip; a truncated or over-long land blob is rejected. **`mapFitBudget`:** the table in §3.4.6 for Bun and Node on 1/2/4/8 GB, MemAvailable and cgroup inputs, the index headroom, and the override clamp |
| `test/unit/map-umap.test.mjs` (new) | Two in-process fits on the same 300-point input and seed → identical bytes; a different seed → different bytes. `knnIndices` present after `initializeFit` (guards an umap-js upgrade). A warm +10 % refit at 2k: disparity ≤ 0.02, old-point p50 ≤ 3 %, p95 ≤ 8 % of the diagonal. **The maximum is not bounded** (measured up to 33 % at 10k, `S/plan/read-server-runtime.md` §6) |
| `test/unit/map-queue.test.mjs` (new) | The pure queue helpers: `mapPayload` never emits `null` or `Infinity` (unset cap and force are omitted; the JSON parses under the worker's Joi); `classifyMapExit`: exit 5 → latch `floor(nFitTried/2)` (min 1000) and one retry, a second → a failure; an unexplained SIGKILL → the same latch from `fitSize`; `killedByUs` → nothing; the timeout and exit 1 → failures; three in a row → the latch. `mapState` covers every row of §3.8.3. `mapRev` changes with each part and ignores the day while `added_max` is old. **Through the real queue** (in process, real worker forks): a pass lands in the status entry; the guard retries once, then three failures latch; the hash-transition applier and a map worker never overlap and no pass runs ahead of a pending ledger (a close dispatching a queued pass, with and without a scan-like task queued); a failing ledger costs each pass one attempt of its own and then lets it past, and once the cause clears the next pass waits for the apply; a pass let past a failure behind another task is dispatched by that task's close, whose drain leaves the applier alone; the applier deletes only the rows it read (rows committed while it runs survive it); after a failed apply, a pass behind a real scan, or let past a failure dated before that scan, waits for the scan's ledger; every re-keyed song keeps its point |
| `test/db/map-sync.test.mjs` (new) | The pattern of `test/db/mood-sync.test.mjs:41-77` (`applyAllMigrations` on `:memory:` plus a temp discovery.db). Copies share a dot; a moved file (new id, same hash) gets a row; a track with no point loses its row; a no-op reconcile writes nothing and leaves `rev` alone; FK-guarded inserts skip deleted ids; writes are chunked (a spy counts ≤ `chunk` rows per transaction); a serving generation bumps `rev` per chunk and a new generation does not; the flip and the old generation's chunked delete; `added_max`; **a re-key through `applyHashTransitionGroups` of a singleton's own hash and of a group's label member keeps every track's row and position** |
| `test/db/discovery-db.test.mjs` | The table list (`:85`); `ensureMapTables` on a `map_schema` mismatch drops and recreates the map tables with a fresh `map_epoch` and keeps `map_recent_after` |
| `test/db/map-layout-worker.test.mjs` (new) | Spawn the worker the way task-queue forks it (`test/integration/discovery-backfill.test.mjs:139` pattern) on temp DBs seeded with synthetic **64-d** vectors under `model_id 'test-fake'`; the dimension comes from the blobs. **Events and exit codes:** `{}` → `Invalid JSON Input` and exit 1; `{"maxFitTracks":null,…}` → exit 1 (guards the payload rule); a bad `expectedSchemaVersion` → exit 3. **Modes:** 0 dots → `empty`; 1, 2 and 30 dots → `pca2` with finite coordinates; 600 dots → `umap` rebuild; a rerun → `mirror` with `rev` unchanged; +30 dots → `place`; +100 dots with `MSTREAM_TEST_MAP_NOW_MS` 7 h past `fitted_at` → `refit` (old p95 bound); +800 dots (more than \|P\| = 730) → `rebuild`. **Fit-set cap** (`MSTREAM_TEST_MAP_FIT_FLOOR=100`, `maxFitTracks` 200): 600 dots → \|F\| = 200 and 400 placed; a refit with 300 new → \|F\| ≤ 200. **Batches:** `MSTREAM_TEST_MAP_PLACE_MAX=50` → `hitCap`, and repeated runs finish. **Landmarks that leave:** a fit set leaving a little at a time is refitted at 15 % of `n_fit` gone; every landmark gone within 6 h → a warm refit (same basis, survivors within a p95 bound), and new songs still place; a layout with no landmarks at all refits from every point. **The applier beside a place run** (`MSTREAM_TEST_MAP_HOLD=write` with `MSTREAM_TEST_MAP_RELEASE`): a point re-keyed after the inventory is not pruned, keeps its values, and `dirty` stays for the next run, which counts its dot again. **Model switch:** rebuild under model A, re-label half the rows to model B, run → mode `mirror`, the old layout serves, the mirror is unchanged; run with `settled` → rebuild under B; genre keys and hues kept. **Dirty:** `MSTREAM_TEST_MAP_HOLD=regions` in a place run, kill, rerun → regions and land recomputed. **Recovery:** hold at `mirror` in a rebuild and kill → the old layout still serves, and the next run recovers; kill after the flip → the new layout serves and the old rows go at the next start; a pointer with a stale `map_epoch` → the newest ready layout is adopted and its generation written. **Guard:** `MSTREAM_TEST_MAP_FORCE_GUARD` → exit 5 with `nFitTried` on the error event. **Safety:** `row_seq` and `index_epoch` unchanged by every run; the payload's JSON never contains vectors. **A bun leg** (`describe('bun', { skip: noBun })`, `test/helpers/bun.mjs:9-15`) runs the rebuild and place cases under Bun |
| `test/integration/discovery-map.test.mjs` (new) | **Setup:** two servers in the `discovery-similarity.test.mjs:107-155` pattern: off, and on with `collectDiscoveryData:true, discoveryModel:'test-fake'` **and `federation: { enabled: true }`** (as `api-server-info.test.mjs:94`, so a minted key reaches the wall). `lib2` is generated with ffmpeg (the `:100-105` pattern): six sine tracks, plus a copy of `Be Somebody` from the fixture library (same audio, so the same hash and dot). Users: admin sees both libraries, bob sees `testlib` only. Vectors are handcrafted so the testlib tracks and the lib2-only tracks form two far-apart clusters, with `genre_tags` `Rock---Indie Rock` and `Jazz---Hard Bop`: at K1 = 2 that gives exactly two provinces, `g:Rock` and `g:Jazz`. The fixture tracks are 1 s long, below the 30 s discovery window (`task-queue.js:2006`), so no embedding pass races the seeding, and the boot drain forks no map worker (no embeddings yet). **Seeding:** insert the vectors, then `POST /api/v1/admin/discovery/map/rebuild`, then poll `/api/v1/scan/status` until the map pass's `lastRun.finishedAt` advances. The suite waits for any running pass before stopping its servers (Windows `rmSync` hits EBUSY on a live worker). **Assertions:** 403 when off; flag 1 on ping and `/api/`; the `GET /map` shape; points decode; ids ascending; the shared dot's id is the lower of the two copies' ids for admin and the testlib copy's id for bob; ETag → 304 with `If-None-Match`; `Cache-Control: private, no-cache`; bob sees no `lib2` dot and the region set `{g:Rock + its towns}` only; deleting a track row through a test handle with foreign keys on changes the ETag (the cascade, with no worker write); the mood bitset equals membership in `POST /db/recent/added {moods}` (seed `track_moods`); plays bytes after `rate`/plays; 409 on a stale rev; plays 403 for a jukebox token; `tracks` ids→rows returns `null` for bob on a `lib2` id (**no leak**); filepaths with and without a leading `/` map to the same id; the lib2 copy's path maps to its dot's representative; search finds artist, album and title; region centre and mix only visible, 404 for unknown and invisible keys; neighbours return distinct placed dots, exclude the seed, and skip a ranked candidate seeded with a vector but no point; a federation key → 403 on all six (in the pattern of `api-server-info.test.mjs:256-286`) |
| `test/unit/federation-auth.test.mjs` | Add the six map routes and the admin route to the refused list (`:59-76`) |
| `test/integration/api-server-info.test.mjs` | `discoveryMap === 1` on both routes |
| `test/integration/scan-status.test.mjs:94`, `test/integration/enrichment-status.test.mjs:38` | The kind list with `'map'` |
| `test/unit/worker-role-parity.test.mjs` | Automatic (`:42-75`) |
| `test/fixtures/map/land-v1.json` (new) | The shared land fixture: rings with a hole and a nested island, their land-v1 bytes, and the expected even-odd inside/outside for a grid of probe points. Phase 1's codec test writes and checks it; Phases 3 and 4 decode it and compare their fills |

**Perf guards** (deterministic):

1. `mapFitBudget` table tests.
2. The base-cache builder prepares its statements once per build, whatever n (a spy on the handle, n = 100 and n = 5,000), and yields between pages.
3. Two requests for one `rev` build once (single-flight plus the LRU).
4. Land bytes ≤ 16 KB per province on the ×10 proxy, and the hard caps.
5. The worker test's fit-cap case proves the fit never exceeds the cap in any mode.

### 3.13 Build and CI

- **`.github/workflows/build-bun.yml`:** add a **separate** step after the iroh step. The main smoke step has about 706 bytes left under GitHub's 21,000-byte expression cap (`:1471-1473`; a 20,294-byte run block measured). Each step starts a fresh shell, so the step derives its own `BIN`, as the iroh step does (`:2089-2104`):
  ```yaml
  - name: Smoke test music map worker
    # Proves the map worker module and umap-js are embedded: the import runs before validation.
    if: matrix.smoke
    shell: bash
    run: |
      set -e
      D=$(ls -d dist/stage/mStream-*-${{ matrix.key }})
      if [ -d "$D/mStream.app" ]; then BIN="$D/mStream.app/Contents/MacOS/mstream-server"; elif [ -f "$D/mstream-server.exe" ]; then BIN="$D/mstream-server.exe"; else BIN="$D/mstream-server"; fi
      OUT=$("$BIN" --mstream-worker=map '{}' 2>&1) || true
      echo "$OUT" | grep -q 'Invalid JSON Input' || { echo "$OUT"; echo "FAIL: map worker did not load (umap-js not embedded?)"; exit 1; }
  ```
  - The musl bundles are not smoke-run, but the code is pure JS.
- **PR checks are builds only.** Run the full suite locally on the merge tree before merging (about 2.5 min; memory: mStream repo merge settings).
- **Bun.** CI pins Bun 1.4.4, while the measurements used 1.4.3. The bun leg covers JSC and bun:sqlite.

### 3.14 Acceptance (Phase 1)

1. `npm test` is green locally on the merge tree with master, including the new suites and the bun leg. Lint is green; `npm run docs:api:validate` is valid.
2. **On a real staged server** (the demo library `S/demo-music`, 108 songs, real `effnet-discogs` model, two users with different libraries):
   - after the embedding pass settles, one map pass completes with `mode: rebuild, method: umap`;
   - `GET /map` returns provinces named by genre with land, and towns;
   - a repeat request is 304; the next UTC midnight does not change the ETag when no song is newer than 30 days;
   - the restricted user sees only their dots;
   - `tracks` maps the playing song's filepath to its dot;
   - `region` returns ≤ 50 visible songs in walk order;
   - `neighbours` returns 8 titled songs;
   - a rescan with no changes forks nothing, or runs a `mirror` pass that writes nothing (`rev` unchanged);
   - moving one file keeps its dot's position (same hash), and its new track id appears in the mirror after the drain.
3. A forced `kill -TERM` of the worker mid-fit leaves `GET /map` serving the previous layout; the next pass recovers. A `kill -9` (an unexplained death) is retried once with a halved fit cap.
4. **Model switch:** switch the model through `POST /api/v1/admin/db/params/discovery-model` (to `test-fake`, which every build registers) and let a partial re-embed run: the old map keeps serving (`model` shows the old id) until the settle, then one rebuild flips it. Switch back afterwards.
5. The bundle smoke step passes on the darwin, linux and windows bundles.
6. After a map pass, `discovery_meta.row_seq` and `index_epoch` are unchanged, and a P2P export snapshot contains no `map_*` table.
7. A v6.32.3 build opens this discovery.db with discovery on (the map tables are ignored), after restoring a pre-upgrade mstream.db.
8. The flag is 1 on ping and `/api/`; every map route answers 403 to a federation key.

### 3.15 Suggested work order (one branch, local commits; push only when the user asks)

1. Rebase `feat/music-map` onto master `54647827`.
2. Dependency, `map-lib.js`, `map-umap.js` and their unit tests.
3. The map tables and V81, the `track-hashes.js` move, `map-sync.js`, the hash-transition extension and their tests.
4. The worker, queue wiring, config, admin route and status surfaces, plus the worker and queue tests (Node and Bun).
5. Routes, flag and federation pins, plus the integration suite.
6. openapi and the CI smoke step.
7. The full suite on the merge tree, then staged acceptance (§3.14).

---

## 4. Phase 2: Webapp (mStream PR 2, stacked on PR 1)

### 4.1 Files

| File | Change |
|---|---|
| `webapp/alpha/music-map.js` (new, UMD `window.MUSICMAP`, CommonJS for node tests) | The pure core: decoders, view math, LOD, grid index, the name and badge placers, the palette, the trail fold, the highlight state reducer and the states reducer. Plus `mount(host, deps) → {update(state), destroy()}`, the DOM and canvas controller, injected with `deps` so it holds no globals |
| `webapp/alpha/m.js` | `mapPanel()`, `mapHide()`, the ping wiring, `PANELS_BY_STATE.map`, `MOODS.filters.map`, the mood dispatch, and the `deps` built from the existing verbs |
| `webapp/alpha/api.js` | `discoveryMapFetch(method, route, {query, body})`: raw `fetch` like `discoveryReq` (`:82-104`), but status-preserving: 403 → `{disabled:true}`, 404 → `{notFound:true}`, 409 → `{stale:true}`, 429 → `{busy:true}`, other non-OK or a network error → `null`, 2xx → the body. `discoveryReq` maps everything but 403 to `null`, which would hide the 409 and 404 that §4.6 acts on. Thin wrappers: `discoveryMap()`, `discoveryMapOverlay(layer, rev, moods)`, `discoveryMapTracks(body)`, `discoveryMapSearch(q)`, `discoveryMapRegion(key)`, `discoveryMapNeighbours(id)`; plus `statsHistory(query)` |
| `webapp/assets/js/mstream.player.js` | A finished-plays ring (≤ 50) fed in `endPlaySession` (`:114-124`), exposed as `MSTREAMPLAYER.stats.recentPlays()` beside `outbox()` (`:155-159`). Each entry records whether the song was a connected server's (the test `discoveryNowPlayingPath()` makes, `m.js:4400-4406`) |
| `webapp/alpha/vp.js` | `hotkeysSkip` (`:4778-4792`) adds `.mmap` to its `closest(...)` list |
| `webapp/index.html` | `#nav-map` directly above the Rated item (`:616`; after `#nav-discover`, `:612-615`, today, after `#nav-peer-recs` once #1088 lands); `#map-head` (`super-hide`) beside `#dpage-head` (`:874-877`); `<script src="alpha/music-map.js"></script>` directly above `alpha/vp.js` (`:1514`) |
| `webapp/alpha/spa.css` | A scoped `.mmap { --sea:#171a1f; --plate-edge:#2a2f37; --lit:#f5f7fa; --ring:#e6e8ec; --pin:#fa832b; … }` block, after the `.dmodal` token precedent (`:2450-2459`); `#filelist.mmap-on { overflow: hidden !important }` (beats `:481-486`); `@media (min-width:1200px) { body.map-open #browser.m6 { width:56.7% } body.map-open #playlist.m6 { width:43.3% } }`; cards and controls below `z-index` 100 (`#pop-f` is 100, `:822-831`); the live region reuses `.dm-sr` (`:3190`) |
| `webapp/locales/en.json` | The `map.*` group and `nav.map` / `panel.map` (§4.10) |
| `test/unit/webapp-music-map.test.mjs`, `test/unit/webapp-map-panel.test.mjs` (new) | §4.11 |

### 4.2 View integration

- **Nav:** `<div id="nav-map" role="link" tabindex="0" class="local-only side-nav-item my-waves super-hide" onclick="changeView(mapPanel, this);" data-panel="map">`, with the board's folded-map stroke icon (`M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z` + `M9 3v15M15 6v15`, `fill="none" stroke="#DDD"`, the Discover-icon precedent at `index.html:613`) and `<span data-i18n="nav.map">Map</span>`.
  - It is focusable, and Enter and Space open it (a keydown handler beside the `onclick`). The existing nav items are `div`s that cannot take focus; `S/plan/read-webapp.md` §4.5 notes that gap predates the map and need not be copied.
  - `mapPanel` sets `aria-current="page"` on it, and `mapHide` removes it.
- **The flag,** in `init()` beside `m.js:827-830`: `MSTREAMAPI.currentServer.discoveryMap = response.discovery === true && response.discoveryMap >= 1;` then toggle `#nav-map`'s `super-hide`.
- **`mapPanel()`,** on the `discoveryPanel()` pattern (`m.js:4450-4501`):
  1. `programState = [{state:'map'}]` **first**, as `discoveryPanel` does (`:4455`). `switchServer(null)`'s keep logic (`:7728-7731`) then lands back on the map instead of the peer's previous panel;
  2. the peer guard (`if (peerContext) { switchServer(null); return; }`, `:4456-4465`);
  3. `setBrowserRootPanel(t('panel.map'), false)`, which hides `#directory_bar`;
  4. show `#map-head`;
  5. `#filelist.classList.add('mmap-on')` and `document.body.classList.add('map-open')`;
  6. `MUSICMAP.mount(filelist, deps)`;
  7. guard every await with `browseGeneration` (`m.js:131`);
  8. on a 403 (`{disabled:true}`), hide `#nav-map` for the session and fall back to the File Explorer (the Sonic Path pattern, `m.js:6011-6016`).
- **`mapHide()`** cancels rAF and the building revalidation timer, disconnects the `ResizeObserver`, removes window listeners and the Vue watcher, and removes the classes and `aria-current`. It is called from `setBrowserRootPanel` (`m.js:414-448`), appended after the existing hide calls, as `typeof mapHide === 'function' && mapHide();`. The guard keeps the six sliced sandboxes working (`S/plan/read-webapp.md` §5). Any new `getElementById` there uses `?.`, as `:435` does.
- **Panel table:** `PANELS_BY_STATE.map = () => mapPanel()`, appended. Not in `PEER_CAPABLE_STATES` (`m.js:7662-7682`).
- **Toolbar** (`#map-head`, the Discover head pattern, `m.js:4846-4863`):
  - a Search icon button (`aria-label` `map.search`) that reveals an input;
  - Filters, via `moodPanelHtml('map')` (Discover's head, `m.js:4819-4821`, `:4888-4892`), shown when `songListMoods()` (`m.js:3448-3450`);
  - a spacer;
  - Plays heat (`aria-pressed`). It is hidden after a 403 on the plays overlay.

### 4.3 Rendering (canvas 2D)

- **The plate.**
  - It is a `position:relative` host filling `#filelist`: `<canvas role="img" aria-label="${t('map.label')}">`, a name-button layer, the controls, the card and one visually hidden live region (§4.7).
  - The plate is `#171a1f`, radius 8, with a 1 px `#2a2f37` edge.
  - **DPR:** backing store = CSS size × `devicePixelRatio`, then `setTransform(dpr,…)`. Recompute on a `ResizeObserver` and on a dpr change.
  - Pause at 0×0 (the column goes `display:none` behind the phone tab, `webapp/alpha/spa.js:59-63`).
- **View.**
  - Zoom 1 = the unit square fits the plate's shorter side minus 24 px; the range is 1–40.
  - The semantic thresholds are 1.8 and 5 (dir-A §2.6), relative to zoom 1.
  - Clamp so at least 20 % of the map stays in view.
- **Layers, bottom to top** (dir-A §2.1):
  1. **Land:**
     - per province, three `Path2D`s (coast, mid and high, from land-v1 in map units) are drawn under the view transform with `ctx.fill(path, 'evenodd')`;
     - fills are the dot colour mixed into the sea at 12 / 19 / 27 %, with a coast edge of 1 px at 42 %;
     - a province selection dims other land to 45 %.
  2. **Songs:**
     - **when more than 5,000 dots are in view:** an `ImageData` raster in an offscreen canvas, each dot a `(2·dpr)²` block in its province colour (alpha .88, dimmed .26), written in id order, then `drawImage` (0.6 ms at 100k in the bench, `S/plan/read-webapp.md` §4.3);
     - **otherwise:** vector dots of radius 1.5 / 2.2 / 3.6 px by zoom band, found through the grid index;
     - **overlay marks replace their song's dot** (§F): both paths skip the dots under trail stops, lit neighbours, path stops, the selected song and now playing, so a hollow quick-skip ring really reads as hollow.
  3. **Recent rings:** only at zoom ≥ 1.8, 1 px at r + 2.6 and 75 %; dimmed context rings at 25 %. Not on a trail stop, now playing or the selected song (§F). A lit neighbour that is recent keeps its ring, in white (`#f5f7fa`, r 7.2; A-W2's Goodbye 78), and its title sits past the ring.
  4. **Selection marks:**
     - lit neighbours and path stops: white r 4.2 with a 1.5 px sea outline;
     - the selected song: a reticle, a dot r 5 inside a 2 px ring r 10;
     - a selected province: its coast stroked 2 px white at 85 %.
  5. **The DJ trail:** only at zoom ≤ 1.05 and when nothing is selected or searched; r 2.4 `#fa832b`, opacity .35 → .90 from oldest to newest, quick skips as hollow 1.2 px rings. Above the songs, below the names and the pin.
  6. **Names:** an HTML button layer (below).
  7. **The pin:** a 16 × 23 teardrop in `#fa832b` with a halo r 8 at 22 %.
     - Off screen it becomes a chevron button on the plate edge (`aria-label` `map.goToNowPlaying` with `{{title}}`), which centres the pin when pressed.
  8. **Path badges:** 16 px `#2d333b` discs with a 10 px / 700 white numeral, about 15 px from the stop, on the side away from the neighbouring stops (σ 15 px).
     - Port the placer from `S/build/A-web/build.mjs:446-566`.
- **Names.**
  - Real `<button>` elements holding the label text, positioned by the placer: one layer, re-laid out on view changes. A region with `label: null` gets no button.
  - **Provinces** below zoom 1.8: Jura (weight 400 ships, so 700 renders synthetic bold, `S/plan/read-webapp.md` §1.7), uppercase via CSS, tracking .16 em, 13 / 12 / 11 px by visible `size` ≥ 400 / ≥ 60 / else.
  - **Towns** from 1.8: system 500 italic 12.5 px.
  - **Neighbour titles:** system 500 12 px `#e6e8ec`, 4.5 px past the dot (past the ring for a recent one), right first.
  - **Halo:** a 3 px `text-shadow` in the sea colour.
  - **The placer** (`S/build/A-web/build.mjs:569-590`; dir-A §2.5; §F):
    - 11 offsets, larger regions first;
    - obstacles: the pin, trail marks, path stops and badges, the card and the controls;
    - the visible-part rule (≥ 12 of the region's songs in view → their centroid);
    - the region centroid is tried before the 11 nudges;
    - skip a name when no spot is free.
  - `aria-pressed` on the selected name; `data-mm="r:<key>"` keeps focus across re-layouts.
- **Controls.** Follow is the 18 px locate-crosshair icon (§F Atlas web); the Zoom group is + over −. The song card's title row carries the reticle glyph (A-W2).
- **Colours from `hue`.**
  - `dot = oklch(.78, .115, h)`, `name = oklch(.88, .075, h)`. The land mixes are as above. A dimmed name is a solid mix into the sea that keeps 4.5:1. Port `S/dir-A/lib.mjs:24-41`, `:66-85`, **without `NUDGE`**.
  - Fixed colours: page `#1e2228`, sea `#171a1f`, lit `#f5f7fa`, ring `#e6e8ec`, pin `#fa832b`, controls `#2d333b` on `#444c56` (`S/dir-A/frames.json` `meta.palette.web`).
- **Redraw policy.**
  - Draw on demand, coalesced into one rAF; there is no idle loop.
  - During a gesture, draw the cached land+dots layer with `drawImage` under the delta transform plus the overlays. On gesture end, a full redraw. This follows the waveform's skip-identical-frame habit (`vp.js:5293-5321`).

### 4.4 Interactions

| Input | Does | Reuses |
|---|---|---|
| Drag; two-pointer pinch | Pan; zoom about the midpoint. Pointer Events with `setPointerCapture`, `touch-action:none` on the surface | New (no gesture code exists, `S/plan/read-webapp.md` §4.4) |
| Wheel, ctrl+wheel, trackpad pinch | Zoom about the cursor: `{passive:false}` plus `preventDefault()`. Ctrl+wheel is the browser's page zoom and Chromium's pinch | New |
| + / − buttons; keys `+` `=` `-`; arrows | Zoom about the centre (×1.5); arrows pan 10 % of the view | `hotkeysSkip` exempts `.mmap` |
| Hover a dot (zoom ≥ 1.8) or a lit dot | Tooltip `Title · Artist` from `POST /map/tracks {ids}`, cached (LRU 500) | — |
| Click a dot (8 px mouse / 22 px touch radius) | Select the song. `POST /map/neighbours {id}` gives the card plus up to 8 lit, named neighbours (placed songs only). The view frames the seed and its neighbours (zoom between 1.8 and 6), as W1 → W2. Follow turns off | Card verbs below |
| Click a lit dot or a neighbour title | It becomes the selection | — |
| Click a name | Select the province or town: the place card, titled with the name; `POST /map/region {key}` on select. A province dims the other land to 45 %, dots to 25 % and names to 55 %. If the anchor would sit under the card, ease it clear (Follow off; A-P2's rule) | — |
| Click the sea; Esc; the card's × | Clear the selection; the trail returns | — |
| Search (head) | Debounced 300 ms, ≥ 2 characters: `POST /map/search`. Lit = ids, the rest dims, the view frames them when ≤ 2,000 are lit. **Zero matches:** nothing lit and nothing dimmed. **`capped`:** light what came back. **Enter** selects `best`; while a Sonic Path end pick is armed, Enter answers the pick with `best` instead. A 429 keeps the previous highlight. Clearing the field clears the highlight | `m.js:6835-6858` debounce pattern |
| Song card: Play / Queue | `queueRow(null, fp, meta, MSTREAMPLAYER.positionCache.val + 1)` / `queueRow(null, fp, meta)` (`m.js:228-241`) | Discover's verbs (`m.js:5369-5372`) |
| Song card: ▾ | `createPopper3(el)` with the row's exact `pop-f` markup and `data-file_location` (`m.js:355-356`, `:904-946`; `vp.js:89-103`) | — |
| Song card: Auto DJ | `AUTODJ.setState({sonicEnabled:true}); AUTODJ.setSonicSeed(fp, title); MSTREAMPLAYER.playerStats.autoDJ ? MSTREAMPLAYER.autoDjKick() : MSTREAMPLAYER.toggleAutoDJ();` (`auto-dj.js:620-635`, `:763-773`; `mstream.player.js:1821-1854`). The current song and the queued rows play first (spec-fixes §5) | Decision 3 |
| Song card: Sonic Path | Start = this song. Arm `VUEPLAYERCORE.songCapture` (`vp.js:4844-4849`) and `showPickBanner(t('sonicPath.pickBannerEnd'), cancel)` (`m.js:5917-5937`). **No navigation away.** The next dot click (or Enter on a lit song, or Enter in search) answers the capture first (as `onFileClick` does, `m.js:598-616`), then `MSTREAMAPI.discoveryPath(start, end, SONICPATH.length)` (`api.js:131-139`), then `POST /map/tracks {filepaths}` gives the ids. Path state: badges, frame all stops, and the path card | Write the result into `SONICPATH` (start, end, rows, `view='results'`, `fetched=true`; `m.js:5872-5882`) so the Sonic Path panel lists the same journey (§F reading order) |
| Place / path card: Play | **Replace and start.** Fetch the mix first. Then, in one synchronous block with no `await`: `MSTREAMPLAYER.clearPlaylist()`, add row 0 with autoplay **on**, add the rest with autoplay off. With Auto DJ on, `clearPlaylist` starts the DJ's two-song bootstrap (`mstream.player.js:968-974`), but its first pick lands only after `await autoDJ()` (`:1806-1818`); row 0 is what starts, and one DJ pick follows the mix: the DJ carrying on after the queue. **Do not** call `sonicPathPlay(true)` (it cues the first song paused, `:910-917`; `S/plan/read-webapp.md` §2.1) or `clearAndPlay` (it replaces the playlist array, `:950-954`, which Vue binds by reference, `vp.js:908`, `:4541`, and no caller uses it) | Tested with Auto DJ off and on |
| Place / path card: Queue all | `discoveryQueueAll`'s loop (`m.js:5569-5582`) with metadata, then a toast via the existing `discover.modal.queued` key | — |
| Place / path card: Save as playlist | `openSavePlaylistModal(() => rows.map(r => r.filepath))` (`m.js:6036-6056`) | — |
| Place card: Auto DJ | The song card's Auto DJ, applied to `centre` | — |
| Follow (control) | On each now-playing change, `POST /map/tracks {filepaths:[fp]}` (cached per path) gives the id; ease (300 ms) so the pin stays in the middle 60 %, zoom unchanged. Any manual pan, zoom or selection turns it off | The now-playing signal: a bare Vue watcher on `MSTREAMPLAYER.playerStats.metadata.filepath` (`mstream.player.js:1324-1343`; the `vp.js:926-932` pattern) and `discoveryNowPlayingPath()` (`m.js:4400-4406`), which is `null` for peer songs |
| Plays heat | `GET …/overlay?layer=plays`: unplayed dots at 40 % opacity, played dots full, with the dot colour mixed toward the name colour by up to 40 % × √(plays / max plays in view) | — |
| Filters | `MOODS.filters.map` (`m.js:3363`); a change calls `GET …/overlay?layer=mood` and dims dots outside the mask to 26 %. A selection overrides the mood dim while it is up | Discover's `discoveryPickMood` dispatch (`m.js:3562-3588`) |

**The place card** has no board of its own (A-W3's lasso card is v2). It takes A-W4's path-card layout (420 px wide, `#2d333b` on `#444c56`, docked bottom-left): the region label as the title, Close, then Play / Queue all / Save as playlist / Auto DJ. It is `role="group"` named by the label.

**One highlight at a time** (§F):

- any selection (song, place, path or search) hides the trail;
- now playing always stays;
- the mood filter is a dim layer, not a selection.

#### 4.4.1 Songs with no dot (the same rules on all three clients)

A playing or listed song may have no dot: it is not analysed yet (a first backfill takes days on a Pi), it is embedded but not placed yet, or the map still shows the previous model's layout during a switch.

- **Pin:** no pin and no off-screen chevron. A pressed Follow stays pressed, and resumes on the next placed song.
- **Trail:** unplaced picks are skipped and do not count toward the 6.
- **Sonic path:** stops without a dot are not lit. Badges keep the path's own numbers, so gaps are allowed; the path card still lists and plays the whole journey.
- **Neighbours:** the server already skips dot-less candidates (§3.8.8). A `notAnalyzed: true` seed opens its card with nothing lit.
- **Search** answers dots only, so nothing changes there.
- **Unlabelled regions** (`label: null`) get no name and so no place card.
- **Selections across a refetch:** a song selection is held by its dot and a region by its `key`. After a refetch, the client re-resolves the song through the dot's new representative id. When the dot or the key is gone, the selection clears.

### 4.5 The DJ trail (webapp)

- **Sources:**
  - `GET /api/v1/stats/history?limit=50&origin=local` once per panel open (`origin` is one of `all|local|peers`, `src/api/stats.js:150`), filtered to `sessionId === MSTREAMPLAYSESSION.tabSessionId()` (`mstream.play-session.js:173-186`; the session survives reloads);
  - merged with `MSTREAMPLAYER.stats.recentPlays()`, which also holds unposted plays; entries for a connected server's songs are dropped.
- **`foldTrail(events, {nowPath, nowMs, gapMs: 30·60·1000, max: 6, djOnly: true})`:**
  - newest first; drop now playing;
  - stop at the first gap over 30 minutes, or at the first play that was not an Auto DJ pick (decision 2), so the trail always ends at now playing;
  - keep `source === 'autodj'`; skip songs with no dot (§4.4.1);
  - take 6 and return them oldest first;
  - quick skip = `outcome === 'skipped' && playedMs < 30000`.
- **Re-fold on every now-playing change** from the ring (history is read once per open).
- **Lookup:** filepaths → `POST /map/tracks {filepaths}` → ids.
- **When history is 403 or failed:** use the ring alone. A guest has no stats; the webapp never runs as a federation guest.

### 4.6 States (all three clients)

The web column is the spec; the phone and terminal sections (§5, §6) point here.

| Server answer or event | Web | Phone | Terminal |
|---|---|---|---|
| `building` | The sea plate and an indeterminate spinner, with no text. Revalidate every 30 s while the panel is open and visible (a 304 is cheap) | The sea and a `CircularProgressIndicator`, no text; revalidate every 30 s while the map is open | The field's ground alone; revalidate every 30 s while the room is open |
| `failed` | The plate, one line `map.failed` and Try again (`dpage.verb.tryAgain`), the Discover card pattern (`m.js:4829`) | One line and Try again, the Discover listing's failed pattern (`phone/lib/screens/discovery/discovery_listing.dart:51-52`) | One DIM line `gui.map.failed`, `Enter` tries again (`gui.discover.retry`) |
| `empty` | The plate and one line `map.empty` | The sea and `mapEmpty` | One DIM line `gui.map.empty` |
| `ready` with 0 dots | The plate alone | The sea alone | The ground alone |
| 403 on `GET /map` | Hide the nav entry for the session; fall back to the File Explorer | Show `discoverTurnedOff` (Discover's off line) and pin the flag false for the session, so the tile is gone on the next home build | Show `gui.discover.turned_off`; the room's gate goes false for the session (nav row absent, `Z` dead) |
| Network error or timeout | As `failed` | As `failed`; the fetch is skipped when the connectivity probe reports no network (§5) | As `failed` |
| 409 on an overlay | Refetch `GET /map` once (If-None-Match), then retry the overlay once; still 409 → drop the overlay until the next user action or revalidation | Same | Same |
| 404 on `region` or `neighbours` | Refetch `GET /map` once, then clear the selection | Same | Same |
| `layout.frame` or `model.id` changed on a refetch | Reset the view to the whole map; re-resolve selections (§4.4.1) | Same | Same |
| Unknown `points.format` or `layout.landFormat` | Treat as 403 for the session | Same (a disk cache meeting a newer server) | Same |
| 403 on the plays overlay | Hide Plays heat for the session | Hide Plays heat | Hide the `heat` word and make `x` dead |
| 429 on search | Keep the previous highlight | Same | Same |
| Peer view | Nav hidden by `.local-only` (`spa.css:2948-2950`). `switchServer` never stays on `map` (`m.js:7716-7745`); `mapPanel()` on a peer returns home | Flag pinned false for a federated server | Gate false for a peer session |

**Revalidation triggers.** Web: panel open, a server switch, `visibilitychange` to visible, after a 409 or 404, and the 30 s building timer. Phone: map open, app resume, a server switch or reconnect, after a 409 or 404, and the building timer. Terminal: room open, reconnect, after a 409 or 404, and the building timer. There is no other polling.

### 4.7 Keyboard and accessibility (web)

- **The drawing** is `role="img"`, with `aria-label` `map.label` ("Music map").
- **The entry** is reachable: `#nav-map` is focusable and opens on Enter or Space (§4.2).
- **Buttons over the drawing:** names, lit songs (neighbours and path stops) and neighbour titles are focusable buttons with stable `data-mm` keys (`r:<key>`, `s:<id>`). A lit song's button is named `Title · Artist`, composed from its metadata (no new string). Path stops sit in path order.
- **Controls** are buttons with `aria-label` and `aria-pressed`: Follow, Zoom in, Zoom out (a group "Zoom"), Plays heat, and the off-screen chevron (`map.goToNowPlaying`).
- **Cards** are `role="group"` named by the song title, the region label, or "Sonic Path" (A-W2, A-W4).
- **Tab order:** the head controls (Search, Filters, Plays heat), then the map controls (Follow, Zoom in, Zoom out, the chevron when shown), then the names, then the lit songs, then the card.
- **Focus:** opening a card (a click or Enter on a name, a dot or a lit song, or Enter in search) moves focus to the card's first verb. Esc or × clears, and focus returns to the opener (the Discover pattern, `m.js:3518-3524`), or to the canvas host when the opener is gone after a re-layout.
- **Keyboard routes:** to a song, Search, type, Enter (it selects `best`); between songs, Tab through the lit songs and Enter; to answer an armed Sonic Path end pick, Enter on a lit song or Enter in search.
- **Live region:** one visually hidden `.dm-sr` `role="status"` element in the map host (precedents `webapp/index.html:1260`, `spa.css:3190`). It says the selection's `Title · Artist`, the place's label, or the path title (`map.pathTitle`). Screen-reader only: no visible text.
- **Reduced motion:** under `prefers-reduced-motion: reduce` (precedent `spa.css:3186`), Follow, the search fly and framing jump instead of easing.
- **Focus ring:** `outline: 2px solid #fa832b` (`spa.css:868`).

### 4.8 Performance (webapp)

| Measure | Budget |
|---|---|
| Decode of 100k points | ≤ 5 ms (typed views, no loop) |
| First full draw at 100k | ≤ 100 ms on M-series |
| Gesture frames | ≤ 16 ms (the cached layer) |
| Full redraw at 100k | ≤ 50 ms |
| Memory | ≤ 30 MB at 100k (grid index + buffers) |

The module stays under 80 KB and loads eagerly beside `discovery-page.js` (`S/plan/read-webapp.md` §6). The draft's 60 KB did not survive the build: the core is about 40 KB and the controller about 36 KB (26 KB gzipped together), in line with `discovery-page.js` (69 KB) and `auto-dj.js` (67 KB), which also load eagerly. Lazy-loading the controller was weighed and not taken: it adds an async load path for about 6 % of the eager JavaScript.

### 4.9 Phone widths (no board)

- At ≤ 768 px the side nav goes off-canvas.
- At ≤ 600 px the map fills `#filelist` behind the browser tab (`index.html:820-827`).
- Touch gestures apply; the cards are full width (`max-width: calc(100% - 24px)`) and the controls stay top-right.
- No new design.

### 4.10 i18n (`webapp/locales/en.json` only)

| Key | English |
|---|---|
| `nav.map` | Map |
| `panel.map` | Map |
| `map.label` | Music map |
| `map.search` | Search |
| `map.playsHeat` | Plays heat |
| `map.follow` | Follow what's playing |
| `map.zoom` | Zoom |
| `map.zoomIn` | Zoom in |
| `map.zoomOut` | Zoom out |
| `map.play` | Play |
| `map.queue` | Queue |
| `map.queueAll` | Queue all |
| `map.saveAsPlaylist` | Save as playlist |
| `map.autoDj` | Auto DJ |
| `map.sonicPath` | Sonic Path |
| `map.songMenu` | Song menu |
| `map.goToNowPlaying` | Go to now playing, {{title}} |
| `map.pathTitle` | {{start}} → {{end}} |
| `map.empty` | Your map appears once songs are analysed. |
| `map.failed` | The map couldn't load. |
| `map.pass` | Music map *(from Phase 1)* |

- Reused keys: `modal.close`, `moods.filters`, `sonicPath.pickBannerEnd`, `sonicPath.playlistSaved`, `discover.modal.queued` and `dpage.verb.tryAgain`.
- **No hint, count or caption strings.**
- A `map.*` group of its own keeps the per-feature key-set tests clean (`test/unit/webapp-discovery-panel.test.mjs:46-47`).

### 4.11 Tests (node `--test`; no browser harness exists)

- **`test/unit/webapp-music-map.test.mjs`:**
  - decoders (cols-v1, land-v1 including the shared fixture `test/fixtures/map/land-v1.json`, bitset; truncated blobs rejected);
  - view math: zoom about a point keeps it fixed; clamps; fit;
  - semantic bands at 1.8 and 5;
  - grid nearest-within-radius;
  - the name placer: no overlaps, obstacles, the visible-part rule, the centroid retry, no button for `label: null`;
  - the badge placer: no collisions;
  - recent-ring visibility rules, the white ring on a lit recent neighbour;
  - overlay marks replace their dots (the reducer's dot mask);
  - the palette: hue 180 → dot `#52cfba` (dir-A §2.3 table); names ≥ 4.5:1 on `#171a1f`;
  - `foldTrail`: session filter, 30-minute gap, the stop at the first non-DJ play, 6 before now playing, quick skip, peer entries dropped, the merge of unposted plays, the 403 fallback;
  - the no-dot rules (§4.4.1): no pin, Follow resumes, path badges keep their numbers, selection re-resolved by dot and key;
  - the highlight reducer (the §F transitions) and the states reducer (§4.6: one 409 retry then hold, one 404 refetch, unknown format → disabled, the building timer).
- **`test/unit/webapp-map-panel.test.mjs`**, which slices like `webapp-discovery-panel`:
  - `mapPanel` sets `programState` before the peer guard, and on a peer calls `switchServer(null)`;
  - `map` is in `PANELS_BY_STATE` and not in `PEER_CAPABLE_STATES`;
  - `init()` toggles `#nav-map` from the flag; `#nav-map` has `tabindex="0"` and opens on Enter and Space;
  - `index.html` order (`#nav-map` directly above Rated) and classes, and the script tag directly above `vp.js`;
  - `en.json` has exactly the `map.*` keys used;
  - `discoveryMapFetch` maps 403/404/409/429;
  - card verbs: Play → `queueRow(…, +1)`; place Play runs `clearPlaylist`, row 0 with autoplay on and the rest off, with no await in between, and row 0 starts with Auto DJ on and off; Auto DJ → `sonicEnabled` + `setSonicSeed` + toggle/kick;
  - stale answers dropped after a `browseGeneration` bump;
  - the live region's text per selection; reduced motion → no ease;
  - `hotkeysSkip` covers `.mmap`. It passes `test/unit/webapp-discovery-page.test.mjs:1784-1802`.
- **Guards:** `setBrowserRootPanel` still calls `discoveryHideHead()` (`webapp-discovery-panel.test.mjs:1829`), and the six sandboxes pass with the guarded `mapHide`.

### 4.12 Acceptance (Phase 2)

1. The unit suites are green.
2. **By hand in the browser pane** against the Phase 1 staged server (demo library, real model, a restricted user), at 1440 × 900 and at 375 px:
   - the whole map with the trail (Main);
   - a selected song with 8 named neighbours (A-W2);
   - a selected province and its place card, with Play starting playback, with Auto DJ off and on;
   - a Sonic path with numbered stops and no line (A-W4);
   - Follow and the off-screen pin, and a playing song with no dot (no pin);
   - search lighting an artist; zero matches dim nothing;
   - mood dims and plays heat;
   - recent rings from 1.8;
   - each state of §4.6 (empty on a fresh server; building during the first pass; failed through `MSTREAM_TEST_MAP_FORCE_GUARD` on the staged server);
   - a peer switch leaving the map;
   - a keyboard-only walkthrough (open the Map from the nav, search, Enter, Tab to a neighbour, answer a Sonic Path pick), and a screen-reader pass of the live region;
   - no console errors.
3. The map does not restyle the Now Playing column. The blue active row, the 5 header icons and "More like this" stay as they are (`S/plan/read-webapp.md` §8.8).

---

## 5. Phase 3: Phone (mstream_music PR; branch from master; never `dart format`)

All anchors are from `S/plan/read-clients.md` §1, checked at `phone/…`.

| Area | Plan |
|---|---|
| **Flag** | `bool? discoveryMapAvailable` beside `discoveryPathAvailable` (`phone/lib/objects/server.dart:49-60`; `fromJson` `:429-460`, `toJson` `:501-511`). Parse `features['discoveryMap'] >= 1 && discovery` in `_applyServerInfo` (`phone/lib/singletons/server_list.dart:526-574`) and the ping fallback (`:600-626`). Pin it false in `_applyFederatedDefaults` (`:2646-2668`). Add it to the change diff and the home refresh (`:420-457`) |
| **Entry** | A "Map" tile with `Icons.map_outlined` under LISTEN after Discover (`phone/lib/singletons/browser_list.dart:426-443`), gated by the flag. The tap branch next to Discover's (`phone/lib/screens/browser.dart:160-168`) calls `MapListing().open(server)`: a frame with one sentinel item of type `mapCanvas`. `Browser` returns `MapView` from the same slot (`browser.dart:1513-1524`). A label case goes in `phone/lib/l10n/enum_labels.dart:121-160`. The server-switch reset comes for free (`browser_list.dart:328-345`) |
| **Back** | The `PopScope` branch (`phone/lib/main.dart:946-981`) clears a selection or sheet before it leaves the map |
| **Sub-bar** | A Map branch before the generic one (`phone/lib/widgets/browser_toolbar.dart`, before `:601`): Back (`popBrowser`), "Map", Plays heat (`Icons.trending_up`, pressed state), Filters (`MoodFilterButton`, `phone/lib/widgets/mood_filter_sheet.dart:54-84`) and Search (`openSearch` → `LocalSearchBar`; the map reads `BrowserManager().search.query`, debounced) |
| **Body** | `MapView` = a `Stack`: `RepaintBoundary(ExcludeSemantics(CustomPaint(MapPainter)))`; invisible 44 pt name buttons (`max(44, width + 6)` wide, `aria-pressed`); the Follow button (44 × 44, `#2a2a2a`, 1 pt `#4a4a4a`, `Icons.my_location` amber when on, at A-P1's position, docking centred on the sheet's top edge at x 342 when a sheet is up, per A-P2 and §F); the **in-body** sheets below; and `MoodFilterStrip` at the top when a filter is set (`mood_filter_sheet.dart:407-450`). The mini-player is untouched (`main.dart:992-1000`). The painter is excluded from semantics (§F: `aria-hidden` on the phone, although A-P1's markup draws `role=img`); names, lit songs and Follow are the semantic buttons |
| **Place sheet** | A-P2: `#242424`, top radius 16, a 36 × 4 handle, the title, Close 44 × 44, four 56 pt round buttons labelled Play / Queue / Save / Auto DJ (`Icons.all_inclusive` for Auto DJ, §F), with full accessible labels "Play all", "Queue all", "Save as playlist", "Auto DJ from here"; header-only drag-to-dismiss as in `phone/lib/widgets/discover_queue_bar.dart:335-336`. When the selected province's anchor would sit under the sheet, the view eases it clear (A-P2: land y 341 → 311); Follow turns off |
| **Song sheet** (the song card; §1.3) | The place sheet's container: the song title, the artist, Close, a ⋯ (44 pt) that opens `showTrackActionsSheet(context, item)` unchanged (`phone/lib/widgets/track_actions_sheet.dart:35-49`), and four round buttons labelled Play / Queue / Auto DJ / Sonic path (`Icons.route`, the Sonic path tile's icon, `browser_list.dart:431`), with full labels "Play now", "Add to queue", "Auto DJ from here", "Play a path to…". **Selection state:** the view frames the seed and its neighbours in the band between the sub-bar and the sheet's top (zoom 1.8–6); neighbour titles are drawn 4.5 pt past their dots (right first), each with an invisible button 44 pt tall and `max(44, title width + 6)` wide; tapping a title or a lit dot selects that song; the selection stays lit and named until the sea, Close, Back or another song clears it; Follow docks on the sheet's top edge |
| **Path sheet** | The same container: the title "‹start› → ‹end›" (`mapPathTitle`), Close, and three round buttons Play / Queue / Save (full labels "Play all", "Queue all", "Save as playlist"). No Auto DJ or Sonic path verb (§F path card) |
| **API** | In `phone/lib/singletons/api.dart`: `fetchMap(server, {etag})` (GET with `If-None-Match`, a **60 s** timeout; the default 15 s is too short over a tunnel, `api.dart:1032-1061`), `fetchMapOverlay`, `postMapTracks`, `postMapSearch`, `postMapRegion`, `postMapNeighbours`, each returning the status classes of §4.6 (403, 404, 409, 429). Decode in `compute` (`phone/lib/util/decode_json.dart:12-20`): base64 → `Uint8List` → `Uint32List.view`/`Uint16List.view` (aligned cols-v1) → per-province `Float32List` buckets plus a grid index; land blobs checked against their counts. Disk cache keyed by server id and `rev` (`path_provider`), sent back as `If-None-Match` |
| **Offline** | `fetchMap` is skipped when `hasConnectivity()` (`phone/lib/util/connectivity_probe.dart`) reports no network, so there is no 60 s wait; the map shows the failed line with Try again. The disk cache saves bandwidth only: a 304 reuses it, and a failed fetch never draws a stale map whose verbs would all fail. An offline map is v2 (§1.2) |
| **Painter** | Land `Path`s with `PathFillType.evenOdd`, under `canvas.transform(view)`. Dots: one `drawRawPoints(PointMode.points, …)` per province bucket with `StrokeCap.round` and `strokeWidth = diameter / scale`; the dots under overlay marks are left out (§F). Dims are two passes (25 % first). Recent rings from 1.8; a lit recent neighbour keeps a white ring. The pin (12 × 18 pt). The trail (r 2.2 with a 0.6 pt sea edge; skip ring r 2.4 at 1.2 pt). Path badges. Names through the placer with `TextPainter`; no name for `label: null`. `shouldRepaint` compares a version counter only |
| **Colours** | Mix into `VelvetColors.bg` at runtime (`phone/lib/theme/velvet_theme.dart:176-334`). The Light palette forces the dark sea inside the body (decision 4). The pin keeps the primary colour; its shape and sea outline separate it from Velvet's violet province |
| **Gestures** | One `GestureDetector`: `onScaleStart/Update/End` (pan and pinch) and `onTapUp` (a 24 pt hit radius through the grid). No double-tap (decision 5). No lasso (v2) |
| **Now playing** | `MediaManager().audioHandler.mediaItem` guarded by `discoveryNowPlayingPin(server)` (`phone/lib/screens/discovery/discovery_listing.dart:89-100`), then the lookup, then the pin or the off-screen chevron (label `mapGoToNowPlaying`). Follow as on the web. The no-dot rules of §4.4.1 apply |
| **Trail** | `PlayTracker().recent` and `.events` (`phone/lib/singletons/play_tracker.dart:252-265`); after a restart, `PlayHistory().events()` (`phone/lib/singletons/play_history.dart:531-545`). Filter by `track.server == server.localname` **and `peerId == null`** (`phone/lib/objects/play_event.dart:35`); stop at a 30-minute gap or the first play that is not `PlaySource.autodj` (decision 2); 6 before now playing; quick skip = `skipped && playedMs < 30000`. Re-fold on every now-playing change |
| **Verbs** | `playNow` / `addNext` / `addToQueueEnd` (`phone/lib/util/queue_actions.dart:311-339`). Place: `playFromHere(rows, 0)` (`:211-254`), `addRowsToQueue(rows)` (`:259-274`), `PlaylistPickerSheet` + `ApiManager().savePlaylist` (`phone/lib/screens/discovery/discovery_widgets.dart:139-165`). **Auto DJ:** extract `_startSonicSession` (`phone/lib/screens/discover_screen.dart:464-519`) into a shared helper used by Discover and the map; the map's call does not `Navigator.pop()`. **Sonic path:** a `TrackCaptureRequest` with `returnScreen: null` whose `onPicked` calls `fetchDiscoveryPath(…, length: 14)` (`api.dart:1143-1162`), then the lookup, then the path sheet. **Dot taps try `TrackCapture.tryCapture(item)` first** (`phone/lib/singletons/track_capture.dart:58-80`) |
| **Search** | The map reads `BrowserManager().search.query` (debounced 300 ms, ≥ 2 characters): lit = ids, the rest dims, the view frames them when ≤ 2,000 are lit; zero matches dim nothing; `capped` lights what came back; the keyboard's search action selects `best`, or answers an armed Sonic path pick |
| **Moods** | `MoodPage.map` (`phone/lib/objects/mood_filter.dart:203-212`); `showMoodFilterSheet`; the overlay request |
| **States** | §4.6's phone column. A 403 shows `discoverTurnedOff` (`phone/lib/l10n/app_en.arb:1772`) and pins the flag false for the session |
| **Strings** | `app_en.arb` with metadata, plus the other nine ARBs (the repo's convention: recent keys exist in all ten), plus the regenerated `app_localizations*`. **New:** `mapTitle` "Map", `mapPlaysHeat` "Plays heat", `mapFollow` "Follow what's playing", `mapPlay` "Play", `mapQueue` "Queue", `mapSave` "Save", `mapAutoDj` "Auto DJ", `mapSonicPath` "Sonic path", `mapAutoDjFromHere` "Auto DJ from here", `mapGoToNowPlaying` "Go to now playing, {title}", `mapPathTitle` "{start} → {end}", `mapEmpty` (decision 6), `mapFailed` "Couldn't load the map.". **Reused:** `close` (`:1027`), `playAll` (`:510`), `queuePlayNow` (`:12`), `tapAddToQueue` (`:68`), `discoverQueueAll` (`:1748`), `discoverPageSaveAsPlaylist` (`:1612`), `discoverPlayPathTo` (`:1892`), `discoverPageRetry` (`:1666`), `discoverTurnedOff` (`:1772`), `moodFilters` (`:887`), `browserSearch` (`:1018`) |
| **Tests** | `phone/test/util/map_payload_test.dart` (decode, buckets, hit radius, trail fold with the peer and first-non-DJ rules, palettes per theme, the shared `land-v1` fixture's even-odd fill against its expected probe grid); a painter `shouldRepaint` test (the `phone/test/screens/eq_curve_test.dart:91-102` pattern); `phone/test/screens/map_listing_test.dart` through the real `Browser` with the fetch injected (`discovery_listing_test.dart:37-70`): the song sheet keeps neighbour titles tappable, the offline open makes no request, failed and Try again, 403 → the off line and the flag pinned false, a 409 retried once. Run `flutter analyze` and `flutter test` locally: the repo has no PR CI |
| **Acceptance** | In the iOS simulator against the staged server: A-P1 (whole map, Follow on, mini-player visible) and A-P2 (Jazz selected, in-body sheet, Follow docked), a selected song with named, tappable neighbours above the song sheet, plus every verb, search, moods, heat, trail and the states, including an offline open (no 60 s wait). A federated server shows no Map tile |
| **Performance** | Decode off the UI isolate, ≤ 300 ms at 100k. Paint ≤ 16 ms per frame at 20k on a mid device; at 100k, LOD buckets keep it smooth |

---

## 6. Phase 4: Terminal (player PR → player release → mStream pin bump)

All anchors are from `S/plan/read-clients.md` §2, checked at `player/…`. Use `cargo +1.98.1` and branch from `origin/main` (memory: local `main` is stale).

| Area | Plan |
|---|---|
| **Contract first** | `player/docs/ux-contracts/music-map.md` in the format of `player/docs/ux-contracts/README.md:19-61`: Header, Intent, Entry points, **States & flows** (§4.6's terminal column), Behavior contract, **Wording** (the table below), Out of scope, Translation notes, Deviations log. **Design of record:** this plan; `S/dir-A.md` §2.4–§2.7, §3.4 and the T1/T2 frames (`:548-829`), as corrected by `S/spec-fixes.md` §6, §7 and §10; boards A-T1/A-T2; `S/connections.md` §C (floors, glyphs) and §F. **Deviations from dir-A:** `Z` not `W`, `f` not `/`, no double-click, no `v` box select in v1, heat changes step weights only (no re-terracing) |
| **Flag** | `#[serde(rename = "discoveryMap")] discovery_map: u32` (default 0) on `Ping` (`player/src/api/types.rs:80-141`), mirrored into `Capabilities` (`:297-357`) and the layered `/api` composition for peers (pinned false). Gate: `discovery && discovery_map >= 1 && app.session.peer.is_none()`, as `discover::gate` (`player/src/gui/discover.rs:362-364`) |
| **Room** | `NavId::Map`: `NAV` grows to 15 (index 14, no digit; `player/src/gui/mod.rs:404-454`). Label `gui.nav.map`; `const MAP_NAV`; `mod map;` plus the `MapUi` field; `Act::Map`; the draw, wheel, reconnect and tips arms (exhaustive matches; `mod.rs:1679-1694`, `:3756-3786`, `:3614-3656`, `:1817-1834`). The **nav row is 18**, absent whenever `set_y ≤ 18` (`mod.rs:1981-2055`; spec-fixes §7). **`Z` opens it** next to `G` (`mod.rs:2869-2871`) and is dead while gated |
| **Room layout at every size** | The room is `content_rect` (`mod.rs:1573-1583`): 47 cells wide with the queue open, 80 folded, rows 2 to `set_y`. Row 2 is the header. While a song, place or path is selected, the **card line takes the room's last two rows**; the field is everything between the header and the card line (or the room's bottom). At 100×30: field rows 3–24, or 3–22 with a card line (A-T1, A-T2). At 100×24 with the footer off: room rows 2–18, field 3–18, or 3–16 with a card line. Footer on: rows 2–17, field 3–17, or 3–15. The unit square fits the field's shorter side in ▀ pixels, centred; the view's centre and zoom do not change when the card line appears |
| **Keys** | **Not a browse room** (`mod.rs:3691-3705`). Its own `map::handle_key` sits beside Discover's (`mod.rs:2822`). Arrows move the cursor (names at ×1–×4, songs from ×8; at ×1–×4 with no name in view, songs; the view follows); `[` `]` zoom; Enter/`P` play now on a song, and **on a name open the place card line** (never play); `N` add next; `a` add to end; **`m` (claimed) opens the song's sheet** via `actions::open_for` (`player/src/gui/actions.rs:151-157`); `d` Auto DJ from here; `j` Sonic path to…; `c` Follow; `x` heat; **`f`** opens the header filter field (map-local, `text_field`): Enter in it selects `best` or answers an armed Sonic path pick, and zero matches dim nothing; **`o`** moods (MAP_NAV arms in `player/src/gui/moods.rs:135-155`, `:178`, `:280-293`); `p` / `A` / `S` / `s` only while a place or path mix is selected (Discover's gating, `discover.rs:3082-3094`). Esc clears; a map-owned capture is caught before the generic Esc (`mod.rs:2795-2806`) |
| **Mouse** | Click a song cell to select; click a name for the place card line; **click an overview pixel (×1–×4) to zoom ×4 about it** (dir-A T1); right-click for the sheet; wheel to zoom about the pointer; drag to pan (where drags are reported); click the edge marker = `c`. No double-click (decision 5). No Shift+drag (no modifiers on drag regions, `player/src/kit/mod.rs:756-767`) |
| **Capture** | A new `Capture::MapPathEnd` (the `TasteSeed` precedent, `player/src/tui/app.rs:1674-1677`) whose banner reuses `gui.sonic.pick_banner_end` (`player/locales/en.yml:1704`). Wrap `answer_capture` and `dj_seed_chosen` in `pub(crate)` (`player/src/tui/app/sonic.rs:539-557`, `player/src/tui/app/autodj.rs:357-399`) |
| **Drawing** | The ▀ field (`player/src/tui/canvas.rs:35-162`): bin the points in view into pixels with the majority province colour; the density step by rank cuts at the 18th / 35th / 73rd percentile among lit pixels in view (spec-fixes §3); unlit land pixels take shore tints, rasterised from land-v1 with an even-odd scanline. From ×8, one glyph per song (`•` / `◦` recent) on a land tint. **Overlay marks replace their song's pixel or glyph** (§F). The selected song: `•` ON-ACCENT bold on an ACCENT background; lit neighbours `•` (`◦` if recent) in TEXT bold. **Names:** provinces bold, towns regular, knocked out with one blank cell of halo on each side; one cell clear of trail cells; never on the field's first or last row; town names placed after neighbour titles; a neighbour title takes the side with fewer marks and letters on the rows above and below, ties right; no name for `label: null`. **The pin cell:** `•` in ON-ACCENT on OK, with a ground cell on each side. Edge markers `▴▾◂▸` in OK bold. **Trail:** `●` pick / `○` quick skip in OK blended into the ground; a skip keeps 60 % of its step; the newest owns a shared cell; on the named-ANSI floor, the three newest picks Green and older ones DarkGray (`S/connections.md` §C). Path digits beside the stops. **Every map cell sets its background explicitly**: the ground on the fixed tiers, the terminal's own background on the named floor. Legacy glyph stand-ins per `S/connections.md` §C. The no-dot rules of §4.4.1 apply |
| **Palette** | `player/src/gui/map_palette.rs`, a pure `(tier, hue) → colours` function: OKLCH → sRGB with dir-A's terminal constants (`S/dir-A/make-dir-A.mjs:32-48`); the nearest xterm-256 index in 16–255 (new helper); the named floor `░▒▓█` in DarkGray / default fg. Add a public tier accessor to `player/src/kit/theme.rs` (`fn tier()` is private, `:210`). Without OSC 11 ownership on the fixed tiers, paint the field's own ground plate (§1.3) |
| **Client** | Types plus calls in `player/src/api/mod.rs`. **The map GET is a new conditional helper:** `send_within` (`:651`) → `send_request` (`:684`) → `request()` (`:698`) sets only the token and body, so it can neither send `If-None-Match` nor take a 304. `get_map(etag: Option<&str>) -> Result<Option<MapPayload>, ApiError>` builds on `request()` with the header and its own ceiling, `map_ceiling()` = 60 s native and `None` on wasm in the `daemon_ceiling` style (`:44-55`); it calls `read_answer` and returns `Ok(None)` on 304 before `answer_of` decodes (`:776-784`). The ETag is the body's `rev`, quoted. Base64 is decoded in **native-only** code: `base64` lives in the `cfg(not(wasm32))` section (`player/Cargo.toml:118`, `:232`). `ApiCmd`/`Event` pairs `MapLoad`, `MapOverlay`, `MapTracks`, `MapSearch`, `MapRegion`, `MapNeighbours` (`player/src/tui/worker.rs:99`, `:750`, `:1864`), each with an arm in `player/src/web/api_worker.rs` (exhaustive, `:66-384`) answering "not supported". Keep the decoded payload plus its ETag in memory for the session |
| **State** | `player/src/tui/app/map.rs`: payload, regions (keyed by `key`), the lookup cache, selection (held by dot and key, §4.4.1), neighbours, path, and a trail ring fed at `stats_end` (`player/src/tui/app/stats.rs:399-404`; `source` `:284-291`; `MIN_POST_MS` `:18`) only for plays whose `origin.peer` is none. The ring starts empty after a restart: the trail is this session's DJ picks. The fold stops at the first non-DJ play. The pin is drawn only for a song whose origin has no peer, the twin of the web and phone guards |
| **Verbs** | Sheet `actions::open_for`; play now / add next `App::queue_track_next` (`app.rs:4415`); add to end (the `taste_append` pattern, `player/src/tui/app/taste.rs:820-830`); place play `replace_queue` + `play_index(0)` (`taste.rs:780-790`); queue all (`:794-797`); save (`playlist_save_files` + the name prompt, `taste.rs:804-816`); Auto DJ via the `dj_seed_chosen` wrapper; Sonic path via `build_sonic_path` (`sonic.rs:581-600`), with stops lit through the lookup and the Sonic room's list staying the reading order |
| **Strings** | `gui.map.*` and `gui.tips.map` in all 10 YAMLs (the repo's convention; rust-i18n falls back to `en`, `player/src/main.rs:227`), plus `gui.nav.map`. Glyphs live in code, never in locales |
| **Tests** | `TestBackend(100, 30)` renders of A-T1 (queue open, ▀ field, names, pin, trail) and A-T2 (queue folded, glyph per song, named neighbours, card line); **`TestBackend(100, 24)` renders of A-T1 and A-T2 with the footer off and on**, including the 47-cell room with the queue open, the card line on the room's last two rows and no name on the field's first or last row; the row-18 absence at 100×24 and at 100×25 with the footer; `Z` dead while gated; an overview click zooms ×4; Enter on a name opens the place line; the cursor falls through to songs when no name is in view; the state lines; legacy glyph pins; palettes per tier; App unit tests for the trail fold (peer and first-non-DJ rules), the peer pin guard and the lookups; the shared `land-v1` fixture's scanline fill against its probe grid; an e2e leg against the fake server, taught the map routes, including the 304 path of `get_map` |
| **Release** | (1) mStream PR 1 merged, with the flag on both payloads. (2) Player PRs green on the 3-OS CI, including the wasm32 build; **measure the release build** before tagging (the rust-i18n wasm OOM history). (3) Tag; the notify hook opens the pin-bump PR on `bin/mstream-player/manifest.json` (`.github/workflows/update-mstream-player-manifest.yml:1-25`; approve bot runs with `gh api …/runs/<id>/approve` if needed). Merge it. (4) An mStream release: tag the "ci: update pre-built" commit, not the bump (memory: release ritual), with release notes carrying §7.5 (the V81 downgrade barrier, the map tables, and the advice to turn compression on for large libraries) |
| **Performance** | Binning ≤ 5 ms per frame at 100k; a fixed redraw only on input or a state change |

**Terminal wording** (English; the contract's Wording section):

| Where | Text | Key |
|---|---|---|
| Room header | `Map` | `gui.nav.map` |
| Header filter | `/ filter`, tooltip "/ filter — f" | the browse bar's (`gui.bar.filter`, `player/locales/en.yml:1355`; tooltip pattern `mod.rs:2196-2201`) |
| Header toggles | `heat`, `follow`, `mood`, right-aligned; DIM when off, OK bold when on | `gui.map.heat`, `gui.map.follow`, `gui.map.mood` |
| Toggle tooltips | "Plays heat — x", "Follow what's playing — c", "Moods — o" | `gui.map.heat_tip`, `gui.map.follow_tip`, `gui.map.mood_tip` |
| Song card line, row 1 | the title (ACCENT bold), the artist (DIM), then `[▸] [»] [+] [⋯]` (play now, add next, add to end, sheet; DIM at rest, BRIGHT under the pointer) | data; glyphs in code; the rows' existing hover-verb tooltips |
| Song card line, row 2 | `auto-dj from here`, `sonic path to…` (text buttons in DIM) | `gui.map.dj_from_here`, `gui.map.path_to` |
| Their tooltips | "Auto DJ from here — d", "Sonic path to… — j" | `gui.map.dj_from_here_tip`, `gui.map.path_to_tip` |
| Place card line | row 1: the place label in ACCENT bold; row 2: `▸ play · + queue all · save as playlist… · auto-dj from here` | data; `gui.bar.play`, `gui.bar.queue` (`en.yml:1353-1354`), `gui.discover.save_playlist` (`:1773`), `gui.map.dj_from_here` |
| Path card line | row 1: `‹start› → ‹end›` in ACCENT bold; row 2: `▸ play · + queue all · save as playlist…` | `gui.map.path_title` ("%{start} → %{end}"); the same reused words |
| Empty | "Your map appears once songs are analysed." | `gui.map.empty` |
| Failed | "couldn't load the map", then `Try again` (Enter) | `gui.map.failed`; `gui.discover.retry` (`:1778`) |
| Off (403) | "Sonic discovery has been switched off on this server." | `gui.discover.turned_off` (`:1781`) |
| Building | nothing: the field's ground alone | — |
| Pick banner | the Sonic path end-pick banner | `gui.sonic.pick_banner_end` (`:1704`) |
| Footer tip | one tip line, as every room has | `gui.tips.map` |

---

## 7. Cross-cutting

### 7.1 Performance budgets

| Where | Budget (M-series; a Pi is about 4–6× slower, an unmeasured estimate) |
|---|---|
| `GET /map` 304 path | ≤ 10 ms (the pointer row and one PK-prefix COUNT) |
| `GET /map` cache hit | ≤ 5 ms |
| `GET /map` new visibility set on a warm base cache | ≤ 15 ms (one JS pass) |
| `GET /map` base-cache build | ≤ 150 ms at 100k in total, no page longer than ~10 ms |
| Overlay | ≤ 50 ms |
| `tracks` | ≤ 20 ms per 500 |
| `region` | ≤ 30 ms |
| `neighbours` | ≈ the similar route's cost (about 25 ms at 25k) |
| Worker fit | ≤ nFitMax points, about 15 s at 20k |
| Worker placement | ≤ 20,000 per run in ≤ 120 s, against ≤ nFitMax references |
| Worker memory | Per `mapFitBudget`, checked before the fit |
| Worker run | Killed at 30 minutes |
| Server event loop | No mirror work; mstream.db write locks held ≤ one 2,000-row chunk |
| Webapp | §4.8 |
| Phone | §5 |
| Terminal | §6 |

### 7.2 Caching and ETag

- **Server:** a strong ETag (`rev`) plus `Cache-Control: private, no-cache`; a visibility-independent base cache and an LRU of serialised per-visibility bodies (§3.8.2).
- **Webapp:** the browser cache revalidates by itself (`fetch`, `webapp/alpha/api.js:16-41`).
- **Phone:** stores the ETag and the decoded payload on disk, as a bandwidth cache.
- **Terminal:** keeps them in memory per session, revalidated through `get_map`'s conditional GET.
- **Lookups** return ids, so they never need a `rev`. Only order-coupled overlays carry one, answered 409 when stale.

### 7.3 Privacy

- The payload holds no per-user data.
- Plays need an account, and jukebox sessions are refused.
- Points and region sizes are filtered per user. Provinces and towns with no visible song are dropped. Partial land shapes remain (decision 1).
- **`renderMetadataByIds` is always fed visibility-filtered ids.**
- The routes are never on the federation allowlist, plus the handler check.
- Map tables never enter P2P snapshots: the export is an allowlist (`src/db/discovery-export.js:1-13`).
- `data_version` is never used in an ETag.

### 7.4 Rollout

- **Flag:** `discoveryMap: 1`.
  - Old clients ignore the key.
  - New clients on old servers see no flag, so no Map.
  - Clients gate on `discovery === true && discoveryMap >= 1` and not on a peer.
  - An unknown `points.format` or `layout.landFormat` reads as disabled for the session (§4.6), so a future format can ship as `discoveryMap: 2`.
- **Release order.** PR 1 and PR 2 can ride the same mStream release. The phone ships on its own cadence. The terminal needs its release and the pin bump before the mStream release that bundles the desktop app.
- **First run on upgrade.**
  - Already-embedded libraries get a map at the first drain after boot.
  - Fresh installs get one at the first settle, or after 1,000 embedded songs during a long backfill.

### 7.5 Rollback

- **The lever:** `scanOptions.musicMap: false`. It stops the pass, sets the flag to 0 (clients hide the Map) and answers the routes 403. The data stays.
- **`collectDiscoveryData: false`** turns off all discovery.
- **Reverting the code does not revert the schema.**
  - A V81 mstream.db makes older builds refuse to boot (`src/db/manager.js:257-262`). Downgrading needs the pre-upgrade backup of mstream.db, as for every migration.
  - discovery.db stays at V4. Older builds open it with discovery on and ignore the map tables; a later upgrade finds them and the next pass reconciles. A rollback therefore costs only the map.
  - The release notes say so, and recommend turning compression on for large libraries (the payload is 1.47 MB at 100k with it off).

### 7.6 Observability

- The scan-status `map` row: state, progress, last-run counts, and `disabledReason: 'failing'` after the latch.
- One info log line per pass, plus warn lines on the memory guard, kills, the timeout and schema-guard exits, and one error line on the failure latch.
- The admin rebuild route, which also clears the latch.
- Clients log nothing new.

---

## 8. Risks, mitigations and open questions

### 8.1 Risks

| Risk | Mitigation |
|---|---|
| Bun fits use about 2× Node's memory, so a 2–4 GB Pi or NAS could swap or be OOM-killed | `mapFitBudget` branches on the runtime and reads MemAvailable and the cgroup on Linux; the fit set is capped by construction in every mode; a pre-fit check exits 5 before allocating; an unexplained kill is retried once with half the fit; three failures stop the pass |
| A big library on a small host gets few landmarks (about 3–4k for 100k on a 4 GB Pi), so its layout is coarser | Placement against the fit set is still deterministic; refits follow real change; the umap-js CSR port (v2) is the lever (§8.2 Q4) |
| Node and Bun give different layouts for the same input | Property-bounded tests only (golden values only for the Rademacher PCA); a bun test leg; layouts are stored, so refits are warm on either runtime |
| A warm refit moves a few points far (max 33 % of the diagonal at 10k) | Procrustes alignment; region keys stay stable (genre provinces by construction, towns by warm Lloyd); tests bound p50/p95, not the max; refits happen at most every 6 h and only on real change, counted against all placed points |
| The worker's mstream.db writes contend with the server's synchronous writes | A double-buffered mirror written in ≤ 2,000-row transactions and switched by one tiny transaction; nothing written when nothing differs |
| The worker's mirror writes move the server's `data_version`, so the similarity index would rebuild | `absorbLibraryVersion` after a clean run, valid because the serial queue makes the worker the only other writer |
| Map writes would trigger P2P republish or index rebuilds | Never touch `row_seq` or `index_epoch` (tested); separate `map_version` |
| A model switch would wipe or shrink the map | `gone` counts only songs that left the library; switch-pending `mirror` runs keep the old layout serving; the rebuild waits for the settle or 90 % coverage, never the early rule (tested) |
| Hash re-keys strand points or drop tracks from the mirror | `applyHashTransitionGroups` moves `map_points` in the same transaction; labels are opaque and every member carries its dot's values; no map worker runs beside the applier (tested) |
| A failed first build would spin forever | The `failed` state; clients revalidate every 30 s while building; retry and latch rules (§3.3.4) |
| A metadata leak through ids | Intersect with `libraryFilter` before `renderMetadataByIds`; an integration test for bob |
| Overlay misalignment after a library change | `rev` on every overlay plus 409, retried once; all other answers are ids |
| A false 304 after a restart, a purge or a reset | `rev` is built from persistent state: `map_epoch`, the pointer and its counter, the generation's COUNT, `map_version`, library ids and the recent part; never `data_version` |
| A big payload with compression off (1.47 MB at 100k) | Aligned columns (no decode loop); no daily re-download unless something is recent; release notes recommend compression; long client timeouts; client caches |
| First-map latency on large first backfills | Early enqueue at ≥ 1,000 embedded, and coverage < 70 % after 24 h; a library that more than doubles is rebuilt, not warm-refitted |
| A serial queue blocked by long runs | nFitMax cap; placement batches with `hitCap`, checked every 100; a 30-minute kill timer; below-normal priority |
| Private umap-js fields (`knnIndices`) used for near-duplicate candidates | Exact version pin; a unit test that fails if the field disappears; an upgrade is its own PR |
| The umap-js licence is mislabelled | Document Apache-2.0 in the PR (§3.1.1) |
| Map tables outside the versioned schema are a new pattern in `discovery-db.js` | One function with a `MAP_SCHEMA` constant; a reset is drop-and-rebuild, safe for a cache; covered by a discovery-db test |
| The bundle smoke step hits GitHub's expression cap | A separate step with its own `BIN` (§3.13) |
| Textual merge conflicts with #1108, #1086/#1088 and the local `feat/flow-webapp` worktree | Expected hunks only (§3.2.3); Phase 2 anchors on neighbours both sides keep; rebase whichever lands second |
| Webapp: the Sonic Path Play cues paused; a manual play wipes the DJ seed; Auto DJ's bootstrap races a cleared queue | The map's Play starts explicitly in one synchronous block (tested with Auto DJ on and off); the seed behaviour is documented, unchanged everywhere |
| Phone: modal sheets would hide the mini-player and block lit neighbours | Every map sheet is in-body; the ⋯ opens the existing track sheet unchanged |
| Terminal: the wasm32 build breaks on shared base64 or missing `ApiCmd` arms | Native-only decode; "not supported" arms; the 3-OS CI includes wasm32 |
| Pi and NAS timings are extrapolated from an M3 (estimates) | Budgets are bounded by count and memory, not time; measure on real hardware before the release notes quote numbers |

### 8.2 Open questions (technical; not user decisions)

1. Real Pi 4 and NAS timings and Bun RSS under ARM were not measured here. Is a measurement on real hardware wanted before release?
2. One giant province in a single-genre library (for example 90 % Rock): accept, since towns carry the detail, or split provinces above a size share in v2?
3. A 5,000-id cap on search answers, a 20,000-row expansion cap and 50-song place mixes: right sizes? All are constants, easy to change.
4. On 2 GB hosts, and on 4 GB hosts with a big library, the budget gives a few thousand landmarks. Is that good enough, or is the umap-js CSR port (v2) worth scheduling early?

---

## 9. Review log (draft → final)

Every blocker and major issue of the three critiques was verified against the code and fixed. Minor issues were applied where cheap, which was all but the parts listed under "Rejected".

### 9.1 Applied

| Critique | Issue | Where it landed |
|---|---|---|
| Robustness R1 (blocker) | A refit's fit set had no cap, so the common first-install path (an early 1,000-song map, then ~99k new) OOMs and sticks | §3.4.4 step 3: F = the nFitMax lowest hashes in every mode; §3.4.2: a library that more than doubled rebuilds; thresholds against \|P\|; §3.4.6 absolute guard and pre-fit check; cap kept in `params` |
| Code truth M1, robustness R7 | `Infinity` serialises to `null` and fails Joi | §3.3.4 step 2 (`mapPayload` omits unset keys; tested) |
| Code truth M2 | A hash re-key renames a dot's representative row, dropping tracks from the mirror | §3.4.4 step 7 (opaque labels; members carry the dot's values), §3.6 step 1, §3.7, map-sync test |
| Code truth M3, completeness M1, robustness R3 | A model change wipes or shrinks the map | §3.4.2 (`gone` = left the library; switch-pending `mirror`; rebuild at the settle or 90 %; never the early rule), §3.3.3 items 1 and 4, worker test |
| Robustness R2 | The 100k-row single-transaction mirror write | §3.2.2 double buffer + `track_map_meta`; §3.6 chunked writes; §3.4.3–§3.4.5 |
| Robustness R4 | The placement reference set grew with the library | §3.4.4 step 5 (reference = fit set; checks every 100) |
| Robustness R5 | Town keys churned on every refit | §3.5.5 warm Lloyd; ≥ 95 % key test |
| Robustness R6 | The memory budget ignored the box and the index rebuild | §3.4.6 (MemAvailable, cgroup, index headroom, pre-fit re-check) |
| Completeness M2 | A failed first build was an endless spinner | §3.8.3 `failed` state; §3.3.4 retry and latch; §4.6 30 s revalidation |
| Completeness M3 | Songs with no dot had no defined behaviour | §3.8.8 skip dot-less candidates; §4.4.1 one rule set for all clients |
| Completeness M4, M5 | Phone and terminal had no states; offline phone undefined | §4.6 shared states table; §5 Offline row |
| Completeness M6 | The phone's song-selected state conflicted with §F | §1.3 default and §5 Song sheet |
| Completeness M7 | Terminal layout stopped at 100×30 | §6 Room layout row and 100×24 tests |
| Completeness M8 | Web keyboard and screen-reader gaps | §4.2 focusable nav; §4.7 rewritten |
| Completeness M9 | Terminal wording undefined; dir-A missing from the design of record | §6 Contract row and the wording table |
| Code truth m1–m11, m13–m17 | Missing helper; private `matchesEtag`; openapi enum and 7 operations; `nFitTried` lost on exit 5; unreachable test cases; import purity and `parseGenreTags`; applier ordering; unguarded early-rule counts; Phase 2 collisions and nav order; terminal conditional GET; `discoveryReq` hides 409; `mapPanel` step order; CI step shell; integration setup; WITHOUT ROWID; dot-less neighbours | §3.3.2, §3.1/§3.8.3, §3.11, §3.3.4/§3.4.1, §3.4.1 seams/§3.12, §3.4.1/§3.5.5, §3.3.2/§3.7, §3.3.3 item 4, §3.2.3/§1.3, §6 Client, §4.1 api.js, §4.2, §3.13, §3.12, §3.2.1, §3.8.8 |
| Completeness m1–m13 | Overlay marks replace dots; small §F/§C rules; web place card; phone path sheet, search, strings, icon; n = 1 NaN; unlabelled regions; trail details; search edges; false empty line; 409 loop; old clients; unowned fixture and release notes; lasso as a decision | §4.3/§5/§6; §4.3, §5, §6; §4.4; §5; §3.4.4 step 6/§3.4.8; §3.5.5/§4.4.1/§6; §4.5/§5/§6; §4.4/§5/§6; §3.8.1/§3.8.3; §4.6; §4.6/§7.4; §3.12 fixture/§6 Release; §1.2 |
| Robustness R8–R10, R12–R20 | `rev` ordering, cost and identity; daily re-download; cold build on the event loop; unbounded run time; small-library refits; discovery.db write discipline; hash-transition overlap and lost triggers; near-duplicate coverage; test seams; land size bounds; search caps; CI `$BIN` | §3.8.2; §3.8.2 recent part; §3.8.2 base cache; §3.3.2/§3.4.4 (kill timer, latch, rowid streaming, 100-step checks); §3.4.2; §3.4.4 step 10/§3.4.3; §3.3.3/§3.7; §3.4.4 step 7; §3.4.1; §3.5.8/§3.5.9; §3.8.6; §3.13 |
| Robustness R11 | Mirror writes triggered similarity-index rebuilds | §3.6 `absorbLibraryVersion` |
| Robustness R21 | discovery V5 would turn all discovery off on rollback | §3.2.1 map tables beside the schema; §7.5 |
| Found while verifying | `Math.min(...xs)` throws at 150k elements under Node 26 (make-mapdata's `fitBox` does this) | §3.4.4 rule, §3.5.3, map-lib test |
| Found while verifying | Master moved to `54647827` (flow-order merged), which brings `resolveFlowTracks` and `createConcurrencyGate` | Header, §3.2.3, §3.8.5, §3.8.6, §3.15 step 1 |

### 9.2 Rejected or changed, with evidence

| Critique | What was not taken | Evidence |
|---|---|---|
| Code truth m12 | The suggested fix, `MSTREAMPLAYER.clearAndPlay(row0)`. The problem is real only if the code awaits between clearing and adding; the plan specifies the synchronous sequence and tests it with Auto DJ on | `clearAndPlay` reassigns `mstreamModule.playlist = []` (`webapp/assets/js/mstream.player.js:950-954`) while Vue binds the original array (`webapp/alpha/vp.js:908`, `:4541`); nothing in the webapp calls it. The DJ's first bootstrap pick lands only after `await autoDJ()` (`mstream.player.js:1806-1818`) |
| Robustness R11 (part) | The same absorb for the novelty identity cache | `src/db/discovery-novelty.js:59-61`: a 60-second TTL already bounds that cache's staleness and rebuilds |
| Robustness R21 (part) | Avoiding the V81 boot refusal on mstream.db the same way | Every mstream.db migration sets that barrier (`src/db/manager.js:257-262`), and the boot probe enforces it for the managed installers (`src/util/boot-probe.js:97-125`); the critique itself calls it the house norm |
| Robustness R12 (part) | A global run budget with per-phase checkpoints | The phases other than fit and placement are bounded by n (§3.4.6); the parent's 30-minute kill timer is the backstop |
| Robustness R14 (part) | Place mode's discovery.db writes in one IMMEDIATE transaction | 20,000 points in one transaction would break the ~100 ms rule the same critique sets; chunked writes plus the `dirty` flag give the same crash safety |
| Robustness R1, R4 (form) | The exact formulas proposed (a proportional `q` of new points; reference = fit set only when \|P\| > nFitMax) | The lowest-hash rule is a pure function of U with the same proportionality and a hard cap; using the fit set as the reference in every mode is simpler and fully deterministic |
| Completeness M5 (form) | Drawing a cached map read-only offline | Its pin, trail and verbs all need the server; a stale map whose verbs fail is worse than Discover's failed line. Moved to v2 (§1.2) |

### 9.3 Phase 1 build review

The built server was reviewed against this plan. Each finding was verified against the code, fixed and written back into the sections above; every code fix carries a test that fails without it.

| Finding | What it was | Where it landed |
|---|---|---|
| Fit-set erosion (major) | Place runs prune landmarks whose songs left and nothing replaced them, so a slowly rotating library lost its fit set; then every pass threw and the failure latch switched the map off | §3.4.2 refit row and the "Landmarks that leave" rule (a warm refit at 15 % of `n_fit` gone, or at once below 10 left); worker fallbacks to every point; map-lib and worker tests |
| The applier beside, or behind, a map worker (major) | Close handlers dispatch before they drain, so a queued pass could fork while the ledger a scan had just written was unapplied, and the re-keyed songs lost their points | §3.3.2 `mapWaitsForTransitions` (ledger check, applier kick, one attempt per pass dated by `scansStarted`), §3.3.3 item 3, §3.3.4 step 1, §3.7, §3.4.4 step 10 (delete by id and hash; `dirty` kept when a planned write is skipped); queue and worker tests |
| The applier's unconditional ledger delete (found in review; also on master) | Rows a scan committed while the applier ran were deleted unapplied | §3.7 (delete only the rows read); queue test |
| The latched fit cap as an override (minor) | After a memory-guard exit the halved cap could exceed the live budget, failing every later pre-fit check | §3.4.6 (the override caps, never raises); map-lib test |
| Overlay ETag (minor) | `docs/openapi.yaml` said overlay answers carry no ETag; Express adds its weak body ETag | §3.11 (`docs/openapi.yaml` overlay text) |
