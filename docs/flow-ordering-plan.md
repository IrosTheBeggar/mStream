# Flow ordering (idea 4): implementation plan (corrected)

## 1. Summary

- **What ships:** one new server route, `POST /api/v1/db/flow`. You send it a list of song paths and some options. It returns the same songs in a new order (a permutation), with an optional reason for each transition. It uses whatever analysis each song has (sound vector, BPM, key, moods) and never drops a song.
- **How it orders:** each pair of neighbouring songs gets one symmetric cost: sound 0.55, tempo 0.20, key 0.15, energy 0.10, plus a penalty when the same artist plays twice in a row.
  - The route builds the order greedily from the playing song, then improves it with 2-opt and Or-opt.
  - The improvement runs on a fixed budget of move evaluations, with a 250 ms wall-clock safety net.
  - Energy arcs sort songs into energy bands, then order each band.
  - An optional seed gives a different order each time.
- **Mixed queues:** each server orders only its own songs. Clients call each server once (a peer through the existing proxy, or directly on the phone) and join the runs by passing the last song's features to the next call.
- **Order of work:** server PR (adds the flag `flowOrder: 1`), then the webapp PR, then the phone and terminal PRs in parallel. One mStream release has to go out before the client releases.
- **Size:**
  - Server: M–L, about 900 lines including tests.
  - Webapp, phone and terminal: M each, about 500–650 lines including strings in every locale (webapp 12, phone 11, terminal 10).

## 2. The API

**Route:** `POST /api/v1/db/flow`, under `db/` rather than `discovery/`, for two reasons:
- Discovery routes 403 when discovery is off (`requireIndex`, `src/api/discovery.js:71-78`), and flow must still order by BPM and key without embeddings.
- It sits next to `db/random-songs` on the federation allowlist (`src/api/federation-auth.js:75`).

**Request.** All options go in the body, because the browse proxy forwards no query string (`src/api/federation-browse.js:276-304`). The Joi schema rejects unknown keys (Joi default via `joiValidate`, `src/util/validation.js:4-11`); the error handler turns that into a 400 (`src/server.js:743-746`).

| key | type | default | limits | meaning |
|---|---|---|---|---|
| `songs` | string[] | required | 2–1000 items, each ≤4096 chars; duplicates allowed | vpath paths (`rawFilePath`; a leading `/` is stripped by `getVPathInfo`, `src/util/vpath.js:7-9`) |
| `start` | int\|null | null | 0..n−1 | Index of the song kept first; the order flows out of it (the playing song) |
| `end` | int\|null | null | must differ from `start` | Index of the song kept last |
| `after` | {vector?, modelId?, bpm?, key?} | — | not allowed together with `start`; `vector` requires `modelId` (as at `src/api/random.js:1396`); bpm 20–300 | The song just before this list when it lives elsewhere (used to join runs) |
| `mode` | `smooth`\|`dj` | smooth | | Weight preset |
| `weights` | {sound, tempo, key, energy} | from `mode` | each 0–1, at least one > 0, normalised | API-only override |
| `arc` | `steady`\|`up`\|`down`\|`wave` | steady | | Energy shape |
| `tempoTolerance` | number | 0.06 | 0.02–0.25 | Tempo ratio at which the tempo cost reaches 0.5 |
| `halfDouble` | bool | true | | Treats 140 BPM as matching 70 |
| `artistGap` | bool | true | | Adds +0.10 when the same artist plays twice in a row |
| `seed` | int | absent | 0–2³¹−1 | Varied order on request; absent means the deterministic order |
| `explain` | bool | false | | Include per-transition rows |
| `returnEnd` | bool | false | | Include the last song's features, for joining runs |

**Response:**

```json
{ "order": [0,7,3,...],            // permutation of input indices, length n
  "songs": ["Music/a.mp3", ...],   // songs[order[k]], for convenience
  "unplaced": [5,9],               // could not be resolved here: tail, in input order
  "unanalysed": [4],               // resolved, but no vector, BPM or key: after the run, before unplaced
  "signals": {"sound":true,"tempo":true,"key":true,"energy":false},
  "model": {"id":"…","version":1} | null,  "seed": null,  "solver": "complete"|"budget"|"deadline",
  "stats": {"before":{…},"after":{…}},  // meanCost, meanSound, tempoOk%, keyOk%, artistRepeats, worst
  "transitions": [{"from":0,"to":7,"cost":0.12,"why":["sameKey","tempoMatch"]}],   // explain only
  "end": {"vector":"…","modelId":"…","bpm":124,"key":"8A"},                     // returnEnd only
  "afterIgnored": "modelMismatch" }  // present only when it applies
```

