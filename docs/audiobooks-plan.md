# Audiobooks — plan

Status: plan v2, 2026-11-18. A proposal. The first build phase, the book rules (S1, §12), is written; nothing else is built. Four things are decided: our own API (§2), a second scanner for audiobook folders (§5.1), no DLNA browsing of books in the first version (§9), and no upgrade path for libraries already marked as audiobooks (§9). The open decisions in §10 are not answered. It covers the API layer, the audiobook scanner, the data model and the build order (§12). The client screens are not designed.
v2 replaces v1's pass over the music scanners' rows with a second scanner for folders marked as audiobook folders (§5).
Facts were verified against mStream `e42502d5` and `mstream_music` master `d17c3fa5` (the play outbox). The grouping and identity rules (§6, §7) are unit-tested on synthetic folder layouts, and tag reading (§5.7) was tried on generated files; neither has been run against a real library.

## 1. Summary

- **What we are building:** audiobook support in mStream's own terms: a book catalogue, a listening position per user that follows them across devices, and bookmarks. It is reachable the way everything else is: plain HTTP, the iroh tunnel and federation.
- **Our own API, not Audiobookshelf's** (§2). 11 routes under `/api/v1/audiobooks` (§4): four catalogue reads and seven for per-user state.
- **A second scanner for audiobook folders** (§5). The admin marks a folder as an audiobook folder when adding it. Such a library is scanned by a dedicated JavaScript scanner instead of the music scanners. It walks the folders and builds books from folder structure, tags and sidecar files together. Audiobook files never enter the music index (§9).
- **A book's ID is random and assigned once.** Each scan re-matches stored books to what is on disk, by audio hash first and by place second. A scan never deletes a book (§7).
- **New tables only** (§8). The music scanners do not change, and `SCANNER_SCHEMA_CONTRACT` stays at 73.
- **Built in six pull requests** to the first release that shows the feature (§12). Nothing is visible to a user until the last one, which adds the checkbox.
- **Tested so far:** the grouping rules give the wanted result on 16 of 19 synthetic layouts, and the ID survives 14 of 15 rescan scenarios (§6.3, §7.4). Both sets are unit tests now. On generated files, the tag library read the tags in every container and the chapters in `.m4b`, `.mp3` and `.opus` files (§5.7).

## 2. Why our own API

Decided 2026-11-18, after reading the Audiobookshelf (ABS) API. Emulating it would buy third-party app support, but only for users who do not need what mStream's own apps exist for.

1. **There is no contract to implement.** The ABS API documentation site says its docs are out of date and no longer maintained. Routes carry no version prefix, and the project's community-apps page describes the API as under constant development. The Subsonic API at least had a specification; here the specification is whatever the current ABS release does.
2. **It has already broken clients, and more is planned.** v2.26.0 replaced authentication with JWT access tokens plus rotating refresh tokens (`POST /auth/refresh`, the `x-return-tokens` and `x-refresh-token` headers), with the old tokens removable from 2025-09-30. v2.36.0 is reported to have stopped accepting refresh tokens as bearer tokens (CVE-2026-73085). In the authentication discussion the maintainer says an endpoint refactor is planned, with no date.
3. **The payloads are ABS's internals.** The (stale) docs list about 155 HTTP endpoints in 19 groups, plus socket.io events. Library items expose `ino`, `libraryFiles`, `mtimeMs`, `scanVersion` and `folderId`, and `POST /api/items/:id/play` returns a playback session that wraps the whole expanded item. Making a real client work means reproducing their data model, not just their routes.
4. **No ABS client can dial iroh.** Compatibility would only reach users who already expose the server over plain HTTP, and those users can run ABS itself. This is the argument in `docs/subsonic-deprecation.md`; that surface was removed in 6.26.0.
5. **The app ecosystem is a weaker prize than it looks.** ABS lists 12 third-party apps and warns that many use endpoints it no longer recommends, producing wrong stats and listening sessions, and that abandoned apps are common. Third-party clients need not be open source, so what a client expects cannot always be read.

**What this costs:** day-one apps with CarPlay, Android Auto, watch support and offline downloads. Those are the expensive features to build in the Flutter app, and iroh needs them built there either way.

**What we take from ABS** is the concepts, not the wire format: a progress record per user and book; listening sessions that record time listened, including batches of offline sessions; one timeline per book with a single chapter list; series with a sequence; narrators; named bookmarks.

**Kept open, cheaply:**
- An importer that acts as an ABS *client*: it logs into a user's ABS server and pulls progress and bookmarks. That is what someone switching needs, and it touches a few read endpoints.
- The model stays mappable onto ABS's, so a translation gateway outside core remains possible. Nothing is built for it.

