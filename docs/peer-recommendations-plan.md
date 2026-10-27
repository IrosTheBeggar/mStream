# Peer Recommendations — plan

Status: plan v1, 2026-10-27, after three review lenses (code facts, compatibility/sequencing, design fidelity). Every finding was checked against the code; Appendix A lists the ones not taken. Design canvas: https://claude.ai/artifact/Vh8cGfvTrRiBsBGoMy6cnv, top row "B + C" (the user's pick; §2 lists where this plan deliberately differs from the boards).
Facts were verified against mStream `c965efac` (v6.32.0), `mstream_music` origin/master `3129ba52` (re-checked at `fee17e09`, which only adds #207's visualizer files, so every phone anchor holds on both), and `mstream-terminal-player` origin/main `12ee9a8` (v0.14.0 + 99 unreleased non-merge commits).

"Peer" in this plan always means the **P2P discovery network**: the catalog of announced servers, and the shelf of snapshots this server has fetched. It never means federation ("connected servers"), which Discover already shows and which is playable.

## 1. What we are building

A second discovery page beside Discover, **Peer Recommendations** (terminal nav label "Peer recs"), on all three clients. It holds the taste route's `network` leads: a similarity walk over the fetched peer snapshots on the local shelf, seeded by the user's finished songs. Leads are songs the user does not own. They are metadata-only (no stream, no album art), and a 30 s preview can play through the deezer/itunes `preview` plug-ins.

| Part | Web | Phone | Terminal |
|---|---|---|---|
| Entry | sidenav row under Discover (Music group) | full-width LISTEN home card after Discover | TOOLS nav row 16, key `R` |
| Top | Discover's config bar, then the **peer strip** (All + shelf peers, plus "+" items for admins) | same; the strip scrolls sideways | header (the config bar), then peer **tabs** on row 4 |
| Songs | two columns, column-major in blocks of 16 (8 \| 8) | 2-up card grid, row-major | two 38-cell columns, column-major in blocks |
| Row tap | the recommendation window (`openDiscoverModal(raw,'p2p',{from:'peerRecs'})`) | the lead sheet | the lead modal |
| Plays | only the always-visible play icon; a sticky band at the bottom of the browser column | only the 44 px circle; a band docked above the mini player | only `▸` / `l`; the band replaces the verbs line on row 6 |

What changes on the server: a member-readable peers route; an async admin Add that makes room on a full shelf; taste generation 2 (a server-side peer filter, network leads for users with no history, an empty-state reason, a stamped peer label, and a **server-stamped generated tile**); a new feature flag; a no-sidecar stage for live checks.

## 2. Decisions (chosen defaults; flagged where the user may want to change them)

Tags: **[user]** = the user's words. **[orch]** = decided by the orchestrator before planning. **[review]** = a review fix taken here. **[flag]** = a default the user should confirm (§7).

1. **[user] Layout "B + C"** (DECISIONS-v2 §1). The peer strip is the peer list: there is no Peers button, popover or window. There are two song columns. A row tap opens the plug-in modal, and only the play icon plays. Nothing else plays: not a row tap, and not the modal opening.
2. **[orch] Gate**: `discovery === true && discoveryP2p === true && discoveryTaste >= 2 && discoveryP2pPeers >= 1` (ping flat keys, or `/api` `features`). An older server shows **no entry point at all**, and there is no reduced page. The strict taste schema answers 400 to the new keys (`src/api/discovery-taste.js:84-94`), and a client-side filter of a global top-N can leave a peer nearly empty. The now-playing panel's Network tab keeps serving older servers unchanged.
3. **[orch] Narrowing is server-side.** A peer tab re-asks taste with `networkPeers:[id]`, pinned to the seed batch on screen (§3.5), so each peer gets its own top-N.
4. **[orch] Users with no finished songs still get leads (S6)**: `networkOnRandomSeed: true` walks the network on the single random pick.
5. **[orch] Add is admin-only and async** (202 plus a per-peer state). A page Add **does not pin**. A full shelf swaps out unpinned snapshots in rotation's eviction order. **No room** appears only when the incoming snapshot cannot fit even after evicting every unpinned one. Member pull is deferred.
6. **[review] "No room" is inert on all three clients**, and the server clears every stored `failed` state (no-room included) on any shelf or pin change. So "No room" disappears by itself as soon as an admin unpins something (§3.3). Only `planRoom` may store `no-room`; the admin panel's synchronous fetch never does.
7. **[orch] Members get a read-only peers route** (online state and shelf peers). Blocked and incompatible-model peers are hidden from everyone. Unheld catalog peers are admin-only.
8. **[review] The server stamps the generated tile and the peer monogram.** Every network lead carries `tile: {key, hue, letter}` and every peer row carries `monogram`, built with the server's own `nameKey` (`src/db/name-key.js`). Clients draw them verbatim and spread earned art by `tile.key`. This replaces three client implementations that the reviews found disagreeing (key fold, title fallback, letter casing, monogram base). The vectors live in one server fixture (§5.1).
9. **[flag] Computed hues replace the boards' fixed sample hues.** `hue = FNV-1a-32(tile.key) % 360` moves Undertow 170→4, Daylight Savings 50→352 and Porchlight 100→353, so three of the nine sample albums sit in reds. The user sees a frame-1 stage screenshot at Gate W (§6) before the webapp PR merges. If they want a curated palette instead, only the server's `leadTile` and the fixture change; clients are untouched.
10. **[review] One earned-art rule**: after a preview resolves, `preview.artwork` (https only) replaces the tile of every row with the same `tile.key`, **only when** both `nameKey(preview.album) == nameKey(lead.album)` (lead album non-empty) and `nameKey(preview.artist) == nameKey(lead.artist)`. Otherwise nothing changes anywhere, with no per-lead fallback. It lasts for the visit and is held in memory only. Terminal: no artwork ever. Phone cards (175 px) take only Deezer art (~250 px); the band and sheet take any (a logged phone deviation).
11. **[review] Attribution is drawn verbatim** from `preview.attribution` ("Preview from Deezer" / "Provided courtesy of iTunes"), linked to `preview.link` when it is https. It shows wherever a clip plays, never before a resolve, and is never a translated key on any client (Apple's wording, `src/discovery-plugins/plugins/itunes.js:5-8`).
12. **[orch] Preview provider** = the first plug-in in `GET /api/v1/discovery/plugins` order whose capabilities include `preview`. There is no fall-through to a second provider: a miss shows "No preview". Pacing and 429 rules are in §5.5.
13. **Preview engines**:
    - web: one shared aside `<audio>` element in `vp.js`;
    - phone: a second, lazily created `just_audio` player;
    - terminal: a new engine "aside" sink, with the main sink paused in place.

    Main pauses when the first clip of a session starts (only if it was playing) and resumes when the session ends. A user starting main ends the clip, and main is not resumed afterwards.
14. **[review] A clip never plays out of sight of its attribution.** It ends, and main is restored, when:
    - web: the page is left;
    - phone: the frame is covered or popped, or the app is backgrounded;
    - terminal: the room is not drawn (another room, a server switch, quit, or the mini player).
15. **[review] The modal shows only what the board draws**: header (tile or earned art, title, "Artist · Album", "● label"), then Preview, Get it…, Find elsewhere, Copy.
    - Get it… is one chip or row per acquire plug-in (title only). A press starts the server's best-match job. There is no destination bar, description, YouTube lookup card or candidate picker.
    - The web window hides its admin "Invite <peer> to federate" row **[flag]**, the "Opens in a new tab" hint and the "Search" lead label.
    - Copy has its own row, whatever plug-ins are on.
    - With plug-ins off and a member user, a web row click **still opens the window** (today it copies, `webapp/alpha/vp.js:1370`).
16. **[review] Rows carry no job state** (no badge, no thin bar, no swatch mark). The job shows inside the modal or sheet only, with a one-row `lookup/batch` when it opens. So the page never batch-looks-up jobs.
17. **[review] No "Show more".**
    - Web: draws all leads (≤ 32) as `DISCOVERYPAGE.columnBlocks` blocks of 16, each 8 | 8, so leads read best-first per block.
    - Terminal: blocks of 2 × the visible rows.
    - Phone: shows all leads in the grid.
18. **[review] States carry a reason and no extra sentences.**
    - "No peers yet": `shelf.searchable == 0`, or reason `empty-shelf` / `no-compatible`.
    - "Nothing new" plus New seeds.
    - Scan pending: Discover's scan-pending card. This is a logged deviation, kept because it names the reason.
    - Error or failed call: "Try again" alone.
    - Switched off (a peers 403, a taste 403, or taste `network: null` on a non-random answer): one re-ping, then the entry hides and the client leaves the page (web: file explorer; phone: pop the frame; terminal: Files). There is no off card.
19. **[review] Copy text** = `Artist - Title`, or just `Title` when the artist is empty, on every client. This includes the webapp's existing `copyDiscoverP2p` (`vp.js:4236`), which today gives "- Title". Copy list = the current tab's leads in list order, joined by `\n` with no trailing newline. The toast is "Copied".
20. **[flag] i18n.** The page's keys go into every locale file of each client: web 12 (EN + de es fr it ja ko nl pl pt ru zh), phone 10 ARBs, terminal 10 yml. The webapp also translates the Discover config-bar keys the page reuses (`nav.discover`, `panel.discover`, `dpage.basedOnLast`, `dpage.bar.*`, `dpage.window.*`, `dpage.verb.newSeeds`): the 11 locale files carry no `dpage.*` key today, so the bar would otherwise stay English beside translated page text.
21. **Terminal specifics.**
    - Nav: the whole column shifts up one row into the empty row 4: LIBRARY 4, rooms 5–11, TOOLS 12, Auto DJ 13, Sonic path 14, Discover 15, ▸ Peer recs 16. Settings stays on the content's last row. The key is `R` (free).
    - Columns are 38 cells, not the board's 39 (the scrollbar lane; logged deviation).
    - **[review]** With the queue open (47 cells) there are still two columns: ▌, title, play slot, about 21 cells each, with ARTIST dropped (the modal carries it).
    - Labels are drawn verbatim (`mStream · 3f9a`, not the board's `mStream·3f9a`).
    - The verbs line is lower-case as on the board.
22. **[flag] One coordinated release.** The mStream version bump waits for the player v0.15.0 pin PR, so the web page and the bundled terminal room ship together. The phone store build follows the mStream tag (§6.5).
23. **[orch] Privacy.**
    - No Cover Art Archive and no batch art lookups.
    - A third party is reached only on a press: the server searches Deezer/Apple; the client loads the clip and, after it, the earned art from the provider CDN.
    - The network walk on a random seed is local-only.
24. **[review] Phone grid** is always 2 columns (the user's "two columns"). Cards are capped at 240 px wide and the grid is centred on wider screens.

## 3. Server contract (mStream)

### 3.1 Flags
- `src/api/server-info.js:102`: `discoveryTaste: 2`. Generation 2 adds the `networkPeers` and `networkOnRandomSeed` body keys, `network.reason`, `peer.label` and `tile` on leads. Clients gate on `>= n` (house rule, `:94-101`).
- New, next to it: `discoveryP2pPeers: 1`. It covers `GET /api/v1/discovery/p2p/peers` and `POST /api/v1/admin/discovery/p2p/peer-dbs/add`.
- `src/api/playlist.js:35-39` (the hand-built ping): add `discoveryP2pPeers: features.discoveryP2pPeers`. The drift-lock (`test/integration/api-server-info.test.mjs:219-237`) fails until it is added.
- `discoveryP2p` stays the config flag (`server-info.js:84`), not the running state. The peers route says whether the stack is running (`shelf.running`, below).

### 3.2 `GET /api/v1/discovery/p2p/peers` (new; member-readable)
- **Wiring**: `src/api/discovery-p2p.js` `setup()`, next to `peer-dbs` (`:269`), with `mstream.use('/api/v1/discovery/p2p/peers', refuseJukebox)` (`src/api/discovery-plugin-jobs.js:83`). Gates:
  - `requireP2p()` (`:40-44`): 403 when p2p is off;
  - `requireAccount` (the taste rule, `discovery-taste.js:69-71`; move it to a shared helper): 403 for a guest or a federation key;
  - 401 without a token;
  - no `requireIndex`, so it works during a scan.
- **200, `Cache-Control: no-store`:**
```json
{ "canAdd": true,
  "shelf": { "held": 3, "searchable": 3, "running": true },
  "peers": [
    { "endpointId": "<64 hex>", "name": "Basement Hi-Fi", "label": "Basement Hi-Fi", "monogram": "BH", "hue": 210,
      "online": true, "onShelf": true, "pinned": false, "rowCount": 18234, "add": null },
    { "endpointId": "3f9a…", "name": "mStream", "label": "mStream · 3f9a", "monogram": "mS", "hue": 140,
      "online": false, "onShelf": true, "pinned": false, "rowCount": 5120, "add": null },
    { "endpointId": "<64 hex>", "name": "Static Garden", "label": "Static Garden", "monogram": "SG", "hue": 330,
      "online": true, "onShelf": false, "pinned": false, "rowCount": 7000,
      "add": { "state": "adding", "code": null, "at": "2026-10-27T10:00:00.000Z" } } ] }
```
- **Rows** (pure `buildPeerView`, NEW `src/state/discovery-peer-view.js`):
  - Shelf rows: one per `peerDbs.list()` entry that is not blocked and whose `modelId` matches the local model; `onShelf: true`; `pinned` from the registry.
  - Addable rows: only when `canAdd`. Catalog entries that are not held, not blocked, compatible (`modelCompatible`, `src/state/discovery-peer-rotation.js:41`), and either online or carrying an add state. Sorted, then capped at 24.
  - Members always get `add: null` and no addable rows.
- **`name`**: the catalog's latest `payload.name`, else the registry `name` (`peer-dbs.js:345`), else `''`.
- **`label`**:
  - The base is `name.trim()`, or `'mStream'` when that is empty.
  - Suffix `' · ' + endpointId.slice(0,4)` when the base is the default `mStream` (case-insensitive, `src/state/config.js:510`), or when two or more ids in the universe (catalog ∪ shelf, minus blocked) share the base (case-insensitive, NFKC).
  - If two suffixed labels still collide, those ids use 6 hex.
  - The same universe and function label taste leads (§3.4), so the strip and the modal agree. Clients render the label verbatim and **key every state on `endpointId`**.
- **`monogram`** (§5.2) and **`hue`** = `parseInt(endpointId.slice(0,6), 16) % 360`.
- **`online`**: `now − Date.parse(catalog.updatedAt) < onlineWindowMs()`. The window is 90 s, `ONLINE_WINDOW_MS` (`rotation.js:30`). `onlineWindowMs()` is a NEW helper in `peer-dbs.js`'s `MSTREAM_TEST_*` block (`:42-75`), overridable by `MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS`. The **same** value feeds the peers route, `planRoom`, `planRotation`/`evictionOrder` and `admin.js:735` (today a literal `90 * 1000`).
- **`shelf`**:
  - `held` = shelf rows before the model filter, minus blocked;
  - `searchable` = the shelf rows returned;
  - `running` = `discoveryP2p.isRunning()`. Unused by clients in v1; it lets an admin tell "network down" apart.
- **`canAdd`** = `req.user.admin === true && config.program.lockAdmin !== true && isAdminAllowed(req)` (`src/util/admin-network.js`). These are the same three gates as `admin.js:127-139`. Clients never infer it from `user.admin`.
- **Order** (stable; an add state never reorders a row):
  1. shelf rows by `online` desc, then `label` (`localeCompare`, base), then `endpointId`;
  2. then addable rows by `seederCount` desc, then `rowCount` desc, then `endpointId`.

  "All" is drawn by each client; it is not a server row.
- **Cost**: in memory (`peerDbs.list()`, the catalog Map, seeder maps, one `getMeta('embedding_model_id')`), well under 1 ms. The response is bounded at 50 + 24 rows. Clients poll every 15 s, or every 3 s while a row they show is adding.

### 3.3 `POST /api/v1/admin/discovery/p2p/peer-dbs/add` (new; admin)
- **Where**: `src/api/admin.js`, next to `peer-dbs/fetch` (`:783`). It inherits the admin guard (`:127-139`: lockAdmin 405, non-admin 403, IP gate 403) and `requireP2pEnabled` (`:631-635`).
- **Body**: `{endpointId}`, Joi `hex().length(64).lowercase()` (any case accepted, compared lower-case, like the taste route's `networkPeers`), else 400.

| status | body | when |
|---|---|---|
| 202 | `{endpointId, state:'adding', code:null, at}` | started, queued, or already in flight (deduped) |
| 200 | `{endpointId, state:'done', code:null, at}` | already on the shelf |
| 200 | `{endpointId, state:'failed', code:'no-room'\|'offline'\|'bad-snapshot', at}` | a pre-check failed (the state is stored) |
| 404 | `{error:'not-in-catalog'}` | no announcement heard |
| 409 | `{error:'blocked'}` / `{error:'incompatible'}` | **`isBlocked` is checked before the catalog lookup**, so a blocked peer (which the block route also forgets, `admin.js:852-853`) gets 409, not 404 |

- **Codes** (clients map `no-room` → "No room"; any other failed code → "Try again"; raw messages only reach `winston`):
  - `no-room`: from `planRoom` only. Either `fits:false`, or, after the download was refused for room (the shelf moved meanwhile), the re-plan says `fits:false`. The re-plan uses the announced size; the bytes received are never more (more is `bad-snapshot`).
  - `no-disk`: the free-disk floor (`peer-dbs.js:241-246`).
  - `offline`, either:
    - before dialing: `!online && seederCount === 0`, or `!discoveryP2p.isRunning()`; or
    - an RPC rejection matching `/timed? ?out|dial|connect|unreachable|no provider/i`.
  - `bad-snapshot`: over-announced, or `inspectSnapshot` failed (`:295-323`), or, as a pre-check, the announcement carries no positive `size` (no room can be planned for it, and the download's only ceiling would be the headroom).
  - `gone`: the peer was not in the catalog when its download was to start (a queued Add's turn, or the retry after a no-room). A peer forgotten while its download runs still lands.
  - `failed`: anything else.
- **State machine** (NEW `src/state/discovery-peer-add.js`, `createPeerAdder(deps)` plus a default instance):
  - `Map<endpointId,{state,code,at,by}>`, ≤ 200 entries.
  - Lifetimes: `done` 5 min, `failed` 30 min (checked on read).
  - At most 2 downloads at once; the rest queue FIFO and report `adding`.
  - The plan is re-run when a queued Add starts.
  - **Clearing [review]**: every stored `failed` entry (no-room included) is dropped on any shelf or pin change. That covers pin/unpin (`admin.js:797-810`), `removePeerDb`, any fetch landing, rotation eviction and the block route. It goes through a NEW `peerDbs.onShelfChange(fn)` hook (no import cycle).
  - **[verify]** A download that ends without landing (any caller: an Add, the panel's fetch, reconcile) fires `onShelfChange(id, 'released')`: the room it reserved, and the evictees nobody else could plan with, are free again. It drops every stored `no-room` (and only those), so a No room decided while another download held the room never outlives it.
  - **[verify]** A `done` entry is dropped when its own peer is `removed` from the shelf, so a row swapped or rotated out within 5 min shows "+" again, not an inert `done`.
  - Every p2p stack stop runs `stopAutoFetch` (`peer-dbs.js:851`), which calls `adder.reset()`: a disable, a failed enable's rollback, and the soft reboot any reboot-requiring admin save triggers (`server.js` reboot teardown → `stopDiscoveryP2pStack`). After a reset, an in-flight fake or real fetch must not write the registry (generation check).
  - Nothing survives a restart; after a reboot the row shows "+" again.
- **Making room** (P1): export `evictionOrder` (`rotation.js:96-113`), and give it, `planRotation` (`:137`) and a NEW `planRoom` an `onlineWindowMs` parameter (default `ONLINE_WINDOW_MS`):
```js
// → { fits: true, evictIds } | { fits: false }. No rotationDays age gate; several
// evictions allowed; never a pinned snapshot; the incoming peer's own entry excluded.
export function planRoom({ shelf, catalog, incoming /* {endpointId,size} */, capBytes,
  reservedBytes = 0, now, seederCountOf = () => 0, onlineWindowMs = ONLINE_WINDOW_MS })
```
- **Execution: always fetch first, then evict.** (Rotation is also fetch-first, unless `planRotation` sets `evictFirst` because the bytes are needed, `peer-dbs.js:781-804`.)
  - **[review] Crash safety**: `fetchPeerNow(id, {pinned:false, discount: evictIds})` removes the evictees **in the same synchronous block** as `registry.set`, with one `save()` (today `:354-355`). So a kill can never leave the shelf over its cap at rest. **[verify]** The `save()` comes first; only then are the evictees' and a replaced copy's files deleted, their blobs forgotten and the evictions recorded, so a kill in between leaves only files the registry no longer names (swept at boot), never a lost newcomer.
  - The cap admission and the post-download check subtract the evictees' bytes.
  - The transient overshoot during the download is at most the incoming size, and the free-disk floor still applies.
  - Each eviction calls `recordEviction` (export it, `:732`) and is logged.
- **[review] Orphan sweep**: `ensureLoaded` (`peer-dbs.js:110`) deletes `*.db` files in `peerDbDir()` (`:102`) that the registry does not reference. This covers a kill after the sidecar exported a file but before `registry.set` (there is no sweep today; the only removals are `:299, 318, 329, 371`). **[verify]** The raw `POST /api/v1/admin/discovery/p2p/fetch` (`admin.js:1233`) exported into that directory too, and its file is the route's deliverable; it now exports into `{dbDirectory}/discovery-fetched/` (`peerDbs.rawFetchDir()`), which the sweep never scans.
- **P3 shelf mechanics** (`src/state/discovery-peer-dbs.js`):
  1. `Object.assign(new Error(msg), {code})` at every throw (`:225-226, 232, 243, 303, 322`) and around the `discoveryP2p.fetch` call (`:275`). Messages are unchanged.
  2. A per-peer in-flight guard: `inFlight: Map<id,{promise, reservedBytes, discount}>`. The exported `fetchPeer` joins an existing promise (then pins if asked) or registers one.
  3. Admission: `projected = totalBytes() − existing − discountBytes + size + reservedOthers(id)`.
  4. Reconcile (`:628`, room math `:649-656`) counts in-flight ids and reserved bytes, and skips in-flight candidates.
  5. Rotation (`:754`) passes `capBytes − reservedOthers(null)`. Rotation evicting an Add's planned evictee is harmless: `removePeerDb` is idempotent.
  6. Export `isBlocked` (`:174`).
  7. **[verify]** A size-less announcement's ceiling is the headroom; at exactly 0 `discoveryP2p.fetch()` drops it (`maxBytes > 0`), so `fetchPeerNow` refuses `no-room` before dialing instead of sending no ceiling.
- **Admin panel back-compat**: `POST …/peer-dbs/fetch` keeps its exact contract: synchronous, **pins**, returns the record, 500 `fetch failed: <msg>`, no eviction of its own (when it joins a page Add's download, that Add's swap evicts as it lands, before the fetch answers). Internally it now joins the deduped `fetchPeer`. While it runs it writes `adding` to the adder, then `done` or `failed`. **It never stores `no-room`**: a cap failure there is stored as `failed{code:'failed'}`. Prefix its failure warn (`admin.js:790`) with `[discovery-peer-dbs]` so it reaches the activity ring.
- **Logging** (every line starts `[discovery-peer-dbs]`, so it matches `P2P_LINE`, `src/logger.js:131`, and shows in `GET /admin/discovery/p2p/activity`):
  - `add <id12>… (<label>) by '<user>'` (plus `queued`);
  - `add … landed (<n> tracks, <size>)`;
  - `add … swapped out <id12>…`;
  - `add … failed (<code>): <raw>`.

### 3.4 `POST /api/v1/discovery/taste`, generation 2
- **Body keys** (strict schema, `discovery-taste.js:84-94`):
```js
networkPeers: Joi.array().items(Joi.string().hex().length(64).lowercase()).min(1).max(50).unique(),
networkOnRandomSeed: Joi.boolean().default(false),
```
  - Absent = the whole shelf. `[]` = 400.
  - Unknown, blocked or unheld ids are ignored; if no requested id is held, `reason: 'not-on-shelf'`.
  - The keys are validated, and ignored, when `sources` lacks `network`.
- **Walk**: `shelfSpaces(modelId, only, stats)` (`discovery-p2p.js:191-199`) skips blocked peers and ids outside `only`, and counts `stats.held`. `searchPeers` (`:224-226`) takes `{peers}` and returns `held` internally. The per-song `p2p/similar` route keeps its wire shape (`:248-255`).
- **S6**: `:551` becomes `want.has('network') && p2pOn && (!random || body.networkOnRandomSeed)`. The vector is the single random pick's own (`collectSeeds :232-246`), so every lead's `seedHash` is that pick. Federation stays `!random`. Discover never sends the key, so it is unchanged.
- **`network.reason`**: `null | 'empty-shelf' | 'not-on-shelf' | 'no-compatible' | 'nothing-new' | 'scan-pending' | 'error'`.
  - `null` when there are results or `limit.network` is 0.
  - `scan-pending` in the `analyzed.length === 0` branch (`:574-579`).
  - `error` in the walk's catch (`:426-430`).
  - Otherwise: held 0 → `not-on-shelf` when filtered, else `empty-shelf`; held but 0 searched → `no-compatible`; else `nothing-new`.
  - With p2p off, `network` stays `null` (non-random answers). Clients read that as switched off (§2 item 18).
- **Leads**: `stampNetworkRows` (`:467-484`) gets the label map and adds two fields **after** `sendableRow` (`:452`):
  - `peer: {endpointId, name, label}`;
  - `tile: {key, hue, letter}` from `leadTile(rec)` (§5.1).

  The recommendation schema strips unknown top-level keys (`src/discovery-plugins/recommendation.js:64`) and keeps unknown `peer` keys (`:37`), so a lead forwarded unchanged to resolve, jobs or lookup stays valid.
- Lead shape: `{artist, title, album, year, isrc, releaseGroupMbid, recordingMbid, duration, similarity, exportId, source:'p2p', seedHash, peer:{endpointId,name,label}, tile:{key,hue,letter}}`.

### 3.5 Client re-ask contract (one rule set; every client has a golden-body test)
- **R1 Page request**: `{sources:['network'], window, pin?, exclude?, newArtistsOnly:false, limit:{seeds:12, network:32}, networkOnRandomSeed:true, networkPeers?:[id]}`.
  - The `networkPeers` key is omitted for All.
  - Open pins now playing, as each client's Discover does.
- **R2 Tab tap** (a peer, or All): `pin` = every `seeds[].filepath` of the batch's first answer (≤ 12, deduped, the random pick included), `limit.seeds` = their count, plus `networkPeers`. A client MAY answer from a per-tab cache for the current batch: a pinned walk over an unchanged shelf gives the same rows.
- **R3 New seeds, window change, seed edits** start a new batch and keep the selected tab's `networkPeers`. On a random answer, the shown pick goes into `exclude` (Discover's "Another pick").
- **R4 Add landed**: an id **this client POSTed** is now `onShelf` (or `add.state == 'done'`), or `shelf.searchable` went 0 → > 0 while "No peers yet" shows. Then re-ask the current tab pinned to the batch, deferred while a clip is live. Adds by other clients or by rotation only update the strip.
- **R5 `reason: 'not-on-shelf'`, or the selected peer gone from the shelf in a poll**: select All and re-ask pinned (or use the cached All).
- **R6 Poll**: `GET /p2p/peers` on open, then every 15 s, or every 3 s while any row shows `adding` or an own POST is out. Paused while hidden or covered (one poll on return). Stopped on leave.
- **R7 Off**: a peers 403, a taste 403, or `network: null` on a non-random 200 → one re-ping. If the gate is now false, hide the entry and leave the page.
- **R8**: the terminal debounces keyboard tab stepping (←/→) by 250 ms; clicks and taps ask at once. The last ask wins everywhere (seq fence).

### 3.6 Existing routes the clients use (no server change)
- **Preview**: `POST /api/v1/discovery/plugins/:name/resolve {recommendation: lead}` → `{result:{preview: null | {provider, url, seconds:30, title, artist, album, link, artwork, attribution, match}}}` (`src/api/discovery-plugins.js:120-161`, 429 at `:149-153`; `deezer.js:58-67`; `itunes.js:84-85`).
  - Deezer artwork is ~250 px, iTunes 100 px.
  - Server-wide limits: Deezer 40 / 5 s (`deezer.js:21`), iTunes 18 / min (`itunes.js:23`).
  - Results are cached 10 min.
- **Get it…**: offered only when all of these hold:
  - an `acquire` plug-in other than `federation-copy` is listed;
  - `jobs.allowed === true`;
  - `GET /api/v1/discovery/collection/destination` returns a non-null `destination` (null when uploads are off, `src/discovery-plugins/destination.js:50-53`).

  Start a job with `POST /api/v1/discovery/plugins/:name/jobs {recommendation, destination: <shown>}`. A 409 `destination_changed` (`discovery-plugin-jobs.js:153-196`) → re-read the destination and return the chip to idle. YouTube is off by default.
- **Job state in a modal**: `POST /api/v1/discovery/plugin-jobs/lookup/batch {recommendations:[lead]}` when it opens, then `GET …/plugin-jobs/:id` every 1.5 s while it is open and the job is live.
- **Find elsewhere**: the `links` plug-in's resolve (`plugins/links.js:44-75`, no network call).

### 3.7 Server pieces and file ownership (one PR; about 6 dev-days)

| # | piece | owns | depends | effort |
|---|---|---|---|---|
| P1 | Shelf policy (pure): export `evictionOrder`; `onlineWindowMs` param on it and on `planRotation`; NEW `planRoom` | `src/state/discovery-peer-rotation.js`, `test/unit/discovery-peer-rotation.test.mjs` | – | 0.5 d |
| P2 | Views (pure): `peerLabels`, `peerHue`, `peerMonogram`, `leadTile`, `buildPeerView` | NEW `src/state/discovery-peer-view.js`, NEW `test/unit/discovery-peer-view.test.mjs`, NEW `test/fixtures/peer-recs-tiles.json` | – | 0.75 d |
| P3 | Shelf mechanics: error codes, in-flight guard, reservations and discount, evict-in-the-swap-block, orphan sweep, `onlineWindowMs()`, `onShelfChange`, `isBlocked` / `recordEviction` exports, `onStop` | `src/state/discovery-peer-dbs.js`, NEW `test/unit/discovery-peer-dbs-inflight.test.mjs` (fetchPeer dedupe and reservations across `reconcile()` / `rotatePeerDbs()` with injected timers and deps; the integration suite cannot reach `startAutoFetch` without a sidecar, `discovery-p2p-stack.js:154, 192`) | P1 | 1 d |
| P3b | Add state machine + test switches | NEW `src/state/discovery-peer-add.js`, NEW `test/unit/discovery-peer-add.test.mjs`; `src/state/discovery-p2p.js`: `fetch()` (`:431-437`) honours `MSTREAM_TEST_P2P_FAKE_FETCH_DIR`; `resolveSidecarBinary()` (`:141-160`) returns null under `MSTREAM_TEST_P2P_NO_SIDECAR=1` | P1, P3 | 0.75 d |
| P4 | Routes + flags | `src/api/discovery-p2p.js` (peers route, `shelfSpaces` / `searchPeers` filter), `src/api/admin.js` (`peer-dbs/add`, the fetch route through the shared path, `:735` → `onlineWindowMs()`, `:790` prefix), `src/api/discovery-taste.js` (keys, S6, reason, label, tile), `src/api/server-info.js`, `src/api/playlist.js` | P2, P3b | 1 d |
| P5 | Fixtures, integration tests, stage | NEW `test/helpers/p2p-shelf.mjs` (from the inline copies at `test/integration/discovery-p2p.test.mjs:54-113`, `discovery-taste.test.mjs:133-182`), NEW `test/integration/discovery-peer-recs.test.mjs`, `test/integration/discovery-taste.test.mjs:874-881` (1 → 2), NEW `test/stage/peer-recs-stage.mjs` | P4 | 1.25 d |
| P6 | OpenAPI | `docs/openapi.yaml`, then `npm run docs:api:validate` | contract frozen (can run beside P4) | 0.5 d |

Notes for builders:
- **Fake fetch** (`MSTREAM_TEST_P2P_FAKE_FETCH_DIR=<dir>`):
  - `<hash>.fail` rejects with `Error('fetch failed: dial timed out')` after an optional `<hash>.delay-ms`;
  - otherwise it copies `<dir>/<hash>.db` to `<outDir>/<hash.slice(0,16)>.db`, honouring `maxBytes`;
  - under it, the Add pre-check reads `isRunning()` as true.
- Verify that `pushHolds()` (`peer-dbs.js:397`) and `discoveryP2p.forget()` are inert when the stack is down.
- Production comment block: the three `MSTREAM_TEST_*` switches (`P2P_FAKE_FETCH_DIR`, `P2P_NO_SIDECAR`, `DISCOVERY_ONLINE_WINDOW_MS`) do nothing unless set. They follow the existing precedent (`peer-dbs.js:42-75`).
- Conflict watch: mStream #1072 (open) edits `buildFeatures`, the ping, `api-server-info.test.mjs` and `openapi.yaml`. The overlap is textual only.

### 3.8 Server tests
- **Unit `discovery-peer-rotation`**, `planRoom`:
  - fits with no eviction;
  - evicts in `evictionOrder` (longest-silent first, then oldest membership, then a seeded snapshot);
  - several evictions;
  - never a pinned snapshot;
  - `fits:false` when everything is pinned, or when incoming > cap − pinned;
  - `reservedBytes` counted;
  - the incoming peer's own entry excluded;
  - `onlineWindowMs` honoured;
  - the existing `ONLINE_WINDOW_MS === 90000` assertion (`:343`) stays.
- **Unit `discovery-peer-view`**:
  - the label rule (default name, empty name, case and NFKC collisions, widening to 6 hex);
  - hue;
  - every `test/fixtures/peer-recs-tiles.json` tile and monogram vector (§5.1–5.2), with `leadTile` built on `src/db/name-key.js`;
  - member vs admin rows;
  - blocked and incompatible hidden;
  - the cap of 24;
  - ordering stable under add-state changes.
- **Unit `discovery-peer-add`** (injected `fetchPeer`, `removePeerDb`, clock):
  - transitions;
  - TTLs;
  - the 2-at-a-time queue;
  - code mapping;
  - fetch-first;
  - an evictee already gone;
  - clearing on `onShelfChange`;
  - `reset()` drops in-flight writes.
- **Unit `discovery-peer-dbs-inflight`**: two callers share one download; reconcile skips an in-flight id and counts its reservation; rotation's cap is reduced by reservations.
- **Integration `discovery-peer-recs`** (no sidecar, so it runs in CI; `test/helpers/server.mjs:359` already sets a dead `MSTREAM_SIDECAR_BASE`).
  - Servers:
    - **A**: p2p on, `autoFetch:false`, discovery `test-fake`; users `admin`, `mia` (member, plays), `neo` (member, no plays), plus a jukebox token. Shelf: K (online), M (`name 'mStream'`, offline), Q (other model), Old (unpinned, offline the longest), K2 (K's name, unheld, online). Catalog: those + Lighthouse (online) + a blocked id. Fake blobs: Lighthouse ok, Rooftop `.fail`, Static `delay-ms 3000`. The cap is set so Lighthouse needs exactly one eviction. `MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS=86400000` (offline = `updatedAt` 2 days ago).
    - **B**: p2p on, empty shelf.
    - **C**: p2p off.
    - **D**: `lockAdmin:true`.
    - **E**: an admin outside the IP gate.
  - Peers route:
    1. member: shelf rows only, `add:null`, `canAdd:false`, Q and the blocked id absent, `shelf {held:4, searchable:3, running:false}`;
    2. admin: plus addable rows;
    3. labels `mStream · <4hex>`, with K and K2 both suffixed;
    4. hue and monogram;
    5. ordering;
    6. 403 on C, for a federation key and for the jukebox token; 401 without a token;
    7. D and E admins get `canAdd:false`.
  - Add:
    8. member 403; D 405; E 403; bad id 400; unknown 404; blocked 409 (with the id **not** in the catalog too); incompatible 409.
    9. Happy path: 202 → poll until `onShelf:true, pinned:false`; **Old** (named, the longest-silent unpinned) is gone; the activity log has `swapped out`.
    10. Two POSTs share one download.
    11. Rooftop → `failed/offline`; a retry → `adding`.
    12. All pinned → 200 `failed/no-room`, nothing evicted; unpinning one clears the state (`add:null`).
    13. An offline peer with no seeders → `offline` without reading the blob.
    14. The sync `peer-dbs/fetch` still returns the record and pins, shows `adding` meanwhile, and on a cap failure stores `failed`, never `no-room`.
    15. **Crash**: start Static (`delay-ms`), SIGKILL the server, reboot on the same state dir → `add:null`, `totalBytes ≤ cap`, no orphan `.db`, and a re-POST works.
    16. p2p disabled during a fake copy → the registry is not written.
  - Taste:
    17. `networkPeers:[K]` gives only K rows; an unknown id → `not-on-shelf`; `[]` → 400.
    18. Reasons on B `empty-shelf`, Q-only `no-compatible`, all owned `nothing-new`, scan pending `scan-pending`.
    19. `neo`: no key → `network:null`; with `networkOnRandomSeed:true` → leads, `seedHash` = the random pick, `seedSource:'random'`.
    20. Rows carry `peer.label` equal to the peers route's and a `tile` equal to `leadTile`; a lead forwarded unchanged to `lookup/batch` and to a `resolve` gets 200.
    21. A taste call during an Add that evicts → 200.
    22. Discover's body (no new keys) is unchanged.
  - Flags:
    23. `discoveryTaste === 2` and `discoveryP2pPeers === 1` on `/api/` and on ping; the drift-lock stays green.

### 3.9 Stage: NEW `test/stage/peer-recs-stage.mjs` (not a `.test.mjs`)
Derived from the discovery-page stage (`~/.claude/projects/-Users-sherika-code-mStream--claude-worktrees-mstream-discovery-page-03fbc1/stage-backup/stage.mjs`, which already hand-stages a two-peer p2p shelf at `:189-192`; memory saying it does not is stale).

Run: `node test/stage/peer-recs-stage.mjs [port=3995]`.
- **Safety**:
  - sets `MSTREAM_TEST_P2P_NO_SIDECAR=1`, so it runs from any checkout, including the main one, which holds `bin/p2p-sidecar/p2p-sidecar-darwin-arm64`. It still refuses to start if `resolveSidecarBinary()` returns a path;
  - dead `MSTREAM_SIDECAR_BASE`, `MSTREAM_PLAYER_BASE`, `MSTREAM_MUSICBRAINZ_BASE`, `MSTREAM_COVERARTARCHIVE_BASE`; `MSTREAM_TEST_BAKED_SEEDS='[]'`; `useCommunitySeeds:false`, `bootstrapPeers:[]`;
  - **`autoAlbumArt:false`**. `MSTREAM_DEEZER_BASE` / `MSTREAM_ITUNES_BASE` are shared with `src/db/album-art-lib.js:28-31`, so the mock would otherwise get album-art calls.
- **Libraries**: calls `ensureFixtures()` (`test/fixtures/music` is generated and gitignored, `.gitignore:115`; worktrees need ffmpeg **and** ffprobe copied from the main checkout) plus a scratch `copies/` library as the destination. **Never** `~/code/mstream-demo-music`.
- **Users**: `stage-admin` (plays), `stage-member` (plays), `stage-new` (no plays). Credentials go to `stage-<port>/CREDENTIALS.txt` and are never printed.
- **Shelf** (pinned):
  - Basement Hi-Fi, Kitchen Radio, `mStream` (endpoint id starting `3f9a`, offline);
  - plus **Attic Tapes**, unpinned and offline the longest: the sacrificial evictee;
  - leads = DECISIONS §3 exactly (Kitchen Radio = Signal Fires, Harbor Lights, Long Exposure, Sunday Wire, Field Notes).
- **Catalog**: those + Lighthouse Tapes (blob ok) + Static Garden (`delay-ms` 120000) + Rooftop FM (`.fail`). Endpoint ids are chosen so peer hues land near the design's. `MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS=31536000000`; offline peers get `updatedAt` 2 years old (`pruneStalePeers` never runs, because the stack never starts).
- **Mocks**:
  - a Deezer mock on `port+1`: `/track/isrc:*` and `/search` give one track per sample song, previews = a local 30 s ffmpeg sine mp3, `album.cover_medium` = a local PNG (Night Ferry two-tone) so earned art shows;
  - `Arcade Rain` answers no match, and `Quiet Engine` answers 429 once;
  - iTunes off; `links` on; `MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN=1`, so Get it… has an acquire plug-in (`noop-acquire.js`).
- **[review] Controls on stdin** (the clients' walks use them):
  - `offline <name>` / `online <name>`: rewrite `catalog.json` `updatedAt` and restart;
  - `restart`: same state dir and port;
  - `pin-all` / `unpin <name>`;
  - `empty-shelf`;
  - `reset`.

  It prints the URL and the LAN URL. Kill only the PIDs it prints.

### 3.10 OpenAPI (P6)
- New paths:
  - `GET /api/v1/discovery/p2p/peers`: the schemas `DiscoveryP2pPeersResponse` / `DiscoveryP2pPeer` / `DiscoveryP2pAddState`, plus the online, label, monogram, order and poll rules;
  - `POST /api/v1/admin/discovery/p2p/peer-dbs/add`: the status table, the codes, "does not pin", the fetch-first overshoot, no restart survival, and the clearing rule.
- Also document the existing `GET /api/v1/discovery/p2p/peer-dbs` and the synchronous `POST …/peer-dbs/fetch`.
- `TasteRequest` (`:815-879`): the two keys. `TasteResponse.network` (`:1002-1022`): `reason`, and the "null with a random seed unless `networkOnRandomSeed`" wording.
- `DiscoveryP2pLead` (`:753-757`): `peer.label`, `tile`.
- `features` (`:1669-1677`, example `:1766`) and ping (`:1824-1830`): the flags.
- The taste description (`:3079-3131`): R1–R5 (§3.5).

## 4. Clients

### 4.1 Webapp (`webapp/`, mStream; ships in the same release as the server)
Abbreviations: DP = `webapp/alpha/discovery-page.js`, M = `webapp/alpha/m.js`, VP = `webapp/alpha/vp.js`, API = `webapp/alpha/api.js`, IX = `webapp/index.html`, CSS = `webapp/alpha/spa.css`, PT = `test/unit/webapp-discovery-page.test.mjs`, MT = `test/unit/webapp-discovery-panel.test.mjs`.

**Entry and gating.**
- `PAGES = ['play','peerRecs']` (DP:53; the hidden `'explore'` page is renamed, its draw code deleted).
- `peerRecsAvailable(flags)` after `pageAvailable` (DP:206-210).
- `applyDiscoveryPing` (M:4021-4033) reads `discoveryP2pPeers` into `discoveryView.flags` (literal M:3973) and calls `peerRecsSetEntry(...)`, which toggles `super-hide` on `#nav-peer-recs`.
- The nav row goes in IX after `:615`, inside Music under Discover: `data-panel="peerRecs"`, globe + lens icon, `data-i18n="nav.peerRecs"`, `local-only`.
- Route state `{state:'peerRecs'}`; `PANELS_BY_STATE.peerRecs` (M:7226-7239). It is needed because `discoveryPanel` routes through `switchServer(null)` when `peerContext` is set (M:4115-4117 → M:7290-7308).
- Off handling (§2 item 18 / R7): a taste 403, a peers 403, or `network:null` on a non-random answer → re-ping. If still off: `peerRecsSetEntry(false)` and `changeView` to the file explorer. No off card. A peers 404 → the strip shows All only.

**Pieces** (order W1 ∥ W2 ∥ W5 → W3 → W4 → W6; about 6.25 dev-days; one PR; W4 alone owns MT; W3 alone owns `WINDOW_METHODS` / `makeWindow` in PT).

| # | piece | owns | effort |
|---|---|---|---|
| W1 | Pure page model | DP: `PAGES`; `peerRecsAvailable`; `PEER_LIMITS {seeds:12, network:32}`; `buildRequests` (DP:252-291) page body per R1 (`networkPeers` kept only as `/^[0-9a-f]{64}$/`, deduped, ≤ 50, the key omitted when empty); NEW `batchRequest(body, batch, peerId)` after `peersRequest` (DP:303-317), per R2 (pins the random pick too); `networkRows` (DP:597-619) gains `peerId`, `peerLabel`, `tile` (from `raw.tile`), subtitle `Artist · Album`, and drops `onLabel` / `newArtist*` / `line`; `sourceState('network')` (DP:1220-1249) reads `network.reason` (drop the `searched.peers === 0` guess); `stateOf` (DP:1276-1299): `scan-pending` → scanPending, random + leads → ready; delete `pluginChips` (DP:465-476); exports (DP:1301-1312). EN: delete `dpage.network.*`, `dpage.plugins.*`. PT describes at `:136, :181, :571, :2362, :2468, :2487`. | 0.75 d |
| W2 | Pure helpers | NEW `webapp/alpha/peer-recs.js` (UMD, global `PEERRECS`): `tileColours(hue)`, `stripItems(answer,{selected,local})`, `pollDelay`, `addOutcome(status,body)`, `landed(prev,next,posted,showingNoPeers)` (R4), `previewProvider(list)`, `retryDelayMs(name)`, `artMatches(raw,preview)`, `leadKey` (§5.3), `nextIndex`, `copyListText`, `copyText`, `peerLine(raw, peersAnswer)`; NEW `test/unit/webapp-peer-recs.test.mjs` | 0.5 d |
| W3 | API + aside audio + window | API: NEW private `statusReq`; `discoveryP2pPeers` (throws), `discoveryP2pAdd` and `discoveryPreview` (→ `{status, body}`). VP: module aside player replacing `discoverPreviewAudio` (VP:349-350): `asideEl / asidePlay / asidePause / asideResume / asideStop / asideMainPlaying`, one reused `HTMLAudioElement` and owner tokens; `playDiscoverPreview` / `stopDiscoverPreview` (VP:1966-1992) become owner `'window'`; `discoverState.clip` (beside VP:164-175) and the `clip*` methods (`clipToggle / Start / Prefetch / Pause / Resume / Stop / Reset`) with exports and `watchClip`; the `playerStats.playing` watcher (VP:4556) calls `asideMainPlaying` first. Window, behind `modal.from === 'peerRecs'`: `openDiscoverModal` (VP:1369) skips the copy fallback (VP:1370) for this source; header `dmArt` (VP:1210) = `clip.art[tile.key]`, NEW `dmTile`; subtitle (VP:1187) `[artist, album]`; meta (VP:1232) = the peer line only (dot when online); a NEW Preview section (one control bound to `discover.clip`, attribution once resolved); Get it… as one chip per acquire plug-in starting the job directly (the existing rows, destination bar, sub lines and lookup card are not drawn); a NEW own Copy row; the invite row, `findHint` and the "Search" lead hidden. IX modal (`:1136-1462`, find section `:1449-1461`). `copyDiscoverP2p` (VP:4236) drops the leading "- ". CSS `.dmodal-tile`, `.dm-clip*`, `.dmodal-dot-none`. NEW `test/unit/webapp-peer-recs-clip.test.mjs`; PT `WINDOW_METHODS` (`:726-746`), `makeWindow` (`:819`) + one describe. | 1.5 d |
| W4 | The page | M: `discoveryPanel` (M:4109-4158) title, programState and highlight per page; `discoveryOnScreen` (M:4055-4057); `discoveryWatchJobs` (M:4369) → `!discoveryOnScreen()`; `discoveryPick` back (M:5229-5241); `setBrowserRootPanel` (M:411-424) calls `peerRecsLeave()`; `redoDiscovery({batch})` (M:4166-4241); every `v.page === 'explore'` site (M:3961, 3997, 4107, 4318, 4352, 4448, 4497, 4556, 4876); New seeds passes the pick (M:5117-5122); delete the explore draw code (`discoveryExploreHtml`, `discoverySectionHtml`, `discoveryEmptyHtml`, `discoveryLeadTag`, `discoveryNetworkHtml`, `discoveryCheckHtml`, `discoveryProgressHtml`, the `lead`/`newArtists` actions, `discoveryView.newArtistsOnly`). NEW top-level `peerRecs*` section (column-0 closing braces, MT's slicer): view const, open/leave, poll (R6, `visibilitychange`), Add, strip + in-place patch, rows (`D.columnBlocks` blocks of 16, markup as M:4829-4830, no Show more), band, Preview-all sequence, Copy list, Get-it gate. No job badges on rows (`discoveryLoadBadges` is not called for this page). IX: nav row, `#dpage-band` host after `#filelist` (`:861`), `<script src="alpha/peer-recs.js">` before `vp.js` (`:1497`). CSS `.prec-*`, `#dpage-band`, `@media (pointer:coarse)` 44 px hit areas on `.prec-play` and the band buttons. MT: FNS (`:100-114`), auto-list `PEER_FNS`, `KNOWN_IDS` (`:123`) += `nav-peer-recs`, `dpage-band`; delete the explore describe (`:2001-2071`) and rewrite or remove the badges describe (`:2120`). | 2 d |
| W5 | Strings | EN + 11 locale files (flat dotted keys, e.g. `"peerRecs.all"`) | 0.5 d |
| W6 | Live walk + fixes | – | 1 d |

**Drawing (summary of the frames).**
- **Strip**: All (neutral circle, network glyph), then shelf peers in server order (64 px circle `hsl(hue,55%,74%)`, the server's `monogram`, a 12 px green dot when online, offline dimmed with no dot; selected = 2 px teal ring), then for `canAdd` the addable items (dashed "+", "Adding…" spinner inert, failed "Try again", noRoom "No room" inert). Item rules: §5.6. Patched in place, keeping `scrollLeft` and focus by `data-v` = endpointId.
- **Acts line**: "Preview all · Copy list", only in ready with rows; Preview all only with a provider.
- **Row**: an open button (40 px tile from `raw.tile` or earned art; title 13 px; "Artist · Album" 12 px), then an always-visible 28 px teal play circle with states idle / live / resolving / waiting / none (muted, `aria-disabled`). No play circle when there is no provider.
- **Band**: sticky at the bottom of the browser column, 56 px: 44 px art or tile, title, artist, attribution link (`rel="noopener noreferrer"`), ⏸ ⏭, Get it… (only with the gate; opens the window), ✕.
- **Window from the page**: §2 item 15. Focus starts on Close and returns to the row's open button.
- **States**: §2 item 18. Loading = 8 skeleton rows × 2 columns; a re-ask dims the old rows (`.6`).

**Strings (complete; EN values; every file).**
- Visible:
  - `nav.peerRecs` / `panel.peerRecs` "Peer Recommendations";
  - `peerRecs.all` "All", `.adding` "Adding…", `.tryAgain` "Try again", `.noRoom` "No room", `.noPeers` "No peers yet", `.nothingNew` "Nothing new";
  - `.preview` "Preview", `.previewAll` "Preview all", `.copyList` "Copy list", `.copied` "Copied", `.getIt` "Get it…", `.copy` "Copy", `.noPreview` "No preview".
- a11y:
  - `peerRecs.a11y.peers` "Peers", `.add` "Add {{name}}", `.adding` "{{name}}: Adding…", `.failed` "{{name}}: Try again", `.noRoom` "{{name}}: No room";
  - `.previewSong` "Preview {{title}}", `.pauseSong` "Pause preview of {{title}}";
  - `.play` "Play preview", `.pause` "Pause preview", `.next` "Next preview", `.close` "Close preview", `.position` "Preview position".
- Reused:
  - `discover.modal.findElsewhere`, `discover.modal.close`, `dpage.basedOnLast`, `dpage.window.*`, `dpage.bar.*`, `dpage.seeds.*`, `dpage.verb.newSeeds`, `dpage.state.scanPending*`, `dpage.verb.checkAgain` / `adminEnrichment`, `dpage.state.loading`;
  - the bar keys are translated per §2 item 20.
- Drawn from the server, never keys: `label`, `monogram`, `attribution`.
- Translations: the draft table in `scratchpad/peer-recs/plan/web.md` §11.2 (not native-reviewed).

**Tests.**
- **`webapp-peer-recs.test.mjs`**:
  - `stripItems`: member vs admin, every add state, a local "adding" yielding to the next poll, the selected id gone → fallback;
  - `pollDelay`;
  - `addOutcome`: 202, 200 done, 200 failed no-room / offline / no-disk / bad-snapshot / gone / failed, 404, 409 ×2, 403, 405, 400, 500, 0;
  - `landed` (R4: an own POST lands, 0 → > 0 only on No peers, a rotation swap → none);
  - `previewProvider` (no fall-through), `retryDelayMs` (deezer 5000, itunes 60000, other 5000);
  - `artMatches` (album + artist; empty lead album; non-https);
  - `nextIndex`, `copyListText` / `copyText` (empty artist → title), `peerLine`, `leadKey`;
  - every new key in all 12 files with matching `{{params}}`.
- **PT (W1)**:
  - `PAGES`;
  - the R1 body, the `networkPeers` filter (case, length, duplicates, 51 ids, empty → absent), null without each of the four flags;
  - `batchRequest` (pins incl. the random pick, `limit.seeds`, `networkPeers` set / removed, null cases);
  - `networkRows` on rows stamped by the server's own `stampNetworkRows` (label + tile);
  - `stateOf` for every reason; random + leads = ready;
  - `pluginChips` tests deleted.
- **PT (W3)**:
  - `WINDOW_METHODS` += `dmTile`, `dmClip*`;
  - the window from peerRecs: meta = the peer line (dot ok / none, no ISRC, no %); subtitle without year / length; `dmArt` = earned art for `tile.key` only; tile fallback; Preview follows `discover.clip` only for its lead; Get it chips start a job directly; its own Copy row;
  - the trim list: none of `discover.modal.getItLiveHint`, `getItSub`, `inviteTitle`, `findHint`, `search`; no destination bar, no lookup card;
  - plug-ins off + member → the window opens and `copyDiscoverP2p` is not called;
  - Discover and now-playing windows unchanged.
- **`webapp-peer-recs-clip.test.mjs`**:
  - one `Audio` element reused;
  - main paused once and resumed once across 3 hand-offs, never touched when not playing;
  - the user's main play stops the clip with no later resume;
  - window and page clips preempt each other; `stopDiscoverPreview` leaves a page clip alone;
  - 429: deezer 5 s, itunes 60 s, one retry; still 429 → transient (the next press asks again); `preview:null` → none for the visit; a prefetch never retries; one resolve in flight, a newer press supersedes;
  - the gen fence; art only on `artMatches`; the results cache; `clipReset`; 403 → off.
- **MT (W4)**:
  - the gate per flag;
  - open = exactly one taste call with the R1 body + one peers call + `[{state:'peerRecs'}]`;
  - strip markup, escaping, aria;
  - tabs: a pinned batch re-ask with `networkPeers`, cached All, chips from the batch, `not-on-shelf` → All;
  - New seeds keeps `networkPeers` and passes a random pick;
  - rows column-major in blocks (5 → 3 | 2; 32 → two blocks of 8 | 8; no Show more); a row click opens the window with no clip call; the play click calls `clipToggle` and opens nothing;
  - Preview all: a sequence, skip on none, one prefetch at 20 s, the chain ends on a failed retry, the band hides at the end, a second press stops;
  - the band attribution link;
  - the Get it… gate;
  - every Add outcome, the 3 s poll, a landed re-ask deferred while a clip plays;
  - Copy list;
  - every state of §2 item 18 (off → nav hidden + file explorer);
  - leaving stops the poll, the clip and the band;
  - the trim list (no %, no year, no `on {name}`, no `dpage.network.`, no plug-ins line, no `data-dp="lead"`, no `dpage.showMore`, no row badges).
- Run: `npm run test:unit` plus `node --test test/unit/webapp-discover-jobs.test.mjs test/unit/webapp-discovery-panel.test.mjs test/unit/webapp-discovery-page.test.mjs`.

**Live check (W6)**: run the stage on 3995 in the built-in browser pane (a local dev host, test credentials from `CREDENTIALS.txt`) at 1600×1000, then 390×844.
1. The nav row under Discover; `/api` flags.
2. Frame 1: strip states, two columns 6 | 6, shared album tiles. **Screenshot to the user for the palette decision (§2 item 9).**
3. Frame 2: queue a fixture song; Signal Fires' play pauses main; the band and attribution show; Night Ferry art lands on both Night Ferry rows; ✕ resumes main.
4. Frame 3: the Long Exposure row opens the window with nothing playing: tile M, "Marlowe Fields · Daylight Savings", "● Kitchen Radio", Preview / Get it… (noop) / Find elsewhere / Copy only.
5. Frame 4: the Kitchen Radio tab (network panel: one call with `networkPeers` + 12 pins; leads 3 | 2; All → no call); `+ Static Garden` Adding… with 3 s polls; Rooftop Try again; `+ Lighthouse` lands → Attic Tapes leaves the strip and a pinned re-ask follows.
6. Preview all pacing (≤ 2 resolves per clip; Arcade Rain skipped; Quiet Engine's 429 then a retry).
7. stage-member (no "+"), stage-new (leads).
8. Stage controls: `offline "Kitchen Radio"` with its tab selected (dot gone, leads stay); `restart` during Adding… (the "+" returns, 3 s polling stops); `pin-all` then "+ Lighthouse" → No room (inert), `unpin "Basement Hi-Fi"` → "+" back; `empty-shelf` → "No peers yet"; p2p off → nav row gone, page left.
9. 390 px: one column per container rule, the strip scrolls, 44 px targets.
10. Safari: the chain advances (one element).
11. Keyboard: strip → acts → each row's open then play button; Esc returns focus.

### 4.2 Phone (`mstream_music`, Flutter)
**Entry and gating.**
- `Server.peerRecsAvailable` (`lib/objects/server.dart`, beside `:88-98`; json `:436-437`, `:489`).
- Computed in both folds of `lib/singletons/server_list.dart`: `_applyServerInfo` (after `:553`) and `_applyPingPayload` (after `:612`), with `@visibleForTesting static bool hasPeerRecs(...)` = all four flags (ints for taste ≥ 2 and peers ≥ 1).
- Pinned false in `_applyFederatedDefaults` (`:2576-2591`); added to both change lists (`:419-450`).
- The LISTEN card goes after Discover in `lib/singletons/browser_list.dart:403-405`: `DisplayItem(server, 'Peer Recommendations', 'execAction', 'peerRecs', Icon(Icons.travel_explore))`. Label in `lib/l10n/enum_labels.dart:165`.
- Full width via NEW pure `lib/widgets/home_card_rows.dart` (`homeCardRows`, `kWideHomeCards = {'peerRecs'}`), used by `flush()` (`lib/screens/browser.dart:809-829`).
- `handleTap` `'peerRecs'` (`browser.dart:152-159`) → `PeerRecsListing().open(s)`.
- Off (R7): the frame pops.
- Admin = the peers route's `canAdd` (no P2pController probe).
- Plug-ins off → leads, the strip and Copy / Copy list only.

**Pieces** (one PR; about 7 dev-days; worktree `~/code/mstream_music/.claude/worktrees/peer-recs`, branch `claude/peer-recs` from **master** at phase start, whether or not #210 has merged; PH0 and PH8 run last to keep the #210 rebase mechanical; enter the worktree before launching agents; never read the stale checkout HEAD).

| # | piece | owns | depends | effort |
|---|---|---|---|---|
| PH0 | Strings | 10 `lib/l10n/app_*.arb` + generated `app_localizations*.dart` (`~/code/flutter/flutter/bin/flutter gen-l10n`), NEW `test/l10n_peer_recs_keys_test.dart` | – | 0.5 d |
| PH1 | Models + flag | `lib/objects/discovery.dart`: `TasteRequest.networkPeers` (omitted when empty, ≤ 50) / `networkOnRandomSeed` / `newArtistsOnly:false`; `TasteLeads.reason` (`NetworkReason`, unknown → null); `DiscoveryLead.peerEndpointId` (64-hex check), `peerLabel`, `tile` (`LeadTile{key,hue,letter}`); `raw` unchanged. NEW `lib/objects/peer_recs.dart` (`PeerView{canAdd, held, searchable, running, peers}`, `PeerRow{…, monogram, hue}`, `PeerAddState`, `signature`). `lib/objects/discovery_plugins.dart` (`PreviewClip`, `kPreviewCapability`). `lib/objects/server.dart`, `lib/singletons/server_list.dart`. Tests: `taste_response_test`, `discovery_plugins_test`, `server_test`, `server_flags_taste_test`, NEW `test/objects/peer_recs_test.dart` | – | 0.75 d |
| PH2 | API clients | `lib/util/discovery_plugins_api.dart` (+`preview(plugin, raw)` returning status + clip); NEW `lib/util/peer_recs_api.dart` (`peers()`, `add(id)` → `{state, status}`, never throws on 4xx; `x-access-token`, own server only). Tests: `discovery_plugins_api_test`, NEW `test/util/peer_recs_api_test.dart` | PH1 | 0.5 d |
| PH3 | Tile widget | NEW `lib/widgets/generated_tile.dart` (draws `lead.tile` verbatim: field `hsl(H 22% 24%)` dark / `hsl(H 28% 86%)` light, ink `hsl(H 30% 72%)` / `hsl(H 30% 32%)`, letter 45 %, weight 600; absent tile → neutral `raised`, no letter); NEW `lib/util/peer_recs_colours.dart`; tests | – | 0.25 d |
| PH4 | Preview engine | NEW `lib/media/preview_player.dart` (`PreviewPlayer`, `MainPlayerPort` over `MediaManager().audioHandler`, so `_playIntent` is respected, `audio_stuff.dart:2545-2598`; `ClipAudio`); http(s) only; never registered with audio_service; no play events. NEW `test/media/preview_player_test.dart` | PH1 | 1 d |
| PH5 | Controller + interface | NEW `lib/screens/discovery/taste_seeds_host.dart` (`TasteSeedsHost`, `TasteRefreshable`), NEW `peer_recs_controller.dart`; `discovery_page_controller.dart` implements the interface (`now()`), with `discovery_widgets.dart:90-101, :209-322` and `discovery_seeds_sheet.dart:24-60` retyped. Tests: NEW `test/screens/peer_recs_controller_test.dart`, `peer_recs_fakes.dart`; Discover's tests unchanged and green | PH1, PH2, PH4 | 1 d |
| PH6 | Listing + view | NEW `peer_recs_listing.dart` (copy of `discovery_listing.dart:218-296` in shape; lead items in an `Expando` like `_leadOfRow`, `discovery_page_controller.dart:613-614`); NEW `peer_recs_view.dart` (bar, strip, grid, footer, band, states); `browser.dart:1469-1474` dispatch; `browser_toolbar.dart:511` + `_newSeedsButton` via `TasteRefreshable`. Tests: NEW `peer_recs_listing_test`, `peer_recs_view_test` | PH0, PH3, PH5 | 1.25 d |
| PH7 | Lead sheet | NEW `peer_recs_sheet.dart` (private sheet bits duplicated from `peer_sheets.dart:154-436`, which #210 rewrites); `elsewhere_sheet.dart:34-51, :97` (optional `fetch`, `jobs` nullable). Tests: NEW `peer_recs_sheet_test`; `discovery_destination_elsewhere_test` green | PH0, PH3, PH5 | 0.75 d |
| PH8 | Home + browser wiring | `browser_list.dart`, `browser.dart` (`handleTap`, `flush()`), `enum_labels.dart`, NEW `home_card_rows.dart`. Tests: `federated_nav_test`, NEW `home_card_rows_test` | PH1, PH6 | 0.5 d |
| PH9 | Integration + live walk | NEW `integration_test/peer_recs_test.dart` (MockServer serving a WAV clip) | all | 0.75 d |

Order: PH1 ∥ PH3 → PH2 ∥ PH4 → PH5 → PH6 ∥ PH7 → PH0 → PH8 → PH9. Only the PH9 owner builds, once.

**Drawing.**
- **Toolbar**: back, "Peer Recommendations", refresh (New seeds).
- **Config bar**: Discover's (`TasteSeedsHost`; the window is shared with Discover, `SettingsManager().discoverWindow`).
- **Strip**: a horizontal list of 56 px circles with 2-line labels. Online: `hsl(hue,55%,72%)` + monogram + a 12 px dot. Offline: `hsl(hue,30%,44%)`, no dot. Selected: a ring. Addable: dashed "+". Adding: a ring spinner. Failed: "Try again". **No room: inert** [review]. Targets ≥ 56 × 92.
- **Grid**: always 2 columns, row-major. Card width `min((w − 28 − 12)/2, 240)`, centred. A square tile r12 (earned Deezer art when earned); title 14/600 (accent when live); artist 12. A **44 px play circle** inset 8 px at the tile's bottom-right; muted (not hidden) for a "No preview" lead [review]; absent with no provider. A card tap opens the sheet; only the circle plays.
- **Footer**: "Preview all" (primary, only with a provider) · "Copy list".
- **Band**: at the bottom of the frame view, which already ends above the mini player (`lib/main.dart:1175-1180`). 64 px: 44 cover, title, artist, attribution link (verbatim, `url_launcher` external, a ≥ 44 px tall hit area), ⏸ ⏭ ✕ each ≥ 44 × 44 [review].
- **Sheet**:
  - header: 60 px cover, title, "Artist · Album", peer line (7 px green dot only when online, then `peerLabel`) [review];
  - rows: Preview (the same session as the circle; attribution once resolved), Get it… (one row per acquire plug-in, best-match job, job words `discoverJob*`), Find elsewhere ›, Copy.
  - Opening it never plays.
- **Lifetime** [review]: a covered or popped frame, or the app backgrounded, ends the session with `resumeMain`. A main-player play anywhere (lock screen, Android Auto, mini player) ends the clip with no resume. Casting: the TV pauses (webapp parity).

**Strings** (10 ARBs, `@` descriptions in `app_en.arb`):
- Visible:
  - `peerRecsTitle` "Peer Recommendations", `peerRecsAll` "All", `peerRecsAdding` "Adding…", `peerRecsNoRoom` "No room", `peerRecsNoPeers` "No peers yet", `peerRecsNothingNew` "Nothing new";
  - `peerRecsPreview` "Preview", `peerRecsPreviewAll` "Preview all", `peerRecsCopyList` "Copy list", `peerRecsCopied` "Copied", `peerRecsGetIt` "Get it…", `peerRecsFindElsewhere` "Find elsewhere", `peerRecsCopy` "Copy", `peerRecsNoPreview` "No preview".
- a11y: `peerRecsAddPeer` "Add {name}", `peerRecsPreviewTrack` "Preview {title}", `peerRecsPauseTrack` "Pause {title}", `peerRecsNextPreview` "Next preview".
- Reused: `discoverPageRetry` ("Try again"), `discoverPageNewSeeds`, the bar strings, `discoverScanPending*`, `discoverCheckAgain`, `discoverJob*`, `p2pOnline`, `close`, `play`.
- **Not added**: `peerRecsFromDeezer` / `peerRecsFromItunes` [review: attribution verbatim].

**Tests.**
- `server_flags_taste_test`: the `hasPeerRecs` truth table (taste 1 / 2 / '2' / 2.5; peers absent / 0 / 1 / true; p2p or discovery false); both folds; the federated pin; a change redraws home.
- `server_test`: the JSON round trip.
- `taste_response_test`: every `reason`; `peerEndpointId` / `peerLabel` / `tile` parsed; `raw` unchanged; `TasteRequest.toJson` golden R1 body.
- `peer_recs_test`: the §3.2 sample; bad ids dropped; every add code; signature stability.
- `discovery_plugins_test` / `_api_test`: `PreviewClip` (Deezer, iTunes, null, non-http rejected); `preview()` posts `{recommendation: raw}`; 429 surfaces.
- `peer_recs_api_test`: 202, 200 done / no-room, 404, 409, 403, 405, transport.
- `generated_tile` test: draws `tile.letter` verbatim; colours dark and light; absent tile → neutral.
- `preview_player_test`:
  - pause then resume main;
  - never resume an already-paused main;
  - a chain keeps the first flag;
  - main playing mid-session stops the clip with no resume;
  - pause keeps the session;
  - single completion ends it;
  - non-http refused;
  - no PlayTracker events;
  - idle dispose.
- `peer_recs_controller_test`:
  - R1–R7 bodies (open, tab, All, New seeds with the random pick in `exclude`, window, seeds sheet, landing);
  - `notOnShelf` → All;
  - polls 15 s / 3 s, stopped when covered or backgrounded;
  - notify only on a signature change;
  - Add mapping; No room never re-POSTs; `canAdd` false never POSTs;
  - provider = the first preview plug-in;
  - 429: 5 s (deezer and other) / 60 s (itunes), one retry, then transient (the next press asks again); null → noPreview for the visit;
  - one resolve in flight; prefetch only in a chain past 20 s;
  - earned art only on an album + artist match, cards only Deezer;
  - Copy text with an empty artist;
  - plug-ins off → no listing call;
  - 403 or `network:null` → re-ping → pop.
- `peer_recs_listing_test`: item order per state; lead items identical across a strip-only change; Back and cover stop the preview with `resumeMain`.
- `peer_recs_view_test` (390×844, 360×780, text 1.0 / 1.3, dark / light):
  - 2 columns of 175 px; the 240 px cap at 1024 wide;
  - the circle inset; a card tap sends no resolve; only the circle plays;
  - the live card;
  - the band at the frame bottom with 44 px targets;
  - every strip state with semantics (No room inert);
  - muted circle on none;
  - the state matrix;
  - no overflow.
- `peer_recs_sheet_test`: the peer line (dot only when online); each gate failing alone hides its row; opening never plays; Get it posts `plugins/<acquire>/jobs` with the raw lead; Find elsewhere uses the fetcher; the attribution renders the server string.
- `home_card_rows_test`: [A,S,D,P] → [[A,S],[D],[P]]; [A,D,P] → [[A,D],[P]]; [A,S,D] unchanged.
- `federated_nav_test`: the card after Discover only with the flag; absent on a federated peer.
- `l10n_peer_recs_keys_test`: every `peerRecs*` key in all 10 ARBs, non-empty, same placeholders.
- Regression: `discovery_page_controller_test`, `discovery_listing_test`, `discovery_destination_elsewhere_test`, `discovery_keep_sheets_test`, `test/media/*`.
- `integration_test/peer_recs_test` (iPhone 17 Pro, MockServer): the full-width card; the exact first body; a Kitchen Radio tap sends `networkPeers` + pins; a card tap opens "● Kitchen Radio" with no resolve; the circle sends one resolve and the band shows "Preview from Deezer"; ✕; `+ Lighthouse` 202 → Adding… → lands → one pinned re-ask; Back / reopen.

**Live check (PH9)**: run the stage (§3.9) in the user's Terminal panel; one `flutter run -d "iPhone 17 Pro"` (attach the simulator panel first); add server `http://127.0.0.1:3995`.
1. Frame 1 (admin).
2. Frame 2: main paused, attribution, earned art on both Night Ferry cards, ✕ resumes.
3. Frame 3: the sheet, nothing plays.
4. Frame 4: Kitchen Radio + Adding… across a pull-to-refresh and a Back / reopen.
5. Lock-screen play wins over the clip.
6. Push another frame during a clip → the clip ends and main resumes.
7. stage-member and stage-new.
8. Stage controls `offline`, `restart` mid-Add (no stuck Adding…), `pin-all` → No room inert.
9. No preview plug-in mode.
10. Light theme, SE size, XL text.
11. Android headset unplug if an emulator is available.

### 4.3 Terminal (`mstream-terminal-player`, Rust ratatui, GUI mode)
**Entry and gating.**
- `Capabilities::peer_recs()` = `discovery && discovery_p2p && discovery_taste >= 2 && discovery_p2p_peers >= 1`, plus `session.peer.is_none()`. A new `discoveryP2pPeers` field on `Ping` (`src/api/types.rs:77-128`), `LayeredFeatures` (`:150-168`) and `Capabilities` (`:284-308`).
- Without the gate: no row, `R` dead, nothing asked. The room yields to Files when the row goes.
- Nav, `src/gui/mod.rs`:
  - `NavId::PeerRecs`, last in `NAV` (`:427-441`, index 13, `PEER_RECS_NAV`);
  - `draw_nav` (`:1938-1980`): LIBRARY `put` 5→4, TOOLS 13→12, rooms `1..=5 => 4+i`, LAST_PLAYED 10, MOST_PLAYED 11, DJ 13, SONIC 14, DISCOVER 15, PEER_RECS 16;
  - `R` beside `:2801` (no existing `Char('R')`).

**Pieces** (waves: T0 ∥ T1 ∥ T2 ∥ T4 ∥ T8-fake → T3 → T5 ∥ T6 ∥ T7 → T8 legs → T9; about 12.5 agent-days). Worktree from **origin/main** (local `main` is stale), `cargo +1.98.1` only, **one shared `CARGO_TARGET_DIR`** for every agent with serialized builds (a `target/` reaches 60–70 GB). Enter the worktree before launching.

| # | piece | owns | effort |
|---|---|---|---|
| T0 | Contract first | NEW `docs/ux-contracts/peer-recommendations.md` (numbered clauses: gate, place, keys, layout, tabs, asking R1–R8, grid, band, preview, modal, Get it / Find / Copy, privacy, wording table, deviations log); amend `docs/ux-contracts/discovery-page.md` (intent `:23-24`, entry point and clause 2 `:28-31, :115-121`: TOOLS 12 … Discover 15; clauses 52/63; out of scope `:2150-2165`, removing the false "the engine plays no external URL", since `engine/http.rs:259` streams any http(s) URL); log lines in `auto-dj.md`, `library-rooms.md`, `sonic-path.md`; `docs/ui-kit.md:705-714` | 0.75 d |
| T1 | API | `src/api/types.rs`: the flag in `Ping` / `LayeredFeatures` / `Capabilities` + `peer_recs()`; the full struct literals that must gain the field are `From<&Ping>` (`:321`), `types.rs:2187`, `src/tui/app/tests.rs:65`, `src/tui/ui.rs:3206` (`gui/discover.rs:3263` and `gui/keep.rs:4412` use `..Default`, so no edit); `TasteRequest` `network_peers` (skip if empty), `network_on_random_seed` (skip if None); `TasteLimit.network`; `LeadPeer.label`; `TasteLead.tile: Option<LeadTile{key,hue,letter}>`; `TasteNetwork.reason` (lenient enum). NEW `src/api/types/peer_recs.rs` (`P2pPeersAnswer`, `P2pPeer` incl. `monogram` / `hue`, `PeerAddState`, `PeerAddAnswer`, `PluginPreview` **without** `artwork`). `src/api/types/plugins.rs` (`PREVIEW`, `preview_plugin()`, `get_it_plugin()`). `src/api/mod.rs` (`p2p_peers_async`, `p2p_peer_add_async`, `plugin_preview_async`, each `own_server()?` first) | 0.75 d |
| T2 | Engine aside | `src/engine/mod.rs`: an `Aside` struct; `play_aside_unless` (http(s) only via `http::is_http_url`, `http.rs:313`; opened before touching any sink; pauses main in place via a refactored `State::pause_now`; `resume_main` carried across chained clips); `pause_aside` / `resume_aside` / `stop_aside(restore)` / `aside_status` / `take_aside_end`; the tick marks run-out, with a 5 s `ASIDE_HOLD` self-restore; main transport ends the aside first as `Taken` (`play_source_unless :1675`, `resume :1822`, `stop :1846`, `seek :1854`, `next_manual :2030`, `previous_manual :2051`, `queue_play_index :2157`); `at_rest` (`:1120`) false while an aside sounds; `rebuild_output` (`:1485`) fails it and restores; `set_volume` (`:1947`) reaches it. `src/player.rs` (`AsideStatus`, `AsideEnd`, defaulted `PlayerCtl` methods). **[review]** Serve-mode regression tests: `serve` (`src/serve/mod.rs:323, :558`) never calls an aside, and with no aside every main command behaves exactly as before; a remote play or seek during a GUI aside (`gui --serve-port`) ends it as `Taken` and restores nothing twice | 1.75 d |
| T3 | Worker | `src/tui/worker.rs`: the `AudioCmd` aside variants; **`collapse()` (`:922-957`) keeps aside commands in place** (it drops unnamed commands at `:950`), with consecutive `AsidePlay`s folded; `decides_aside`; `apply_audio_cmd` (`:1106-1128`) sends aside failures as `Event::AsideEnded{Failed}`, never `Error` / `PlaybackFailed`; `listen` emits `Aside` / `AsideEnded`; `TastePart::Network`; one door `ApiCmd::PeerRecs{generation, cmd}` with `PeerRecsCmd{Peers, Add, Gate, Preview, Lookup, Start, Links}` and its events. `src/web/api_worker.rs` (one arm), `src/web/audio.rs` (no-op arms) | 0.75 d |
| T4 | Config-bar extraction (pure refactor) | NEW `src/gui/taste_bar.rs` from `src/gui/discover.rs` (`head_steps :887-909`, `HeadWords :925-962`, `head_plan :964-1012`, `draw_header :1014-1074`, the window list, the seeds modal); `TasteRoom` param on the `src/tui/app/taste.rs` pin / seed / window methods (`:594-722`); `Capture::TasteSeed(TasteRoom)` in `src/tui/app.rs`, `sonic.rs`, `tests.rs`, `src/gui/mod.rs:730, :916, :1093-1098, :2735-2738`; `Act::Bar(TasteRoom, BarAct)`. Gate: every Discover test green with only mechanical signature edits | 1 d |
| T5 | App room | NEW `src/tui/app/peer_recs.rs` (`PeerRecsState` embedding a `TasteState`; network slot; peers slot + poll R6; `selected` + `hold_seeds`; `adds_out` (R4 = own POSTs); `PreviewState`; gate; links; the modal's one-row job lookup; the frozen GUI API: `peer_recs_open / ask_again / new_seeds / select / add / tick / preview / preview_all / clip_toggle / clip_stop / leave / get_it / links_open / leads / tabs / pane / row / can / copy_text / online`); `src/tui/app.rs` (field, mod at `:1467`, routing `:6280-6292`, session resets); `taste.rs` (Network routing in `consume_taste :969`, the probe twin `:1139`); `src/tui/app/keep.rs` (`LinksState::asking`, `seq()`) | 2 d |
| T6 | GUI room | NEW `src/gui/peer_recs.rs`; `src/gui/mod.rs` (nav, gate, `R`, hooks at `:1595 :1602 :1658 :1735 :1788 :1835 :2752 :3401 :3558 :3604 :3653 :3700`, `Act::Peer`, `List::PeerRecs`); `src/gui/keep.rs` (`LinksOwner` for `draw_links` and friends `:3957-4120`); `src/kit/theme.rs` (`truecolor()`); moved nav tests (`src/gui/discover.rs:3550-3570` → Discover 15; `src/gui/dj.rs:1944-1989` rows[12] TOOLS, rows[13] Auto DJ) | 3 d |
| T7 | Strings | `locales/{en,de,es,fr,it,ja,pl,pt,ru,zh}.yml` | 0.5 d |
| T8 | e2e | `test/e2e/fake_mstream.py` (`FAKE_P2P`, `FAKE_MEMBER`: ping flags; the peers route; add 202→done; network taste answers with `tile` and the `networkPeers` filter; a strict 400 on unknown keys and a counted failure if a Discover body carries them; a deezer resolve with null / 429 cases; `/_clip` mp3; an `/_art` counter; jobs; `/_state`); NEW `test/e2e/legs/gui-peer-recs.exp`; NEW `test/e2e/check_peer_recs.py`; `test/e2e/run.sh` Scenarios P / P2; `test/e2e/README.md` | 1 d |
| T9 | Review, live check, release | `Cargo.toml`, `Cargo.lock` | 0.75 d |

**Room layout** (content x 17, y 2; 100×30 hints off, queue folded):

| row | content |
|---|---|
| 2 | Header (taste_bar): `Peer Recommendations` · `Last 30 days ▾` · `more options` · `↻ new seeds`. The narrow steps fall to `Peer recs` (the nav key) before the name drops. No `new_seeds_tip` tooltip [review]. |
| 4 | Tabs: ` All ` (slab when selected) · `● {label}` (shelf, online) · `{label}` DIM (offline) · admins: `+ {label}` ACCENT, `{label} adding…` GOLD (inert), `! {label}` DANGER (Try again, re-POST), `{label} no room` DIM (inert) [review]. Overflow `‹ ›`. Skeleton `░` before the first answer. |
| 6 | The verbs line `▸ preview all · copy list`; while a clip plays, **the band**: `▮▮ title · artist ▰▰▱▱ attribution [get it] [✕]`. Drop order: bar → `[get it]` → title down to 8 cells. The attribution and `[✕]` never drop (they fit at 47 cells). |
| 8–9 | DIM column heads `TRACK  ARTIST` per column, then a rule. |
| 10–24 | Grid. Two columns of `cw = (list.width − 2)/2` (38 at 80 cells). Cells: `▌` in `hsl(lead.tile.hue,45%,60%)` (DIM without truecolor) · TRACK · ARTIST · play slot `▸` / `▮▮` / `◌` / `–` (none). Column-major **in blocks of 2 × visible rows** [review]. With the queue open (cw ≈ 21): `▌` · TRACK · play slot, ARTIST dropped [review]. No job marks [review]. Panes: Loading, `No peers yet`, `Nothing new`, the scan-pending sentence + `Check again`, `Try again` alone. |

At the 100×24 floor (hints on) the blank rows drop: tabs on 3, verbs on 4, heads on 5, the rule on 6, grid on 7–17.
- **Keys** (`R` = new seeds while the room is up):
  - stowed: `↓` grid, `←/→` step the selected tab (debounced 250 ms, R8);
  - grid: `↑↓ ←→`, PgUp / PgDn, `Enter` modal, `l` preview;
  - tabs stop: `←/→` outline, `Enter` select / Add / Try again;
  - anywhere: `L` preview all, `y` copy list, `w` window, `e` more options, `Space` toggles the clip only while one is live, `x` ends the clip, `Esc` closes → stows → ends the clip.
- **Mouse** (left click, Apple Terminal echo swallowed centrally, `mod.rs:3160-3168`): a row opens the modal; the play slot previews; tabs; `‹ ›`; **the verbs line's `▸ preview all` and `copy list`, the band's `▮▮` / attribution / `[get it]` / `[✕]`, and every modal row** [review].
- **Lead modal**:
  - `keep::window_rect(area, room, 46, 12)` + `open_window` + `draw_borders(title, "Esc close")` (`src/gui/keep.rs:116-145, :1419-1436`), ACCENT border;
  - `{artist} · {album}`, then `● {label}` (dot only when online);
  - rows `▸ Preview  l` · `Get it…` (the job word from `gui.discover.mark.*`) · `Find elsewhere…` · `Copy`;
  - the cursor starts on Get it… when offered;
  - tips `gui.tips.discover_menu` (reused) [review].
- **Preview**: offered only with `audio_available` (`src/tui/app.rs:6072`) and a provider. `AsidePlay{ticket, url}` takes the URL verbatim (never through the stream URL builder, no token). Never fetches artwork. Leaving the room or the room not being drawn → `AsideStop{restore:true}` [review].
- **Get it…**: `plugin_job_start_async(get_it_plugin, raw, Some(JobScope::Song), Some(destination))`.
- **Copy**: §5.7 (fixes the draft's "- Title").

**Strings** (19 keys; the ten-locale mirror test `src/setup/mod.rs:4014`; every label ≤ 12 cells):
- `gui.nav.peer_recs` "Peer recs".
- `gui.peer_recs.`:
  - `name` "Peer Recommendations", `all` "All", `tab_adding` "%{peer} adding…", `tab_no_room` "%{peer} no room";
  - `add` "Add" (tooltip), `try_again` "Try again" (tooltip), `no_peers` "No peers yet", `nothing_new` "Nothing new";
  - `preview` "Preview", `no_preview` "No preview", `preview_all` "preview all", `copy_list` "copy list", `copied` "Copied";
  - `get_it` "Get it…", `get_it_band` "get it", `find_elsewhere` "Find elsewhere…", `copy` "Copy".
- `gui.tips.peer_recs` "↵ open · l preview · ← → peers · y copy list · R new seeds".
- Reused: `gui.discover.window_*`, `more_options`, `options_short`, `new_seeds`, `asking`, `col_track`, `col_artist`, `retry`, `scan_pending`, `check_again`, `mark.*`, `links.*`, `keep.esc_close`, `gui.tips.discover_menu`, the seeds modal's keys.
- Not keys: attribution, labels, monograms.

**Tests.**
- **types.rs**:
  - `ping_reads_discovery_p2p_peers_flat_and_layered`;
  - `the_peer_recs_gate_needs_all_four_flags`;
  - `discover_taste_body_is_unchanged_by_the_network_keys` (golden);
  - `the_peer_recs_body_spells_the_generation_2_keys` (R1);
  - `network_reason_parses_every_word_and_tolerates_new_ones`;
  - `a_lead_reads_its_peer_label_and_tile_and_keeps_raw_verbatim`.
- **peer_recs.rs (types)**: `the_peers_answer_parses_the_server_plans_sample` (+ a bad id dropped); `a_preview_answer_parses_deezer_itunes_and_null`; `a_preview_never_keeps_artwork`.
- **plugins.rs**: `preview_plugin_is_the_first_listed_with_preview`, `get_it_plugin_skips_federation_copy`.
- **api/mod.rs** mock sockets: peers, add (202 / 200 / failed / 404 / 409), preview posts the lead unchanged, a 429 stays a server 429.
- **engine (State-level, no device)**:
  - `an_aside_pauses_main_and_restore_resumes_it_where_it_stood`;
  - `…over_a_paused_main_restores_nothing`;
  - `a_second_aside_carries_the_first_ones_resume_promise`;
  - `main_transport_ends_the_aside_as_taken` ×7;
  - `…runs_out_is_held_then_restores_by_itself`;
  - `at_rest_is_false_while_an_aside_sounds`;
  - `volume_reaches_the_aside`;
  - `a_rebuild_fails_the_aside_and_restores_main`;
  - `an_aside_refuses_a_path_or_a_file_url`;
  - `an_aside_that_will_not_open_leaves_main_untouched`;
  - **`serve_mode_without_an_aside_is_unchanged`**, **`a_remote_play_during_an_aside_ends_it_once`**.
- **worker**:
  - `collapse_keeps_aside_commands_in_place_and_folds_consecutive_aside_plays`;
  - `an_aside_that_fails_is_aside_ended_never_playback_failed_or_an_error`;
  - `an_aside_open_gives_up_for_a_newer_aside_or_a_main_play`;
  - `aside_status_goes_out_each_tick_while_live_and_the_end_once`;
  - `end_watch_ignores_aside_commands`.
- **App** (`peer_recs.rs` mod tests):
  - R1–R8 bodies;
  - stale answers dropped;
  - `not_on_shelf_falls_back_to_all_once`;
  - polls 15 s / 3 s;
  - landed re-ask pinned and deferred while a clip is live;
  - a member never posts; no-room never posts;
  - a press resolves the raw lead and plays the URL verbatim;
  - null → none; 429 waits 5 s / 60 s and retries once, then transient;
  - one resolve in flight; preview all one ahead, ending on a failed retry;
  - a taken clip ends preview all;
  - leaving or not drawn restores main;
  - no audio, no preview;
  - no artwork is ever asked;
  - the Get it gate;
  - `copy_text_with_no_artist_is_the_title`;
  - each reason draws its pane.
- **GUI**:
  - `the_nav_column_at_every_floor` ((30,off,24) (30,on,23) (24,off,18) (24,on,17));
  - `the_row_and_r_are_absent_without_the_gate_or_for_a_peer`;
  - `the_100x30_room_matches_the_board`;
  - `the_100x24_floor_keeps_two_columns`;
  - `the_queue_open_room_keeps_two_track_only_columns`;
  - `32_leads_fill_column_major_by_screen_blocks`;
  - `tabs_wear_every_state_and_overflow` (no room DIM, inert);
  - `a_member_sees_no_addable_tabs`;
  - `the_band_drops_in_order_but_never_the_attribution` (80 and 47 cells, both providers);
  - `clicks_reach_rows_play_tabs_verbs_band_and_modal_rows` (100×30 and 100×24);
  - `the_modal_draws_the_board_and_starts_on_get_it`;
  - `keys_walk_the_columns_and_climb_to_the_tabs`;
  - `space_toggles_the_clip_only_while_one_is_live`;
  - `esc_closes_then_stows_then_ends_the_clip`;
  - `every_locale_fits`;
  - `the_swatch_draws_the_stamped_hue`.
- **e2e P** (admin, Apple Terminal dialect, 100×30):
  - nav rows 15 / 16; `R` opens; two columns at x 19 / 59;
  - a Kitchen Radio tab click sends `networkPeers` + pins + `limit.seeds`;
  - a row click opens the modal and its echo presses nothing;
  - `+ Lighthouse Tapes` posts once → adding… → lands → a pinned re-ask;
  - preview asserted only where a device opened, else absence asserted;
  - `art_gets == 0`;
  - `y` → Copied.
- **e2e P2** (member): no `+` / `adding…` / `!`; `adds == 0`.
- Every existing scenario stays green after the nav shift.
- CI matrix before the PR:
  - `cargo +1.98.1 test` and `… --features desktop`;
  - `cargo +1.98.1 check --target wasm32-unknown-unknown` (± desktop);
  - `cargo +1.98.1 build --features desktop`;
  - `bash test/e2e/run.sh`;
  - a trunk web-bundle memory measurement (the rust-i18n wasm OOM history).

**Live check (T9)**: against the stage (§3.9), under a pty (`HOME=<scratch> script -q /dev/null <target>/debug/mstream-player gui --server http://127.0.0.1:3995 --token …`) at 100×30 and 100×24, queue folded and open. Kill only the PID it started; wrap with `HOME=<scratch> exec` under Ghostty's `login`.
1. `l` pauses main, and `x` restores it at the same second.
2. `L` chains three clips with no blip.
3. `Space` in the room vs on Now Playing.
4. Add lands → a pinned re-ask; `pin-all` → `no room` DIM.
5. Member and stage-new.
6. Stage `offline` and `restart` mid-Add.
7. Terminal.app clicks by hand.
8. **Server-audio**: the GUI with `--serve-port` as mStream's server-audio engine, a clip in Peer recs, then `/server-remote` play → the main track plays, the clip ends, no double audio.
9. mStream's server-audio smoke with the v0.15.0 binary.

## 5. Shared spec (every client)

### 5.1 Generated tile (server-stamped; `leadTile` in `src/state/discovery-peer-view.js`)
- `a = nameKey(artist)`, `b = nameKey(album)` (`src/db/name-key.js`: collapse whitespace, trim, fold quotes and dashes, lower-case; no diacritic fold).
- **key** = `a|b` when both are non-empty, else whichever is non-empty, else `nameKey(title)`.
- **hue** = FNV-1a-32 over the key's UTF-8 bytes (basis `0x811c9dc5`, prime `0x01000193`, `Math.imul`, `>>> 0`) `% 360`.
- **letter**: the first `\p{L}|\p{N}` scalar of the trimmed artist, else of the title, else `''`. Upper-cased only when that yields exactly one scalar, so `ß` stays `ß`.
- **Colours are client-side from `hue`**:
  - web field `hsl(H,22%,24%)`, ink `hsl(H,30%,72%)`;
  - phone dark the same, light field `hsl(H,28%,86%)`, ink `hsl(H,30%,32%)`;
  - terminal swatch `hsl(H,45%,60%)`.
- Clients never compute the key or the hue.

Vectors (`test/fixtures/peer-recs-tiles.json`, checked by `test/unit/discovery-peer-view.test.mjs`; computed with the server's `nameKey` on node):

| artist | album | title | key | fnv1a32 | hue | letter |
|---|---|---|---|---|---|---|
| Hollow Coast | Low Tide Hymns | Salt Road | `hollow coast\|low tide hymns` | 7358f393 | 203 | H |
| Paper Lantern | Night Ferry | Signal Fires | `paper lantern\|night ferry` | 9eb21e3f | 39 | P |
| Tidewater | Undertow | Glass Season | `tidewater\|undertow` | f9493aa4 | 4 | T |
| Marlowe Fields | Daylight Savings | Long Exposure | `marlowe fields\|daylight savings` | 6b786b30 | 352 | M |
| Juniper Static | Neon Psalms | Arcade Rain | `juniper static\|neon psalms` | 83dbfe86 | 78 | J |
| The Vesper Lines | Small Hours | Paper Moons | `the vesper lines\|small hours` | d783b5f2 | 154 | T |
| Okra Bloom | Porchlight | Sunday Wire | `okra bloom\|porchlight` | bdafd9b1 | 353 | O |
| Kestrel & Vine | (null) | Copper Dawn | `kestrel & vine` | fd2e0225 | 53 | K |
| Ada Merrow | Cartography | Field Notes | `ada merrow\|cartography` | 47a66ae9 | 81 | A |
| `"  PAPER   lantern "` | `"Night  Ferry"` | Harbor Lights | `paper lantern\|night ferry` | 9eb21e3f | 39 | P |
| Paper Lantern | Night Ferry – Live (en dash) | Signal Fires | `paper lantern\|night ferry - live` | 8c3bd9e2 | 162 | P |
| Guns N’ Roses (curly) | Appetite for Destruction | Paradise City | `guns n' roses\|appetite for destruction` | 4fac24b2 | 210 | G |
| “Weird Al” Yankovic | Mandatory Fun | Tacky | `"weird al" yankovic\|mandatory fun` | 71fc2e7b | 339 | W |
| Beyoncé | Lemonade | Formation | `beyoncé\|lemonade` | f05090b4 | 44 | B |
| Ólafur Arnalds | re:member | Saman | `ólafur arnalds\|re:member` | 3c3b7c8d | 309 | Ó |
| 坂本龍一 | async | andata | `坂本龍一\|async` | f5399869 | 169 | 坂 |
| (Sandy) Alex G | DSU | Harvey | `(sandy) alex g\|dsu` | 9ece1544 | 348 | S |
| ßtraße | Weiß | Schnee | `ßtraße\|weiß` | 4e777e78 | 248 | ß |
| élan | (null) | x | `élan` | d7110104 | 252 | É |
| 123 Band | One | Two | `123 band\|one` | 31860802 | 58 | 1 |
| (empty) | Night Ferry | Untitled | `night ferry` | e3cf9981 | 41 | U |
| (empty) | (empty) | Untitled Lead | `untitled lead` | 3ecc92ce | 318 | U |
| (empty) | (null) | (empty) | `` | 811c9dc5 | 61 | (none) |

### 5.2 Peer monogram (server-stamped on the peers route)
- base = `label` minus a trailing ` · [0-9a-f]{4,6}`, trimmed, else `mStream`.
- Words split on whitespace, each reduced to its `\p{L}|\p{N}` scalars; words with none are dropped.
- ≥ 2 words: the first scalar of words 1 and 2, each upper-cased by the one-scalar rule.
- 1 word: its first two scalars as written (a one-scalar word is upper-cased).
- 0 words: `''`.
- Vectors: `Basement Hi-Fi`→BH · `Kitchen Radio`→KR · `mStream · 3f9a`→mS · `mStream · 3f9a2c`→mS · `Lighthouse Tapes`→LT · `Static Garden`→SG · `Rooftop FM`→RF · `kitchen radio`→KR · `Kitchen Radio · 1a2b`→KR · `The Vesper Lines`→TV · `Ünterwelt`→Ün · `Björk`→Bj · `坂本`→坂本 · `x`→X · `"  DJ  ⚡ Night "`→DN · `⚡`→`` (empty).
- The terminal draws no monogram.

### 5.3 Lead key (client-internal: the live clip, "No preview" sets, modal pinning)
`peer.endpointId + '\u0000' + exportId`. When `exportId` is absent, it falls back to `endpointId + '\u0000' + nameKey(artist)|nameKey(title)|nameKey(album)`. Earned art is keyed by `tile.key`, not the lead key.

### 5.4 Earned art
See §2 item 10. Source: `preview.artwork`, https only, loaded with `referrerpolicy=no-referrer` (web) or `Image.network` (phone). Held in memory for the visit only, and never fetched before a press.

### 5.5 Preview pacing and lifetime
- Resolve only on a press; Preview all counts as the press.
- One resolve in flight per client. A newer press or ⏭ supersedes a queued, unsent one (~300 ms debounce).
- At most one prefetch: the next lead, once the live clip passes 20 s, in Preview all only. A prefetch never retries.
- **429**: wait 5 s (deezer and any provider other than itunes) or 60 s (itunes), then retry once. Still failing → "No preview" for that press only. It is transient: the next press asks again, and Preview all ends the chain instead of skipping into an exhausted limiter.
- `preview: null`: "No preview" for the visit (muted icon); Preview all skips it.
- A transport failure is treated like a 429 after its retry.
- Main player rules: §2 items 13–14. The clip never counts as a play, never scrobbles, and is never queued.

### 5.6 Strip / tab item states (all clients; keyed on `endpointId`)

| row | shows | action |
|---|---|---|
| All (client-drawn) | neutral; selected by default | select |
| shelf, online | hue + monogram (web, phone) or label, plus an online dot | select (narrow, R2) |
| shelf, offline | dimmed, no dot | select |
| addable, no state (admins) | dashed "+" / `+ label` | POST add |
| `adding` (server), or a local press until the next poll | spinner / `adding…` | none |
| `failed`, code `no-room` | "No room" | **none** |
| `failed`, any other code | "Try again" | POST add |
| `done` | it is a shelf row by then | – |

Answer handling: 202 = adding; 200 `done` = landed (R4); 200 `failed` = per the code; 404 / 409 / 403 / 405 = drop the local state and poll now; 400 / 5xx / transport = a local "Try again" until the next poll. Server words are never drawn.

### 5.7 Copy
Copy = `Artist - Title`, or `Title` when the artist is empty. Copy list = the current tab's leads (all of them) in list order, joined by `\n`. Toast "Copied".

## 6. Phasing (server first, then webapp, phone, terminal)

House rules for every phase:
- Every workflow agent runs on **Opus 5.5** (`model: 'opus'`).
- `EnterWorktree` the phase's worktree **before** launching a workflow, and never switch mid-run.
- Pieces run in parallel per their ownership tables. One review agent (the code-review skill at high effort) and one verify agent run before the PR.
- The orchestrator does the live check in-session.
- Commits end with the session's attribution lines.
- Kill only owned PIDs.
- Never use `~/code/mstream-demo-music`.
- Watch disk space (`disk-space-hogs` memory).

### 6.1 Phase 1: server (mStream)
- Worktree `.claude/worktrees/peer-recs-server`, branch `claude/peer-recs-server`, fresh from `master`. Copy ffmpeg and ffprobe into the worktree.
- PR "feat(discovery): Peer Recommendations server — peers route, async Add, taste generation 2".
- Workflow waves: P1 ∥ P2 → P3 → P3b → P4 → P5 ∥ P6.
- **Gate S**:
  - `npm test` (unit + integration) green; `npm run docs:api:validate`; lint;
  - `node test/stage/peer-recs-stage.mjs` boots from the **main** checkout too (NO_SIDECAR), and the curl checks pass (peers member / admin, an Add's states, a taste body with `networkPeers`, `tile` and `label` on leads);
  - test 15 (SIGKILL mid-Add) green.
- Merge to master. **No mStream version bump yet** (§2 item 22).

### 6.2 Phase 2: webapp (mStream)
- Worktree `.claude/worktrees/peer-recs-webapp`, branch `claude/peer-recs-webapp`, fresh from master **after Phase 1 merges**.
- PR "feat(webapp): Peer Recommendations page".
- Waves: W1 ∥ W2 ∥ W5 → W3 → W4 → W6.
- **Gate W**:
  - `npm run test:unit` + the three discovery files green;
  - the §4.1 live walk done;
  - **the frame-1 screenshot with computed hues shown to the user, and their palette answer recorded in DECISIONS** (a curated palette would be a small server follow-up before the release);
  - #1044 rebase checked.
- Merge.

### 6.3 Phase 3: phone (mstream_music)
- Worktree `.claude/worktrees/peer-recs`, branch `claude/peer-recs`, fresh from `master` (currently `fee17e09`).
- PR "feat(discovery): Peer Recommendations".
- Waves: PH1 ∥ PH3 → PH2 ∥ PH4 → PH5 → PH6 ∥ PH7 → PH0 → PH8 → PH9. If #210 (93 files, unreviewed) lands first, rebase before PH0 / PH8 and re-run gen-l10n; never edit `lib/util/discover_badges.dart` (#210 touches it; the tile is server-stamped, so nothing here needs `nameKey` changes).
- **Gate P**:
  - `flutter test` green;
  - `flutter gen-l10n` clean (`l10n_untranslated.txt` lists no `peerRecs*`);
  - `integration_test/peer_recs_test.dart` on the iPhone 17 Pro simulator;
  - the §4.2 walk with one build;
  - re-run `test/media/*` if #209 landed.
- Merge. The card stays hidden until a generation-2 server.

### 6.4 Phase 4: terminal (mstream-terminal-player)
- Worktree `.claude/worktrees/peer-recs`, branch `claude/peer-recs`, fresh from **origin/main**.
- One PR (or T2 + T3 split out first if review prefers): "feat(gui): the Peer recs room (and the engine's aside playback)".
- Waves per §4.3; one shared `CARGO_TARGET_DIR`; serialized builds.
- **Gate T**:
  - the full CI matrix (§4.3);
  - e2e P / P2 and every existing scenario;
  - the §4.3 live check, including the server-audio steps 8–9;
  - rebase over #56 / #28 if either moved.
- Merge.

### 6.5 Release (one coordinated sequence)
1. Player: the release commit `release: v0.15.0` (`Cargo.toml :3` + `Cargo.lock`) on `main`, plus an annotated tag `v0.15.0`.
   - The release notes cover Peer recs, the aside engine and the **99 unreleased perf-audit commits** since v0.14.0 (e.g. `84a3dea perf(serve): drop --prefetch`).
   - `release.yml` publishes; its `notify` job opens mStream's pin PR (`auto/mstream-player-manifest-update`). Fallbacks: `notify-mstream.yml`, or `gh workflow run update-mstream-player-manifest.yml --repo IrosTheBeggar/mStream -f tag=v0.15.0`.
   - Measure the trunk web bundle first.
2. mStream: the server-audio smoke with the v0.15.0 binary, then merge the pin PR (`bin/mstream-player/manifest.json` `tag` → `v0.15.0`).
3. mStream version bump (v6.33.0). Wait for CI's `ci: update pre-built mstream-launcher binaries` commit and **tag that commit**, not the bump (the provenance guard; `release-ritual-ordering` memory). Dispatch on the tag ref if the tag event is eaten.
4. Phone, after the mStream tag:
   - bump `pubspec.yaml` `version` (0.39.0+58 → 0.40.0+59) and push tag `v0.40.0`;
   - `.github/workflows/release.yml` builds the APK, the AAB (Play internal track once the secret is set) and the unsigned IPA;
   - TestFlight stays a local step (`flutter build ipa` + Transporter), done by the user.
5. Clients merged before the server release stay hidden (the gate), so steps 1–2 may slip without harm. Only step 3 must wait for step 2.

## 7. Open questions (each with the default this plan builds)
1. **Palette** (§2 item 9): computed FNV hues (default) vs a curated palette indexed by the hash. Decided at Gate W; server-only either way.
2. **Admin "Invite <peer> to federate" row in the web window from the page**: hidden (default, minimal text) vs kept for admins.
3. **Coordinated release** (§2 item 22): hold the mStream bump for the v0.15.0 pin (default), vs ship server + web first and let the terminal room arrive with the next mStream release.
4. **Admin panel sync `peer-dbs/fetch` keeps pinning** (default yes, back-compat), while page Adds never pin. An admin who wants a page-added peer kept presses Pin in the panel.
5. **Addable rows**: online peers only (default, the design), vs also offline peers that seeders still hold.
6. **`limit.network`**: 32 (default; two blocks of 16) vs 48.
7. **Web i18n of Discover's bar keys** in the same PR (default yes, those keys only).
8. **Phone Get it…**: the server's best match, no YouTube candidate picker (default; the same on all three clients). A picker is a follow-up.
9. **Casting** (phone): a clip pauses the remote renderer (default, webapp parity) vs leaves it playing.
10. **Terminal window memory**: shared with Discover's `[gui] discover_window` (default; the web and phone share theirs too).
11. **P2P Network screen** (phone `p2p_screen.dart:365-393`) "Find similar music on the network": keeps opening More like this (default).
12. **Preview all when the list changes** (a tab, New seeds): the live clip finishes, then the chain ends (default) vs continuing into the new list.

## 8. Risks
- **Engine aside (terminal)** can regress main playback and mStream's server-audio. Several mechanisms are involved: soft pause/resume, device sleep (`at_rest`), `rebuild_output`, crossfade outgoing sinks, and `collapse()` dropping unnamed commands. Mitigations: State-level tests; "main transport ends the aside first" in every main command; the 5 s `ASIDE_HOLD` self-restore; the serve-mode tests; the server-audio live check and smoke before the pin PR.
- **Two `just_audio` players (phone)**: Android audio focus and the ExoPlayer / wifi locks, and iOS's shared AVAudioSession. PH4 isolates the coupling behind `MainPlayerPort`; a real-device check comes in the walk.
- **Autoplay (web)**: chained Safari clips depend on one reused `<audio>` element and on sticky activation after an awaited resolve. Checked in walk step 10.
- **Fetch-first overshoot**: the shelf can sit above its cap by up to the incoming snapshot's size during a download (the disk floor is still enforced). One large Add can evict several small peers; all of them are logged.
- **Page Adds do not pin**, so rotation may swap them out after `rotationDays` (7).
- **No global shelf lock**: safety rests on reservations, the post-download re-check and idempotent removal. The worst case is one wasted download.
- **Three `MSTREAM_TEST_*` switches in production code**. They are inert unless set and documented in one comment block.
- **Label churn**: a newly heard same-name peer suffixes both labels on the next poll. All state keys on `endpointId`.
- **Privacy**: members see the online state of shelf peers (already public gossip). Third parties are reached only on a press. Earned art loads from the provider CDN on the client after a press.
- **Rate limits are server-wide**. Several users on Preview all can exhaust Deezer's 40 / 5 s. This is bounded by one-in-flight plus one prefetch and the transient 429 rule.
- **Restart**: every peer reads offline for about 15 s, and in-flight Add states vanish (the row shows "+" again). A soft reboot (any reboot-requiring admin save) does the same to Add states and abandons running downloads.
- **`discoveryP2p` true while the stack is down** (no sidecar for the platform, or the recovery ladder): admins get "Try again" (`offline`) and members "No peers yet". `shelf.running:false` and the activity log tell an admin why.
- **Merge conflicts** (textual):
  - mStream #1072 (flags, ping, openapi);
  - mStream #1044 (m.js, vp.js, index.html, spa.css, en.json, api.js);
  - phone #210 (browser.dart, browser_list.dart, browser_toolbar.dart, discovery_plugins*, ARBs) and #209 (behavioural, `test/media/*`);
  - player #56 (`types.rs` `LayeredFeatures`, `gui/mod.rs`, locales, `fake_mstream.py`, `run.sh`) and #28 (`engine/mod.rs`).
- **Translations** in all three clients are not native-reviewed.
- **CI has no audio device on Linux runners**: the terminal's band and clip path are covered by unit tests, and the e2e leg asserts absence when no device opened.
- **The rust-i18n wasm release memory** (the v0.8.0 OOM): measure trunk before tagging.
- **Hues differ from the approved boards** until the user answers Q1.

## Appendix A — review findings

Applied: every finding not listed below, with its fix as written in this plan. In particular:
- facts F1–F15;
- compat B1 (server stamping, the reviewer's preferred option), M1 (state clearing, sync route never stores no-room), M2–M7, m2–m6;
- design B1, B2, M1–M3, m1, m2, m5–m12, m14 (as a flagged user check).

Rejected or changed, one line each:
- **compat M1, "a tap on No room re-POSTs"**: rejected. No room is inert on all three clients, because the server now clears the state on any shelf or pin change, and when another download that held room ends without landing, so the row returns to "+" exactly when a retry could succeed. A re-POST before that would only repeat the same `planRoom` refusal.
- **compat m1, "in Preview all, skip past a long iTunes wait"**: rejected. Skipping fires the next resolve into the same exhausted server-wide limiter; the chain ends after one wait and one retry instead.
- **compat m7, "All: re-ask on every client" vs the web's cache**: not unified either way. A per-tab cache is optional (R2), because a pinned walk over an unchanged shelf returns the same rows.
- **compat B1 fallback ("vendor the fixture into phone and terminal")**: not needed. The tile and the monogram are stamped by the server, so clients carry no hash code and no fixture copy.
- **design m3, phone "cap at 2 columns and let the cards grow"**: changed. 2 columns always, with cards capped at 240 px and the grid centred, so tablets do not get 500 px cards.
- **design m4, "reuse Discover's `new_seeds_tip` with the key as a placeholder"**: changed. The tooltip is dropped instead, so Discover's string does not churn in 10 locales. The modal reuses `gui.tips.discover_menu`, so no new modal tips key.
- **design m13, "a glyph-only job badge on rows"**: changed to no job state on rows at all (§2 item 16). This also removes the page-wide `lookup/batch` polling on all three clients.
- **facts F7, "or document the 404"**: the other option was taken (`isBlocked` is checked first, 409).
- **facts F8, "or export a pure `shelfSpaces`"**: the integration option was taken (taste + shelf fixture, test 17). `shelfSpaces` stays private.
- **compat M2 detail, "20+ unreleased player commits"**: corrected to 99 non-merge commits since v0.14.0. The release-notes step is kept.
- **facts F15, the "TOOLS takes row 4" wording**: no plan change was needed, because the drafts' coordinates were already right. §2 item 21 states that the whole column shifts.
- **web draft, "keep the plug-ins-off copy fallback"; phone draft, the attribution ARB keys; terminal draft, its own `norm` and the "- Title" copy**: all superseded by design B2 / M3, facts F1 / F5 and §5.

Build review (the verify pass over the finished server pieces): seven findings, all applied (the §3.3 ones marked **[verify]**). A download ending without landing clears stale No room; a `done` goes with its snapshot; a size-less announcement is refused up front and a zero ceiling is no-room; non-string peer names read as none, and the taste route's label stamping sits inside the network section's try; the swap saves the registry before deleting files; the raw admin fetch exports outside the swept directory; and the docs now say what resets Add states, when `gone` is decided, and that the panel's fetch can join an Add's swap.