**Indices, not paths.** Clients act on indices, which handle duplicate songs and peer songs without ambiguity. A path the server cannot resolve, such as a webapp row with an escaped path (see §8), still lands in `unplaced`.

**`why` codes:** `soundClose`, `sameKey`, `relativeKey`, `adjacentKey`, `keyClash`, `tempoMatch`, `halfTime`, `tempoJump`, `sameArtist`, `noData`. Clients don't need to show them in v1.

**When there is nothing to order by:** if fewer than two songs carry any signal, the route returns the input order with every `signals` entry false, so a client can say "nothing to flow by yet".

**Errors:**
- **400:** Joi caps, an index out of range, `start` equal to `end`, `after` sent with `start`, weights that are all zero, or an `after.vector` of the wrong length (`decodeSeedVector`, `src/api/discovery.js:159-182`).
- **401:** not authenticated.
- **413:** body over 1 MB (`src/state/config.js:898`, `src/server.js:405`).
- **429:** too many solves in flight (see the concurrency note in §3).
- **Never a per-item 404.** Today `resolveSeedTrack` 404s the whole request (`src/api/discovery.js:84-107`). Here a missing file, a forbidden vpath and a path-escape error all land in `unplaced`, indistinguishable from one another.
- **Never a 403 when discovery is off.** The route answers with `signals.sound: false` and `model: null`.

**Plumbing:**
- `flowOrder: 1` in `buildFeatures` (`src/api/server-info.js:58`). It is unconditional, a version fact like `discoveryOwned`, and an integer generation like `discoveryTaste` (`:98-105`).
- The same key added by hand to ping (`src/api/playlist.js:20-57`). The drift-lock test enforces this (`test/integration/api-server-info.test.mjs:219`).
- An allowlist line in `ALLOWED_EXACT` (`src/api/federation-auth.js:47-86`).
- An OpenAPI entry modelled on `docs/openapi.yaml:3074-3127`.

## 3. The algorithm

The logic goes in a pure module, `src/db/flow-order.js`, with no database or Express code. The thin async route goes in `src/api/flow.js` (Express 5, so a rejected promise reaches the error handler). It is imported next to `randomApi` (`src/server.js:21`) and set up next to it (`:634`).

1. **Resolve.** Write a lean batch resolver alongside `pullMetaDataBatch` (`src/api/db.js:503-569`). Copy its visibility step (`getVPathInfo` + `getLibraryByName`, with a catch-all, `:520-532`) and its `(library_id, filepath) IN (VALUES…)` chunks of 500.
   - Select only `tracks` columns: `id`, `audio_hash`, `file_hash`, `bpm`, `musical_key`, `artist_id`, `album_id`. Don't use `trackQuery`: its user_metadata, artist and album joins are wasted here, and a federation key's user has `id: null` (`src/api/federation-auth.js:160`).
   - The canonical hash is `audio_hash || file_hash` (`src/api/discovery.js:211`). The rendered `metadata.hash` is `file_hash` only (`src/api/db.js:38`).
   - Moods come from one `track_moods` read per 500 ids (`src/db/schema.js:3381-3392`).
   - Vectors come from `sim.getIndex().byHash` (`src/db/discovery-similarity.js:225-303`), only when `collectDiscoveryData` is on. `getIndex()` alone would still return an index for a switched-off server whose store exists.