Sources (read 2026-11-18): [ABS API docs](https://api.audiobookshelf.org/), [third-party apps](https://audiobookshelf.org/docs/documentation/community/community-apps/), [app FAQ](https://audiobookshelf.org/faq/app), [authentication discussion #4460](https://github.com/advplyr/audiobookshelf/discussions/4460), [v2.26.0 notes](https://newreleases.io/project/github/advplyr/audiobookshelf/release/v2.26.0), [v2.36.0 notes](https://newreleases.io/project/github/advplyr/audiobookshelf/release/v2.36.0), [CVE-2026-73085](https://feedly.com/cve/CVE-2026-73085).

## 3. What exists today

| What | Where | State |
|---|---|---|
| Library type `audio-books` | `src/state/config.js:929`; set once by `addDirectory` (`src/util/admin.js:120-130`); reported per library in `user.vpathMetaData` (`src/api/server-info.js:265-271`) | Only DLNA acts on it (`src/api/dlna.js:342-349`, `:528-534`). No route changes a library's type after it is created. |
| Marking a folder as audiobooks | `PUT /api/v1/admin/directory` takes `isAudioBooks` (`src/api/admin.js:1385`) | The API half exists. The admin UI's add-folder form had an "Audiobooks & Podcasts" checkbox from v5.12.0 (2024-03) through v6.23.0. It stored the type and changed nothing else, so v6.24.0 removed it as a dead code path (commit `d55d61d6`). The form does not send the flag today (`webapp/admin/index.js:977-982`). The label's string is still in all 12 locale files (`admin.folders.audiobooks`, `webapp/locales/en.json:818`). |
| Scan dispatch | `runScan` (`src/db/task-queue.js:2501-2581`) | Loads the library row, builds one JSON payload, then starts the Rust scanner or the JavaScript one. The library type plays no part. |
| Audiobook files in music surfaces | n/a | Files in such a library are ordinary tracks. They appear in albums and Auto DJ picks and count in play stats, and a counted play with an artist and a title is forwarded to a linked Last.fm account (`src/stats/forward.js:35-43`). Neither the webapp nor the Flutter app reads the library type. |
| Seeking into a long file | `src/api/transcode.js:490-494`; `/media/` | `/transcode/…?offset=<seconds>` restarts the transcode at that point. Raw files under `/media/` take Range requests. |
| Play ingest and the client outbox | `src/stats/ingest.js`, `src/api/stats.js:88-110`; Flutter `lib/singletons/play_sync.dart` | The idiom §4.5 copies. |
| `user_bookmarks`, `user_play_queue` | `src/db/schema.js:422`, `:439` | Left inert by the Subsonic removal. One position per user and track, so they cannot hold several named bookmarks per book or a book-level position. Not reused. |
| Chapter marks | n/a | Neither scanner reads them. |
| "Audiobook controls" | `webapp/alpha/vp.js:40` | A player layout option only. |

## 4. The API

### 4.1 Three rules

These come from how the server already works.

1. **Catalogue reads are `POST` with a JSON body on fixed paths.** A federation key and the outbound browse proxy both screen against one exact "METHOD path" set (`ALLOWED_EXACT`, `src/api/federation-auth.js:47`), and the proxy forwards no query string (`src/api/federation-browse.js:55-56`). In this shape a peer's audiobooks become browsable by adding four lines to that set.
2. **Per-user state copies the Stats API v2 ingest** (`src/stats/ingest.js`): ids generated by the client, batches that are safe to resend forever, and an answer of `accepted` / `duplicates` / `rejected`. The Flutter app's `PlaySync` already implements that policy, including holding events while an iroh tunnel is down.
3. **No new byte routes.** Files play through `/media/` and `/transcode/`; covers come from `/album-art/`. Over federation the existing stream and art proxies carry them.

### 4.2 Capability and plumbing

- `audiobooks: 1` in `buildFeatures` (`src/api/server-info.js:82`): an integer generation like `flowOrder`, a version fact, never probed for.
- The same key added by hand to ping (`src/api/playlist.js:20-73`); the drift-lock test in `test/integration/api-server-info.test.mjs` checks it.
- Apps find audiobook libraries from `user.vpathMetaData[vpath].type`, which `GET /api/` already returns.
- Four lines in `ALLOWED_EXACT` for the catalogue routes.
- An OpenAPI entry per route in `docs/openapi.yaml`.

### 4.3 Routes

All under `/api/v1/audiobooks`.

| Route | What it does |
|---|---|
| `POST /books` | List books. |
| `POST /book` | One book by `id`: full metadata, `tracks`, `chapters`. |
| `POST /authors` | Authors with book counts. |
| `POST /series` | Series with book counts. |
| `POST /sessions` | Report listening as a batch of sessions. Answers with verdicts and the current progress of each book touched. |
| `GET /progress` | Progress rows changed since a cursor, removals included. |
| `PUT /progress/:bookId` | Set explicitly: position, finished, hidden. |
| `DELETE /progress/:bookId` | Forget a book's progress. |
| `GET /bookmarks` | Bookmarks, optionally for one book. |
| `PUT /bookmarks/:id` | Create or update one, with an id generated by the client. |
| `DELETE /bookmarks/:id` | Remove one. |

The first four are the catalogue: pure reads, scoped by `libraryFilter` like every `db/` route, and open to a federation key. The other seven are account-only under the stats rule (`requireAccount`, `src/api/stats.js:218-220`): 403 for a federation key or a guest token. On a server with no users they work against the shared public-mode account (`src/api/auth.js:155`).

### 4.4 Books

`POST /books` body (all optional):

| key | type | meaning |
|---|---|---|
| `author`, `narrator`, `series`, `genre` | string | Keep books matching that name. |
| `q` | string | Search title, author and series. |
| `ignoreVPaths` | string[] | The house parameter: leave these libraries out. |
| `limit`, `cursor` | int, string | Paging. `cursor` is opaque. |

The answer is `{ "revision": "…", "next": null, "items": [ … ] }`, ordered by title. `revision` is also the ETag, and a first page sent with a matching `If-None-Match` gets a 304, as `sync/manifest` does (`src/api/sync.js:113-120`). A client that keeps an offline index asks again cheaply.

A book, as `POST /book` returns it. The list omits `description`, `tracks` and `chapters` and adds `trackCount`.

```json
{
  "id": "b_9k2f7q",
  "vpath": "audiobooks",
  "title": "Book Title",
  "subtitle": null,
  "authors": ["Author Name"],
  "narrators": ["Narrator Name"],
  "series": [{ "name": "Series Name", "sequence": "2" }],
  "year": 2020,
  "genres": ["Fantasy"],
  "description": "…",
  "publisher": null,
  "language": "en",
  "durationMs": 25020000,
  "sizeBytes": 356000000,
  "artFile": "5f1c.jpg",
  "addedAt": "2026-11-02T10:11:12.000Z",
  "missing": false,
  "tracks": [
    { "filePath": "audiobooks/Author Name/Book Title/01.mp3", "startMs": 0, "durationMs": 1312000, "sizeBytes": 18400000, "format": "mp3", "hash": "…" }
  ],
  "chapters": [
    { "startMs": 0, "endMs": 1312000, "title": "Chapter 1" }
  ]
}
```

- `id` is opaque. A client stores it and never parses it.
- `series` is an array because a book can sit in more than one. `sequence` is text ("1", "2.5").
- `tracks[].filePath` is the vpath-prefixed path every other route takes, so play, transcode, download and waveform work unchanged. `tracks[].hash` is the audio hash, else the file hash: the key user state uses, not the file hash that `metadata.hash` carries on the music routes.
- A request for an ID that was merged into another book (§7.3) answers with that book and its ID.

`POST /authors` and `POST /series` answer `{ "items": [{ "name": "…", "bookCount": 3 }] }`. The books of one come from `POST /books` with that name.

### 4.5 Listening sessions

`POST /sessions` body, at most 200 sessions (the stats batch cap):

```json
{
  "client": { "name": "mstream-android", "version": "0.20.0", "instanceId": "…" },
  "sessions": [
    {
      "id": "c1c9e0f2-…",
      "bookId": "b_9k2f7q",
      "startedAt": "2026-11-18T19:02:11.000Z",
      "updatedAt": "2026-11-18T19:41:40.000Z",
      "startPositionMs": 3600000,
      "positionMs": 5940000,
      "listenedMs": 2340000
    }
  ]
}
```

| key | meaning |
|---|---|
| `id` | The client's id for this sitting. It stays the same for as long as the session grows. |
| `startedAt`, `updatedAt` | Client instants (ISO 8601 or epoch milliseconds, as stats takes them). `updatedAt` is when `positionMs` was true. |
| `startPositionMs`, `positionMs` | Positions on the book's timeline (§4.8). |
| `listenedMs` | Time actually spent listening. At 1.5× speed it is less than the position moved. |
| `peerId`, `book` | For a book on a federated server: the peer's id and a snapshot (`title`, `authors`, `durationMs`, `artFile`). Ignored for a local book. |

Answer:

```json
{
  "accepted": ["c1c9e0f2-…"],
  "duplicates": [],
  "rejected": [{ "id": "…", "reason": "unknown-book" }],
  "progress": [ { "bookId": "b_9k2f7q", "positionMs": 5940000 } ]
}
```

- `accepted`: stored, or advanced to a later version.
- `duplicates`: an id already stored with nothing newer. Acknowledged, nothing moved.
- `rejected`: the client drops the session. Reasons, mirroring stats:

| reason | meaning |
|---|---|
| `unknown-book` | No such book in a library this user can see. |
| `unknown-peer` | `peerId` is not a peer this server lists. |
| `bad-time` | An instant that cannot be parsed, or one more than five minutes ahead of the server clock. |
| `invalid` | A peer session without its book snapshot, or an id another user already owns. |

- `progress`: the current progress row of every book the batch touched (full rows as in §4.6; shortened above), so a device learns in the same round trip that another device is further along.

### 4.6 Progress

A progress row:

```json
{
  "bookId": "b_9k2f7q",
  "peerId": null,
  "positionMs": 5940000,
  "durationMs": 25020000,
  "finished": false,
  "hidden": false,
  "startedAt": "2026-11-12T08:15:00.000Z",
  "finishedAt": null,
  "updatedAt": "2026-11-18T19:41:40.000Z",
  "client": "mstream-android/0.20.0",
  "book": { "title": "Book Title", "authors": ["Author Name"], "artFile": "5f1c.jpg" }
}
```

- `GET /progress?since=<cursor>` answers `{ "items": [ … ], "cursor": "…" }`: every row changed since the cursor, plus `{ "bookId", "peerId", "deleted": true }` for a removed one. With no `since` it returns every row. The client keeps the returned cursor for next time. The cursor is a server counter, not a time.
- Each row carries a small `book` summary, so "Continue listening" (rows that are not finished and not hidden, newest first) is one call.
- `PUT /progress/:bookId` takes `{ positionMs?, finished?, hidden?, at? }` and answers with the row. `at` is when the user did it; it defaults to now and competes with sessions under the newest-wins rule (§4.8). `hidden` takes a book out of "Continue listening" without losing its position.
- `DELETE /progress/:bookId` forgets the book.
- For a peer's book, the `PUT` body carries `peerId` and `book`, and the `DELETE` takes `?peerId=`.

### 4.7 Bookmarks

`{ "id", "bookId", "peerId", "positionMs", "note", "createdAt", "updatedAt" }`.

- `GET /bookmarks` returns the caller's bookmarks, or one book's with `?bookId=` (and `?peerId=`).
- `PUT /bookmarks/:id` creates or replaces. The id is the client's, so a bookmark made offline is safe to send twice.
- `DELETE /bookmarks/:id` removes it.

### 4.8 Behaviour

- **One timeline per book.** `positionMs` counts from the start of the first file; `tracks[].startMs` maps it to a file and an offset. `chapters` is always filled: embedded chapter marks where the files have them, otherwise one chapter per file.
- **A session is re-sent as it grows.** The client posts its open session about once a minute and on pause, with the same `id` and a later `updatedAt`. The server keeps the longest version. There is no open or close call to lose on a bad connection, and a resend is always safe.
- **The newest listening wins.** A book's position follows whichever session or explicit set has the latest `updatedAt`: when it was heard, not when it arrived. A phone syncing last week's offline listening cannot rewind what was heard since.
- **Finished** is set by the server when a position lands within a configurable margin of the end, or explicitly.

### 4.9 Federation

- The four catalogue routes answer a federation key, scoped to the key's libraries, and reach a peer through `/api/v1/federation/peers/:id/api/…` unchanged.
- Files and covers of a peer's book go through the existing stream and art proxies.
- State for a peer's book lives on the listener's own server, keyed by `peerId`, with a snapshot of the book because this server has no row for it. A federation key never reaches the state routes. Stats already works this way (`play_events.peer_id` and its snapshot).

### 4.10 Not in the first version

Podcasts, ebooks, metadata editing and online lookups, collections, listening-stats reads for books (the session log keeps the data), sockets and HLS.

Outside the API, DLNA browsing of books is also left for later (§9).

## 5. The audiobook scanner

### 5.1 Why a second scanner

Direction set 2026-11-18: a folder marked as an audiobook folder is scanned by a scanner of its own, which combines folder structure with tags. This replaces the plan's first version, in which books were computed from the rows the music scanners wrote.

- **The dispatcher already knows the library.** `runScan` loads the library row before it picks an engine (`src/db/task-queue.js:2501-2581`), so sending `audio-books` libraries to another scanner is one branch. The queue, scan status, schema guard, pidfile reaper and file watcher are shared.
- **Audiobook files never enter the music index.** The music surfaces are clean by construction instead of by a filter in every route (§9), and the waveform, BPM, discovery, AcoustID and album-art passes never spend time on a twenty-hour file.
- **A folder walk sees what `tracks` rows cannot.** Cover images, sidecar files and the folders that hold no audio (the author and series levels) are all inputs to a book. A pass over `tracks` saw audio files only.
- **It can be simple.** The hard part of the music scanners is deleting safely. This scanner never deletes a book (§7.3).
- **Album identity is the wrong shape for books either way.** An album row is keyed globally by tag (`mbid:<release id>` or `name:<album>|<album-artist id>`, `src/db/album-key.js:28-31`), so two editions of one book would collapse and a badly tagged book would fragment.

It is a JavaScript worker with no Rust twin. Book libraries are small next to music libraries and nothing is decoded. A second engine would bring back the byte-for-byte parity burden and the committed binaries the music scanners carry.

### 5.2 Marking a folder

- The add-folder API already takes the flag: `PUT /api/v1/admin/directory` with `isAudioBooks` (`src/api/admin.js:1385`) stores the library as type `audio-books`.
- The admin UI's add-folder form does not send it (`webapp/admin/index.js:977-982`). The checkbox the form had until v6.24.0 comes back, and the folder list should show each library's type.
- Nothing changes a library's type after it is created (§10).
- A library is music or audiobooks, not both. A folder that mixes them has to be split.

### 5.3 Dispatch

- In `runScan`, a library of type `audio-books` starts the audiobook scanner; every other library takes the existing Rust-or-JavaScript path. The task stays a `scan`, so deduplication, `isScanning`, the watcher and the after-scan hooks behave as they do now.
- It is launched through `launchWorker` like the JavaScript music scanner (`src/util/worker-process.js:19-25`), with the same handlers (`attachScanHandlers`, `onScanClose`). It needs its own worker role so the Bun standalone build can dispatch it.
- It takes the same JSON payload (`dbPath`, `libraryId`, `vpath`, `directory`, `scanId`, `expectedSchemaVersion`, `supportedFiles`, `followSymlinks`, the dot-entry flags, `albumArtDirectory`, `forceRescan`). Nothing is added to it.
- It speaks the scanners' stdout protocol (`scanStart`, then `scanComplete` with `filesProcessed`, `filesUnchanged`, `staleEntriesRemoved` and `walkErrors`) and writes `scan_progress` rows, so the scan log line and the progress API need no special case.

### 5.4 What a scan does

1. **Walk** the library folder with the shared ignore rules (`src/db/scan-ignore.js`) and the library's `followSymlinks` flag. Each folder's audio files, images and sidecar files are noted.
2. **Read** each audio file, unless it is unchanged. A file is unchanged when its path, size and modification time match its stored `book_files` row (§8); then nothing is opened. Otherwise the scanner computes its hashes with the music scanners' own function (`computeHashes`, `src/db/audio-hash.js:437`), which samples files above 25 MB instead of reading them whole, and reads its tags, duration and chapter marks in-process (§5.6).
3. **Group** the files into books by folder structure and album tag (§6).
4. **Resolve** each book's fields from sidecar files, tags and folder names, in that order of trust (§5.5), and its chapters (§5.6).
5. **Match** the books found to the books stored, by content and then by place (§7.2).
6. **Write** the catalogue in bounded transactions. A stored book that matched nothing is marked missing, and only when the walk was clean: an unreadable library root fails the scan, and a folder that could not be listed shields the books under it.
7. **Clear the music index** for this library if it holds any rows. A folder added as an audiobook folder never has any, so this is a safety net for a library that carried the type before this scanner existed (§9). Such rows are removed in chunks, as `deleteLibraryRows` does (`src/util/admin.js:206-213`), followed by the usual orphan cleanup.

The catalogue `revision` (§4.4) is derived from the caller's visible books, their count and latest change, the way `manifestRevision` derives it from tracks. Nothing has to be bumped.

### 5.5 Where the fields come from

For each field, the first source that has a value wins.

| Field | 1. Sidecar | 2. Tags | 3. Folder structure |
|---|---|---|---|
| Title | Metadata file | Most common album tag | The book folder's name, else the file name |
| Authors | Metadata file | Most common album-artist tag, else the artist tag | The folder above the book, or above its series folder |
| Narrators | Metadata file | A narrator tag, else the composer tag | n/a |
| Series and sequence | Metadata file | Series tags, else a grouping value such as "Series Name #2" | A folder between author and book, and a leading number on the book folder |
| Description, publisher, language | Metadata file | Description, publisher and language tags | n/a |
| Cover | An image file in the book folder | Embedded picture | n/a |
| Year, genres | Metadata file | Year and genre tags | n/a |

- A folder with no audio of its own is structure, not a book: its name is a candidate author or series for the books under it.
- Covers go through the art cache the music scanners use (`saveImageToCache`, `src/db/album-art-lib.js:227`), so `/album-art/` serves them.
- Authors and narrators are plain names in the book tables, not rows in `artists`, so an author never becomes a music artist.
- Which metadata file formats to read first is open (§10). Audiobookshelf's `metadata.json` is the obvious candidate for people switching.

### 5.6 Chapters

A book's chapters are its files' embedded chapter marks, each shifted by the file's start on the book timeline. A file with no marks is one chapter, titled from its own title tag when the files' titles differ, else from its name.

| Container | Read with | In the test (§5.7) |
|---|---|---|
| M4B, M4A, MP4 (a chapter track or a Nero chapter list) | The tag library, `format.chapters`, with `includeChapters` on | 3 of 3 chapters, in both file layouts. |
| MP3 (ID3 `CHAP` and `CTOC` frames) | The tag library, `format.chapters` | 3 of 3 chapters, with start and end. |
| Ogg and Opus (`CHAPTERnnn` comments) | The tag library's raw tags, parsed by the scanner | Present as `CHAPTER000=00:00:00.000` and `CHAPTER000NAME=…`. |
| FLAC | n/a | The generator wrote no chapters. Untested. |

- The marks come from the same in-process read as the tags, so no file is opened twice and no process is started.
- Start times arrive in different units. An MP4 chapter's `start` counts in its `timeScale` (`start / timeScale` is seconds); an ID3 chapter's `start` is in seconds. The scanner stores milliseconds.
- `ffprobe` is not part of the design. It read the same chapters in the test, so it remains a fallback if real files show a gap (§11).

### 5.7 Tag-reading test

Thirty-second files with three chapters and book tags were generated with the bundled `ffmpeg` (`bin/ffmpeg`, build N-126342 of 2026-08-31) as `.m4b`, `.mp3`, `.opus` and `.flac`. They were read with the tag library the JavaScript music scanner already uses (`music-metadata`), at 12.3.0, the version `package-lock.json` pins.

- **Tags came through in every container:** title, album, artist, album artist, composer, genre and year. Custom `SERIES`, `SERIES-PART` and `NARRATOR` tags were readable from the MP3 (as `TXXX` frames) and from Opus and FLAC (as plain comments), along with publisher and language. On the M4B, grouping, description and comment were read. `ffmpeg` does not write custom tags into that container, so those are untested there.
- **Chapters came through in `.m4b`, `.mp3` and `.opus`.** The M4B gave 3 of 3 with the file's index at the end, which is how `ffmpeg` writes it by default, and with the index moved to the front. The generated M4B files carry both chapter formats, a chapter track and a Nero list, so the test does not show each one working alone.
- **The first run of this test was wrong about M4B.** It used the worktree's stale install, 11.15.0, which read no chapters from one M4B and threw on the other, and an earlier draft of this plan called for `ffprobe` because of it. The results here are from 12.3.0 only. `package.json` allows 12.2.3 and later, and versions below 12.3.0 are untested.

## 6. What a book is

### 6.1 Grouping rules

1. **A folder is one book.** The audio files directly in a folder form one book.
2. **Disc folders fold into the folder above them.** A subfolder whose whole name is `CD`, `Disc`, `Disk`, `Part` or `Pt` followed by a number belongs to the book above it, at any depth: `CD1/Part 2` folds twice. Disc folders directly under the library root form one book.
3. **Loose files in the library root are never one book.** There, each album tag is a book and each untagged file is its own book.
4. **A shelf splits by album tag.** A shelf is a folder that holds several whole books as loose files. A folder counts as one only when every file has an album tag, there are two or more distinct tags, each tag's files form one unbroken run in path order (§6.2), and no tag has more than three files.

Album tags are compared after normalising: `nameKey` (`src/db/name-key.js`), with bracketed parts and trailing disc or part markers removed. "Title (Disc 1)", "Title - Part 2" and "Title (Unabridged)" all compare as "title". Spelled-out numbers ("Part One") and the words Book and Volume are not markers.

A book has an address: its folder; its folder and album key, when the folder holds several books; or its file, for a lone file split out of a shelf or the root. No two books of one scan share an address.

The rules are tuned so that mistakes fall on the merge side. A user fixes a merge by giving each book its own folder. A split inside one folder cannot be fixed by moving files.

### 6.2 File order

Disc and track tags decide the order when every file has a track number and no two files share a disc and track. Otherwise the order is the natural sort of the path, which handles `CD1/01.mp3 … CD2/01.mp3` with restarting track numbers and no disc tags. A missing disc tag, or disc 0, counts as disc 1. Track 0 is a track number.

The natural sort compares paths name by name: digit runs by value, everything else by lowercased character code, and the file extension last. So `CD2` sorts before `CD10`, `Title.mp3` before `Title 2.mp3`, and folder `B` before `B 2`. It is written out in the rules and does not use the runtime's locale collation. A file's place in the order decides where it sits on the book timeline, and collation data differs between Node, the Bun build and their releases.

### 6.3 Test results

19 synthetic layouts; 16 group as wanted. They are unit tests on the real `nameKey` (`test/unit/book-rules.test.mjs`), one per row, and the three misses are asserted as they are. The rules run on lists of paths and tags; nothing here walks a disk.

| Layout | Result |
|---|---|
| `Author/Title/*.mp3` | One book. |
| Loose single-file books in an author folder | One book each. |
| `Author/Series/01 - Title/*.mp3` | One book. |
| Files at the library root, some untagged | One book each. |
| `CD1` / `CD2` subfolders, track numbers restart, no disc tags | One book, discs in order. |
| A two-part `.m4b` beside another book | Two books. |
| One book with a tag typo in the middle | One book. |
| Album tags carrying "(Disc n)" | One book. |
| A loose file plus a non-disc subfolder | Two books. |
| An untagged folder | One book. |
| A book with differently tagged bonus tracks at the end | One book. |
| `Part 1` / `Part 2` subfolders | One book. |
| A series folder, one subfolder per book | Two books. |
| Series entries in bare `Volume n` folders | Two books. |
| One book whose two halves are tagged differently | One book. |
| A three-file book whose album tags differ only by a part marker | One book. |
| A chapter-per-file book sharing a folder with a loose book | **Merged** (wanted two). |
| Untagged loose files in an author folder | **Merged** (wanted five). |
| A three-file book whose files carry different album tags | **Split** (wanted one). |

## 7. Identity

### 7.1 The ID

A random string (`nanoid`, already a dependency), assigned when the book is first seen and never reused. Offline devices hold it for weeks, so it has to survive rescans, renames and moves.

### 7.2 Matching

Each scan matches the groups it found to the books already stored, in this order:

1. **Content.** A stored book and a group that share at least half of the smaller side's files, by audio hash, are the same book. Pairs are taken strongest first: most shared files, then same place. A tie after that goes to a live book before a missing one, to a missing one before a book already merged into another, and then to the older book. This covers an unchanged library, renames, moves, retagging and added or removed files.
2. **Place.** A stored book with no content match keeps its ID if a group sits where it was (same library, path and group key) and nothing has claimed that group. This covers a book re-encoded in place.
3. **New.** A group nobody claimed gets a new ID.
4. **Gone.** A stored book nothing matched is marked missing (§7.3).

A scan matches against the library's own books, live and missing, and against the missing books of every other library. That is how a book moved between libraries, or the books of a removed library, get their IDs back. The place rule only holds inside one library.

Content comes before place on purpose. Place-first failed two prototype scenarios: renumbering generically named folders (`Book 1` becomes `Book 2` while the old `Book 2` becomes `Book 3`) handed one book's ID to another book's files, and splitting a merged folder left the ID with the smaller part.

### 7.3 Missing and merged books

- **A scan never deletes a book.** A book with no files gets `missing_since` and keeps its row, its ID and all user state. An unmounted drive costs nothing: when the files return, the content rule gives the book back its ID.
- **Copied, then the original deleted.** When a book goes missing and a live book holds at least half of its files, `merged_into` points at the live one; if several do, at the one holding the most. Requests for the old ID answer with the new book, sessions sent against the old ID apply to it, and the old book's state is re-keyed to it. A missing book keeps its pointer when nothing holds its files any more, and loses it when its own files come back.
- **Two stored books can share an address.** A missing book keeps the address it had, and another book can move into that folder. So an address is unique among the books one scan finds (§6.1), not among stored books (§8).
- **Removing a library keeps its books as missing** (`library_id` goes NULL). A library's type is fixed at creation today, so removing and re-adding is the only way to change it; the content rule then gives every book its ID back.
- Missing books are left out of lists. `POST /book` still answers for one, with `missing: true`.

### 7.4 Test results

15 rescan scenarios; 14 keep the ID. They are unit tests too, one per row, and the miss is asserted as it is.

| Scenario | Result |
|---|---|
| Rescan, nothing changed | Same ID. |
| Folder renamed | Same ID. |
| Moved under another author | Same ID. |
| A file added | Same ID. |
| Retagged in place | Same ID. |
| Re-encoded in place (every hash changes) | Same ID, by place. |
| Drive unmounted for one scan, then back | Missing, then the same ID. |
| Copied, original kept | Two books. |
| Copied first, original deleted in a later scan | The old ID points at the copy. |
| A loose file renamed | Same ID. |
| A loose file moved into its own folder | Same ID. |
| Numbered folders renumbered | IDs follow the content. |
| Two books merged into one folder | The bigger keeps its ID; the other points at it. |
| A merged folder split | The ID stays with the larger part. |
| Moved **and** re-encoded in one step | **New ID.** The old book stays as missing with its progress. |

## 8. Tables

Additive only. The schema is at V80 (`src/db/schema.js:107`), so this is V81, or the next free number when it merges. It is not `rescanRequired`, and `SCANNER_SCHEMA_CONTRACT` stays at 73: the music scanners neither read nor write these tables.

```sql
-- Catalogue: written by the audiobook scanner only.
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,           -- random, assigned once, never reused
  library_id    INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
  path          TEXT NOT NULL,              -- folder, or the file of a lone-file book; library-relative
  group_key     TEXT NOT NULL DEFAULT '',   -- normalised album tag when a folder holds several books
  title         TEXT NOT NULL,
  sort_title    TEXT NOT NULL,
  subtitle      TEXT,
  year          INTEGER,
  description   TEXT,
  publisher     TEXT,
  language      TEXT,
  genres        TEXT NOT NULL DEFAULT '[]', -- JSON array, display only
  chapters      TEXT,                       -- JSON, on the book timeline; NULL = one chapter per file
  art_file      TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,           -- ms epoch, kept across moves
  updated_at    INTEGER NOT NULL,
  missing_since INTEGER,                    -- ms epoch; NULL while its files are present
  merged_into   TEXT                        -- the book that now holds its files
);
CREATE INDEX IF NOT EXISTS idx_books_place ON books(library_id, path, group_key);

-- One row per audio file of a book: the only record of these files (they have no tracks row).
CREATE TABLE IF NOT EXISTS book_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id       TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,           -- order within the book
  filepath      TEXT    NOT NULL,           -- library-relative, '/'-separated
  file_size     INTEGER NOT NULL,
  modified      INTEGER NOT NULL,           -- mtime, ms epoch; with file_size, the unchanged-file check
  track_hash    TEXT    NOT NULL,           -- audio hash, else file hash (src/db/audio-hash.js)
  hash_v        INTEGER NOT NULL,           -- hashing generation, as tracks.hash_v
  format        TEXT,
  duration_ms   INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,           -- offset on the book timeline
  title         TEXT,                       -- the file's own title tag: a chapter-title fallback
  tags          TEXT,                       -- JSON: the book-level tags read from this file
  chapters      TEXT,                       -- JSON: embedded chapter marks, file-relative; NULL = none
  UNIQUE (book_id, position)
);
CREATE INDEX IF NOT EXISTS idx_book_files_hash ON book_files(track_hash);
CREATE INDEX IF NOT EXISTS idx_book_files_path ON book_files(filepath);

CREATE TABLE IF NOT EXISTS book_people (
  book_id  TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  role     TEXT    NOT NULL,                -- 'author' | 'narrator'
  position INTEGER NOT NULL DEFAULT 0,
  name     TEXT    NOT NULL,
  name_key TEXT    NOT NULL,                -- nameKey(name), for lists and filters
  PRIMARY KEY (book_id, role, name_key)
);
CREATE INDEX IF NOT EXISTS idx_book_people_key ON book_people(role, name_key);

CREATE TABLE IF NOT EXISTS book_series (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  name_key TEXT NOT NULL,
  sequence TEXT,                            -- text: "1", "2.5"
  PRIMARY KEY (book_id, name_key)
);
CREATE INDEX IF NOT EXISTS idx_book_series_key ON book_series(name_key);

-- User state: the scanner never touches it, except to re-key on a merge.
CREATE TABLE IF NOT EXISTS book_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id     INTEGER NOT NULL DEFAULT 0,   -- 0 = this server
  book_id     TEXT    NOT NULL,
  position_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  finished    INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT    NOT NULL,             -- when it was heard, not when it arrived
  client      TEXT,
  snapshot    TEXT,                         -- JSON book summary; required for a peer's book
  deleted     INTEGER NOT NULL DEFAULT 0,   -- tombstone for the feed
  rev         INTEGER NOT NULL,             -- per-user counter: the feed cursor
  PRIMARY KEY (user_id, peer_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_book_progress_feed ON book_progress(user_id, rev);

CREATE TABLE IF NOT EXISTS book_sessions (
  session_id        TEXT PRIMARY KEY,       -- the client's id
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id           INTEGER NOT NULL DEFAULT 0,
  book_id           TEXT    NOT NULL,
  started_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  start_position_ms INTEGER NOT NULL,
  position_ms       INTEGER NOT NULL,
  listened_ms       INTEGER NOT NULL DEFAULT 0,
  client            TEXT
);
CREATE INDEX IF NOT EXISTS idx_book_sessions_user_time ON book_sessions(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_book_sessions_book ON book_sessions(user_id, peer_id, book_id);

CREATE TABLE IF NOT EXISTS book_bookmarks (
  id          TEXT PRIMARY KEY,             -- the client's id
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id     INTEGER NOT NULL DEFAULT 0,
  book_id     TEXT    NOT NULL,
  position_ms INTEGER NOT NULL,
  note        TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_bookmarks_book ON book_bookmarks(user_id, peer_id, book_id);
```

Notes:

- **A book's address is indexed, not unique.** An earlier draft had `UNIQUE (library_id, path, group_key)`. It cannot hold: a missing book keeps its address while a live book takes the same folder (§7.3), and a scan that renumbers folders updates one row to an address the next row has not left yet.
- **`book_files` is everything the server knows about an audiobook file.** These files have no `tracks` row, so the unchanged-file check, the hashes and the per-file chapters all live here. A missing book keeps its rows: they are what matches it when its files return.
- **The state tables have no foreign key to `books`.** A peer's book has no local row, and state has to outlive a missing book. `user_metadata.track_hash` has none to `tracks` for the same reason.
- **`peer_id` is 0, not NULL, for this server**, because NULLs do not collide in a composite primary key. A peer is keyed by `federation_peers.id`, as `play_events.peer_id` is. A peer removed and paired again gets a new id, a limit stats shares.
- **The scanner owns its hashes.** They come from the same function as the music index's, so the values agree, but the music side's re-key machinery (`src/db/hash-migration.js`) never sees them. `hash_v` records the generation, so a later change of hashing scheme re-hashes these files on the scanner's own schedule.
- **Instants in the state tables** are stored the way the stats tables store them (UTC text with milliseconds, `src/stats/time.js`).
- **Lists you filter by are tables; lists you only show are JSON.** People and series get tables; genres and chapters are JSON on the book.

## 9. What changes for an audiobook library

Once a library is scanned by the audiobook scanner, its files are not in `tracks`.

| Area | What happens |
|---|---|
| Music reads: albums, artists, genres, search, recently added, Auto DJ, rated, the sync manifest | Audiobook files are absent. The plan's first version left this as an open decision; the second scanner settles it. |
| Play stats and Last.fm | A play of an audiobook file is answered `unknown-track` (`src/stats/ingest.js:172-173`), so it is never counted or forwarded, and the client's outbox drops it. |
| Waveform, BPM and key, discovery, AcoustID and album-art passes | They work from `tracks`, so they never touch audiobook files. |
| File explorer, `/media/`, `/transcode/`, downloads, playlists, shares | Unchanged. They work from the filesystem or from paths. |
| `db/metadata` for a file | No row, so it answers `metadata: null` (`src/api/db.js:485`): an audiobook file opened from the file explorer shows no tags. |
| DLNA | Decided 2026-11-18: DLNA browsing of books is not in the first version. Every browse query reads `tracks` (`src/api/dlna.js`), so until it is built a renderer shows an audiobook library with a count of 0 and six empty views inside (`:462-484`, `:550-557`, `:1308`). The audiobook item classes DLNA advertises today (`:342-349`, `:528-534`) have nothing to apply to. DLNA is off by default (`src/state/config.js:609`). Whether to hide these libraries from DLNA in the meantime is open (§10). |
| Libraries already typed `audio-books` | Decided 2026-11-18: no upgrade path. The old checkbox had no effect, and no library is marked today. The type can also be set in the config file (`docs/json_config.md:114`). A library that does carry it is scanned as audiobooks from its next scan, which removes its `tracks` rows (§5.4). |

## 10. Open decisions

1. **DLNA before it can browse books.** Browsing books over DLNA is decided: not in the first version (§9). Still open is what DLNA does with an audiobook library until then: list it, empty, or leave it out of the library lists. Recommended: leave it out. An empty library looks like a failed scan, and the filter is small: both DLNA handlers load the library list once (`src/api/dlna.js:1265`, `:1830`).
2. **Changing a library's type.** Audiobook folders already on a server are music libraries. The first version marks a folder only when it is added, so an existing one has to be removed and added again. That drops its per-user access and its backup destinations and restarts the server (`removeDirectory`, `src/util/admin.js:228-293`). A switch on an existing library would avoid that. Recommended: leave the switch for later.
3. **Federation scope.** Recommended: store `peer_id` from the start, ship peer browsing of books after local listening works.
4. **Metadata files.** Which sidecar formats the first version reads. Recommended: cover images and Audiobookshelf's `metadata.json`, once its format is checked (§11).
5. **Purging missing books.** Recommended: never purge a book that has progress or bookmarks; purge the rest after a retention period or on an admin action.
6. **Manual fixes.** Merge, split and edit by hand are not in the first version. They would be an overrides table the scanner applies last. Nothing here blocks it.
7. **Position across a merge.** When two different books are merged into one folder, the smaller one's position does not mean anything on the combined timeline. To settle when building §7.3.
8. **The shelf limit.** Three files per album tag is a judgment, not a measurement (§11).

## 11. Not verified

- **Real files.** The tag test (§5.7) used generated files. Real audiobook files are untested. So are custom tags inside M4B files, and an M4B that carries only one of the two chapter formats.
- **Cost.** A scan of a large library has not been timed, and the in-process read timings from the test were too noisy to use.
- **Layout frequency.** How often each layout in §6.3 occurs in real libraries. The layouts are synthetic. `scripts/audiobook-grouping-preview.mjs` prints how the rules group a real folder (§12, S1), and it has been run on generated files only.
- **Audiobookshelf's `metadata.json` sidecar.** Its format is recalled, not checked.
- **The session-sync and socket sections of the ABS docs**, which the docs page was too large to page through. Nothing in this plan depends on them.

## 12. Build phases

Six pull requests reach the first release that shows the feature. Each leaves master releasable. Nothing is visible to an ordinary user until the last one, which adds the checkbox: a marked folder leaves every music view (§9), so the checkbox waits until the web UI can list books. Nothing changes on upgrade, because no library is marked.

| Phase | Adds | Needs | What a user sees |
|---|---|---|---|
| S1 | The book rules: grouping, file order, matching | n/a | Nothing |
| S2 | The catalogue tables, the scanner and its dispatch | S1 | Nothing in the UI |
| S3 | The catalogue API | S2 | Nothing; API only |
| S4 | The listening-state tables and API, and the capability flag | S3 | Nothing; API only |
| W1 | Web UI: browse, play, resume | S4 | Nothing until a folder is marked |
| A1 | Admin UI: the checkbox and the folder type | W1 | The feature |

S is the server, W the web UI, A the admin UI. Chapters and bookmarks in the web UI (W2) and the Flutter app come after; neither holds the first release.

### S1. Book rules

Written 2026-11-18.

- **Adds:** grouping (§6.1), file order (§6.2) and matching (§7.2) as functions over lists of files and stored books, in `src/db/book-rules.js`. No database and no disk. Nothing imports it yet.
- **Tests:** `test/unit/book-rules.test.mjs`, 97 tests. The 19 layouts (§6.3) and the 15 rescan scenarios (§7.4) are one test per row, on the real `nameKey`. The three grouping misses and the one identity miss are asserted as they are, so changing one later is a deliberate act. The rest covers the edges the two tables leave out. Each rule was also broken on purpose in a scratch copy, 43 ways, and the suite failed every time.
- **Why first:** these rules decide every book ID, and they are the part most likely to change once a real library is scanned.
- **First look at real data:** `node scripts/audiobook-grouping-preview.mjs <folder>` walks a folder, reads each file's album, track and disc tags, and prints the books the rules form. The judgment calls come first: folders kept as one book despite several album tags, untagged folders, folders split into several books, and books that fell back to path order. It writes nothing. It has been run on generated files only (§11).
- **Settled while writing it,** where the plan had not said:
  - Disc folders directly under the library root form one book. Left to the root rule, an untagged book in `CD1` and `CD2` folders became one book per file.
  - Disc folders fold at any depth.
  - Path order is a natural sort written out in the rules, not the runtime's collation (§6.2).
  - Stored books that match a group equally well are taken in a fixed order (§7.2).
  - A book with no file rows is never reported as merged. The prototype pointed such a book at the first live book it found.
  - The `books` table cannot have a unique address (§8).

### S2. Catalogue tables, scanner, dispatch

The largest piece. It can land as two pull requests: the worker with its tests, then the wiring into the queue.

- **Adds:** a migration with `books`, `book_files`, `book_people` and `book_series` (§8); the scanner worker (§5.4); the branch in `runScan` (§5.3).
- **Touches:** `src/db/schema.js`; a new worker beside `src/db/scanner.mjs`; `src/db/task-queue.js`; a new role in `maybeRunWorker` (`src/util/worker-process.js:51-73`), which the Bun standalone build needs and `test/unit/worker-role-parity.test.mjs` enforces.
- **Kept simple in this version:**
  - Every scan of an audiobook library is a full scan. A subtree request from the file watcher or a finished torrent (`src/util/library-watcher.js:151`, `src/torrent/completion-watcher.js:167-170`) runs as a full one. An unchanged file costs a stat and a lookup (§5.4).
  - The passes a music scan queues behind itself (`src/db/task-queue.js:1164-1183`) are not queued. They have nothing to do for these files (§9).
  - Cover images are the only sidecar files read (§10).
- **Tests:** scans of fixtures on disk, generated with the bundled `ffmpeg` as other suites do (`.m4b`, `.mp3` and `.opus` with chapters); rescans after a rename, a move, a retag and a removal; the schema guard; the migration. Path handling differs by OS, so this runs the full CI matrix.
- **Carried over from S1:**
  - `matchBooks` takes the stored books oldest first, each with every hash in its file rows. The stored set is the library's own books plus the missing books of every other library (§7.2).
  - A book moved to another library gets a new ID when that library is scanned before the one it left. The old ID then goes missing with nothing to point at, because the rules look for the book that took its files among one scan's books only. Looking a gone book's hashes up across all libraries closes this.
  - A lone file in a folder is addressed by the folder (§6.1). With no album tag, its title falls back to the folder's name (§5.5), and that folder may be the author's. The file's name may be the better fallback for a book of one file.
- **Gate before S3:** scan a real audiobook library and read the result: the grouping, the chapters, and how long it took (§11).
- **What a user sees:** nothing in the UI. From here on, a library created through the API with `isAudioBooks` is scanned as books.
- **Decision needed:** whether DLNA leaves audiobook libraries out of its lists (§10, item 1). If so, the filter lands here.

### S3. Catalogue API

- **Adds:** the four catalogue routes (§4.4) in a new API module, set up in `src/server.js` beside the stats API (`src/server.js:653`).
- **Covers:** scoping to the caller's libraries, paging, `revision` with ETag and 304, the answer for a merged ID (§7.3), and missing books left out of lists. The routes go into `docs/openapi.yaml`.
- **Left out:** the four federation allowlist lines (§4.1), until peer browsing of books is built (§10, item 3).
- **Tests:** an integration suite beside the other route suites in `test/integration/`.

### S4. Listening state and the flag

- **Adds:** a second migration with `book_progress`, `book_sessions` and `book_bookmarks` (§8); the session ingest, modelled on `src/stats/ingest.js`; the seven state routes (§4.5 to §4.7); re-keying of state when the scanner records a merge (§7.3).
- **The flag goes in last.** `features.audiobooks: 1` is added with the final route, in `buildFeatures()` and in the ping answer, and the test that keeps the two in step is updated (`test/integration/api-server-info.test.mjs`). A client that sees the flag can rely on all 11 routes.
- **Tests:** unit tests for the ingest rules (a session that grows, a resend, older listening that arrives late, a time in the future) and an integration suite for the routes, including the refusal of a federation key.
- **Decision needed:** what happens to a position when two books are merged (§10, item 7).

### W1. Web UI: browse, play, resume

- **Adds:** an Audiobooks entry in the sidebar; a book grid, with author and series views; a book page; play and resume; a "Continue listening" row; marking a book finished or hidden.
- **Hidden by default.** The entry appears only when the server sets the flag and the user has a library of type `audio-books`. The ping answer the web UI reads at start already carries each library's type (`src/api/server-info.js:262-271`), and the stats entry is revealed from the same answer (`webapp/alpha/m.js:822`).
- **How it plays:** the book's files are queued by path with the metadata the API returned, and the player seeks to the saved position. Both exist today (`addSongWizard`, `MSTREAMPLAYER.seek`). A listening session is posted about once a minute and on pause (§4.8). It is fed by the player signals the play session already uses (`webapp/assets/js/mstream.play-session.js`). Plays are not reported for book files, because the stats API would refuse them (§9).
- **Touches:** `webapp/alpha/` for the views, `webapp/assets/js/` for the player, and all 12 locale files.
- **Tests:** the timeline arithmetic (position to file and offset, the current chapter, time listened) goes in a module with no DOM and is unit-tested on node, as `webapp/stats/stats-view.js` is. The rest is checked in a browser against a real library.

### A1. Admin UI: the checkbox

- **Adds:** the checkbox on the add-folder form (`webapp/admin/index.js:977-982`) and the library's type in the folder list (`webapp/admin/index.js:822-825`). The label drops "Podcasts" in all 12 locale files.
- **Also:** the config doc (`docs/json_config.md`) and the release note.
- **What a user sees:** the feature. This is the release that announces it.

### After the first release

- **W2. Web UI: chapters and bookmarks.** The chapter list with jump-to-chapter, the current chapter in the player, and bookmarks. Speed control exists already (`changePlaybackRate`, and the "Audio Book Controls" layout).
- **The Flutter app.** Its own plan in its own repository, once S4 is merged. A likely split is browse, play and resume online; then a session outbox beside `PlaySync`, so offline listening syncs; then downloads of whole books. That split is a guess: this plan read the app's code for the play outbox only.
- **Later, in no fixed order:** DLNA browsing of books (§9); peer browsing of books over federation (§4.9); the Audiobookshelf importer (§2); `metadata.json` sidecars, once the format is checked (§11); a type switch on an existing library (§10); manual merge, split and edit (§10); purging missing books (§10).

### Not planned yet

- The screens for W1 and W2. Nothing is designed.
- The Flutter app's own plan.
