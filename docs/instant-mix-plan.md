# Instant Mix (idea 2): build spec — direction B, with Auto DJ's filters

The spec the build followed, written after a study of the server, webapp and phone code and a design round. §0.2 lists the corrections it made to the three study plans; §8 lists where the code ended up differing from it. Line anchors refer to the trees below, before this change.

**Trees**
- Server + webapp: this repository at master **54647827**. Paths below are repo-relative; `m.js` = `webapp/alpha/m.js`, `index.html` = `webapp/index.html`, `spa.css` = `webapp/alpha/spa.css`, `en.json` = `webapp/locales/en.json`.
- Phone: the mstream_music repository at master **7fee2a85**. `lib/…`, `test/…` are the phone's.
- Open PR #1108 (`feat/autodj-less-like`, 78cb4aff) touches `random.js`; §3.10 keeps the overlap at zero conflicts.

**The ask, verbatim:** "go with B, with one addition. On the instant mix page, add options for additional filters. i assume we will be using the random api for this (or something very similair) so we should have access to all the same filters autoDJ does".

**Direction B, as the judges amended it:** choosing Instant Mix opens a page with the seed's header and ~50 songs that sound like it, plus ▶ Play · Shuffle · Queue all · Save as playlist. Nothing plays until a button is pressed. No Close | Varied switch, one ranking. Entries are gated on readiness. Short state lines. Save goes through each client's house flow. The webapp's ▾ is retitled "More".

---

## 0. In one page

### 0.1 What gets built

- **Server:** `POST /api/v1/discovery/local/mix`, in a new `src/api/discovery-mix.js`.
  - It takes random-songs' own filter keys, through one exported Joi fragment and one shared SQL builder taken out of `runRandomSongs`, plus a mix-only `skipWords`.
  - It ranks the library by sound against the item, applies every filter as a hard WHERE, caps and spreads artists, and dedupes.
  - Flag: `features.instantMix: 1`.
- **Webapp:**
  - Entries: the song ▾ menu, the queue ⋮, and a bar glyph on album, artist and playlist pages.
  - The page: a header with the four verbs, then Discover-style rows.
  - The filters: a **Filters** funnel at the end of the header's action row opens a panel under the header. It holds Auto DJ's controls in Auto DJ's order: Sources · Minimum Rating · BPM continuity (+ BPM tolerance) · Harmonic mixing · Keyword filter · Genre filter · Mood · Track length.
- **Phone:**
  - Entries: the track sheet, the queue swipe pane, Song Info, and the album, playlist and artist toolbars.
  - The page: a browser frame with a fixed banner.
  - The filters: a **Filters** icon in its toolbar opens a sheet of Auto DJ's rows: Smart filters · Genres · Rating · Length · Beat matching · Harmonic mixing · Skip words · the folders. The grey strip under the bar names what is set, with Clear.

### 0.2 Corrections to the three plans (each verified in code)

| Plan | Claim | Correction | Evidence |
|---|---|---|---|
| webapp | BPM continuity and Harmonic mixing are not on the mix page in v1 | **They are**, for song seeds with a BPM / a key: the user asked for all of Auto DJ's filters, and the phone plan already had them | `random.js:1267-1286` takes `bpmRanges`/`musicalKeys`; phone Auto DJ rows at `lib/screens/auto_dj.dart:165-170` |
| phone | The mix body sends `bpmRangesWide`, and tempo/key relax tight → wide → any | `bpmRangesWide` is refused (400). Tempo and key are hard, like every mix filter | It is a waterfall-only key (`random.js:1268`, `:941-1051`) |
| phone | Skip words are a phone post-filter with `limit: 75` | The server applies `skipWords`. Send `limit: 50`, no over-ask | §3.2 |
| phone | Entries show on peers (Save hidden) | **Hidden on connected servers in v1, on both clients** (§1, confirm Q4) | `lib/widgets/track_actions_sheet.dart:148-150` already hides Find similar on peers (`discoveryAvailable` pinned false, `lib/singletons/server_list.dart:2650`) |
| phone | "Must match" / "Prefer" headings on the sheet | No headings: everything on a mix must match | `auto_dj.dart:157,165` are Auto DJ's semantics |
| phone | Resend once without a rejected key; a non-key 400 means "no match" | Neither. The route answers 200 for empty, so a 400 is "Couldn't build the mix" | §3.7 |
| phone | Parse `instantMix` from ping too | `/api/` only. The ping fallback runs only for pre-`/api/` servers, which cannot have the route; it sets `null` | `server_list.dart:583-596` |
| all | `includeSeed` key | Dropped: the seed always leads a song mix when it passes the filters | YAGNI |
| server | `from.album.album` may be `null` (the singles bucket) | Refused (400): no client offers it | `m.js:3319-3322` |
| server | Multi-point seeds just take `mode:'max'` | Points get **quotas** in the select step. Measured: `'max'` alone gave an eclectic set 2/17/1 per artist | the study's eclectic seed set |
| server | Artist kind ranks with the default near-dup guard | `nearDup: Infinity` for artists. A one-song album's centroid is that song, which would drop it | `discovery-similarity.js:518,553` |
| server | Skip-word haystack uses the library-relative path | It uses the **wire** path `<library>/<relative>`, the field both clients document | `auto-dj.js:185-190`; phone `auto_dj_manager.dart:827-833` |
| server | Members resolve under `ignoreVPaths` | Under the caller's **access** only, so the item's sound is the item's. `ignoreVPaths` shapes the candidates | — |
| server | — | New: an LRU of ranked lists per seed, so a filter change skips the scoring pass | §3.5 step 2 |
| webapp | Reuse `dpage.seeds.notAnalyzed` with a `::first-letter` CSS trick | A new `mix.notAnalyzed` key, "Not analyzed yet" | `en.json:1506` is a seed-chip suffix |
| webapp | `mix.noMatch` "No songs match these filters" | "**No songs match your filters**", the phone's existing wording, so one state reads the same on both clients | phone `app_en.arb:1844` |
| webapp | Read `instantMix` from ping | Read it from `/api/` `features`, with `discoveryReady`, in the call `init()` already makes | `m.js:820-826` |
| webapp | Six panels each set `programState = []` | One line in `changeView` (`spa.js:39-50`) resets it, and records `lastView` | §4.7 |

---

## 1. Decisions

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | Random-songs mode, or a sibling route? | Sibling `POST /api/v1/discovery/local/mix`. It takes random-songs' keys, Joi schemas and SQL builder | random-songs is a picker: ≤ 25 songs (`random.js:698`), random inside a threshold, first step wins (`:41-49`), 400 when empty (`:905-909`). Each trait breaks a ranked 50-song list |
| D2 | Which Auto DJ settings count as filters? | Sources/folders · Minimum Rating · BPM continuity (+ tolerance) / Beat matching · Harmonic mixing · Keyword filter / Skip words · Genre filter · Mood / Smart filters · Track length | These narrow which songs qualify; the rest steer a running session (`left_out` list) |
| D3 | Hard or soft? | Every filter is a hard WHERE that is never relaxed | A list may be short. Widening it silently would show excluded songs, and saying so would need a badge, which the minimal-text rule forbids |
| D4 | Tempo and key on which items? | Song seeds only, built around the seed's own BPM and key by each client's Auto DJ helper. Hidden for album, artist and playlist seeds | No single tempo or key: Stim Pack Volume one spans five keys |
| D5 | Skip words | New mix-only server key `skipWords`. It lowercases and folds repeated letters (the webapp rule) over title, artist, album and wire path | Client post-filtering shortens the list and breaks the artist spread |
| D6 | Similar artists (Last.fm) | Not on the mix (confirm Q2) | A second, name-based notion of similarity. Webapp-only, needs a Last.fm key, and as a hard filter it drops the seed's own artist |
| D7 | Seed song that fails a filter | It drops out; the header still names it (confirm Q3) | Every row keeps the filters' promise |
| D8 | Narrow filters on tiny libraries | Take every match within the ranking budget, `considerBudget(50)` = 2,500 nearest. No relative floor in v1 | The budget bounds distance on real libraries. A floor needs measuring across seeds first |
| D9 | Close \| Varied | Cut | Judges: the first 12 rows are identical, and the remembered setting earns nothing |
| D10 | An artist's own songs in its mix | Kept, inside the cap | An excluding Boukmanflow mix on the demo is 40 ALM + 10 Color Out |
| D11 | An album's / playlist's own songs | Left out | Playing the item is what its own Play does |
| D12 | Filter persistence | The page keeps its own filters in memory: for the session (webapp), for the app run (phone). Never read from or written to Auto DJ | The rule every filtered list here follows (`m.js:3339-3352`, phone `mood_filter.dart:218-222`). Auto DJ's values steer a playing session |
| D13 | Webapp placement | Funnel at the right end of the header's action row; the panel under the header, inside `#browse-head`, capped at 45vh | The verbs never move, and the panel sits right above the list it shapes (Discover's precedent, `m.js:4819-4821`) |
| D14 | Phone placement | `MoodFilterButton` in the toolbar opens a sheet of Auto DJ rows. It holds a draft; Done applies it as one request. The strip names what is set, with Clear | The app's one Filters pattern (`browser_toolbar.dart:319-351`). Nothing is on the page until something is set |
| D15 | Labels, headings, hints | Auto DJ's own labels. No section headings, hints or per-row enable toggles: a filter is on when it holds a value | Minimal text |
| D16 | Re-asking | Webapp: on each commit, debounced 250 ms, newest wins, old rows dimmed. Phone: on Done or Clear; rows inert, a 3 px line under the banner | Each client's existing filtered-list behaviour (`m.js:3526-3557`; Discover phone controller) |
| D17 | Entry gating | `discovery && discoveryReady && instantMix ≥ 1`. Hidden, never disabled | The judges' readiness gate |
| D18 | Connected servers' items | No Instant Mix on either client in v1. The route is allowlisted server-side anyway (confirm Q4) | Save, Rating, Sources and Smart filters don't apply there, and the webapp cannot read a peer's flag. The server ships ready for a later client |
| D19 | Flag and version | `features.instantMix: 1` on `/api/` and ping. Generation 1 = the route with every filter in this spec. It ships in the release after v6.32.3; clients never read the version string | House rule (`server-info.js:69-136`) |
| D20 | `includeSeed`, `from.vectors`, `album: null`, `offset` | Not in the contract (400) | No v1 client needs them; a later generation can add them |
| D21 | `from.songs` | Kept | It is the playlist kind's internal form, and the form a peer playlist will use later |
| D22 | Save | Webapp: `#savePlaylistModal` prefilled "‹seed› Mix", with the `pattern` attributes removed. Phone: `PlaylistPickerSheet` → New playlist prefilled. "‹seed› Mix 2", 3… when the name is taken | One name on both clients; overwriting happens only by choosing an existing playlist (judges) |
| D23 | Shuffle | Replaces the queue, shuffled, and plays | direction B |
| D24 | Play | Replaces the queue. A seed that is already playing keeps playing | direction B |
| D25 | The webapp ▾ | Retitled "More" (title and aria-label), Discover's ⋯ too | the judges |
| D26 | Failure after a filter change | Webapp: the line and Try again replace the rows; the open panel stays. Phone: the rows stay, the filters revert to theirs, and a snackbar shows | Each client's surface: the webapp panel is still open, the phone sheet already closed |
| D27 | Repeated asks for one seed | The server caches the ranked list per seed (LRU 8), so filter edits cost a probe, not a scoring pass | Filters change while the seed doesn't |