2. **Edge cost.** Each term is scaled to 0–1 and the weights sum to 1.
   - **Sound:** `(1−v·w)/(2·median)`, capped at 1. The median is taken over the request's own pairs, with a floor of 0.02.
   - **Tempo:** `min over m∈{1,½,2} of |ln(m·b₂/b₁)| / ln(1+2·tol)`, then +0.03 after scaling when m≠1, capped at 1. That gives 0 for the same tempo, 0.5 at ±6%, 1 at ±12%, and 0.03 for 70 vs 140. It replaces Auto DJ's absolute ±8 BPM (`webapp/alpha/auto-dj.js:123-138`, `:322`), which is 11% at 70 BPM and 4.7% at 170 BPM.
   - **Key:** parse with an inverted, lower-cased `CAMELOT_TO_KEYS` (`src/api/random.js:84-109`), trimming whitespace. It accepts "Am", "A minor" and "8A", and Essentia's "Bb minor" form (`src/db/audio-analysis-lib.js:209`). Costs:

     | Move | Cost |
     |---|---|
     | Same key | 0 |
     | ±1 on the wheel, same letter | 0.10 |
     | Relative major/minor | 0.10 |
     | Diagonal | 0.35 |
     | ±2 | 0.5 |
     | ±7 | 0.6 |
     | Anything else | 0.8–1 |

     The webapp's `toCamelot` matches case exactly and misses "Am" (`webapp/alpha/auto-dj.js:61-68`), so it is not reused.
   - **Energy:** `|e₁−e₂|`, with `e = mean(aggressive, party, danceable, 1−relaxed)`.
   - **Penalties:** +0.10 for the same artist (`artist_id`); +0.25 for the same recording (cos ≥ `NEAR_DUP` 0.99, `src/db/discovery-novelty.js:19`, or a matching `entryNameKey`, `src/db/discovery-similarity.js:444`).
3. **Missing data.**
   - A term missing on a pair gets that term's mean over the pairs that have it.
   - The sound fill is ×0.6 for songs on the same album and ×0.8 for the same artist.
   - A song with no vector, no BPM and no key goes to `unanalysed`.
   - When a signal is absent from the whole request, its weight is shared out among the other terms and reported under `signals`.
4. **Distance matrix.** Copy the n vectors into one contiguous buffer and compute the upper triangle of an n×n `Float32Array` with a 4×-unrolled dot product. Yield with `setImmediate` every 64 rows. `rankTracksMulti` yields between seed passes (`src/db/discovery-similarity.js:531`); this is the same idea at a finer grain.
5. **Construction.**
   - With `start`: greedy nearest-neighbour from that song.
   - Without `start`: greedy from the 16 songs with the highest mean cost; keep the cheapest result.
   - With `after`: it becomes a virtual first node that is removed afterwards.
6. **Improvement.** 2-opt (O(1) delta, because costs are symmetric) plus Or-opt (moving runs of 1–3 songs). Pinned ends stay locked.
   - The stop rule is a budget of move evaluations scaled to n. That is deterministic, and `solver: "budget"` is reported when it is hit.
   - The 250 ms wall clock is only a safety net (`solver: "deadline"`).
   - The solver yields every ~16 ms.
7. **Arcs.** Sort by energy, cut into 5 bands that follow the curve, and order each band starting from the previous band's last song. The first band starts from `start` when it is pinned. Without mood data the arc is ignored.
8. **Seed.** A mulberry32 generator. Greedy picks among the 3 cheapest next songs with weight `exp(−d/τ)`, where τ is the median edge cost. The seed is echoed back.
9. **Determinism.** Before solving, sort by (canonical hash or path, input index) and break every tie by that rank. With `solver` `complete` or `budget`, the output depends only on the set of songs, the pins and the options, and a rerun on its own output gives the same order. A `deadline` answer promises neither.
10. **Concurrency.** At n = 1000 a request costs about 0.6–1 s of CPU, and nothing in mStream limits CPU per route (`federation-limits.js` covers only bytes and streams). Allow one solve at a time per process, with a short wait queue. Beyond about 4 waiting, answer 429.

**Cost and quality.** These were measured in the studies on synthetic clustered 1280-d vectors; they could not be re-verified here. The quality gap is against a long simulated-annealing run.

| n | resolve | matrix, Node / Bun | solve | gap | total on Bun |
|---|---|---|---|---|---|
| 50 | <10 ms | 1.5–4 / 1–2 ms | ≤2 ms | +1.0% | ~15 ms |
| 200 | ≤40 ms | 16–26 / 8 ms | 2–15 ms | ~+1.1% | ~60 ms |
| 1000 | ≤200 ms | 520–600 / 210–231 ms | 200–250 ms | +0.9% | ~0.6 s (Node ~1 s) |

