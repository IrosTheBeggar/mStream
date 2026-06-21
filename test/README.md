# Tests

The suite runs on the built-in [Node test runner](https://nodejs.org/api/test.html)
(`node:test`). `npm test` discovers every `test/**/*.test.mjs` file via a glob —
there is no hand-maintained file list, so a new test runs as soon as it lands in
one of the folders below.

## Layout

Tests are grouped by subsystem. Pick the folder that matches what you're testing:

| Folder           | What lives here                                                        |
| ---------------- | --------------------------------------------------------------------- |
| `unit/`          | Pure / in-process module tests — no server boot (e.g. `parse-size`).   |
| `db/`            | Schema, migrations and FTS5 (direct `node:sqlite`, no server).         |
| `scanner/`       | Scanner invocation, parity (JS vs Rust), waveform, provenance.         |
| `subsonic/`      | The Subsonic API surface (boots a server).                            |
| `torrent/`       | Torrent subsystem — unit helpers through to the admin routes.          |
| `integration/`   | Everything else that boots a full mStream server or spans subsystems.  |

Non-test support code lives alongside but is **not** picked up by the runner
(it doesn't match `*.test.mjs`):

| Folder        | What lives here                                                          |
| ------------- | ----------------------------------------------------------------------- |
| `helpers/`    | Shared harness: server spawner, fixtures, scanner runner, DB snapshot…   |
| `fixtures/`   | Generated media library (built lazily by ffmpeg, gitignored).            |
| `smoke/`      | Manual live-daemon smoke harnesses (`test:smoke:*`) — see [smoke/README.md](smoke/README.md). |
| `cli-audio/`  | Manual Docker harness for the mpv/vlc/mplayer/mpd adapters (`test:cli-audio`).           |

## Running

```bash
npm test               # everything
npm run test:unit      # one folder — also: test:db, test:scanner,
                       # test:torrent, test:subsonic, test:integration
npm run test:dlna      # a single file
node --test "test/db/**/*.test.mjs"   # ad-hoc glob
node --test --watch "test/unit/**/*.test.mjs"
```

`npm test` first runs a `pretest` check ([helpers/ensure-prereqs.mjs](helpers/ensure-prereqs.mjs))
that pre-builds the fixture library once and fails fast with a clear message when
a prerequisite is missing — rather than a cryptic error deep into the run.

`unit/` and `db/` need nothing but Node. The `scanner/`, `subsonic/` and
`integration/` folders boot a server and/or generate fixtures, so they need:

- **ffmpeg** at `bin/ffmpeg/` — used to synthesize the fixture library. A fresh
  git worktree won't have it; copy `bin/ffmpeg/` from your main checkout.
- **rust-parser** (optional) at `bin/rust-parser/` or `rust-parser/target/release/`.
  Scanner-parity tests skip cleanly when it's absent and fall back to the JS scanner.

## Manual harnesses (opt-in)

These exercise real external systems, so they're **not** part of `npm test` —
run them deliberately:

```bash
npm run test:cli-audio      # mpv/vlc/mplayer/mpd adapter routing, inside Docker
npm run test:smoke:docker   # mStream + torrent daemons, all in Docker
npm run test:smoke:windows  # native-Windows Transmission / qBittorrent
```

`test:cli-audio` is self-contained (it builds its own image). The two
`test:smoke:*` harnesses need their daemons brought up first — see
[smoke/README.md](smoke/README.md).