## 2. Confirm with the user (four)

1. **Tempo and key only on song mixes, as hard filters around the seed's BPM and key?** Recommended: yes. Albums, artists and playlists have no single tempo or key.
2. **Leave Similar artists (Last.fm) off the mix?** Recommended: yes for v1. It is a second, name-based similarity, webapp-only, and needs a key.
3. **When a filter excludes the seed song itself, it drops out of its own mix (the header still names it)?** Recommended: yes. Every row keeps the filters' promise.
4. **No Instant Mix on a connected server's items in v1 (both clients), with the server route allowlisted for later?** Recommended: yes.

---

## 3. API

### 3.1 Route, flag, version

- `POST /api/v1/discovery/local/mix`. It reads and records nothing, so anyone the auth wall admits may call it: accounts, public mode, and federation keys and their guests (allowlisted, §3.8).
- `features.instantMix: 1` (`src/api/server-info.js`, after `flowOrder` `:135`) and `instantMix: features.instantMix` on ping (`src/api/playlist.js`, after `flowOrder` `:48-51`).
  - It is an integer generation and a version fact, unconditional like `flowOrder`.
  - Clients show entries on `discovery === true && discoveryReady === true && instantMix >= 1`.
  - Generation 1 = this route with every key in §3.2. A filter added later to `SONG_FILTER_KEYS` bumps it to 2 in the same PR.
- First shipped in the release after v6.32.3. Clients gate on the flag only.

### 3.2 Request

Strict Joi (unknown keys → `400 "<key>" is not allowed`).

| Key | Type / bounds | Default | Notes |
|---|---|---|---|
| `from` | object with **exactly one** of the five below (`.xor`) | required | |
| `from.song` | string 1-4096, `"<library>/<path>"` | | `resolveSeedTrack` (`discovery.js:84-107`) |
| `from.songs` | string[] 1-500 | | Unresolvable paths are skipped; none resolvable → 404 |
| `from.album` | `{album: string 1-1000 (required, non-null), artist?: string\|null, album_artist?: string\|''\|null, year?: int\|null}`, strict; null = absent | | The `album-songs` identity, incl. the year range (`db.js:1156-1229`) |
| `from.artist` | string 1-1000, any spelling | | Folded with `nameKey` |
| `from.playlist` | string 1-1000 | | The caller's own; no user id → 404 |
| `limit` | int 1-200 | 50 | |
| `ignoreVPaths` | string[] ≤ 50 | | From here to `moods`: **`SONG_FILTER_KEYS`**, random-songs' exact schemas (`random.js:1255-1329`) |
| `minRating` | int 0-10 | | 0 = off; skipped for a caller with no user id (`:749-756`) |
| `bpmRanges` | `BPM_RANGE_ITEM[]` ≤ 16 (`{min,max}` 0-1000, min ≤ max) | | Hard |
| `requireBpm` | bool | | |
| `musicalKeys` | Camelot string[] ≤ 24, ≥ 1 recognised | | Hard |
| `requireMusicalKey` | bool | | |
| `genres` | string 1-200 [] ≤ 200 | | |
| `genreMode` | `whitelist`\|`blacklist` | whitelist | |
| `genreSource` | `tag`\|`model` | both | |
| `minDuration`, `maxDuration` | 0-86400 s | | 0 = no bound; backwards window → 400 |
| `allowUnknownDuration` | bool | | |
| `moods` | MoodFilter `{valence?, energy?, voice?, tags?, threshold?}` | | `parseMoods`, strict (`mood-filter.js:57-63,86-90`) |
| `skipWords` | string (trimmed, 1-100) [] ≤ 50 | | **Mix only** |

**Refused by name** (each a 400): `ignoreList`, `ignoreArtists`, `artists`, `bpmRangesWide`, `similarTo`, `similarToVector`, `similarToModelId`, `minSimilarity`, `lessLike`, `lessLikeVectors`, `lessLikeModelId`, `includeSeed`, `offset`, `variety`, `maxPerArtist`, `vectors`.