- The matrix figures fit the arithmetic: n(n−1)/2 × 1280 ≈ 640M multiply-adds at n = 1000.
- The resolve column is a loose upper bound from the full-metadata path (~20 ms per 100 tracks, `src/api/db.js:491-502`). The lean query should be well under it.
- The input order is +57–115% above the best order found; greedy alone is +2.4–3.2%.
- After ordering, 86–93% of transitions are harmonically compatible (16–28% in the input order), and 85–98% have BPM within about 6% (15–20% before).
- Five arc bands cost 8–15% of smoothness for an energy-rank correlation of about 0.96.

## 4. Federation and mixed queues

**Recommendation: group by server and join the runs.**

1. The client splits the upcoming rows by where they come from:
   - webapp: `song.federation.peerId` (`webapp/alpha/vp.js:4944-4958`)
   - phone: `extras['server']`, a server localname (`lib/objects/metadata.dart:17-19`)
   - terminal: `Origin{server, peer}` (`src/tui/app.rs:646-650`)
2. It calls each server's route:
   - **Webapp:** a peer is called through the parent's proxy (`src/api/federation-browse.js:276`; `peerReq`, `webapp/alpha/api.js:351-354`), as a new `MSTREAMAPI.peer.flow`.
   - **Phone:** `server.apiUri`, which takes the proxy or the peer's own direct tunnel (`lib/objects/server.dart:388-401`).
   - **Terminal:** the row's `Reach`.
   - **The allowlist line has to exist on both sides:**
     - the parent screens outbound routes against its own allowlist (`federation-browse.js:287`, 403);
     - the peer's wall refuses off-list routes (`federation-auth.js:151`, 403).
   - A 403 or 404 from a peer call means the peer cannot flow.
3. The playing song's server goes first, with that song as `start`. The other servers follow, largest group first. Each later call passes the previous run's `end` as `after`. The calls are sequential; the proxy deadline is 15 s (`federation-browse.js:42`).
   - If the playing song's server cannot flow, or the song has no server, the first call takes `after: {bpm, key}` from the playing song's metadata. Webapp `metadata.bpm` and `'musical-key'`, and phone extras `bpm` and `musicalKey`, already carry them.
   - Groups of one song skip the call.
4. These rows go last, in their current order: songs with no server (phone local files, `lib/util/queue_actions.dart:24-31`), songs on servers that cannot flow, and every run's `unplaced`.
5. An `after.vector` from a different model is dropped softly, as `src/api/federation-discovery.js:54-56` does (not the hard 400 at `src/api/random.js:658-661`). Its BPM and key are still used.

**Rejected options:**
- **Order only this server's songs and keep the others in place.** The fixed peer slots break the flow at every one of them.
- **Accept vectors for foreign songs.** Each vector is 6,828 chars of base64, so the 1 MB body holds about 140. Getting them takes embedding reads capped at 8 paths per call (`src/api/discovery.js:202`), about 25 calls per 200 songs.
- **Have the server fetch peer features itself.** Same 8-path cap, and the route would then depend on network latency.

## 5. Clients

**Shared rules for all three clients.** The webapp's unit test pins these down as the spec.
- Send the playing song as `start`, plus at most 999 songs after it. Rows beyond that stay after the flowed rows in their current order. With nothing playing, send up to 1000 with no `start`.
- Apply the answer by matching rows. Skip rows that were played or removed while the request was out. Rows added meanwhile (Auto DJ picks) stay after the flowed rows.
- Flow turns shuffle off.
- Undo reapplies the previous upcoming order through the same path.
- Show Flow only when the playing server has `flowOrder >= 1`. Other servers are probed by calling.
- Play-session tracking is unaffected, because the playing song never changes. Flowed songs report source `manual`; a `flow` source would need `SOURCES` widened (`src/stats/store.js:18-19`), which is not planned for v1.

### Webapp (M, about 500 lines, half of them tests)

**Entry points:**
- A Flow icon in `#playlist-buttons` (`webapp/index.html:891`). A popover holds mode and arc, remembered in `localStorage` inside try/catch.
- A Flow button on the playlist page (`onPlaylistClick`, `webapp/alpha/m.js:3022-3058`) that plays the playlist in flow order.
- In v2, "Flow from here" in the row menu (`webapp/index.html:1485-1493`).

**Gating:**
- Read the flag from ping, the way `discoveryPath` is read (`webapp/alpha/m.js:770`, `:829-830`).
- Hide the button in server-audio mode, because the engine has no move route (`src/api/server-playback.js:251-270`).

**Applying the order without stopping playback.** Add `MSTREAMPLAYER.applyQueueOrder`, which never calls `goToSong`. The drag-reorder precedent is `checkMove` (`webapp/alpha/vp.js:1004-1008`). Steps, in order:
1. Check that the new array holds exactly the same objects.
2. Replace the songs in place with `playlist.splice(0, len, ...arr)`. Vue is bound to that array (`webapp/alpha/vp.js:905-919`).
3. Call `resetPositionCache()` (`webapp/assets/js/mstream.player.js:1400-1415`).
4. Clear `cacheTimer` and call `setCachedSong(pos+1)` (`:1692-1706`).
5. The caller then runs `saveLiveQueue` (`webapp/alpha/vp.js:27-31`).

**New code:**
- A pure `webapp/alpha/queue-flow.js` in the UMD shape of `auto-dj.js`, plus a `<script defer>` tag next to `webapp/index.html:47`. Test: `test/unit/webapp-queue-flow.test.mjs`.
- Paths are sent as `rawFilePath` (as at `webapp/alpha/m.js:6005-6007`), never the escaped `filepath`.
- Strings in all 12 `webapp/locales/*.json`.

**Undo:** an iziToast with an Undo button (`webapp/alpha/m.js:5547-5555`).

### Phone (M, about 550 lines)

**Entry points:**
- A Flow item in the More sheet (`lib/widgets/more_actions_sheet.dart:102-131`).
- For playlists, a Flow button next to Shuffle (`lib/widgets/browser_toolbar.dart:565-583`) that calls `playFromHere(..., flow: true)`, mirroring the shuffle branch (`lib/util/queue_actions.dart:211-227`).

**Applying the order:** a custom action modelled on `moveQueueItem` (`lib/media/audio_stuff.dart:3184-3215`):
- Clear `_restoreSpot` (`:3189`).
- Run it in `_switchChain` like `clearPlaylist` (`:3172-3182`). `moveQueueItem` itself is not chained today.
- Publish the final queue once.
- Call `moveSource` at most n−1 times, holding `_reordering` (`:2280`, which also suppresses the Auto DJ top-up, `:396`) for the whole loop.
- On the local backend each move is a platform call. Measure at 1000.
- Never take the reload path (`:3528-3546`).

**Other pieces:**
- Pure logic in `lib/util/queue_flow.dart`. The phone repo has no PR CI, so run the tests locally.
- Undo through a `SnackBarAction`. Strings in all 11 `.arb` files.
- Parse `features.flowOrder` in `_applyServerInfo` (`lib/singletons/server_list.dart:525-575`).
  - Do not pin it off in `_applyFederatedDefaults` (`:2646-2668`).
  - A proxied peer needs both its own flag and its parent's; a direct peer needs only its own.

### Terminal player (M, about 600 lines)

**Entry points:**
- TUI: `Action::FlowQueue` on capital `F`, which is free; lowercase `f` is the filter (`src/tui/keymap.rs:292`, `:326-335`).
- GUI: a "flow" word next to "clear" (`src/gui/queue.rs:113-119`), with `Act::QueueFlow` next to `QueueClear` (`src/gui/mod.rs:184`, `src/gui/actions.rs:730`).
- Listings: a Flow verb in the shared bar beside Shuffle (`src/gui/mod.rs:2209-2214`). It appears on every listing with tracks, and squeezes out first.

**Applying the order:**
- Add `Queue::reorder_upcoming`, modelled on `move_row` (`src/tui/app.rs:1318-1346`), bumping `rev` through `touch()` (`:1277`).
- Clear `announced` (`:4327`) and switch shuffle off.

**Worker and replies:**
- A new `ApiCmd::Flow { reach: Option<Reach>, … }` and reply event, modelled on `TrackInfo`/`AutoDj`, **not** `SavePlaylist`: that one is session-only (`src/tui/worker.rs:381`).
  - It must join the exhaustive `reach()` match (`:334-347`).
  - The web build ignores reach (single server, `src/web/api_worker.rs:120`, `:343`).