**Example** (the Filtered boards' body; Dolo is 87 BPM, Bb minor = 3A):
```json
{ "from": { "song": "demo/Boukmanflow/Dolo.mp3" },
  "limit": 50,
  "moods": { "energy": "relaxed" },
  "musicalKeys": ["3A", "3B", "2A", "2B", "4A", "4B"],
  "requireMusicalKey": true }
```
Other kinds: `{"from":{"album":{"album":"Stim Pack Volume one","album_artist":"Boukmanflow","year":2019}}}` · `{"from":{"artist":"Boukmanflow"}}` · `{"from":{"playlist":"Road trip"}}`.

### 3.3 Validation and errors

| Status | When |
|---|---|
| 400 | Joi: `from` missing or doubled; an unknown or refused key; bounds; a BPM range with min > max; no recognised Camelot code; a backwards length window (`checkDurationWindow`); a bad `moods` group or value; a `skipWords` item blank after trim |
| 403 | Discovery off, or the store dead (`requireIndex`, `discovery.js:71-78`) |
| 404 | Uniform, so it cannot be used to probe: unknown or forbidden song; album, artist or playlist with no visible track; a playlist not the caller's, or a caller with no id; `songs` with nothing resolvable. Bodies: "Track not found" / "Album not found" / "Artist not found" / "Playlist not found" |
| 200 | Everything else, the empty states included (§3.7) |

### 3.4 Seeds: members and points

The members resolve under the caller's **access** only, `libraryFilter(req.user)`, never `ignoreVPaths`. A member is *analysed* when the index has its canonical hash.

| Kind | Members | Points (≤ 6) | Excluded from candidates |
|---|---|---|---|
| song | the seed row | its vector | its hash and name key (`entryNameKey`); `rankTracksMulti`'s default near-dup (0.99) drops its re-encodes |
| album | `albumSongConditions(from.album, filter)` rows | one: `centroidOf` of the analysed members | member hashes, name keys, and cos ≥ 0.99 against any member (checked on the walk) |
| artist | primary-artist rows: `a.name_key = nameKey(from.artist)` | album groups (`album_id`, NULL = one group), analysed only, the 6 largest; one group = one point | **nothing**: own songs stay in, capped. `nearDup: Infinity` |
| playlist | `playlist_tracks` of `playlists(name, user_id = req.user.id)` in position order → `resolveFlowTracks` (`db.js:578`) | artist groups (`entry.artistKey`), analysed only, the 6 largest | as album |
| songs | `resolveFlowTracks(from.songs)` | as playlist | as album |

- No analysed member gives `notAnalyzed`.
- **Weights** for the quotas (§3.5 step 5): equal for artist groups; each group's share of the analysed members for playlist and songs. One point means no quotas.

### 3.5 The walk

1. **Index.** `requireIndex()`, then resolve the seed (§3.4), then:
   - `minRating = effectiveMinRating(req, body)`;
   - `f = songFilterConditions(req, body, { minRating })`, which gives `{ ratingJoin, baseConditions, baseParams }`;
   - `m = buildBpmKeyFilter(body)`;
   - `{ moods, echo } = applicableMoods(parseMoods(body.moods))`.
2. **Rank, cached.**
   - Call `await sim.rankTracksMulti(index, points.map((p) => p.vec), { exclude, excludeNameKeys, nearDup, topK: considerBudget(limit), mode: 'max', dedupe: false })` (`discovery-similarity.js:500-601`). It returns `{entry, similarity, seedIndex}` in descending order. `dedupe: false` because dedupe must follow visibility (`:494-498`).
   - Cache the result in `rankCache`: a `WeakMap<index, Map<key, ranked>>`, LRU 8, with key = kind + the sorted member hashes + `limit`. It follows the `sonicPoolCache` pattern (`random.js:600-676`). A rebuilt index drops it.
   - It is async and yields between passes.
3. **Probe.** Walk the ranking in chunks of 400 hashes, one statement per chunk:
   ```sql
   SELECT t.id, COALESCE(t.audio_hash, t.file_hash) AS hash, t.title, t.filepath, l.name AS library_name,
          a.name AS artist_name, al.name AS album_name
     FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
     JOIN libraries l ON l.id = t.library_id ${f.ratingJoin}
    WHERE ${f.baseConditions.join(' AND ')} [AND ${m.clauses.join(' AND ')}]
      AND t.id IN (SELECT id FROM tracks INDEXED BY idx_tracks_audio_hash WHERE audio_hash IN (…)
                   UNION ALL
                   SELECT id FROM tracks INDEXED BY idx_tracks_hash WHERE file_hash IN (…) AND audio_hash IS NULL)
    ORDER BY t.id
   ```
   - Parameters: `f.baseParams` (user id first when rating), then `m.params`, then the hashes twice. The `INDEXED BY` pins are `visibleTracksByHash`'s (`src/discovery/taste-queries.js:86-124`); without them, the `file_hash` leg picked the wrong index at 25k.
   - Per hash, keep the lowest-id passing row.
   - Drop a `skipWords` match. The haystack is `title + ' ' + artist + ' ' + album + ' ' + library/filepath`, lowercased and with repeated characters folded (`(.)\1+` → `$1`), the same for each word; a blank word never matches (`auto-dj.js:139-197`).
   - Keep the first row per name key.
   - Album, playlist and songs kinds: drop cos ≥ `NEAR_DUP` (0.99, `discovery-novelty.js:19`) against any member.
   - Stop at `2 × limit + 64` eligible, or when the ranking ends.
4. **Seed lead** (song kind). Probe the seed's hash with the same statement and the skip-word check. It leads only if a row passes (D7).
5. **Select.** `cap = max(2, ceil(limit / 10))`, which is 5 at 50. The seed counts toward its artist.
   - **One point:**
     - *band* = `min(2 × limit, |{eligible with s ≥ s[limit-th eligible] − 0.10}|)`; every eligible song when there are fewer than `limit`.
     - Ladder: (band, cap) → (band, 2 × cap) → (band, none) → (all, cap) → (all, 2 × cap) → (all, none).
     - Each step takes candidates in rank order, skipping those taken, those over the cap, and those at cos ≥ 0.99 against a pick, until `limit`.
     - Any pick at a step other than the first sets `relaxed: ["artistCap"]`.
   - **Several points:** quota `q_p = round(limit × w_p)`, adjusted so Σq = limit. For each point, heaviest first, run the one-point select over the eligible songs whose `seedIndex = p`, up to `q_p`, sharing the artist counts and the pick near-dup check. Then fill what is left with the one-point select over all remaining eligible songs.
6. **Order.**
   - The seed first.
   - Then the picks by similarity descending, cut into bands of 10.
   - Inside a band, repeatedly take the first row whose artist differs from the previous row's, else the first row.
   - Deterministic.
7. **Hydrate.**
   - `trackQuery(uid, { includeGenres: false })` `WHERE t.id IN (…)`, then `enrichRows`, `renderMetadataObj` and `toLiteMetadata` (`db.js:16,178,275,380`).
   - `genreTags` comes from the index entry.
   - `similarity` is rounded to 4 dp; the seed's is 1.
8. **`filteredOut`.** Only when nothing beyond the seed survived and the ranking held candidates. Probe the first ranked chunk with only `libraryFilter(req.user)` and the m3u rule: any visible row means `true`.

**Cost** (measured during the study)
- Demo: 0.6-3 ms.
- 25k: 31-44 ms, the scoring pass being 25-28 ms. A cached re-ask skips that pass.
- 100k: about 110-140 ms (estimated).
- Six points cost about six passes.

### 3.6 Response (200)

```json
{ "model": { "id": "effnet-discogs", "version": "1" },
  "seed": { "kind": "song", "members": 1, "analyzed": 1 },
  "notAnalyzed": false,
  "songs": [
    { "filepath": "demo/Boukmanflow/Dolo.mp3", "similarity": 1, "metadata": { "title": "Dolo", "artist": "Boukmanflow", "album": "Stim Pack Volume one", "bpm": 87, "musical-key": "Bb minor", "duration": 100, "album-art": "49210a871aa550bde1818f31244b9b69.jpeg", "…": "…" }, "genreTags": ["…"] },
    { "filepath": "demo/ALM/Free Instrumentals Vol.2 - Old School Session/Enfance.mp3", "similarity": 0.7942, "metadata": { "…": "…" }, "genreTags": ["…"] }
  ],
  "short": true, "capped": false, "relaxed": ["artistCap"], "floor": 0.23, "filteredOut": false,
  "moods": { "energy": "relaxed" } }
```
- `songs` are in play order (§3.5 step 6), so `similarity` is not strictly descending.
- `seed`, `short`, `capped`, `relaxed` and `floor` are diagnostics for logic and tests. They are **never drawn**.
- `capped` = fewer than `limit` eligible after walking the whole budget.
- `moods` is the echo, present whenever the server has mood scores: `{}` when the request had none. It is absent when the server has no scores, and then no mood was applied.

### 3.7 States

| State | Answer | Webapp line | Phone line |
|---|---|---|---|
| Seed, or every member, not analysed | `notAnalyzed: true`, `songs: []` | `mix.notAnalyzed` "Not analyzed yet" | `instantMixNotAnalyzed` "Not analyzed yet" |
| Nothing similar | `songs` = `[]` or `[seed]`, `filteredOut: false` | `mix.nothingSimilar` "Nothing similar yet" | `instantMixNothingSimilar` |
| Nothing matches the filters | `songs` = `[]` or `[seed]`, **`filteredOut: true`** | `mix.noMatch` "No songs match your filters" + Clear | `autoDjSeedNoMatch` (same words), the strip's Clear |
| Short | `short: true` | nothing | nothing |
| Mood unavailable now | `moods` absent | the Mood row hides and `MOODS.filters.mix` empties | `moodEchoFits` false: the mood leaves the page's filters and strip (`mood_filter.dart:199-200`) |
| Discovery switched off | 403 | `dpage.state.off`; `currentServer.instantMix = 0` retracts the entries for the session | `discoverTurnedOff`; one re-ping, then the flag hides the entries |
| Any other failure | 400 / 5xx / network | `mix.failed` "Couldn’t build the mix" + `dpage.verb.tryAgain` | `instantMixFailed` + `discoverPageRetry` |

A client counts "nothing beyond the seed" as no row whose path differs from the seed's.

### 3.8 Federation

- Add `'POST /api/v1/discovery/local/mix'` to `ALLOWED_EXACT` (`src/api/federation-auth.js:47-94`, after `local/embeddings` `:83`), commented: a read, grant-scoped, no user id.
- With a key, `minRating` is skipped and `from.playlist` is a 404. The outbound browse proxy screens against the same table (`federation-browse.js:276-289`), so it forwards the route.
- v1 clients do not use it (D18). No change to `federation.js` health: a peer mix sends paths, not vectors.

### 3.9 OpenAPI (`docs/openapi.yaml`)

- **The path** `/api/v1/discovery/local/mix` goes after `/api/v1/discovery/local/similar/tracks` (`:3216`), before `/local/path` (`:3345`). It carries:
  - the request schema (`from` as a `oneOf`);
  - the response;
  - each status from §3.3 and each state from §3.7;
  - the note that generation 1 = these keys.
- **A `SongFilters` component** holds `SONG_FILTER_KEYS`; the mix request uses `allOf: [SongFilters]` + `from`, `limit` and `skipWords`. Pointing random-songs' entry at `SongFilters` is a follow-up after #1108 lands, because #1108's doc hunks sit inside that entry.
- **`features.instantMix`** goes after `flowOrder` (`:1783`), in the example (`:1874`), and in the ping schema after `flowOrder` (`:1943`).

### 3.10 Code layout (small overlap with PR #1108)

**`src/api/random.js`.** Four hunks, each with unchanged lines between it and #1108's.
- **(a) New exports after `buildArtistFilter`** (`:376`):
  - `BPM_RANGE_ITEM`;
  - `SONG_FILTER_KEYS` (`ignoreVPaths`, `minRating`, `bpmRanges`, `requireBpm`, `musicalKeys` with the Camelot custom, `requireMusicalKey`, `genres`, `genreMode`, `genreSource`, `minDuration`, `maxDuration`, `allowUnknownDuration`, `moods`);
  - `checkDurationWindow`;
  - `effectiveMinRating(req, body)`;
  - `songFilterConditions(req, body, { minRating })`. It returns `{ ratingJoin, baseConditions, baseParams }`, with the user id first, and covers library, rating, genre, length, mood and the m3u rule.
- **(b) `runRandomSongs`:** `:758-838` is replaced by one call to `songFilterConditions`. Lines `:749-757` (the `minRating` computation) stay where they are, beside #1108's insertion. Once #1108 lands, a follow-up makes them call `effectiveMinRating`.
- **(c)** `bpmRangeItem` becomes `BPM_RANGE_ITEM` (`:1216-1224`); the comment `:1206-1215` stays.
- **(d)** The schema spreads `...SONG_FILTER_KEYS` (`:1255-1329`), and `.custom(checkDurationWindow)` takes over the window check (`:1377-1382`); the comment stays.
- `bpmRangesWide`, `artists`, `ignoreArtists` and the sonic keys stay random-only, with a comment on the split.
- **Verified:** `git merge-file` against #1108 gives 0 conflicts in every code file, and the merged tree passes 250/250 db/unit and 238/238 integration Auto DJ tests (a trial merge during the study).

**`src/api/discovery-mix.js`** (new, the `flow.js` shape)
- Header contract comment, schema and `setup(mstream)`.
- `resolveMixSeed`, `runMix` and `rankCache`.
- Pure exports for the unit tests: `mixCap(limit)`, `selectMix(eligible, opts)`, `orderMix(picks)`, `skipWordsMatcher(words)`, `quotasFor(weights, limit)`.
- Imports:
  - from `discovery.js`: `requireIndex`, `resolveSeedTrack`, `considerBudget`;
  - from `random.js`: `SONG_FILTER_KEYS`, `songFilterConditions`, `effectiveMinRating`, `checkDurationWindow`, `buildBpmKeyFilter`;
  - from `mood-filter.js`: `parseMoods`, `applicableMoods`;
  - from `db.js`: `trackQuery`, `enrichRows`, `renderMetadataObj`, `toLiteMetadata`, `libraryFilter`, `resolveFlowTracks`, `albumSongConditions`;
  - from `discovery-similarity.js`: `rankTracksMulti`, `centroidOf`, `entryNameKey`, `dot`;
  - from `discovery-novelty.js`: `NEAR_DUP`;
  - from `name-key.js`: `nameKey`.

**Other files**
- **`src/api/db.js`.** Extract `albumSongConditions({album, artist, album_artist, year}, filter)` from the `album-songs` handler (`:1156-1229`). The handler calls it and keeps identical behaviour. #1108 does not touch this file.
- **`src/db/discovery-similarity.js`.** `function dot` (`:57`) becomes `export function dot`. #1108 does not touch `src/db/`.
- **`src/server.js`.** `import * as mixApi from './api/discovery-mix.js'`, and `mixApi.setup(mstream)` beside `flowApi.setup` (`:656`).
- **`src/api/server-info.js`, `src/api/playlist.js`, `src/api/federation-auth.js`, `docs/openapi.yaml`** as in §3.1, §3.8 and §3.9.

**Sequencing.** Either order merges clean. Stacking on `feat/autodj-less-like` is the zero-risk option, since merge commits support stacked PRs here. Run the suite on the merge tree before merging; PR checks are builds only.

### 3.11 Server tests

**`test/integration/discovery-mix.test.mjs` (new).** The `random-sonic.test.mjs` pattern: discovery on, model `test-fake`, handcrafted vectors on the scanned fixture, and a second admin-only library.
- **Gate:** 403 with discovery off.
- **Validation:**
  - `from` missing or doubled;
  - each refused key by name;
  - bounds, BPM order, Camelot, backwards window, moods, `skipWords` caps;
  - `album: null` is a 400.
- **Seeds:**
  - song leads, and drops out when a filter excludes it;
  - album excludes its members and respects the year range;
  - artist keeps its own songs, capped;
  - a one-song album's song survives an artist mix;
  - playlist: your own works, another user's is a 404;
  - songs: partial resolution works, none resolvable is a 404;
  - unknown or forbidden seeds get a uniform 404.
- **`notAnalyzed`:** an unembedded song; a multi-song item with nothing analysed.
- **Walk:**
  - the same body gives the same list;
  - three dedupe layers;
  - cap, spread and `relaxed`;
  - quotas keep every group present (eclectic playlist fixture);
  - `short`, and `capped` when the budget runs out.
- **Each hard filter,** plus the property "every returned row satisfies every filter":
  - the property runs over all seeds × each filter alone × two combinations;
  - the cases: `ignoreVPaths`; `minRating`, also ignored for a key; genres whitelist/blacklist × source; length ± unknown; every mood group and `threshold`; the mood echo, and its absence without scores; `bpmRanges`, `musicalKeys`; `skipWords`, including folding ("acappella" vs "acapella").
- **`filteredOut`:** true when the filters empty the list, false when nothing is similar.
- **Parity lock with random-songs:**
  - Use the base filters only (library, rating, genre, length, mood), which random-songs also never relaxes.
  - The fixture is fully embedded, has no same-title twins, and ≤ 25 songs pass.
  - The set of random-songs at `limit: 25` must equal the set of the mix at `limit: 200`.
- **Cache:** a second call for the same seed with other filters returns the right filtered list (the cache key ignores filters).
- **Access:** a restricted user never receives another library's songs.
- **Federation:** a minted key may call the route; its `playlist` kind is a 404 and its `minRating` is ignored; the browse proxy forwards the route.

**Other server tests**
- **`test/db/discovery-mix.test.mjs` (new,** the `autodj-cooldown.test.mjs` style). Pin the probe's EXPLAIN QUERY PLAN: the rowid IN-list, both hash legs on their `INDEXED BY` index, and PK probes for moods and rating. Pin the parameter order with `minRating` plus every filter at once.
- **`test/unit/discovery-mix.test.mjs` (new).**
  - `mixCap`; band and ladder; quotas; spread order; the skip-word matcher.
  - The lock: `SONG_FILTER_KEYS` keys ⊆ both route schemas' keys, via Joi `describe()`, so a new filter reaches both routes.
- **`test/unit/federation-auth.test.mjs`.** Add `['POST', '/api/v1/discovery/local/mix']` to "allows the read surface" (`:30-58`).
- **`test/integration/api-server-info.test.mjs`.** Assert `features.instantMix === 1` beside the `flowOrder` assert (`:137`). The drift-lock (`:220-238`) covers ping.
- **Unchanged and green:** `test/db/autodj-cooldown`, `test/unit/auto-dj-client`, and integration `random-route`, `random-sonic`, `random-similar-artists`, `random-genre-source`, `mood-filters`. With #1108 also `autodj-less-like` and `random-less-like`.

---

## 4. Webapp

### 4.1 Gating

- **`init()`** (`m.js:820-826`). In the existing `MSTREAMAPI.serverInfo().then`, also set:
  - `currentServer.discoveryReady = info.features.discoveryReady === true`;
  - `currentServer.instantMix = Number(info.features.instantMix) || 0`.

  The `.catch` sets both to false / 0.
- **`instantMixOn()`** = `currentServer.discovery === true && currentServer.discoveryReady === true && currentServer.instantMix >= 1 && !peerContext`. Before `/api/` answers, it is false.
- A 403 sets `instantMix = 0` for the session, as Sonic Path retracts itself (`m.js:6011-6016`).
- **Never offered on:** the singles bucket (`album === null`); a playlist or album page that drew no rows; a connected server's rows. `createPopper3` already refuses peer rows (`m.js:909-912`).

### 4.2 Entries

| Where | What | Anchor |
|---|---|---|
| Song ▾ menu `#pop-f` | First item "Instant Mix" (`#pop-f-mix`, `.pop-list-item`), above "Add To Playlist:". Shown by `createPopper3` when `instantMixOn()`. It serves browse rows, search rows, Downloads rows, Discover's ⋯ and the mix's own ⋯, so mixes chain | header written at `m.js:773`, `:2904` → a shared `popFHeadHtml()`; `index.html:881-883` |
| Queue ⋮ `#pop-d` | "Instant Mix" (`#pop-d-mix`) after Song Info, for a local song (no `federation`) while `instantMixOn()`. The order becomes Song Info · Instant Mix · Download · (Keep a copy…) · Add To Playlist: | `index.html:1485-1492`; a new capture listener beside `onQueueMoreCapture` (`m.js:8920-8955`), kept separate because `webapp-browse-keep.test.mjs:73` slices that function |
| Directory bar | `#instant_mix_btn`, a 24 × 40 white sparkles glyph (Material `auto_awesome`), `title`/`aria-label` "Instant Mix", just left of Add All (`id="add_all_btn"` on that svg) | `index.html:834-858`; shown by `getAlbumSongs` (`m.js:3782-3839`), local album, non-null, ≥ 1 row; by `getArtistsAlbums` (`:3305-3336`), local; by `onPlaylistClick` (`:3022-3058`), ≥ 1 row; hidden by `setBrowserRootPanel` (`:414-448`) with `?.` guards |
| ▾ titles | "More" (`t('dpage.verb.more')`) as `title` and `aria-label` on `createMusicFileHtml` (`:355`), Downloads (`:4175`) and search (`:7552`) rows, and Discover's ⋯ (`:5133`, today `dpage.verb.addToPlaylist`). The class `fileAddToPlaylist` stays | the judges |
| `.pop-playlist` grey | `#888` → `#9a9a9a` (4.5:1) | `spa.css:833-840` |

### 4.3 The page

- **Chrome** (`instantMixChrome()`)
  - The directory bar is shown (needed under Discover, `m.js:3786-3790`) holding ← Go Back and `#directoryName` = "Instant Mix".
  - Hidden: 🔍, mkdir, upload, Add All, `#instant_mix_btn`, `#genre_source` and the bar's `#mood_filter_btn` (`hideMoodFilters()`).
  - Calls `discoveryHideHead()` and `browseKeepReset(true)`.
  - The column title stays (e.g. "Albums").
- **Header** in `#browse-head` (`index.html:873`), with the `.browse-head` grid (`spa.css:2988-3011`)
  - **Tile:** 72 px, via `browseHeadTile`: album or song art, the round person for an artist, a playlist glyph.
  - **Title:** `h2.browse-head-title` with `tabindex="-1"`, focused on open.
  - **Sub-line:** song → artist; album → album artist or artist; artist and playlist → none.
  - **Action row** `.browse-head-row`:
    - `▶ Play` (`.spath-btn.spath-btn-primary`, `sonicPath.play`);
    - `Shuffle` / `Queue all` / `Save as playlist` (`.spath-btn`, `dpage.verb.*`);
    - then the **Filters** funnel (§4.4) with `margin-left: auto`.
  - The row is hidden until the first answer has songs.
  - **Narrow (< 420 px):** the container rule (`spa.css:3006-3011`) shrinks the tile to 56 px, and the row takes the full width.
- **List** in `#filelist`
  - `<div class="dpage mix-page"><div class="dpage-songs dpage-songs-solo"><div class="dpage-col"><div class="dpage-rows" aria-label="Instant Mix">…`
  - Rows are `discoverySongRowHtml`'s markup (`m.js:5118-5149`) with `data-mx` actions:
    - `.discover-row.dpage-row`, the 40 px art (`discoveryArtHtml`), the title, and "Artist · Album" ("Artist" for a single);
    - hover verbs `.dpage-vb`: ▶ Play now, + Add to queue, ⋯ "More" with `data-file_location` (opens `#pop-f`).
  - **Row actions:**
    - a row click queues the song and toasts `discover.modal.queued`;
    - ▶ inserts it next and plays it (`m.js:5369-5370`).
  - **First load:** `discoverySkelHtml('rows', 4)` (`m.js:4978-4983`).
- **Verbs** (`instantMixPlay(shuffle)`, `instantMixQueueAll()`, `instantMixSave()`). They act on the answer for the current filters; while an ask is out, each awaits it.
  - **Play:**
    - When row 1 is the local song now playing: a new `MSTREAMPLAYER.trimToCurrent()` (§4.8), then rows 2…n are appended.
    - Otherwise: `clearPlaylist()`, then add every row with `autoPlayOff` after the first, so row 1 plays. Do not copy Sonic Path's all-`autoPlayOff` loop (`m.js:6031-6033`).
  - **Shuffle:** `clearPlaylist()`, the rows in Fisher-Yates order, play the first. The player's shuffle toggle is untouched.
  - **Queue all:** `addSongWizard(…, false, undefined, false, true)` per row (`discoveryQueueAll`, `m.js:5569-5582`), then the toast `discover.modal.queued`.

### 4.4 The filters

**Funnel.** `<button type="button" id="mix_filter_btn" class="mood-filter-btn" aria-expanded="false" aria-controls="mix-filters" aria-label="Filters" title="Filters">`.
- **Glyph:** `index.html:843`'s 22 px path with its `.mood-filter-dot`.
- **States:**
  - white at rest;
  - orange with the dot while anything is set (`.mood-on`, `spa.css:1943-1945`);
  - `#31353d` behind it while open (`:1947`).
- **When shown:** with the first answer, and in the ready, re-asking, no-match and failed-after-a-change states. Never during not-analysed, nothing-similar or off.

**Panel.** `<div class="mood-filters mix-filters" id="mix-filters" role="region" aria-label="Filters">`, appended inside `#browse-head` after `.browse-head`. It is closed on every new mix page; the values carry over, the open state does not.
- **Layout:** a 2-column grid: label (`max-content`) | control (`minmax(0, 1fr)`), gap 8 px 14 px, `align-items: center`, `max-height: 45vh; overflow-y: auto`.
  - **Mood spans both columns,** its label above its controls, as Auto DJ's own `.autodj-opt-col` row does. Inline it would wrap to five lines.
  - **Labels** are `.mix-filter-label` (13 px `#8a919e`, the `.mood-sort-label` look, 4.5:1 on `#262a33`).
  - **Under 420 px** of `#browse-head`, it becomes one column.
- **Rows,** in Auto DJ's order (`m.js:6617-6654`), with its labels. Shared builders lifted out of `autoDjPanel` so the two cannot drift: `ratingOptionsHtml(selected)` (`:6256-6261`), `filterChipsHtml(items, kind)` (`:6325-6329`, `:6367-6371`), `genreSuggestHtml(query, selected, list)` (`:6967-7002`).

| # | Label (`en.json`) | Control (classes) | Shown when | Sends |
|---|---|---|---|---|
| 1 | Sources (`autoDJ.sectionSources`) | `.dj-vpath-pills` / `.dj-vpath-pill` (`.on` = included); the last one on is inert | the global folder choice leaves ≥ 2 libraries | `ignoreVPaths` = `localIgnoreVPaths()` ∪ the pills turned off. Never writes `djVpaths` or the legacy key |
| 2 | Minimum Rating (`autoDJ.minRating`) | `<select class="autodj-select browser-default">`: Any (`autoDJ.ratingAny`), ★ 0.5 … ★ 5 | always | `minRating` 1-10; omitted at Any |
| 3 | BPM continuity (`autoDJ.bpmContinuityLabel`) | `.toggle-sw` | song seed with a BPM | `bpmRanges` = `AUTODJ.buildBpmRanges(seed.bpm, tolerance)` (`auto-dj.js:123-137`) |
| 3b | BPM tolerance (`autoDJ.bpmToleranceLabel`) | `.autodj-slider` 1-20, value `autoDJ.bpmToleranceValue` "± n", default 8 | while row 3 is on | the width of `bpmRanges` |
| 4 | Harmonic mixing (`autoDJ.harmonicMixingLabel`) | `.toggle-sw` | song seed whose key maps to Camelot (`AUTODJ.toCamelot`) | `musicalKeys` = `[...AUTODJ.camelotNeighbours(code)]` + `requireMusicalKey: true` (Auto DJ's own pair, `mstream.player.js:288-305`) |
| 5 | Keyword filter (`autoDJ.keywordFilterLabel`) | `.dj-filter-tags` chips (`.dj-filter-tag` with `.dj-filter-tag-rm`, `autoDJ.keywordFilterTagRemove`) + `.dj-filter-input` (`autoDJ.keywordFilterPlaceholder` "Add a word and press Enter…"); Enter or comma commits; case-insensitive and unique; ≤ 50 | always | `skipWords` |
| 6 | Genre filter (`autoDJ.genreFilterLabel`) | `.dj-genre-mode` Whitelist \| Blacklist (`autoDJ.genreModeWhitelist/Blacklist`) + chips + `.dj-genre-combo` input (`autoDJ.genrePlaceholder` "Type to filter…") with `.dj-genre-suggest`; ≤ 200; the list comes from `AUTODJ.getCachedGenresList()` / `MSTREAMAPI.getGenres()`, prefetched on open | the genre list is non-empty, or a genre is set | `genres` + `genreMode` while the list is non-empty; mode alone asks nothing |
| 7 | Mood (`autoDJ.moodFilterLabel`) | `moodPanelHtml('mix', f, { clear: false })`: Happy\|Neutral\|Sad · Relaxed\|Neutral\|Aggressive · Instrumental\|Vocals · Acoustic / Party / Danceable · Strict\|Standard\|Loose; no Sort | ping `moodFilters` (`m.js:4363`) and the last answer did not drop it | `moods`, via `moodFilterBody('mix')` (threshold 0.7 / 0.3; Standard sends none) |
| 8 | Track length (`autoDJ.durationFilterLabel`) | `.dj-duration-inputs`: two `.dj-duration-field` (captions `autoDJ.durationMinLabel` / `durationMaxLabel`, `.dj-filter-input.dj-duration-num`, placeholder `autoDJ.durationNoLimit`, aria `durationMin/MaxInputLabel`), commit on `change`; then `.toggle-sw` "Include tracks with unknown length" (`autoDJ.durationUnknownLabel`) while a bound is set; the panel's **Clear** (`.mood-clear`, `moods.clear`) at this row's right end while anything is set | always | `minDuration`/`maxDuration` (seconds, each only > 0), `allowUnknownDuration` only beside a bound; backwards repaired by `AUTODJ.durationWindow` |

**Commits** are Auto DJ's twins: immediate for pills, select, switches, segments, chips and ×; Enter or comma for words; Enter, comma or a suggestion `mousedown` for genres (`m.js:7064-7076`); `change` for lengths.
- A commit updates the pressed states, chips, Clear and the funnel's `.mood-on` **in place**. The panel is never redrawn, so focus stays (`m.js:3526-3549`).
- Clear empties every row, hides itself, and puts focus on the funnel (`m.js:3522-3523`).
- The slider commits on `change`; it asks nothing while it is hidden.

### 4.5 Asking, loading, empty

- **Body.** `INSTANTMIX.requestBody(seed, MIX.filters, ctx)`:
  - `from`, by kind: song strips the leading slash; album sends `{album, artist?, album_artist?, year?}` with year a number; `{artist}`; `{playlist}`;
  - `limit: 50`;
  - every filter key only when it filters (§4.4 "Sends");
  - `moods` only with ping `moodFilters`;
  - tempo and key only for a song seed with a BPM / a key.
- **Ask.** `instantMixAsk()`:
  - `MIX.seq++`;
  - an LRU of 8 answers by body, drawn at once on a hit; otherwise `MSTREAMAPI.instantMix(body)`, kept in `MIX.pending`;
  - an answer is drawn only while `seq === MIX.seq` **and** the page is still on screen (`programState.at(-1) === entry`). `browseGeneration` alone doesn't move on navigation (`m.js:174`, `:3552`).
- **Re-ask.**
  - `clearTimeout`, then `setTimeout(instantMixAsk, 250)`.
  - `.mix-busy` goes on `.mix-page` at once: `.dpage-songs` opacity .6, `transition: opacity .15s .1s`, so a fast answer never flashes, plus `aria-busy="true"`.
  - The new rows replace the old and the list scroll goes to the top. The header and the open panel are untouched.
- **First load.** The header draws from what was clicked (`instantMixSongHead`: `browsingListMetadata()` `m.js:710-719`, Discover's `shown.allTracks`, the mix's rows, the queue song, else one `MSTREAMAPI.lookupMetadata`). The action row and funnel are hidden. Four skeleton rows show.
- **Lines.** One `.dpage-hint` line per state (`spa.css:3317`), from §3.7.
  - Not-analysed, nothing-similar and off show no action row and no funnel.
  - No-match keeps the orange funnel and puts a **Clear** (`.dpage-vb.dpage-hint-btn`) beside the line (the `discoveryColHintHtml` pattern, `m.js:5156-5159`).
  - **Failed after a change:** the line and Try again replace the rows; the funnel and open panel stay.
  - Opening a mix whose carried filters leave nothing: the panel stays closed, and the line plus Clear say why.

### 4.6 Save

- `openSavePlaylistModal(getPaths, name)` (`m.js:6039-6043`) gains `name` and prefills `#save_playlist_name` with it.
- **The default name** = `t('mix.defaultName', {name: seedTitle})` ("Dolo Mix", "Stim Pack Volume one Mix"). When `VUEPLAYERCORE.playlists` already has it (exact compare), it becomes "Dolo Mix 2", then 3, and so on. Accents and symbols are kept.
- **`savePlaylistFromModal`** (`:6045-6056`). After a save that created a new name, push it to `VUEPLAYERCORE.playlists`, `#pop-f` (via the shared row builder) and `#live-playlist-select`, as `savePlaylist` does (`:3227-3229`). Today Sonic Path and Discover saves skip that, so a second default name could collide unseen.
- **Remove `pattern="[a-zA-Z0-9 _-]+"`** at `index.html:108`, `:187` and `:255`. The server takes any title (`src/api/playlist.js:131,152`).
- The toast stays `sonicPath.playlistSaved` with the name.

### 4.7 Back

- **Opening** pushes `{ state: 'mix', seed, head, underView: lastView, previousScroll, previousSearch }`. On a phone-width layout it brings the browser tab forward (`m.js:4436-4440`).
- **Leaving** a mix (`instantMixLeave()`, idempotent):
  - restore 🔍 and Add All;
  - empty `#browse-head`;
  - abort the page's listeners (one AbortController per page).
- **What redraws underneath,** in `onBackButton` (`m.js:2847-2892`):
  - an existing branch is used;
  - **`fileExplorer`** calls `senddir()` **without** popping `fileExplorerArray`;
  - new **`playlist`** branch: pop the entry and reopen the playlist by name, like the `album` branch;
  - new **`mix`** branch: redraw that mix from the answer cache;
  - anything else (root lists with no branch, or panels with no `programState`): `changeView(entry.underView.fn, entry.underView.el)`.
- **Mix at the stack root:** a mix with `programState.length === 1` is handled before the early return at `:2848-2850`.
- **`changeView`** (`spa.js:39-50`) records `lastView = { fn, el }` and sets `programState = []` before `fn()`. A panel that keeps no state (Auto DJ, Sonic Path, Transcode, Jukebox, Mobile, Config) therefore can't leave a stale album entry under a mix. The root lists overwrite it anyway.
- **Fix in passing:** `onPlaylistClick`'s catch calls `boilerplateFailure(response, error)` with neither name defined (`m.js:3056`).

### 4.8 Files

| File | Change |
|---|---|
| `webapp/alpha/instant-mix.js` (new; UMD `window.INSTANTMIX`, pure like `discovery-page.js`) | **Constants:** `LIMIT = 50`, `WORDS_MAX = 50`, `GENRES_MAX = 200`, `DURATION_MAX = 86400`, `CACHE_MAX = 8`, `BPM_TOLERANCE = 8`.<br>**`emptyFilters()`** → `{ vpathsOff: [], minRating: 0, bpm: false, bpmTolerance: 8, harmonic: false, words: [], genres: [], genreMode: 'whitelist', minDuration: 0, maxDuration: 0, allowUnknownDuration: false }`; moods live in `MOODS.filters.mix`.<br>**`active(f, moodsBody, ctx)`** counts only the page's own filters that would be sent for this seed; the global folder choice is not one of them.<br>**Also:** `requestBody(seed, f, ctx)`, `viewState(answer, {kind, active})` (loading \| off \| failed \| notAnalyzed \| noMatch \| nothingSimilar \| ready), `defaultName(title, taken, fmt)`, `shuffle(list, rng)`, `cacheKey(body)` |
| `webapp/alpha/api.js` | `mstreamModule.instantMix = (body) => discoveryReq('api/v1/discovery/local/mix', body)` after `discoveryPath` (`:135-139`): 403 → `{disabled:true}`, other failures → null (`:88-104`) |
| `webapp/alpha/m.js` | **Flags:** `init()` per §4.1; `popFHeadHtml()` used by `init()` (`:773`) and `getAllPlaylists()` (`:2904`).<br>**Entries:** `createPopper3` toggles `#pop-f-mix` (`:904-946`); `instantMixFromMenu()` reads and then resets `curFileTracker`, or the next ▾ press toggles shut (`:919-923`); the queue capture listener; the bar glyph's show and hide in `getAlbumSongs`, `getArtistsAlbums`, `onPlaylistClick`, `setBrowserRootPanel`; the ▾ retitles.<br>**Back and save:** `onBackButton` branches (§4.7); `openSavePlaylistModal` / `savePlaylistFromModal` (§4.6).<br>**Mood plumbing:** `MOODS.filters.mix = {}` (`:3363`); `moodPanelHtml` treats `'mix'` like `'autodj'` (delegated, no inline handlers, `:3396-3397`) and takes `{clear:false}` (`:3407`).<br>**Shared builders:** lifted out of `autoDjPanel`, which calls them unchanged.<br>**A new "Instant Mix" section after Sonic Path (~`:6194`):** `MIX = { filters, open, seq, timer, pending, answer, cache, entry, abort }`, `instantMixOn`, `instantMixFromMenu/FromQueue/FromBar`, `instantMixSongHead`, `instantMixOpen`, `instantMixChrome`, `instantMixHeadHtml`, `instantMixFiltersHtml`, `instantMixRowHtml`, `onInstantMixClick` (list), `onInstantMixHead` (click, change, keydown and input on `#browse-head`), `instantMixAsk`, `instantMixDrawList`, `instantMixFilterChanged`, `instantMixPlay`, `instantMixQueueAll`, `instantMixSave`, `instantMixLeave` (guarded with `typeof` where shared functions call it) |
| `webapp/alpha/spa.js` | `changeView`: `lastView` + `programState = []` (§4.7) |
| `webapp/alpha/auto-dj.js` | Export pure `durationWindow(minSec, maxSec, prefer)` from `setDurationBounds` (`:1294-1307`), which calls it then `setState`. Nothing else changes; the mix never calls `setState` |
| `webapp/assets/js/mstream.player.js` | `mstreamModule.trimToCurrent()` beside `clearPlaylist` (`:956-977`): splice all but `positionCache.val`, set it to 0, drop the removed rows from `shuffleCache`/`shufflePrevious`, `clearEnd()`, and **no** `_autoDjQueueN`. Looping `removeSongAtPosition` would fire `autoDJ()` (`:1056-1059`) |
| `webapp/index.html` | **Bar:** `#instant_mix_btn` before Add All, and `id="add_all_btn"` on Add All (`:834-858`).<br>**Menus:** hidden `#pop-f-mix` before "Add To Playlist:" (`:881-883`); `<div id="pop-d-mix" class="pop-list-item" style="display:none" onclick="instantMixFromQueue()">{{ tt('mix.title') }}</div>` after Song Info (`:1486`).<br>**Name inputs:** drop the `pattern` attribute at `:108`, `:187`, `:255`.<br>**Script:** `<script src="alpha/instant-mix.js"></script>` beside `discovery-page.js` (`:1513`) |
| `webapp/alpha/spa.css` | `.mix-bar-btn` (24 × 40, transparent, white glyph, focus-visible `#fa832b`, 44 px under `pointer: coarse`); `.pop-playlist` `#9a9a9a`; `#browse-head .mix-head .mood-filter-btn { margin-left: auto }`; `.mix-filters` (grid §4.4, `max-height: 45vh; overflow-y: auto`, `.dj-filter-input`/`.dj-genre-mode` `margin-top: 0` inside it, the Mood row `grid-column: 1 / -1`, one column under a 420 px container); `.mix-filter-label`; `.mix-page.mix-busy .dpage-songs { opacity: .6; transition: opacity .15s .1s }` |

### 4.9 `en.json` (only this file; other locales fall back, `webapp/assets/js/i18n.js:35`)

**New** (6):

| Key | Text |
|---|---|
| `mix.title` | "Instant Mix" |
| `mix.noMatch` | "No songs match your filters" |
| `mix.nothingSimilar` | "Nothing similar yet" |
| `mix.notAnalyzed` | "Not analyzed yet" |
| `mix.failed` | "Couldn’t build the mix" |
| `mix.defaultName` | "{{name}} Mix" |

**Reused**
- The verbs: `sonicPath.play`, `dpage.verb.shuffle`, `dpage.verb.queueAll`, `dpage.verb.saveAsPlaylist`, `dpage.verb.playNow`, `dpage.verb.queue`, `dpage.verb.more`, `dpage.verb.tryAgain`.
- Moods: `moods.filters`, `moods.clear`, `moods.*`.
- Auto DJ labels: `autoDJ.sectionSources`, `autoDJ.minRating`, `autoDJ.ratingAny`, `autoDJ.bpmContinuityLabel`, `autoDJ.bpmToleranceLabel`, `autoDJ.bpmToleranceValue`, `autoDJ.harmonicMixingLabel`, `autoDJ.keywordFilter*`, `autoDJ.genre*`, `autoDJ.moodFilterLabel`, `autoDJ.duration*`.
- States and toasts: `dpage.state.off`, `discover.modal.queued`, `sonicPath.playlistSaved`, `sonicPath.playlistSaveFailed`, `sonicPath.saveAsPlaylist`.

### 4.10 Webapp tests

- **New `test/unit/webapp-instant-mix.test.mjs`** drives `INSTANTMIX` under node:
  - one body per seed kind;
  - each key only when set;
  - `allowUnknownDuration` only beside a bound;
  - `moods` only with `moodFilters`, and `threshold` only when not Standard;
  - tempo and key only for song seeds with a BPM / a key, with Dolo's windows and its 3A set;
  - the `ignoreVPaths` union;
  - `active()`;
  - every `viewState`;
  - `defaultName` ("Dolo Mix", "Dolo Mix 2", "Téranga Mix" kept);
  - seeded `shuffle`.
- **New m.js sandbox cases**, with the sliced-function technique (`test/unit/webapp-mood-filters.test.mjs:38-58`):
  - `popFHeadHtml` + `createPopper3` gating;
  - the ▾ titles read "More";
  - `onBackButton` covers mix → album, mix → explorer (path kept), mix → playlist, mix over Auto DJ (runs `changeView`), and mix → mix;
  - `savePlaylistFromModal` registers a new name;
  - `trimToCurrent` keeps the playing row and adds no DJ pick.
- **Update the sandboxes that slice changed functions:**
  - `webapp-discovery-panel.test.mjs` (`FNS` `:100`; its Discover verb titles at `:633` become `dpage.verb.more`);
  - `webapp-browse-keep.test.mjs:74-79`;
  - `webapp-album-cards.test.mjs:57-59`;
  - `webapp-add-all.test.mjs:92`;
  - `webapp-local-search.test.mjs:75`;
  - `webapp-mood-filters.test.mjs:60`.

  Any new reference inside a shared function is `?.`-guarded or `typeof`-guarded: the sandbox's `getElementById` returns null for unknown ids (`webapp-browse-keep.test.mjs:259`).

---

## 5. Phone

### 5.1 Gating

- **`lib/objects/server.dart`**
  - New `int? instantMixGeneration` in `fromJson` (`:399-473`) and `toJson` (`:482-521`); junk loads as null.
  - `bool get instantMixUsable => (instantMixGeneration ?? 0) >= 1 && sonicUsable && !isFederated;` beside `sonicUsable` (`:160`). In v1 `!isFederated` is D18, the single place to flip.
- **`lib/singletons/server_list.dart`**
  - `_applyServerInfo` (`:525-576`): `server.instantMixGeneration = features is Map && features['instantMix'] is int && features['instantMix'] >= 1 ? features['instantMix'] : null` (the `hasTasteGeneration` rule, `:634`).
  - `_applyPingPayload` (`:601-626`): sets `null`.
  - The persist block (`:358-458`): add a `prevInstantMix` compare, so a change writes the servers file and fires `capabilityChanges`.
  - `_applyFederatedDefaults` (`:2646-2668`): unchanged (the getter handles peers).
- Hidden, never disabled. No version floor; `ServerCapabilities` and the random-songs table stay out of the mix call.

### 5.2 Entries

| Where | What | Anchor |
|---|---|---|
| Track sheet | "Instant mix" (`Icons.auto_awesome`) right after Play now when `isServerTrack && item.server!.instantMixUsable`. Order: Add next · Play now · **Instant mix** · (Add to end) · Add to playlist · Download · Find similar. It opens on `parentContext` once the sheet pops. It covers browser rows, album detail, the queue's Discover bar and the mix's own rows | `lib/widgets/track_actions_sheet.dart:146-150`, `:270-276` |
| Queue swipe pane | Info · **Instant mix** · Find similar; `extentRatio` = 0.25 × the number of actions; `_canInstantMix(item)` beside `_canFindSimilar` | `lib/widgets/queue_list.dart:58-62`, `:165-205` |
| Song Info | "Instant mix" chip (`Icons.auto_awesome_rounded`) after Find similar, with the same server resolution | `lib/screens/metadata_screen.dart:127-143` |
| Album toolbar | ✦ first: ✦ · Shuffle · ▶ · Add All · Download, inside the `_enqueueable(albumSongs)` block, for a named album | `lib/widgets/browser_toolbar.dart:498-514` |
| Playlist toolbar | ✦ before Shuffle when the playlist has rows | `:565-584` |
| Artist albums frame | ✦ before search | `:630-649` |

- Every ✦ is `Icons.auto_awesome`, tooltip "Instant mix", gated on `instantMixUsable`.
- **Not in v1:** album grid cards, the whole queue, More like this / the Discover bar strip, and peer sheets.

### 5.3 The page

- **The frame.** A browser frame (the mini-player stays docked, `main.dart:1197-1219`), with item types `kMixBanner = 'mixBanner'` and `kMixState`. Not `'banner'`, which `isHomeList` skips (`browser_list.dart:23-31`).
- **Toolbar** (a new branch before the normal list, `browser_toolbar.dart:~600`):
  - ← · "Instant mix" (`_title`) · **Filters** (`MoodFilterButton`, count = the mood's `count` + 1 per other set row) · Shuffle · ▶ (`_playButton`) · Add All · Save as playlist (`Icons.playlist_add_check`, tooltip `pathSaveAsPlaylist`).
  - The verbs show only with rows and are disabled while re-asking.
  - Width: 282 dp + the label, which ellipsises below ~380 dp.
- **Strip** under the toolbar (`browser.dart:1296-1306` returns it too): `FilterStrip(text, onClear)`. `MoodFilterStrip` becomes a wrapper of it and keeps the `mood-strip` key.
  - **Text:** the set rows' values in sheet order, joined " · ".
  - **Clear** applies at once and asks again.
- **Banner,** fixed above the rows (unlike the album banner), with a 3 px slot at its bottom edge for the re-ask line.
  - **Tile:** 86 px r8 cover (song or album); an artist gets a round raised tile with the person icon; a playlist a raised tile with an amber `queue_music` glyph.
  - **Text:** title 20/700, sub-line 13.5 text2.
- **Rows:** the browser's song rows, in the list-density `ListTileTheme` (`browser.dart:1654-1658`).
  - **Tap** follows the tap setting, by default Play from here (`settings.dart:157`).
  - **Long-press** opens the track sheet, so mixes chain.
- **Verbs:**
  - **Play** = `playMix(rows)` (`lib/util/queue_actions.dart`).
    - When row 1 is the playing track (same server and path), remove every other queue item through `removeQueueItemAt` (`audio_stuff.dart:3018-3029`), by identity, then `addQueueItems` rows 2-n. The plan of indices comes from a pure function.
    - Otherwise `playFromHere(rows, 0)` (`:211-253`).
    - Fallback if judged risky: always `playFromHere`.
  - **Shuffle** = `playFromHere(rows, 0, shuffle: true)`.
  - **Add All** = `addRowsToQueue(rows)`, then the snackbar `browserSongsAdded(n)`.

### 5.4 The filters

**Sheet** (`lib/widgets/mix_filters_sheet.dart`, new; `showAutoDjSheet` + the `AutoDjSheet` chrome, `auto_dj_sheets.dart:42-51`, `:271-323`)
- Handle, then the title "Filters" (`moodFilters`) with ✕.
- One `FedCard` of rows, no headings.
- Clear \| Done.
- It holds a **draft** of the page's filters. A row's own sheet, in value mode, hands its choice back to the draft. **Done** applies the draft as one request; **Clear** empties the draft; closing any other way changes nothing (`auto_dj_sheets.dart:1-4`).

| # | Row (ARB) | Opens / control | Shown when | Sends |
|---|---|---|---|---|
| 1 | Smart filters (`autoDjMoodTitle`) | `AutoDjValueRow`, value `moodLabels(…).join(' · ')` or `autoDjAny` → `showMoodFilterSheet(…, title: autoDjMoodTitle)`, no Sort | `server.moodFiltersAvailable` (else greyed "No mood data" via `autoDjMoodBlocked`) | `moods` = `MoodFilter.toJson()` |
| 2 | Genres (`autoDjGenres`) | `AutoDjValueRow` (`autoDjGenreValue`) → `GenresSheet`, one server, value mode: Only \| Skip, Generated \| Tags \| Mixed where offered (`:1450-1454`), a checklist, ≤ 200 | always | `genres`, `genreMode`, `genreSource` (none for Mixed) |
| 3 | Rating (`autoDjRating`) | `AutoDjValueRow` (`autoDjRatingValue` "3.5★+") → `RatingSheet`, one server, value mode | always (peers are hidden in v1) | `minRating` 1-10 |
| 4 | Length (`autoDjDurationRange`) | `AutoDjValueRow` (`autoDjLengthValue`) → `LengthSheet` value mode (Shortest / Longest wheels, Include unknown) | always | `minDuration`, `maxDuration`, `allowUnknownDuration` |
| 5 | Beat matching (`autoDjTempo`) | `AutoDjValueRow` ("Off" / `autoDjBpmTolerance` "± 8 BPM") → `TempoSheet` value mode (switch + 1-20 slider, default 8) | song seed with a BPM | `bpmRanges` = `bpmWindows(seed.bpm, tolerance)` |
| 6 | Harmonic mixing (`autoDjHarmonicTitle`) | `AutoDjSwitchRow` **without** the hint line | song seed whose key maps (`toCamelotCode`) | `musicalKeys` = `camelotNeighbours(code)` + `requireMusicalKey: true` (`lib/util/camelot.dart:56,71`) |
| 7 | Skip words (`autoDjSkipWords`) | `AutoDjValueRow` (the words joined " · " / `commonOff`) → `SkipWordsSheet` value mode, ≤ 50 | always | `skipWords` |
| 8 | (the server's name) | `AutoDjFolderCard`: one switch per folder; the last one on can't go off | the server has ≥ 2 folders | `ignoreVPaths` = the folders switched off |

**The strip text,** in that order:
- the mood labels;
- the genre value;
- `autoDjRatingValue`;
- the length value;
- `autoDjBpmTolerance`;
- "Harmonic mixing";
- the skip words;
- the folders still on, when one is off.

**The wire.** `MixFilters.toRequest(server, seed)` gives `{from, limit: 50, …libraryFilterFields(…), bpmRanges?, musicalKeys?, requireMusicalKey?, skipWords?}`.
- `libraryFilterFields` is pure and new (`lib/util/library_filters.dart`). `AutoDJManager.libraryFilters` (`auto_dj_manager.dart:639-671`) becomes a thin call into it, with an unchanged wire shape.
- `bpmWindows` moves out of `audio_stuff.dart:5345-5353` into `lib/util/bpm_windows.dart`.
- Each client keeps its own Auto DJ tempo rule. The phone's ± tolerance on all three windows differs from the webapp's scaled one (`auto-dj.js:123-137`); that difference predates this work.

**`from`:**
- song: `{song: path}`, leading slash stripped;
- album: `{album: albumSongsBody(name, year, albumArtist, artist)}` (`lib/util/album_songs_body.dart:14-24`);
- `{artist: name}`;
- `{playlist: name}`.

### 5.5 Behaviours

- **Persistence.** `MixFilterStore`, per app run, never saved.
  - App-level parts: mood, length, tempo + tolerance, harmonic, skip words.
  - Per-server parts, keyed by `localname`: genres, rating, folders.
  - A new mix frame starts from the store. Done or Clear updates that page and the store. An older mix frame keeps its own filters and strip.
- **Asking.**
  - The first load draws the banner at once, then `DiscoverySkeleton(rows: 6)` (`discovery_widgets.dart:431`).
  - **A re-ask** (on Done when the draft differs, or on the strip's Clear):
    - `generation++`;
    - the rows go inert (`IgnorePointer`), the verbs and Filters are disabled;
    - a 3 px amber `LinearProgressIndicator` runs at the banner's bottom;
    - the answer replaces the rows (`BrowserManager.replaceFrame`, `browser_list.dart:639-648`) and the list jumps to the top;
    - a late answer is dropped.
  - **A failed re-ask** keeps the rows, reverts the page's filters to the ones those rows were built with, and shows the snackbar `instantMixFailed`.
  - No pull-to-refresh: the mix is deterministic.
- **States** (`DiscoveryHint`, 14 px text2, `discovery_widgets.dart:368`), from §3.7:
  - no match keeps Filters and the strip;
  - nothing similar, not analysed, off and failed show no toolbar verbs;
  - failed has Try again (`discoverPageRetry`);
  - off re-pings once, as `discovery_page_controller.dart:477-491` does.
- **Save.** `PlaylistPickerSheet(server, newName: …)` → New playlist → `PlaylistNameDialog.show(initial:)`, which autofocuses (`playlist_name_dialog.dart:61`). Then `ApiManager().savePlaylist` (`api.dart:452-471`), add the name to `server.playlists`, and show the snackbar `addedToPlaylist`.
  - Picking an existing playlist overwrites it, the house convention.
  - **One shared `savePlaylistFlow(context, server, rows, {newName})`.** Sonic path (`sonic_path_screen.dart:298-332`) and Discover (`discovery_widgets.dart:131-158`) may move onto it.
  - **Default name** `instantMixPlaylistName(seedTitle)`; " 2", " 3"… when it is in `server.playlists`.

### 5.6 Files

| File | Change |
|---|---|
| `lib/objects/server.dart`, `lib/singletons/server_list.dart` | §5.1 |
| `lib/singletons/api.dart` | `fetchInstantMix(Server, Map body)`: direct http on `server.apiUri('/api/v1/discovery/local/mix')`, off the loading bar like `_postDiscovery` (`:1032-1059`), 20 s timeout → ok(`MixAnswer`) \| off (403) \| failed |
| `lib/objects/instant_mix.dart` (new) | `MixSeed` (kind, server, `from`, title, sub-line, art, seed BPM and key; `.song`, `.queued(MediaItem)`, `.album`, `.artist`, `.playlist`); `MixAnswer.fromServerMap` (rows as `file` `DisplayItem`s with lite metadata and `partialMetadata = true`, exactly as `discover_screen.dart:267-282` does; `notAnalyzed`, `filteredOut`, `moods`); `mixPlaylistName(base, existing)` |
| `lib/objects/mix_filters.dart` (new) | Immutable `MixFilters` (mood, public `GenreChoice` from `_GenreDraft` `auto_dj_sheets.dart:1456-1461`, minRating, length, folders off, tempo, harmonic, skip words); `toRequest`, `count`, `labels(l)`, `isEmpty`; `MixFilterStore` |
| `lib/util/library_filters.dart`, `lib/util/bpm_windows.dart`, `lib/util/queue_actions.dart` | §5.4 (`libraryFilterFields`, `bpmWindows`); `playMix` + its pure plan (§5.3) |
| `lib/screens/instant_mix/instant_mix_controller.dart` (new) | `ChangeNotifier`: the states, `refreshing`, `generation`, the frame's `MixFilters`, rows; `load`, `retry`, `apply`, `clearFilters`; injectable `fetch`/`reping` (`discovery_page_controller.dart:77-91`) |
| `lib/screens/instant_mix/instant_mix_listing.dart` (new) | A **stack** of entries (frame, controller, the label under it, the album to reopen), so a mix of a mix keeps the first alive. It watches `browserListStream`: re-labels "Instant mix" on top, and on pop restores the label under it and drops the controller.<br>**`openInstantMix(context, seed)`:** `Navigator.popUntil(isFirst)`, ask the panel to collapse, `closeSearch()`, close album detail and remember it, set the label, push, load |
| `lib/screens/instant_mix/instant_mix_widgets.dart` (new) | Banner, state lines |
| `lib/singletons/browser_list.dart` | `artistCache`/`currentArtist` and `returnAlbumCache`, kept in every reset, push and pop path (`:289-345`, `:509-573`, `:706-741`); `popBrowser` reopens the remembered album detail; a `revealRequests` stream |
| `lib/main.dart` | Beside the `TrackCapture` collapse (`:266`, `:690-692`), listen to `revealRequests` and collapse the panel |
| `lib/screens/browser.dart` | Dispatch `InstantMixListing.isListing` beside Discover (`:1519`); `_mixView` (the fixed banner + `ListView` on `BrowserManager().sc` of `makeListItem`); `_moodStrip` also returns the mix strip (`:1296-1306`) |
| `lib/widgets/browser_toolbar.dart` | The mix branch; the ✦ entries (§5.2) |
| `lib/screens/auto_dj_sheets.dart` | A **value mode** (optional start value + `onDone`) on `LengthSheet`, `TempoSheet`, `SkipWordsSheet`, `RatingSheet` (one server), `GenresSheet` (one server, `GenreChoice`). Without `onDone`, nothing changes. Extract `AutoDjFolderCard` from `_folders` (`:841-860`) and `autoDjCardHeader` from `_sheetHeader` (`:500-509`) |
| `lib/screens/auto_dj.dart` | `_ValueRow` → public `AutoDjValueRow` (`:619-714`); `AutoDjSwitchRow` from `_harmonicRow` (`:521-581`) with an optional hint; `_genreValue` → `autoDjGenreValue` (`:404-412`) |
| `lib/widgets/mood_filter_sheet.dart` | `FilterStrip`; `MoodFilterStrip` wraps it (`:407-458`) |
| `lib/widgets/playlist_picker_sheet.dart` | Optional `newName` → `PlaylistNameDialog.show(initial:)` (`:46-47`) |
| `lib/widgets/track_actions_sheet.dart`, `lib/widgets/queue_list.dart`, `lib/screens/metadata_screen.dart` | §5.2 |
| `lib/l10n/enum_labels.dart` | `browserChromeLabel` maps "Instant mix" → `l.instantMix` (`:121-161`) |

**PR split.** Stacked, merge commits:
1. The page: flag, API, page, entries, Save, keeping the seed playing, strings, tests.
2. The filters, on top: shared builders, sheet seams, public rows, `FilterStrip`, the sheet, the controller wiring, the icon and strip, tests.

Each merges after the server PR. Never run `dart format` in the phone repo. The repo has no PR CI: run `~/code/flutter/flutter/bin/flutter test` on the merge tree.

### 5.7 ARB strings

`lib/l10n/app_en.arb` with `@` descriptions, plus the nine other ARBs (de, es, fr, it, ja, pl, pt, ru, zh). Regenerate with `flutter gen-l10n` and commit the generated `app_localizations*.dart` (precedent 192e092e).

| Key | English |
|---|---|
| `instantMix` | "Instant mix" (the action, tooltips, the toolbar label) |
| `instantMixNotAnalyzed` | "Not analyzed yet" |
| `instantMixNothingSimilar` | "Nothing similar yet" |
| `instantMixFailed` | "Couldn't build the mix" |
| `instantMixPlaylistName` | "{name} Mix" (`name`: String; translations mirror the webapp's `mix.defaultName`) |

**Reused**
- Verbs: `play`, `shuffle`, `addAll`, `browserSongsAdded`, `pathSaveAsPlaylist`.
- Save: `trackAddToPlaylist`, `playlistsNew`, `create`, `addedToPlaylist`, `trackAddToPlaylistFailed`.
- Sheet: `moodFilters`, `clear`, `done`.
- Row titles: `autoDjMoodTitle`, `autoDjGenres`, `autoDjRating`, `autoDjDurationRange`, `autoDjTempo`, `autoDjHarmonicTitle`, `autoDjSkipWords`.
- Row values: `autoDjAny`, `commonOff`, `autoDjRatingValue`, `autoDjLength*`, `autoDjBpmTolerance`, `autoDjGenresSkipValue`, `autoDjNoMoodData`.
- States: `autoDjSeedNoMatch`, `discoverTurnedOff`, `discoverPageRetry`.

### 5.8 Phone tests

**New**
- `test/objects/instant_mix_test.dart`: `from` per kind; parsing, with `partialMetadata`, `notAnalyzed` and `filteredOut`; `mixPlaylistName`.
- `test/objects/mix_filters_test.dart`:
  - `toRequest` per row;
  - no `bpmRangesWide`, ever;
  - tempo and key only with a seed BPM / key;
  - `count`, `labels` and the strip order;
  - the store, per run and per server;
  - frame copies.
- `test/util/library_filters_test.dart`: the drift test (Auto DJ and the mix send identical keys for identical choices). `test/auto_dj_library_filters_test.dart` stays green unchanged.
- `test/util/bpm_windows_test.dart`, `test/util/mix_play_plan_test.dart`.
- `test/singletons/server_flags_instant_mix_test.dart` (the `server_flags_taste_test.dart` model):
  - the generation rule;
  - `/api/` sets it and ping nulls it;
  - the `servers.json` round trip;
  - `instantMixUsable` with `discoveryReady` false, with it null, and **false on a federated server**.
- `test/singletons/browser_return_album_test.dart`.
- `test/screens/instant_mix_controller_test.dart`: every state; generations; one re-ping; a failed re-ask reverting the filters.
- `test/screens/instant_mix_listing_test.dart` (with the real `Browser` + `BrowserToolbar`): push, replace in place, let go; chained frames and label restore; the toolbar per state.
- `test/widgets/mix_filters_sheet_test.dart`: rows, order and gating, incl. tempo and harmonic hidden for album seeds; the draft against Done; Clear; each sub-sheet handing its value back.
- `test/widgets/track_actions_sheet_test.dart`: Instant mix after Play now; hidden for local files, without the flag, while scanning, and on a peer.

**Extend**
- `test/screens/auto_dj_sheets_test.dart`: value mode writes nothing to `AutoDJManager`/`Server`.
- `test/widgets/mood_filter_sheet_test.dart`: `FilterStrip` keeps `mood-strip`.

---

## 6. Board content (real demo data)

**Source:** the study's prototype walk (the real filter builders) over the demo library's database.
- One library, "demo", so no Sources row and no folders card.
- Dolo: Boukmanflow · Stim Pack Volume one · 87 BPM · Bb minor (3A) · 1:40.

**Dolo, no filters (50):** the current boards' rows 1-12.

| # | Title | Sub-line | Cover |
|---|---|---|---|
| 1 | Dolo | Boukmanflow · Stim Pack Volume one | #803e61 |
| 2 | Elevation | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 3 | TopRanking | Boukmanflow · Stim Pack Volume one | #803e61 |
| 4 | Enfance | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 5 | SkyWalk | Boukmanflow · Stim Pack Volume one | #803e61 |
| 6 | Swing | ALM | #776c6c |
| 7 | Better Days | Boukmanflow | #77848a |
| 8 | (Bonus) Bawane | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 9 | Trouble in paradise | Boukmanflow | #47514d |
| 10 | Hip Hop Story | ALM · Free Instrumentals, Vol. 5 | #1f445b |
| 11 | Love of this key | ALM | #776c6c |
| 12 | up and down | Boukmanflow | #192b3d |

**Dolo, Mood = Relaxed (Standard) + Harmonic mixing on (14, seed leads)**, body as §3.2's example:

| # | Title | Sub-line (webapp) | Cover |
|---|---|---|---|
| 1 | Dolo | Boukmanflow · Stim Pack Volume one | #803e61 |
| 2 | Enfance | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 3 | The Hangout | Boukmanflow · The Hangout | #192b3d |
| 4 | Profondeurs | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 5 | Does she not | Boukmanflow | #77848a |
| 6 | El | ALM · Free Instrumentals Vol.2 - Old School Session | #675344 |
| 7 | Business as usual | Boukmanflow | #47514d |
| 8 | Destiny | ALM · Free Instrumental Vol.3 | #1f1b1a |
| 9 | Come Back Stronger | ALM | #ab9ea3 |
| 10 | One Day | ALM · Free Instrumental Vol.3 | #1f1b1a |
| 11 | Téranga | ALM · Free Instrumental Vol.3 | #1f1b1a |
| 12 | Being stuck | Boukmanflow | none (placeholder) |
| 13 | Civil Attack | ALM | #ab9ea3 |
| 14 | Therapy (In My Skin) | Color Out | none |

Every row is in 2A/3A/3B/4A/4B and scores relaxed. The list is short because the demo has 110 analysed songs; on a real library it fills to 50 within the budget.

## 7. Risks

1. **Far songs under narrow filters on tiny libraries.** Therapy (In My Skin) sits at cos 0.23 in row 14 above. The budget bounds this on real libraries (D8).
2. **The probe plan.** It must keep the `INDEXED BY` pins; the db test pins them.
3. **Event loop.** About 25 ms per point at 25k and ~100 ms at 100k, with ≤ 6 points. The scoring yields between passes, and the rank cache spares filter re-asks. The first call after a scan pays the index rebuild (1.5-1.7 s at 25k).
4. **Filters carried between mixes can surprise.** The funnel (orange) and the strip name them, with Clear (D12).
5. **Skip-word matching.** The phone's Auto DJ doesn't fold repeated letters; the mix (server) does. The phone's mix and its Auto DJ can differ on an odd word.
6. **Sliced-function sandboxes** (webapp), **the browser's single label and the album overlay** (phone): covered by the tests listed in §4.10 and §5.8.
7. **Play keeping the seed** loops queue removals on the phone. The fallback is `playFromHere`.
8. **Removing the webapp name pattern.** Smoke-test a name with an accent and a slash through rename, share and live playlists.
9. **Data quirk.** The demo stores the title `Wine &amp; Chill` raw; boards avoid it.

---

## 8. As built: where the code differs from this spec

Found while building, in review, or in the end-to-end checks against the demo library. The code and its comments are the reference; this list says why they differ.

**Server**
- **Probe plan.** The probe reads `FROM tracks t NOT INDEXED` with a `LEFT JOIN libraries l`. With a library clause (a caller who sees only some libraries), SQLite otherwise drove from `l` through `idx_tracks_library`, one lookup per library for every hash. `test/db/discovery-mix.test.mjs` pins the plan under node:sqlite and Bun.
- **Near-duplicate checks** (against members and picks) go through `nearDupSet`: a staged dot product with an exact early exit, so a 2,000-member playlist stays near 200 ms at 25k. Verdicts are cached with the ranking.
- **The walk** keeps going until each point holds twice its quota, or the ranking ends. Otherwise a tight corner's neighbours filled the target before a looser corner's first song arrived.
- **Quota runs never relax the artist cap;** only the final fill does (D10). Run per point, the full ladder let one artist take most of an artist or playlist mix.
- **The near-dup guard against the points** is 0.99 for the song kind only. Album, playlist and songs points are centroids, so the walk's exact per-member check decides members' recordings instead.
- **`filteredOut`** re-runs the same walk with no filters and is set only when the filtered walk found nothing, so a member's remaster or a full one-song list is never reported as filtered out.
- **`relaxed: ['artistCap']`** is set only by a pick taken under a looser cap than the base one. **`capped`** means short and stopped at the budget.
- **The seed lead** prefers the seed's own file among its recording's passing files. Unanalysed members still exclude their song by name key; the rank-cache key covers each member's hash, group and name key.
- A `notAnalyzed` answer carries the full diagnostic set, so the response has one shape. `nearDupSet` and `mixSchema` are exported for tests.

**Webapp**
- `changeView` sets `programState = [{ state: 'view' }]`, not `[]`: about nine existing reads of `programState[0].state` would throw on an empty stack.
- `trimToCurrent()` does not call `clearEnd()`, which would disarm the playing song's `onended` and stop the seed instead of moving on to row 2. Play keeps the seed only while it is the current entry and playing.
- The answer cache (`INSTANTMIX.keeps`) never keeps a "yet" state or a failure, so a mix reopened after analysis catches up asks again.
- `dpage.verb.addToPlaylist` left `en.json`: nothing uses it once Discover's ⋯ reads "More".
- The filter panel: the unknown-length switch sits inside the Track length control; the select, slider and focus colours are scoped to the panel (Materialize overrides Auto DJ's own); genre suggestions scroll the panel to show themselves; with the panel open the header shrinks and the list keeps two rows in sight; the last library still on is inert, with no toast.
- `INSTANTMIX.addName` applies Auto DJ's add rules plus the route's length limits, so a chip never silently drops out of the request.

**Phone**
- One PR (the page and its filters), not two stacked ones, merged onto the phone's master as of the build.
- `instantMixUsable` requires `discoveryReady == true` (D17), not `sonicUsable`'s `!= false`.
- `playMix` compares paths without the leading slash (Auto DJ queues server paths without it) and adds rows 2…n before removing the rest, so no Auto DJ pick lands between the seed and row 2.
- `MixFilters.toRequest(seed)` takes the seed only (it carries its server). `MixFilters.forSeed` holds only what a page can apply. The strip's words are `mixFilterLabels(l, filters, server)`, and `GenreChoice` lives in `lib/objects/genre_source.dart`.
- The mix request cuts each `bpmRanges` window to 0–1000 (the route refuses wider ones); value-mode Skip words stop at 100 characters.
- Below 360 dp the playlist bar moves search, Download and Shuffle into ⋮ to make room for ✦.
- `instantMixPlaylistName` is "{name} Mix" in every locale, as the webapp's `mix.defaultName` falls back to English.
- `camelotNeighbours` (`lib/util/camelot.dart`) had one capture group and read a second, so it threw on every key: the phone's Auto DJ Harmonic mixing has been broken since v0.15.0. Fixed here, since the mix needs it.