- Add `flow_order` to `Ping` and `LayeredFeatures` (`src/api/types.rs:129`, `:175`), and a `Client` method with an async twin.
- When the reply lands, apply only if `rev()` (`src/tui/app.rs:1282`) and `current` are both unchanged. Otherwise re-check the sent rows by (origin, path):
  - apply if they are still the rows right after `current`, leaving appended rows after them;
  - drop the answer if not.
  - `rev` also moves on tag learning (`src/tui/app/track.rs:64`) and on DJ pushes, and does not move when playback advances.

**Undo:** pressing Flow again restores the previous order while `rev` still matches.

**Docs and strings:** new clauses in `docs/ux-contracts/track-actions.md` and `playlists.md`; strings in all 10 `locales/*.yml`.

## 6. Phasing and quality

1. **Server PR**
   - **Contents:** the library, route, lean resolver, mood read, concurrency limit, flag in features and ping, allowlist line, OpenAPI entry.
   - **Unit tests:**
     - the key-parser table ("8A", "A minor", "Am", "Bb minor", "G#m"/"Abm", junk), the Camelot costs, and tempo cases (70 vs 140 gives 0.03; 120 vs 127 gives about 0.5);
     - within 2% of brute force for n ≤ 9;
     - pins honoured; the output is always a permutation;
     - the same answer under shuffled input, and on a second run over its own output;
     - missing-data placement; arc correlation ≥ 0.9; a valid permutation under the deadline; the seed reproduces its order.
   - **Integration tests:**
     - duplicates;
     - an unknown path and a forbidden vpath give identical `unplaced` results;
     - discovery off still orders by BPM and key;
     - 1001 songs gives a 400, and so does an unknown key;
     - an `after` vector from another model gives `afterIgnored`;
     - a federation key is allowed, both on the wall and through the outbound proxy screen;
     - the flag appears on `/api/` and on ping;
     - a 429 when the queue is full.
   - **Quality probe:** 50/200/1000-song subsets of the demo library on Bun and Node. Then release mStream.
2. **Webapp PR.**
3. **Phone PR and terminal PR** in parallel. The terminal needs a player release and a pin bump; time the wasm web bundle build before tagging.
4. **Later:** keeping album runs together (`flowOrder: 2`), "Flow from here", extra pins, a PCA speed-up.

**How to judge quality.** Compare the input order with the flowed order on:
- mean combined cost and mean 1−cos;
- share of tempo-OK transitions (within 6%, half/double aware);
- share of key-OK transitions (cost ≤ 0.10);
- key clashes (cost ≥ 0.6);
- same-artist neighbours;
- the single worst transition.

Starting targets, to tune after the first probe:
- mean cost at least 40% below the input order;
- within 2% of the annealing reference;
- tempo-OK and key-OK each ≥ 80% where both songs have data;
- one listening pass on three queues: mixed-genre, single-genre, and a saved Auto DJ session.

## 7. Open product questions

1. **Can Flow move the playing song or songs already played?** No. It orders only what comes next.
2. **What happens to shuffle?** Flow turns it off.
3. **What does Flow do on a playlist?** It plays the playlist in flow order. Saving that order back is a separate, explicit action, because `playlist/save` overwrites the whole playlist (`src/api/playlist.js:147-187`).
4. **How are mixed-server queues handled?** As joined per-server runs. This regroups an interleaved queue by server.
5. **Which controls does the UI show?** Mode (Smooth/DJ) and arc (Steady/Build/Wind down/Wave) only.
6. **Should Flow work while Auto DJ is on?** The webapp's DJ keeps only a 2-deep lookahead (`webapp/assets/js/mstream.player.js:1806`). Recommended: disable Flow while the DJ is on, as shuffle is (`:1730`, `:1737`).

## 8. Risks and what is harder than it looks

- **Event-loop blocking.** n = 1000 on Node costs about 1 s of CPU even with yields. The first call after an index change pays a 1.5–1.7 s synchronous rebuild (`src/db/discovery-similarity.js:14`). The cap, the budget, the yields and the concurrency limit bound it.
- **Scale differs between requests.** Per-request sound scaling means costs and stats compare only before and after within one request.
- **Noisy keys.** Tag keys are stored verbatim (`src/db/schema.js:1194-1196`). Analysis keys only fill gaps (`src/db/audio-analysis-lib.js:253-260`), and their confidence isn't stored. Keep the key weight low.
- **BPM octave errors.** RhythmExtractor2013 makes half/double errors (`src/db/audio-analysis-lib.js:199`), which is why `halfDouble` defaults to on.
- **Unvalidated energy proxy.** Mood heads are confidences, not intensities (`src/api/mood-filter.js:22-24`). Ship arcs behind `moodFilters` and check them by listening.
- **2-opt needs symmetric costs.** That is why arcs use bands.
- **Webapp pitfalls:**
  - `clearAndPlay` reassigns the array (`webapp/assets/js/mstream.player.js:950-953`), so `applyQueueOrder` must splice in place.
  - Shuffle plays from `shuffleCache` (`:1726-1749`).
  - Auto DJ appends songs mid-request (`:1250-1252`).
  - **Confirmed:** webapp saves and the live queue store the escaped `filepath`. It is escaped at `vp.js:4853-4858`, pushed at `m.js:3207-3209` and `vp.js:18`, and stored verbatim at `playlist.js:180-181`. Songs with `%`, `#` or `?` in their names come back `unplaced`.
  - A jukebox remote holds row indices until its next `getPlaylist` (`webapp/assets/js/mstream.jukebox.js:128`), as after a drag today.
- **Phone pitfall.** On Chromecast and DLNA, `moveSource` only reorders a list in memory (`lib/media/emulated_playlist_backend.dart:351-363`). Without `_reordering` held for the whole loop, Auto DJ appends songs mid-loop.
- **Older servers.** A peer or a parent without the route answers 403 or 404, and its songs go to the tail until both sides upgrade.
- **Missing key notations.** Traktor's Open Key notation (`1m`–`12d`) isn't in `CAMELOT_TO_KEYS`. Such keys parse as unknown, which costs only key signal.

## Corrections

1. **Tempo cost:** adding the 0.03 before dividing gave 0.265 for 70 vs 140, which contradicts the plan's own test. The 0.03 now goes after the scaling, with a cap at 1.
2. **Determinism:** a wall-clock deadline breaks "same set gives the same order". I switched to an evaluation budget, kept the clock as a safety net, added `solver: "budget"`, and made the solver yield.
3. **Resolver:** `pullMetaDataBatch` gets visibility from `getVPathInfo` + `getLibraryByName`, not from `libraryFilter`. I also advised against `trackQuery` (wasted joins; federation users have `id: null`).
4. **`rankTracksMulti`** yields between seed passes, not every 64 rows.
5. **Line fixes:**
   - `hash` is at `db.js:38`;
   - phone `server` is at `metadata.dart:17-19`;
   - the soft model check is at `federation-discovery.js:54-56`;
   - the web worker arm is at `api_worker.rs:297`;
   - the route setup is at `server.js:634`.
6. **Escaped playlist paths:** this was marked unverified and is now confirmed in code. I removed the claim that indices handle escaped paths.
7. **Federation:**
   - the allowlist is checked on both the parent (outbound) and the peer (wall);
   - the proxy forwards no query string, so options stay body-only;
   - phone peers may be direct;
   - the webapp has no per-peer feature read, so it calls and falls back on 403/404.
8. **Phone:**
   - peer flags are pinned off by `_applyFederatedDefaults`, so `flowOrder` must be exempt, and proxied peers need the parent's flag too;
   - `moveQueueItem` isn't chained today;
   - added the `_restoreSpot` reset and the cost of the per-move platform calls.
9. **Terminal:**
   - `SavePlaylist` is session-only, so flow needs a `reach` and an entry in the exhaustive `reach()` match;
   - added the types and client changes;
   - the `rev` check can't detect "only the playing song moved on" (tag learning and DJ pushes bump `rev`, and advancing doesn't), so it is replaced with a rev+current check plus a row-snapshot fallback.
10. **Added what was missing:**
    - the 1000-row cap rule for long queues, and skipping one-song groups;
    - client-side `after` from metadata;
    - a CPU concurrency limit and 429;
    - the all-zero weights check and `after.vector` requiring `modelId`;
    - an answer for "nothing to flow by";
    - strings in every locale, the terminal UX contracts, and the webapp script tag;
    - the play-session `source` (unchanged in v1) and jukebox notes;
    - the Auto DJ question.
11. **Cost numbers:** the matrix figures fit the arithmetic, but the table comes from synthetic data and could not be re-verified here. The resolve column is now labelled as a loose upper bound.