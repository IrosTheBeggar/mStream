use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rayon::prelude::*;

use md5::{Digest, Md5};

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::FileType;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue};
use lofty::picture::MimeType;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use walkdir::WalkDir;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// Number of bars in a waveform — matches NUM_BARS in src/db/waveform-lib.js.
// Cache files are exactly this many bytes (one u8 per bar).
const NUM_BARS: usize = 800;

// ── Config (matches what task-queue.js passes) ──────────────────────────────

#[derive(Deserialize)]
struct ScanConfig {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "libraryId")]
    library_id: i64,
    #[serde(default)]
    vpath: String,
    directory: String,
    #[serde(rename = "skipImg")]
    skip_img: bool,
    #[serde(rename = "albumArtDirectory")]
    album_art_directory: String,
    #[serde(rename = "scanId")]
    scan_id: String,
    #[serde(rename = "compressImage")]
    compress_image: bool,
    #[serde(rename = "supportedFiles")]
    supported_files: HashMap<String, bool>,
    #[serde(rename = "scanCommitInterval", default = "default_commit_interval")]
    scan_commit_interval: u64,
    #[serde(rename = "forceRescan", default)]
    force_rescan: bool,
    #[serde(rename = "waveformCacheDir", default)]
    waveform_cache_dir: String,
    // Number of worker threads for parallel file extraction (Phase 2).
    // 0 (the default) means "auto" — resolved at scan start to half
    // the available parallelism so a scan running alongside the live
    // server doesn't starve other CPU work. 1 keeps the single-
    // threaded loop verbatim for users who want bit-for-bit legacy
    // behaviour or are running on tiny VPSes. Values > available
    // parallelism are capped by rayon at the OS level — no fence
    // needed here.
    #[serde(rename = "scanThreads", default)]
    scan_threads: usize,
    // Per-library flag from the libraries row (V21). When true,
    // the walker follows symlinks inside the library. When false
    // (default), symlinks are treated as opaque entries and skipped.
    // Default matches the legacy Rust behaviour (walkdir's
    // follow_links flag defaults to false); the JS scanner's default
    // changed to match in this release.
    #[serde(rename = "followSymlinks", default)]
    follow_symlinks: bool,
    // Enable BPM + musical-key detection via stratum-dsp during the
    // existing symphonia decode pass. Default true; users on
    // memory-constrained hosts (small NAS boxes) can flip to false
    // in config.json. Skip gates inside extract_track also drop
    // analysis for tag-sourced tracks, audiobook genres, and tracks
    // outside the [30s, 30min] duration window. See
    // scanOptions.analyzeBpm in src/state/config.js.
    #[serde(rename = "analyzeBpm", default = "default_true")]
    analyze_bpm: bool,
}

fn default_commit_interval() -> u64 { 25 }
fn default_true() -> bool { true }

// Snapshot of a row in the `tracks` table, pre-fetched in bulk at scan
// start so the per-file fast-path check doesn't hit SQLite. For a
// library that hasn't changed since the last scan, this cuts N
// `SELECT … WHERE filepath = ? AND library_id = ?` queries down to one
// `SELECT … WHERE library_id = ?` upfront.
#[derive(Clone)]
struct ExistingTrack {
    id: i64,
    modified: i64,
    file_hash: Option<String>,
    audio_hash: Option<String>,
    album_id: Option<i64>,
    lyrics_sidecar_mtime: Option<i64>,
}

// Extract → Commit handoff. Workers (extract_track) own the I/O- and
// CPU-heavy stages: file read, lofty tag parse, MD5 hashes, symphonia
// waveform decode, album-art / waveform .bin file writes. The writer
// thread (commit_track) owns the SQLite Connection and resolves the
// artist/album/genre IDs, INSERTs the tracks row, populates M2M
// tables, and runs the migrations.
//
// In Phase 1 (this commit) the call is still serial: process_one
// invokes extract_track immediately followed by commit_track on the
// main thread. Phase 2 swaps in a worker pool that calls extract_track
// in parallel and pushes ExtractedTrack values across an mpsc channel
// to a single writer thread that calls commit_track. Splitting now
// makes the data-flow boundary explicit and lets the determinism
// test (test/scanner-parity.test.mjs) lock the behaviour in before
// any concurrency lands.
#[derive(Debug)]
struct ExtractedTrack {
    rel_path: String,
    mod_time: i64,
    ext: String,

    file_hash: String,
    audio_hash: Option<String>,

    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<i64>,
    track_num: Option<i64>,
    disc_num: Option<i64>,
    genre: Option<String>,
    rg_track_db: Option<f64>,
    duration_sec: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    bit_depth: Option<i64>,

    album_artist_tag: Option<String>,
    album_artists: Vec<String>,
    track_artists: Vec<String>,
    is_compilation: bool,

    lyrics_embedded: Option<String>,
    lyrics_synced_lrc: Option<String>,
    lyrics_lang: Option<String>,
    current_sidecar_mtime: Option<i64>,

    // V32: BPM (range-validated 20..=300) + musical key (trimmed, capped
    // at 12 chars). Sourced from embedded tags only — Lofty's
    // ItemKey::Bpm / ItemKey::InitialKey, which cover TBPM / Vorbis BPM
    // / MP4 tmpo and TKEY / INITIALKEY respectively. The JS scanner
    // mirrors this via music-metadata's common.bpm / common.key.
    bpm: Option<i64>,
    musical_key: Option<String>,
    bpm_source: Option<&'static str>,

    // V36: provenance label from embedded tags. NULL when no recognised
    // marker is present. See detect_source_from_tag().
    source: Option<String>,

    aa_file: Option<String>,

    // Captured from the prior tracks row (when one existed) so the
    // writer can run user_*-row + album-stars migrations after the
    // INSERT OR REPLACE swaps the canonical identity.
    old_hash: Option<String>,
    old_audio_hash: Option<String>,
    old_album_id: Option<i64>,
}

enum ExtractResult {
    // The fast-path: file mtime matched and no sidecar drift, so the
    // existing tracks row only needs its scan_id bumped. Carries the
    // row id so the writer can issue a one-shot UPDATE without
    // re-querying.
    Unchanged { existing_id: i64 },
    // New / modified file: full extraction succeeded. Boxed because
    // the struct is large (~500 bytes with strings) and we want the
    // enum discriminant to stay cheap in the common-case channel
    // payload the writer thread drains.
    Extracted(Box<ExtractedTrack>),
}

// Phase 2: payload sent from each worker to the single writer thread.
// `rel_path_progress` is the forward-slash-normalised path used for
// the scan_progress.current_file column — pre-computed in the worker
// so the writer's commit-interval branch doesn't have to reach back
// into the entry.
struct WorkerMessage {
    rel_path_progress: String,
    // Worker errors are stringified at the channel boundary because
    // Box<dyn std::error::Error> isn't Send. The string is used only
    // for the eprintln warning; nothing inspects its structure.
    result: Result<ExtractResult, String>,
}

// Resolve the user-configured scanThreads value into an actual
// worker count.
//
// configured == 0 → auto: clamp(cores/2, 1, AUTO_MAX_THREADS).
//   Half-of-cores leaves headroom for the live server during a long
//   initial scan. The upper cap exists because the workers feed a
//   single writer thread (SQLite is single-writer in WAL mode), so
//   past ~8 decode workers the extra threads mostly idle on a full
//   channel — paying the OS scheduler cost without proportional
//   throughput gain. The cap also bounds peak memory: each worker
//   can hold up to MAX_BUFFERED_FILE (256 MB) bytes, so 8 workers ×
//   256 MB ≈ 2 GB worst-case live, well within a typical server's
//   RAM budget.
//
// configured > 0 → use as-is, no upper bound. An operator with a
//   monster box and a maintenance window who wants the scan to rip
//   can set scanThreads=32 and live with the memory peak. Footgun
//   territory, but explicit.
//
// available_parallelism honours Linux cgroup CPU quotas, so a 4-core
// container running on a 32-core host gets 2 workers, not 16.
const AUTO_MAX_THREADS: usize = 8;
fn resolve_scan_threads(configured: usize) -> usize {
    if configured > 0 { return configured; }
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(1, AUTO_MAX_THREADS))
        .unwrap_or(1)
}

// Process-wide unique sequence used by `write_atomic` to give each
// worker its own temp filename. The atomic write pattern (write to
// `<file>.tmp.<N>`, fsync rename to `<file>`) is race-safe even
// when multiple workers target the same final path — which happens
// any time two tracks share a content hash (e.g., every track in an
// album with embedded cover art shares the same art-file hash).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// Write `data` to `path` atomically: stage in a unique temp file,
// then rename to the target. Multiple workers writing the same
// target produce correct content with no race window where a reader
// could see a 0-byte or partially-written file.
//
// Why this matters under parallelism: `fs::write` opens with O_TRUNC
// + writes + closes. Two workers racing on the same path can leave
// the file at length 0 between one's truncate and the other's write,
// which is observable by any concurrent reader (e.g., the live
// album-art / waveform endpoints serving the file mid-scan).
//
// Returns Some(()) on success; None on any I/O error (the temp file
// is best-effort cleaned up on failure).
fn write_atomic(path: &Path, data: &[u8]) -> Option<()> {
    let parent = path.parent()?;
    let file_name = path.file_name()?.to_str()?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!("{}.tmp.{}", file_name, seq));
    if fs::write(&tmp_path, data).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return None;
    }
    if fs::rename(&tmp_path, path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return None;
    }
    Some(())
}

fn load_existing_tracks(
    conn: &Connection, library_id: i64,
) -> Result<HashMap<String, ExistingTrack>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT filepath, id, modified, file_hash, audio_hash, album_id, lyrics_sidecar_mtime
           FROM tracks
          WHERE library_id = ?",
    )?;
    let rows = stmt.query_map([library_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ExistingTrack {
                id: row.get(1)?,
                modified: row.get(2)?,
                file_hash: row.get::<_, Option<String>>(3)?,
                audio_hash: row.get::<_, Option<String>>(4)?,
                album_id: row.get::<_, Option<i64>>(5)?,
                lyrics_sidecar_mtime: row.get::<_, Option<i64>>(6)?,
            },
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (path, track) = row?;
        map.insert(path, track);
    }
    Ok(map)
}

// ── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Hidden developer/test subcommand that uses the buffered scan path
    // (whole file into RAM → md5 from slice). Exercises the same
    // `compute_hashes_from_bytes` the scanner uses, so a side-by-side
    // diff vs. `--audio-hash` below proves the streaming and buffered
    // paths are byte-identical.
    if args.len() == 3 && args[1] == "--audio-hash-buffered" {
        let p = Path::new(&args[2]);
        let ext = file_ext(p).to_lowercase();
        match fs::read(p) {
            Ok(bytes) => {
                let (fh, ah) = compute_hashes_from_bytes(&bytes, &ext);
                let ah_json = match ah {
                    Some(s) => format!("\"{}\"", s),
                    None => "null".to_string(),
                };
                println!("{{\"fileHash\":\"{}\",\"audioHash\":{},\"format\":\"{}\"}}", fh, ah_json, ext);
                return;
            }
            Err(e) => { eprintln!("read failed: {}", e); std::process::exit(2); }
        }
    }

    // Hidden developer/test subcommand: `rust-parser --audio-hash <path>`
    // prints the dual-hash result as JSON on stdout and exits. Used by
    // test/audio-hash-parity.test.mjs to compare against the JS impl.
    if args.len() == 3 && args[1] == "--audio-hash" {
        let p = Path::new(&args[2]);
        let ext = file_ext(p).to_lowercase();
        match compute_hashes(p, &ext) {
            Ok((fh, ah)) => {
                // Null-safe JSON serialization without pulling in serde for a
                // one-line output: quote strings, use "null" for None.
                let ah_json = match ah {
                    Some(s) => format!("\"{}\"", s),
                    None => "null".to_string(),
                };
                println!("{{\"fileHash\":\"{}\",\"audioHash\":{},\"format\":\"{}\"}}", fh, ah_json, ext);
                return;
            }
            Err(e) => {
                eprintln!("compute_hashes failed: {}", e);
                std::process::exit(2);
            }
        }
    }

    // Hidden developer/test subcommand: `rust-parser --extract-lyrics <path>`
    // prints the four lyrics column values as JSON on stdout. Used by
    // test/lyrics-parity.test.mjs to confirm the JS extractor
    // (src/db/lyrics-extraction.js) and the Rust extractor below
    // produce byte-identical results for the same input. Any drift
    // means a track scanned by one scanner looks different from a
    // track scanned by the other — silent divergence on libraries
    // that mix-and-match (dev + prebuilt binary, different versions).
    if args.len() == 3 && args[1] == "--extract-lyrics" {
        let p = Path::new(&args[2]);
        match extract_lyrics_for_cli(p) {
            Ok((embedded, synced, lang, sidecar_mtime)) => {
                // Manual JSON serialisation (same reason as --audio-hash:
                // one-line output, no serde dance). All four fields emit
                // as `null` when absent so the consumer can JSON.parse
                // and compare with ===.
                let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"")
                    .replace('\n', "\\n").replace('\r', "\\r");
                let j = |v: &Option<String>| match v {
                    Some(s) => format!("\"{}\"", esc(s)),
                    None    => "null".to_string(),
                };
                let mtime_json = match sidecar_mtime {
                    Some(n) => format!("{}", n),
                    None    => "null".to_string(),
                };
                println!("{{\"lyricsEmbedded\":{},\"lyricsSyncedLrc\":{},\"lyricsLang\":{},\"lyricsSidecarMtime\":{}}}",
                    j(&embedded), j(&synced), j(&lang), mtime_json);
                return;
            }
            Err(e) => {
                eprintln!("extract_lyrics failed: {}", e);
                std::process::exit(2);
            }
        }
    }

    // Hidden developer/test subcommand: `rust-parser --waveform <path>`
    // prints `{"bars":"<hex of 800 bytes>"}` on success or `{"bars":null}`
    // when no waveform can be produced (e.g. .opus, where symphonia 0.5
    // has no decoder). Used by test/waveform.test.mjs to exercise the
    // decoder across every supported format without standing up a full
    // scan's worth of DB scaffolding.
    if args.len() == 3 && args[1] == "--waveform" {
        let p = Path::new(&args[2]);
        let ext = file_ext(p).to_lowercase();
        match waveform_from_symphonia(p, &ext, false) {
            Some(output) => {
                // Hex instead of base64: trivial to produce without extra
                // crates, trivial for the JS test to decode, fixed-length
                // 1600 chars so a bug that truncates or pads shows up
                // immediately.
                let mut hex = String::with_capacity(NUM_BARS * 2);
                for b in output.bars.iter() { hex.push_str(&format!("{:02x}", b)); }
                println!("{{\"bars\":\"{}\"}}", hex);
            }
            None => {
                println!("{{\"bars\":null}}");
            }
        }
        return;
    }

    let json_str = match args.last() {
        Some(s) if args.len() > 1 => s.clone(),
        _ => {
            eprintln!("Warning: failed to parse JSON input");
            std::process::exit(1);
        }
    };

    let config: ScanConfig = match serde_json::from_str(&json_str) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Invalid JSON Input: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = run_scan(&config) {
        eprintln!("Scan Failed\n{}", e);
        std::process::exit(1);
    }
}

// Per-chunk row cap for the end-of-scan orphan cleanup. Each
// chunked_orphan_delete iteration runs as its own autocommit DELETE,
// releasing the writer lock between batches so concurrent API writes
// from the main mStream server (scrobble, star, play event) don't hit
// busy_timeout. 500 is a balance between per-chunk lock duration (well
// under SQLite's 5s busy_timeout) and per-iteration overhead (each
// iteration re-runs the candidate-id subselect, which is the slow
// part on big libraries).
const ORPHAN_CHUNK_SIZE: usize = 500;

// Repeatedly DELETE up to ORPHAN_CHUNK_SIZE rows from `table` whose
// ids match `select_ids_sql`, until no rows remain. SQLite's bundled
// build doesn't ship with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so the
// LIMIT goes on a subselect rather than the DELETE itself.
//
// Loop terminates when a chunk reports zero changes, which means the
// candidate query found no more orphans. On a small library this is
// a single DELETE that handles everything plus one trivial no-op
// confirmation; on a large one it's many small DELETEs that cooperate
// with concurrent writers instead of starving them.
fn chunked_orphan_delete(
    conn: &Connection, table: &str, select_ids_sql: &str,
) -> rusqlite::Result<()> {
    let sql = format!(
        "DELETE FROM {} WHERE id IN ({} LIMIT {})",
        table, select_ids_sql, ORPHAN_CHUNK_SIZE,
    );
    let mut stmt = conn.prepare(&sql)?;
    loop {
        let changes = stmt.execute([])?;
        if changes == 0 { break; }
    }
    Ok(())
}

// ── Main scan ───────────────────────────────────────────────────────────────

fn run_scan(config: &ScanConfig) -> Result<(), Box<dyn std::error::Error>> {
    // Fail fast if the library root isn't accessible. Without this check,
    // `WalkDir` yields zero entries on a missing mount — main-loop runs
    // over an empty set — the final `DELETE FROM tracks WHERE scan_id != ?`
    // then wipes *every* track for this library, cascading through
    // albums / artists / user_album_stars. A transient CIFS or NFS outage
    // would silently erase the DB. Erroring out before any DB writes is
    // safer than trying to reason about partial-processed states.
    if !Path::new(&config.directory).is_dir() {
        return Err(format!(
            "library directory not accessible: {}", config.directory
        ).into());
    }

    let conn = Connection::open(&config.db_path)?;
    // Wait up to 5s when another connection holds the write lock (e.g. the
    // main server's shared-playlist cleanup or any API-triggered write).
    // Without this, the scanner fails immediately with "database is locked".
    // V31 AFTER triggers on tracks/artists/albums maintain the FTS5
    // index. Not strictly required for V31's design, but set on as
    // defence-in-depth to match src/db/manager.js initDB() and
    // src/db/scanner.mjs. Cheap.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA recursive_triggers = ON;")?;
    // Keep every prepared SELECT/INSERT/UPDATE/DELETE used by process_one
    // in the statement cache. Hot loop does ~15 distinct statements per
    // changed file; the default (16) just barely fits, so bump headroom
    // so cache churn doesn't re-compile SQL on every track.
    conn.set_prepared_statement_cache_capacity(64);

    let dir_art_cache: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());
    // Per-directory filename listing cache. Avoids N×22 `fs::metadata`
    // calls per scan when probing lyrics sidecars (every audio file
    // otherwise probes 21 `<base>.<lang>.lrc` candidates + `<base>.txt`
    // via stat, which on a remote CIFS mount costs one round-trip each).
    // One `read_dir` per directory at first touch, cached thereafter.
    let dir_file_cache: Mutex<HashMap<PathBuf, DirListing>> = Mutex::new(HashMap::new());

    // Pre-scan the waveform cache directory once up front, keeping an
    // in-memory set of `<hash>.bin` filenames. The per-track existence
    // check then becomes a HashSet probe instead of `fs::metadata` —
    // saves one stat per track on every scan when waveforms are
    // enabled (local disk or network-mount for the cache dir).
    let waveform_cache_names: Mutex<HashSet<String>> = Mutex::new(
        if config.waveform_cache_dir.is_empty() {
            HashSet::new()
        } else {
            load_waveform_cache_names(Path::new(&config.waveform_cache_dir))
        }
    );

    // Bulk-prefetch every tracks row for this library into memory. The
    // per-file fast-path then lives off this HashMap instead of issuing
    // one `SELECT … WHERE filepath = ?` per entry — on a 3400-file
    // library that's 3400 round trips collapsed into one query.
    let existing_tracks = load_existing_tracks(&conn, config.library_id)?;

    // Per-scan name→id memoisation. `find_or_create_artist` in
    // particular runs 2-4× per changed file (primary + featured +
    // album-artist + M2M) and almost always resolves to a small set of
    // repeat values, so caching collapses thousands of SELECTs into
    // a handful. Albums key on (name, artist_id, year) because the
    // same album name under a different artist is a different row.
    // Genres are keyed by name alone.
    let artist_cache: Mutex<HashMap<String, i64>> = Mutex::new(HashMap::new());
    let album_cache: Mutex<HashMap<(String, Option<i64>, Option<i64>), i64>> = Mutex::new(HashMap::new());
    let genre_cache: Mutex<HashMap<String, i64>> = Mutex::new(HashMap::new());
    // Cached id for the seeded "Various Artists" row, resolved on
    // first compilation track. -1 stored after a negative lookup so we
    // don't re-query for every compilation file on libraries that
    // never seeded the row.
    let various_artists_id: Mutex<Option<i64>> = Mutex::new(None);

    println!("Scanning {}...", config.directory);

    let entries: Vec<walkdir::DirEntry> = WalkDir::new(&config.directory)
        .follow_links(config.follow_symlinks)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .collect();

    // Count expected audio files for progress reporting. File extensions
    // are ASCII by convention; `to_ascii_lowercase` skips the Unicode
    // mapping table that `to_lowercase` applies.
    let expected_files: u64 = entries.iter()
        .filter(|e| {
            let ext = file_ext(e.path()).to_ascii_lowercase();
            config.supported_files.get(&ext).copied().unwrap_or(false)
        })
        .count() as u64;

    // Insert initial progress row
    let _ = conn.execute(
        "INSERT OR REPLACE INTO scan_progress (scan_id, library_id, vpath, scanned, expected) VALUES (?1, ?2, ?3, 0, ?4)",
        rusqlite::params![config.scan_id, config.library_id, config.vpath, expected_files],
    );

    let mut file_count = 0u64;      // new/modified files parsed
    let mut total_processed = 0u64; // all files touched (including unchanged — for progress)
    // Commit cadence: doubles as progress-update cadence and write-lock release.
    // Lower = more responsive API writes during scans but more COMMIT/BEGIN overhead.
    // Admin-configurable via scanCommitInterval; default (25) is a balanced starting point.
    // Clamp to ≥1 because the modulo below panics on zero, and 0 would mean
    // "never commit mid-scan" which breaks progress reporting. The JS side's
    // Joi schema already enforces min(1), but defence-in-depth for direct
    // invocations of the binary.
    let commit_interval = config.scan_commit_interval.max(1);

    // Resolve worker count once, log it for visibility in scanner output.
    // Goes to stdout (not stderr) so task-queue.js's handleStderrLine
    // doesn't treat it as a real error — anything on stderr without a
    // "Warning:" prefix gets logged at ERROR level. Stdout informational
    // lines flow through handleScannerLine and get logged at INFO,
    // matching the existing "Scanning ..." print just above.
    let n_workers = resolve_scan_threads(config.scan_threads);
    println!("Scanner using {} worker thread(s)", n_workers);

    // Use explicit transactions for batch performance.
    // Without this, SQLite does a disk fsync per INSERT (~50 files/sec).
    // With transactions, it batches fsyncs (~5000+ files/sec).
    // `execute_batch` parses & validates every statement in the string;
    // for a one-liner we can skip that overhead by going through the
    // lighter `execute` path.
    conn.execute("BEGIN", [])?;

    if n_workers <= 1 {
        // ── Serial path ──────────────────────────────────────────────
        // Identical to the pre-Phase-2 main loop; kept verbatim so users
        // who pin scanThreads=1 (or run on single-core hosts) get
        // bit-for-bit legacy behaviour. Test suite relies on this for
        // the serial-vs-parallel parity check.
        for entry in &entries {
            let ext = file_ext(entry.path()).to_ascii_lowercase();
            if !config.supported_files.get(&ext).copied().unwrap_or(false) {
                continue;
            }

            match process_one(
                entry, &ext, config, &conn,
                &dir_art_cache, &dir_file_cache,
                &waveform_cache_names, &existing_tracks,
                &artist_cache, &album_cache, &genre_cache, &various_artists_id,
            ) {
                Ok(true)  => { file_count += 1; }
                Ok(false) => {} // skipped (unchanged)
                Err(e) => {
                    eprintln!("Warning: failed to process {}: {}", entry.path().display(), e);
                }
            }

            total_processed += 1;

            if total_processed % commit_interval == 0 {
                let rel_cow = entry.path().strip_prefix(&config.directory)
                    .map(|p| p.to_string_lossy())
                    .unwrap_or_default();
                let rel: String = if rel_cow.contains('\\') {
                    rel_cow.replace('\\', "/")
                } else {
                    rel_cow.into_owned()
                };
                conn.execute("COMMIT", [])?;
                let _ = conn.execute(
                    "UPDATE scan_progress SET scanned = ?1, current_file = ?2 WHERE scan_id = ?3",
                    rusqlite::params![total_processed, rel, config.scan_id],
                );
                conn.execute("BEGIN", [])?;
            }
        }
    } else {
        // ── Parallel path ────────────────────────────────────────────
        // Workers (rayon pool, n_workers threads) call extract_track
        // concurrently and pipe ExtractResult values across a bounded
        // mpsc channel to the writer thread (this thread). The writer
        // owns the SQLite Connection and drains every result through
        // commit_track / scan_id UPDATE.
        //
        // Bounded channel caps memory: workers can run at most 2×N
        // files ahead of the writer. With the in-process buffer cap
        // of 256 MB per file (see extract_track), the worst-case live
        // memory is N × 2 × 256 MB. Operators concerned about this on
        // small VPSes should lower scanThreads.
        //
        // Why std::thread::scope (not rayon::scope): the writer body
        // captures `&conn` (Connection is !Sync, so &Connection is
        // !Send). rayon::scope's outer closure must be Send; std's
        // scope places no such requirement on the outer closure, only
        // on per-`s.spawn` task closures.
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(n_workers)
            .build()?;
        let (tx, rx) = std::sync::mpsc::sync_channel::<WorkerMessage>(n_workers * 2);
        // When the writer hits an unrecoverable COMMIT failure we set
        // this to true so workers short-circuit instead of producing
        // more work that will get discarded.
        let stop = AtomicBool::new(false);

        let writer_err: Option<Box<dyn std::error::Error>> = std::thread::scope(|s| {
            // Capture-by-reference helpers for the worker closure (must
            // all be Send + Sync for the spawned task).
            let entries_ref          = &entries;
            let config_ref           = config;
            let dir_art_cache_ref    = &dir_art_cache;
            let dir_file_cache_ref   = &dir_file_cache;
            let waveform_names_ref   = &waveform_cache_names;
            let existing_ref         = &existing_tracks;
            let stop_ref             = &stop;
            let pool_ref             = &pool;
            let tx_workers           = tx.clone();

            s.spawn(move || {
                pool_ref.install(|| {
                    entries_ref.par_iter().for_each_with(tx_workers, |tx, entry| {
                        if stop_ref.load(Ordering::Relaxed) { return; }
                        let ext = file_ext(entry.path()).to_ascii_lowercase();
                        if !config_ref.supported_files.get(&ext).copied().unwrap_or(false) {
                            return;
                        }
                        // Pre-compute the progress path here so the
                        // writer doesn't have to call strip_prefix
                        // for every commit-interval boundary.
                        let rel_cow = entry.path().strip_prefix(&config_ref.directory)
                            .map(|p| p.to_string_lossy())
                            .unwrap_or_default();
                        let rel_path_progress: String = if rel_cow.contains('\\') {
                            rel_cow.replace('\\', "/")
                        } else {
                            rel_cow.into_owned()
                        };

                        let result = extract_track(
                            entry, &ext, config_ref,
                            dir_art_cache_ref, dir_file_cache_ref,
                            waveform_names_ref, existing_ref,
                        ).map_err(|e| e.to_string());

                        // Best-effort send — if the writer disconnected
                        // (set `stop` and stopped draining), let it drop.
                        let _ = tx.send(WorkerMessage { rel_path_progress, result });
                    });
                });
                // tx_workers drops when the spawned closure returns.
            });
            // Drop the original tx so the channel closes once the
            // worker thread finishes its `for_each_with`. Without this
            // the writer's `for msg in rx` loop never terminates.
            drop(tx);

            // ── Writer loop (this thread) ───────────────────────────
            let mut err: Option<Box<dyn std::error::Error>> = None;
            for msg in rx {
                if err.is_some() {
                    // Already failed mid-scan; keep draining so workers
                    // unblock at the bounded channel send. No further
                    // DB writes — those would just fail again.
                    continue;
                }

                match msg.result {
                    Ok(ExtractResult::Unchanged { existing_id }) => {
                        // Same hot-path UPDATE as the serial fast-path.
                        match conn
                            .prepare_cached("UPDATE tracks SET scan_id = ? WHERE id = ?")
                            .and_then(|mut stmt| stmt.execute(rusqlite::params![config.scan_id, existing_id]))
                        {
                            Ok(_) => {}
                            Err(e) => eprintln!(
                                "Warning: scan_id update failed for {}: {}",
                                msg.rel_path_progress, e
                            ),
                        }
                    }
                    Ok(ExtractResult::Extracted(et)) => {
                        match commit_track(
                            &conn, config, &et,
                            &artist_cache, &album_cache, &genre_cache, &various_artists_id,
                        ) {
                            Ok(()) => { file_count += 1; }
                            Err(e) => eprintln!(
                                "Warning: failed to commit {}: {}",
                                msg.rel_path_progress, e
                            ),
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "Warning: failed to process {}: {}",
                            msg.rel_path_progress, e
                        );
                    }
                }

                total_processed += 1;

                if total_processed % commit_interval == 0 {
                    if let Err(e) = conn.execute("COMMIT", []) {
                        err = Some(Box::new(e));
                        stop.store(true, Ordering::Relaxed);
                        continue;
                    }
                    let _ = conn.execute(
                        "UPDATE scan_progress SET scanned = ?1, current_file = ?2 WHERE scan_id = ?3",
                        rusqlite::params![total_processed, msg.rel_path_progress, config.scan_id],
                    );
                    if let Err(e) = conn.execute("BEGIN", []) {
                        err = Some(Box::new(e));
                        stop.store(true, Ordering::Relaxed);
                    }
                }
            }
            err
        });

        if let Some(e) = writer_err {
            // Best-effort: try to commit the in-flight transaction so
            // any successful work before the failure persists.
            let _ = conn.execute("COMMIT", []);
            return Err(e);
        }
    }

    conn.execute("COMMIT", [])?;

    // Remove progress row — scan is done
    let _ = conn.execute("DELETE FROM scan_progress WHERE scan_id = ?1", rusqlite::params![config.scan_id]);

    // Belt-and-suspenders: if the walk yielded zero files but the library
    // had tracks before this scan, the mount probably went away after the
    // initial is_dir() check above succeeded. Legitimately emptying a
    // populated library ends up here too — we distinguish by re-checking
    // the directory. Still accessible → user emptied it, proceed with
    // cleanup. Gone → skip cleanup, leave user data alone, let the next
    // scan with a working mount converge.
    if total_processed == 0 && !existing_tracks.is_empty()
        && !Path::new(&config.directory).is_dir()
    {
        eprintln!(
            "Warning: scan processed 0 files and directory is no longer accessible ({}). \
             Library had {} tracks — skipping cleanup to avoid data loss.",
            config.directory, existing_tracks.len(),
        );
        println!(
            "{{\"event\":\"scanComplete\",\"filesProcessed\":0,\"filesUnchanged\":0,\"filesScanned\":0,\"staleEntriesRemoved\":0}}"
        );
        return Ok(());
    }

    // Remove tracks not seen in this scan (deleted files)
    let deleted = conn.execute(
        "DELETE FROM tracks WHERE library_id = ? AND scan_id != ?",
        rusqlite::params![config.library_id, config.scan_id],
    )?;

    // Clean up orphaned artists and albums. An artist is kept if ANY of:
    //   - tracks.artist_id references it (primary track artist)
    //   - albums.artist_id references it (primary album artist)
    //   - track_artists M2M references it (featured artists)
    //   - album_artists M2M references it (co-credited album artists)
    // Missing the M2M checks would orphan featured/credited artists whose
    // only reference is via the V17 M2M tables — cascade-deleting their
    // M2M rows and breaking `song.artists` for collabs.
    //
    // CHUNKED, not one big DELETE: on libraries with hundreds of thousands
    // of tracks and a long tail of one-track artists, the artists DELETE's
    // 4-way NOT IN can run past 5 seconds. Run as one autocommit DELETE
    // (or one execute_batch with three of them) it holds the SQLite writer
    // lock for that whole window, and any concurrent API write from the
    // main mStream server hits busy_timeout (5000ms) and fails with
    // SQLITE_BUSY. chunked_orphan_delete releases the writer between
    // batches so other processes can squeeze in.
    chunked_orphan_delete(&conn, "albums",
        "SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)")?;
    chunked_orphan_delete(&conn, "artists",
        "SELECT id FROM artists \
         WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL) \
           AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL) \
           AND id NOT IN (SELECT DISTINCT artist_id FROM track_artists) \
           AND id NOT IN (SELECT DISTINCT artist_id FROM album_artists)")?;
    chunked_orphan_delete(&conn, "genres",
        "SELECT id FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM track_genres)")?;

    // Structured end-of-scan event — parsed by task-queue.js to decide whether
    // to run the waveform post-processor and to print a human-readable summary.
    // Integer fields only; no escaping needed.
    //
    //   filesProcessed     New / modified — DB rows actually written by this scan.
    //   filesUnchanged     Cache-hit fast-path skips — file existed in DB and
    //                      mtime matched, only scan_id was bumped.
    //   filesScanned       Total supported-extension files visited (sum of the
    //                      above plus any per-file errors). Lets the operator
    //                      sanity-check 'is the scanner actually seeing my
    //                      library' even on a no-op subsequent run.
    //   staleEntriesRemoved  Tracks deleted because the file disappeared.
    let unchanged = total_processed.saturating_sub(file_count);
    println!(
        "{{\"event\":\"scanComplete\",\"filesProcessed\":{},\"filesUnchanged\":{},\"filesScanned\":{},\"staleEntriesRemoved\":{}}}",
        file_count, unchanged, total_processed, deleted
    );
    Ok(())
}

// ── Per-file processing ─────────────────────────────────────────────────────

// Thin orchestrator kept for the (still serial) main loop — Phase 2
// will replace this with a worker-pool / writer-thread split that
// calls extract_track and commit_track directly. Single call site
// keeps the diff small and the existing per-file error logging in
// run_scan unchanged.
#[allow(clippy::too_many_arguments)]
fn process_one(
    entry: &walkdir::DirEntry,
    ext: &str,
    config: &ScanConfig,
    conn: &Connection,
    dir_art_cache: &Mutex<HashMap<String, Option<String>>>,
    dir_file_cache: &Mutex<HashMap<PathBuf, DirListing>>,
    waveform_cache_names: &Mutex<HashSet<String>>,
    existing_tracks: &HashMap<String, ExistingTrack>,
    artist_cache: &Mutex<HashMap<String, i64>>,
    album_cache: &Mutex<HashMap<(String, Option<i64>, Option<i64>), i64>>,
    genre_cache: &Mutex<HashMap<String, i64>>,
    various_artists_id: &Mutex<Option<i64>>,
) -> Result<bool, Box<dyn std::error::Error>> {
    match extract_track(
        entry, ext, config,
        dir_art_cache, dir_file_cache, waveform_cache_names,
        existing_tracks,
    )? {
        ExtractResult::Unchanged { existing_id } => {
            // Hot path for any rescan of a stable library; keep the
            // statement prepared so the cache hit is the only cost.
            conn.prepare_cached("UPDATE tracks SET scan_id = ? WHERE id = ?")?
                .execute(rusqlite::params![config.scan_id, existing_id])?;
            Ok(false)
        }
        ExtractResult::Extracted(et) => {
            commit_track(
                conn, config, &et,
                artist_cache, album_cache, genre_cache, various_artists_id,
            )?;
            Ok(true)
        }
    }
}

// Per-file CPU + I/O work. No SQLite access; safe to call from any
// thread. Returns Unchanged for the mtime fast-path (so the writer
// only has to bump scan_id) or a fully-populated ExtractedTrack
// payload the writer will INSERT.
//
// Side effects worth knowing about:
//   - Reads `fs::metadata`, `fs::read`, walks lyric sidecars.
//   - May write album-art files to disk via save_embedded_art /
//     check_directory_for_album_art (those keys files by content
//     hash and skip the write when the target already exists, so
//     duplicate work across workers is harmless).
//   - May write a waveform .bin (atomic temp+rename, dedup'd via
//     waveform_cache_names).
fn extract_track(
    entry: &walkdir::DirEntry,
    ext: &str,
    config: &ScanConfig,
    dir_art_cache: &Mutex<HashMap<String, Option<String>>>,
    dir_file_cache: &Mutex<HashMap<PathBuf, DirListing>>,
    waveform_cache_names: &Mutex<HashSet<String>>,
    existing_tracks: &HashMap<String, ExistingTrack>,
) -> Result<ExtractResult, Box<dyn std::error::Error>> {
    let filepath = entry.path();
    // Pull size + mtime in one stat. Used below to decide whether to
    // pull the file fully into RAM for the buffered fast-path, and
    // replaces the separate `file.metadata()?.len()` inside
    // compute_hashes.
    let meta = entry.metadata()?;
    let mod_time = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    let file_size = meta.len();

    // Skip the `replace` allocation on Unix where there are no
    // backslashes to convert. `to_string_lossy()` returns a Cow, so the
    // common path is zero-copy.
    let rel_path_cow = filepath.strip_prefix(&config.directory)?.to_string_lossy();
    let rel_path: String = if rel_path_cow.contains('\\') {
        rel_path_cow.replace('\\', "/")
    } else {
        rel_path_cow.into_owned()
    };

    // Existing-track snapshot comes from the pre-fetched HashMap, not
    // a per-file SELECT. See `load_existing_tracks` at the top of
    // run_scan. The row (if any) carries everything the fast-path
    // check and the downstream migration logic need:
    //   - id            — for the scan_id UPDATE
    //   - modified      — mtime equality check for fast path
    //   - file_hash /
    //     audio_hash    — migrate user-facing rows (stars, bookmarks,
    //                     play queue) on tag edits that change the
    //                     canonical identity
    //   - album_id      — migrate user_album_stars on V17
    //                     compilation-collapse
    //   - sidecar_mtime — fast-path invalidation on .lrc / .txt drift
    let existing = existing_tracks.get(&rel_path);

    // Probe sidecars BEFORE the fast-path decision so a drift between
    // the stored mtime and what's on disk triggers a re-read.
    let current_sidecar_mtime = sidecar_mtime_cached(filepath, dir_file_cache);

    // NOTE: we intentionally do NOT DELETE the old tracks row before
    // tag parsing. A mid-parse failure used to leave the DELETE
    // committed without a matching INSERT on the next batch flush,
    // orphaning user_metadata / bookmarks / play-queue rows keyed off
    // the old hash. The INSERT OR REPLACE in commit_track handles the
    // row swap atomically — the old row (and its cascaded
    // track_artists / track_genres) only disappears when the new one
    // is ready to take its place.
    let (old_hash, old_audio_hash, old_album_id): (Option<String>, Option<String>, Option<i64>) =
        if let Some(e) = existing {
            let audio_unchanged = e.modified == mod_time;
            let sidecar_drifted = e.lyrics_sidecar_mtime != current_sidecar_mtime;
            if audio_unchanged && !config.force_rescan && !sidecar_drifted {
                return Ok(ExtractResult::Unchanged { existing_id: e.id });
            }
            (
                e.file_hash.clone().filter(|s| !s.is_empty()),
                e.audio_hash.clone().filter(|s| !s.is_empty()),
                e.album_id,
            )
        } else {
            (None, None, None)
        };

    // Parse metadata
    let mut title = None;
    let mut artist = None;
    let mut album = None;
    let mut year: Option<i64> = None;
    let mut track_num: Option<i64> = None;
    let mut disc_num: Option<i64> = None;
    let mut genre = None;
    let mut rg_track_db: Option<f64> = None;
    let mut aa_file: Option<String> = None;
    let mut duration_sec: Option<f64> = None;
    // OpenSubsonic extended audio-format fields. Populated from lofty's
    // audio properties below; NULL when unavailable.
    let mut sample_rate: Option<i64> = None;
    let mut channels: Option<i64> = None;
    let mut bit_depth: Option<i64> = None;
    // V17: multi-artist / compilation extraction. Mirrors the JS helper
    // in src/db/artist-extraction.js — same tag aliases, same delimiter
    // list, same fallback rules.
    let mut album_artist_tag: Option<String> = None;
    let mut album_artists_multi: Vec<String> = Vec::new();
    let mut track_artists_multi: Vec<String> = Vec::new();
    let mut is_compilation = false;

    // V19: lyrics. Populated by the lofty block below from ItemKey::Lyrics
    // + ItemKey::LyricsLanguage (unsynced + language), then overlaid by
    // the sibling `<basename>.lrc` / `.txt` sidecar probe. See
    // src/db/lyrics-extraction.js for the JS mirror — same precedence,
    // same language normalisation.
    let mut lyrics_embedded: Option<String> = None;
    let mut lyrics_synced_lrc: Option<String> = None;
    let mut lyrics_lang: Option<String> = None;

    // V32: BPM + key from embedded tags. Populated from Lofty below;
    // mirrors src/db/scanner.mjs's parseMyFile extraction so the parity
    // test (snapshotting both columns) holds.
    let mut bpm: Option<i64> = None;
    let mut musical_key: Option<String> = None;

    // V36: provenance from embedded tags — populated from the lofty
    // primary_tag block below via detect_source_from_tag().
    let mut source: Option<String> = None;

    // Single-buffer fast path: pull the file into RAM once and share the
    // bytes between lofty (tags), MD5 (hashes), and symphonia (waveform).
    // Previously each of those steps opened the file independently and
    // re-read up to the full payload from disk. On local SSD the savings
    // are in the tens of ms per new/modified file; on CIFS or spinning
    // disk they're dominant. A size threshold keeps memory bounded so a
    // pathological 2 GB WAV doesn't blow out the process.
    const MAX_BUFFERED_FILE: u64 = 256 * 1024 * 1024;
    let mut buf: Option<Vec<u8>> = if file_size <= MAX_BUFFERED_FILE {
        match fs::read(filepath) {
            Ok(b) => Some(b),
            Err(e) => {
                // If the read failed outright (permission, transient
                // network), fall back to the streaming path. lofty/hash
                // will likely also fail and get logged per-step, but
                // that matches the pre-buffered-path behaviour.
                eprintln!("Warning: buffered read failed on {}: {}", filepath.display(), e);
                None
            }
        }
    } else {
        None
    };

    // Use Relaxed parsing so malformed frames (e.g. odd-length UTF-16 strings,
    // invalid year lengths) get dropped individually instead of failing the
    // whole file. Bulk rips with a broken tagger can otherwise lose all
    // metadata for hundreds of tracks from one bad frame each.
    // Match `Probe::open`'s behaviour: set the file type from the
    // extension (what lofty's source does via `FileType::from_path`).
    // The earlier version of the buffered arm used `guess_file_type()`
    // which is magic-bytes-only — for files whose magic signature is
    // unusual or corrupted but whose extension is known, `Probe::open`
    // succeeds while magic detection returns `UnknownFormat`. Keeping
    // the two paths semantically identical preserves parity.
    let parse_opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let tagged_result = match buf.as_deref() {
        Some(bytes) => {
            let mut probe = Probe::new(Cursor::new(bytes));
            if let Some(ft) = FileType::from_ext(ext) {
                probe = probe.set_file_type(ft);
            }
            probe.options(parse_opts).read()
        }
        None => Probe::open(filepath).and_then(|p| p.options(parse_opts).read()),
    };
    match tagged_result {
        Ok(tagged_file) => {
            // Get duration + extended audio properties.
            let props = tagged_file.properties();
            let dur = props.duration();
            if !dur.is_zero() {
                duration_sec = Some(dur.as_secs_f64());
            }
            if let Some(sr) = props.sample_rate() { sample_rate = Some(sr as i64); }
            if let Some(ch) = props.channels() {
                if ch > 0 { channels = Some(ch as i64); }
            }
            if let Some(bd) = props.bit_depth() { bit_depth = Some(bd as i64); }

            let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
            if let Some(tag) = tag {
                title = tag.title().map(|s| s.to_string());
                artist = tag.artist().map(|s| s.to_string());
                album = tag.album().map(|s| s.to_string());
                year = tag.year().map(|y| y as i64);
                track_num = tag.track().map(|t| t as i64);
                disc_num = tag.disk().map(|d| d as i64);
                genre = tag.genre().map(|s| s.to_string());

                rg_track_db = tag.get(&ItemKey::ReplayGainTrackGain).and_then(|item| {
                    if let ItemValue::Text(s) = item.value() {
                        parse_replaygain_db(s)
                    } else { None }
                });

                if !config.skip_img {
                    if let Some(pic) = tag.pictures().first() {
                        aa_file = save_embedded_art(pic, config);
                    }
                }

                // Album artist (single-value scalar tag, may need splitting).
                album_artist_tag = tag.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string());

                // Multi-value ARTIST / ALBUMARTIST: get every item (each item
                // may be Text or Locator). Honour multi-value natively.
                for item in tag.get_items(&ItemKey::AlbumArtist) {
                    if let ItemValue::Text(s) = item.value() {
                        album_artists_multi.push(s.to_string());
                    }
                }
                for item in tag.get_items(&ItemKey::TrackArtist) {
                    if let ItemValue::Text(s) = item.value() {
                        track_artists_multi.push(s.to_string());
                    }
                }

                // Compilation flag — ID3v2 TCMP, MP4 cpil, Vorbis COMPILATION,
                // WMA WM/IsCompilation. lofty normalises all via FlagCompilation.
                is_compilation = tag.get_string(&ItemKey::FlagCompilation)
                    .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                    .unwrap_or(false);

                // V19: embedded lyrics. lofty exposes USLT / SYLT / Vorbis
                // LYRICS / MP4 ©lyr / APE Lyrics under ItemKey::Lyrics. We
                // have no easy way to pull ID3v2 SYLT structured timings
                // through the unified API (lofty treats it as opaque
                // non-text), so for synced we lean on sidecar .lrc files —
                // which is by far the more common distribution channel
                // anyway. Language comes from ItemKey::Language when
                // present (ID3v2 USLT's 3-char field).
                if let Some(t) = tag.get_string(&ItemKey::Lyrics) {
                    let s = t.trim();
                    if !s.is_empty() {
                        if looks_like_lrc(s) {
                            lyrics_synced_lrc = Some(s.to_string());
                        } else {
                            lyrics_embedded = Some(s.to_string());
                        }
                    }
                }
                if let Some(lang) = tag.get_string(&ItemKey::Language) {
                    lyrics_lang = normalise_lang(lang);
                }

                // V32: BPM + musical key. Both pulled as text and parsed
                // here so the validation matches the JS scanner: BPM
                // accepted only when it rounds to 20..=300, key trimmed
                // and capped at 12 chars.
                //
                // Lofty routes BPM to two distinct ItemKey variants
                // depending on the source format / tag version:
                //   • Vorbis comments (FLAC, OGG) `BPM=…`  → ItemKey::Bpm
                //   • ID3v2.3+ (MP3, WAV)         `TBPM=…` → ItemKey::IntegerBpm
                // music-metadata unifies both under common.bpm, so to
                // stay in parity we must check both ItemKeys and accept
                // whichever fires. (This is hardcoded in Lofty's frame
                // mapping; there is no config option to merge them.)
                let bpm_raw = tag.get_string(&ItemKey::Bpm)
                    .or_else(|| tag.get_string(&ItemKey::IntegerBpm));
                if let Some(s) = bpm_raw {
                    if let Ok(f) = s.trim().parse::<f64>() {
                        let n = f.round() as i64;
                        if (20..=300).contains(&n) { bpm = Some(n); }
                    }
                }
                if let Some(s) = tag.get_string(&ItemKey::InitialKey) {
                    let trimmed: String = s.trim().chars().take(12).collect();
                    if !trimmed.is_empty() { musical_key = Some(trimmed); }
                }

                // V36: provenance from custom tags. See
                // detect_source_from_tag for the priority order; mirrors
                // src/db/scanner.mjs::detectSource so both scanners
                // produce the same value for the parity tests.
                source = detect_source_from_tag(tag);
            }
        }
        Err(e) => {
            eprintln!("Warning: metadata parse error on {}: {}", filepath.display(), e);
        }
    }
    let mut bpm_source: Option<&'static str> =
        if bpm.is_some() || musical_key.is_some() { Some("tag") } else { None };

    // BPM/key analysis gate. We run stratum-dsp only when ALL of:
    //   • the operator hasn't disabled the feature,
    //   • neither BPM nor key was already extracted from tags
    //     (tag values are user-curated; never overwrite them),
    //   • the genre doesn't mark this as spoken-word content,
    //   • duration falls in roughly [30s, 30min] — too short =
    //     unreliable statistics, too long = audiobook/podcast/
    //     DJ-mix territory where (a) BPM has no meaningful single
    //     value and (b) the retained-samples buffer balloons
    //     memory across rayon workers. The upper bound is 1801.0
    //     rather than 1800.0 to absorb encoder rounding: a track
    //     labelled "30:00" in iTunes/etc. can decode to anywhere
    //     between ~29:59.5 and ~30:00.5 because mp3 frames are
    //     ~26ms each and decoders/encoders round in either
    //     direction. 1 second of slack handles all realistic
    //     encoder padding without meaningfully shifting the
    //     "music vs audiobook" semantic. Files with unreadable
    //     duration skip via the None branch of map_or.
    let analyze_this_file = config.analyze_bpm
        && bpm_source.is_none()
        && !is_audiobook_genre(genre.as_deref())
        && duration_sec.map_or(false, |d| (30.0..1801.0).contains(&d));

    // Resolve final artist lists using the shared fallback rules.
    let album_artists = resolve_album_artists(
        album_artist_tag.as_deref(),
        &album_artists_multi,
    );
    let track_artists = resolve_track_artists(
        artist.as_deref(),
        &track_artists_multi,
    );

    // V19: sidecar lyrics — only consulted when we haven't already got a
    // synced variant from the tag. Mirrors the JS extractor's precedence
    // (embedded synced > sidecar .lrc > embedded plain > sidecar .txt).
    if lyrics_synced_lrc.is_none() {
        if let Some((text, lang)) = read_lrc_sidecar_cached(filepath, dir_file_cache) {
            lyrics_synced_lrc = Some(text);
            if lyrics_lang.is_none() {
                lyrics_lang = lang.and_then(|l| normalise_lang(&l));
            }
        }
    }
    if lyrics_synced_lrc.is_none() && lyrics_embedded.is_none() {
        if let Some(text) = read_txt_sidecar_cached(filepath, dir_file_cache) {
            if looks_like_lrc(&text) {
                lyrics_synced_lrc = Some(text);
            } else {
                lyrics_embedded = Some(text);
            }
        }
    }
    // sidecar_mtime_val: the probe-time value is what we store, whether
    // or not we ended up reading those bytes. The DB stores "newest
    // sidecar mtime seen" — a tag-only track whose sibling later gains
    // an .lrc still triggers re-read on the next scan.


    if aa_file.is_none() && !config.skip_img {
        aa_file = check_directory_for_album_art(filepath, config, dir_art_cache);
    }

    let (file_hash, audio_hash) = match buf.as_deref() {
        Some(bytes) => compute_hashes_from_bytes(bytes, ext),
        None => compute_hashes(filepath, ext)?,
    };

    // Best-effort waveform generation + optional BPM/key analysis. Both
    // ride the same symphonia decode pass — when only one is needed we
    // still pay the decode once, never twice.
    //
    // Waveform: uses audio_hash as the cache key so waveforms survive
    // tag edits (same pattern as user_* rows). Falls back to file_hash
    // when the format has no audio_hash. Skipped for .opus (symphonia
    // 0.5 has no decoder; on-demand endpoint handles it via ffmpeg) and
    // for tracks whose .bin file already exists.
    //
    // Analysis: piggybacks on the same decoded sample stream when the
    // gate (analyze_this_file) is open. Even if the waveform .bin is
    // already cached we still decode for analysis — this is what lets
    // an existing library backfill BPM/key on a force-rescan without
    // needing the user to nuke the waveform cache first.
    let wf_dir_set = !config.waveform_cache_dir.is_empty();
    if wf_dir_set || analyze_this_file {
        let wf_key = audio_hash.as_deref().unwrap_or(&file_hash);
        let wf_filename = format!("{}.bin", wf_key);
        // Membership check against the in-memory set we pre-scanned at
        // the start of run_scan — saves one `fs::metadata` per track.
        let already_cached = wf_dir_set
            && waveform_cache_names.lock().unwrap().contains(&wf_filename);
        let need_waveform = wf_dir_set && !already_cached;
        let need_decode = need_waveform || analyze_this_file;

        if need_decode {
            // Move `buf` into symphonia when we have one — the decoder
            // reads from the Vec<u8> directly, saving a full file read.
            // `buf` is consumed here so `None` path is still safe.
            let wf_output = match buf.take() {
                Some(b) => waveform_from_bytes(b, ext, analyze_this_file),
                None => waveform_from_symphonia(filepath, ext, analyze_this_file),
            };
            if let Some(output) = wf_output {
                // Persist the 800-bar peak waveform to disk if (a) we're
                // configured to and (b) this audio_hash hasn't already
                // been written by another worker in the same scan.
                if need_waveform {
                    let wf_path = PathBuf::from(&config.waveform_cache_dir).join(&wf_filename);
                    if let Some(dir) = wf_path.parent() {
                        let _ = fs::create_dir_all(dir);
                    }
                    // Atomic write via temp+rename. The unique sequence in
                    // write_atomic's temp filename is essential here: two
                    // workers can race on the same `wf_key` whenever two
                    // tracks share an audio_hash (e.g., duplicate copies
                    // of the same song). A shared temp path would let one
                    // worker's truncate clobber the other's write, briefly
                    // leaving a 0-byte .bin visible to the GET /api/v1/db/
                    // waveform endpoint mid-scan.
                    if write_atomic(&wf_path, &output.bars).is_some() {
                        // Track what we wrote so a subsequent track with the
                        // same audio_hash in the same scan doesn't redo the work.
                        waveform_cache_names.lock().unwrap().insert(wf_filename);
                    }
                }

                // stratum-dsp analysis. Validates the output before
                // committing (BPM in [20, 300] matches the same range
                // we accept from tags at line 1172). Failure modes —
                // empty buffer, silence trim, NaN — are surfaced as
                // `Err(_)` by stratum-dsp; we log + leave the columns
                // NULL so the next force-rescan can retry.
                if analyze_this_file {
                    if let Some(samples) = output.samples {
                        match stratum_dsp::analyze_audio(
                            &samples,
                            output.sample_rate,
                            stratum_dsp::AnalysisConfig::default(),
                        ) {
                            Ok(result) => {
                                let rounded = result.bpm.round() as i64;
                                if (20..=300).contains(&rounded) {
                                    bpm = Some(rounded);
                                    musical_key = Some(result.key.name().to_string());
                                    bpm_source = Some("stratum");
                                }
                            }
                            Err(e) => {
                                eprintln!(
                                    "Warning: stratum-dsp analysis failed on {}: {:?}",
                                    rel_path, e
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    // `buf` (if not moved into the waveform branch above) drops here
    // — no explicit free needed, but worth being aware of the memory
    // peak: one audio file's bytes are live from fs::read until here.
    drop(buf);

    Ok(ExtractResult::Extracted(Box::new(ExtractedTrack {
        rel_path,
        mod_time,
        ext: ext.to_string(),
        file_hash,
        audio_hash,
        title,
        artist,
        album,
        year,
        track_num,
        disc_num,
        genre,
        rg_track_db,
        duration_sec,
        sample_rate,
        channels,
        bit_depth,
        album_artist_tag,
        album_artists,
        track_artists,
        is_compilation,
        lyrics_embedded,
        lyrics_synced_lrc,
        lyrics_lang,
        current_sidecar_mtime,
        bpm,
        musical_key,
        bpm_source,
        source,
        aa_file,
        old_hash,
        old_audio_hash,
        old_album_id,
    })))
}

// All SQLite writes for one extracted track. Resolves artist/album/
// genre IDs (each cached for the rest of the scan), inserts the
// tracks row, populates the M2M tables, then runs hash- and album-
// stars migrations against the prior canonical identity (if any).
//
// MUST be called from a single thread per Connection — the artist/
// album/genre caches sit behind Mutexes for backwards compatibility
// with the still-serial process_one shim, but the writer-thread
// design in Phase 2 means contention is zero in practice.
fn commit_track(
    conn: &Connection,
    config: &ScanConfig,
    et: &ExtractedTrack,
    artist_cache: &Mutex<HashMap<String, i64>>,
    album_cache: &Mutex<HashMap<(String, Option<i64>, Option<i64>), i64>>,
    genre_cache: &Mutex<HashMap<String, i64>>,
    various_artists_id: &Mutex<Option<i64>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve track-artist ids (primary first) and album-artist ids.
    let primary_track_artist_name = et.track_artists.first().cloned()
        .or_else(|| et.artist.clone());
    let primary_track_artist_id = match primary_track_artist_name.as_deref() {
        Some(name) if !name.is_empty() => Some(find_or_create_artist(conn, artist_cache, name)?),
        _ => None,
    };
    let mut album_artist_ids: Vec<i64> = Vec::new();
    for name in &et.album_artists {
        if !name.is_empty() {
            album_artist_ids.push(find_or_create_artist(conn, artist_cache, name)?);
        }
    }

    // Fallback chain for the primary album-artist (what goes in albums.artist_id):
    //   1. First ALBUMARTIST value, if present.
    //   2. Various Artists seed, if compilation flag is set.
    //   3. Primary track artist.
    let primary_album_artist_id = if !album_artist_ids.is_empty() {
        Some(album_artist_ids[0])
    } else if et.is_compilation {
        find_various_artists(conn, various_artists_id).ok().flatten().or(primary_track_artist_id)
    } else {
        primary_track_artist_id
    };

    // Find or create album
    let album_id = match &et.album {
        Some(name) => {
            let aid = find_or_create_album(
                conn, album_cache,
                name, primary_album_artist_id, et.year, et.aa_file.as_deref(),
                et.album_artist_tag.as_deref(), et.is_compilation,
            )?;
            Some(aid)
        }
        None => None,
    };

    // Insert track. Hottest statement in the scanner — prepared once
    // per connection and reused for every changed file.
    // V34 dropped tracks.genre — the canonical store is the track_genres
    // M2M, populated below via set_track_genres. V36 added tracks.source
    // (open-enum provenance) — extracted from custom tags in extract_track.
    // Keep the column list in lock-step with src/db/scanner.mjs.
    conn.prepare_cached(
        "INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
         disc_number, year, duration, format, file_hash, audio_hash, album_art_file,
         replaygain_track_db, sample_rate, channels, bit_depth,
         lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime,
         bpm, musical_key, bpm_source,
         modified, scan_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?.execute(rusqlite::params![
        et.rel_path, config.library_id, et.title, primary_track_artist_id, album_id,
        et.track_num, et.disc_num, et.year, et.duration_sec, et.ext, et.file_hash, et.audio_hash,
        et.aa_file, et.rg_track_db, et.sample_rate, et.channels, et.bit_depth,
        et.lyrics_embedded, et.lyrics_synced_lrc, et.lyrics_lang, et.current_sidecar_mtime,
        et.bpm, et.musical_key, et.bpm_source,
        et.mod_time, config.scan_id, et.source
    ])?;

    let track_id = conn.last_insert_rowid();
    set_track_genres(conn, genre_cache, track_id, et.genre.as_deref())?;

    // V17: populate M2M. Album-artists — INSERT OR IGNORE across multiple
    // tracks sharing the same album. Fall back to the primary album-artist
    // id so the M2M isn't empty for legacy single-artist albums. Hoist the
    // prepared statement out of the loop to avoid a statement-cache
    // lookup per collaborator.
    if let Some(aid) = album_id {
        let m2m_ids: Vec<i64> = if !album_artist_ids.is_empty() {
            album_artist_ids.clone()
        } else {
            primary_album_artist_id.into_iter().collect()
        };
        if !m2m_ids.is_empty() {
            let mut stmt = conn.prepare_cached(
                "INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position)
                 VALUES (?, ?, 'main', ?)",
            )?;
            for (i, artist_fk) in m2m_ids.iter().enumerate() {
                stmt.execute(rusqlite::params![aid, artist_fk, i as i64])?;
            }
        }
    }

    // Track-artists — clear first (defensive; REPLACE above should have
    // cascaded, but a partial-run rescan could leave orphans). Primary is
    // role='main'; any additional collaborators are 'featured' in tag order.
    conn.prepare_cached("DELETE FROM track_artists WHERE track_id = ?")?
        .execute(rusqlite::params![track_id])?;
    let mut track_artist_ids: Vec<i64> = Vec::new();
    for name in &et.track_artists {
        if !name.is_empty() {
            track_artist_ids.push(find_or_create_artist(conn, artist_cache, name)?);
        }
    }
    if track_artist_ids.is_empty() {
        if let Some(id) = primary_track_artist_id { track_artist_ids.push(id); }
    }
    if !track_artist_ids.is_empty() {
        let mut stmt = conn.prepare_cached(
            "INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
             VALUES (?, ?, ?, ?)",
        )?;
        for (i, artist_fk) in track_artist_ids.iter().enumerate() {
            let role = if i == 0 { "main" } else { "featured" };
            stmt.execute(rusqlite::params![track_id, artist_fk, role, i as i64])?;
        }
    }

    // Migrate user_* rows to the new canonical identity. Canonical = audio_hash
    // when present, file_hash otherwise. A tag edit keeps audio_hash stable,
    // so the common case is a no-op; migration only runs on real content
    // change or on the transition from file-hash-only rows to audio_hash rows.
    let new_canon = et.audio_hash.clone().unwrap_or_else(|| et.file_hash.clone());
    let old_canon = et.old_audio_hash.clone().unwrap_or_else(|| et.old_hash.clone().unwrap_or_default());
    if !old_canon.is_empty() && old_canon != new_canon {
        migrate_hash_references(conn, &old_canon, &new_canon)?;
    }

    // V17: album-stars migration on compilation-collapse.
    if let (Some(old), Some(new)) = (et.old_album_id, album_id) {
        if old != new {
            migrate_album_stars(conn, old, new)?;
        }
    }

    Ok(())
}

/// Update user-facing rows that key off `file_hash` when a file's content
/// hash changes without a path change. Mirrors `migrateHashReferences` in
/// src/db/scanner.mjs — see the comment there for the rationale.
fn migrate_hash_references(
    conn: &Connection, old_hash: &str, new_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "UPDATE user_metadata SET track_hash = ? WHERE track_hash = ?",
        rusqlite::params![new_hash, old_hash],
    )?;
    conn.execute(
        "UPDATE user_bookmarks SET track_hash = ? WHERE track_hash = ?",
        rusqlite::params![new_hash, old_hash],
    )?;

    // user_play_queue stores the queue as a JSON array of hashes. Pull
    // affected rows, rewrite in place, write back. Quoted match on the
    // JSON text prevents false positives from substring overlap between
    // MD5 hex values.
    let quoted = format!("\"{}\"", old_hash);
    let mut stmt = conn.prepare_cached(
        "SELECT user_id, current_track_hash, track_hashes_json
           FROM user_play_queue
          WHERE current_track_hash = ?
             OR instr(track_hashes_json, ?) > 0",
    )?;
    let rows: Vec<(i64, Option<String>, String)> = stmt
        .query_map(rusqlite::params![old_hash, quoted], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (user_id, current_hash, queue_json) in rows {
        // Parse the JSON array, swap occurrences, serialize back. If the
        // row's JSON is corrupt we skip it rather than blowing up a scan.
        let hashes: Vec<String> = match serde_json::from_str(&queue_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let migrated: Vec<String> = hashes.into_iter()
            .map(|h| if h == old_hash { new_hash.to_string() } else { h })
            .collect();
        let new_json = serde_json::to_string(&migrated)?;
        let new_current = match current_hash {
            Some(c) if c == old_hash => Some(new_hash.to_string()),
            other => other,
        };
        conn.execute(
            "UPDATE user_play_queue
                SET current_track_hash = ?, track_hashes_json = ?
              WHERE user_id = ?",
            rusqlite::params![new_current, new_json, user_id],
        )?;
    }

    Ok(())
}

// ── Artist / Album helpers ──────────────────────────────────────────────────

fn find_or_create_artist(
    conn: &Connection,
    cache: &Mutex<HashMap<String, i64>>,
    name: &str,
) -> Result<i64, rusqlite::Error> {
    // Check the per-scan memo first — most tracks reuse ~dozens of
    // artist names, so the SELECT rarely has to hit SQLite twice for
    // the same value across a scan.
    if let Some(&id) = cache.lock().unwrap().get(name) {
        return Ok(id);
    }
    let existing: Option<i64> = conn
        .prepare_cached("SELECT id FROM artists WHERE name = ?")?
        .query_row([name], |row| row.get(0))
        .optional()?;
    let id = match existing {
        Some(id) => id,
        None => {
            conn.prepare_cached("INSERT INTO artists (name) VALUES (?)")?
                .execute([name])?;
            conn.last_insert_rowid()
        }
    };
    cache.lock().unwrap().insert(name.to_string(), id);
    Ok(id)
}

fn find_or_create_album(
    conn: &Connection,
    cache: &Mutex<HashMap<(String, Option<i64>, Option<i64>), i64>>,
    name: &str, artist_id: Option<i64>, year: Option<i64>,
    art: Option<&str>, album_artist_display: Option<&str>, compilation: bool,
) -> Result<i64, rusqlite::Error> {
    let key = (name.to_string(), artist_id, year);

    // Cache hit → we already resolved this album this scan. We still
    // re-apply the album-art + display + compilation UPDATEs because
    // per-track rescans can surface new art / change compilation
    // flagging, and we need to keep those in sync with the DB.
    let cached = cache.lock().unwrap().get(&key).copied();
    let id = match cached {
        Some(id) => id,
        None => {
            let existing: Option<i64> = conn
                .prepare_cached("SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?")?
                .query_row(rusqlite::params![name, artist_id, year], |row| row.get(0))
                .optional()?;
            let resolved = match existing {
                Some(id) => id,
                None => {
                    conn.prepare_cached(
                        "INSERT INTO albums (name, artist_id, year, album_art_file, album_artist, compilation)
                         VALUES (?, ?, ?, ?, ?, ?)",
                    )?.execute(rusqlite::params![
                        name, artist_id, year, art, album_artist_display, compilation as i64,
                    ])?;
                    let new_id = conn.last_insert_rowid();
                    // Newly-inserted row already has the art/display/
                    // compilation columns we want; skip the UPDATE path.
                    cache.lock().unwrap().insert(key, new_id);
                    return Ok(new_id);
                }
            };
            cache.lock().unwrap().insert(key, resolved);
            resolved
        }
    };

    if let Some(art_file) = art {
        conn.prepare_cached(
            "UPDATE albums SET album_art_file = ? WHERE id = ? AND album_art_file IS NULL",
        )?.execute(rusqlite::params![art_file, id])?;
    }
    conn.prepare_cached(
        "UPDATE albums SET album_artist = COALESCE(?, album_artist), compilation = ? WHERE id = ?",
    )?.execute(rusqlite::params![album_artist_display, compilation as i64, id])?;
    Ok(id)
}

/// Return the id of the seeded "Various Artists" row, if any. Used by
/// the album-artist fallback chain when COMPILATION=1 is set but no
/// ALBUMARTIST tag is present. The id is memoised for the rest of the
/// scan (both hits and misses) to avoid re-querying for every
/// compilation track.
fn find_various_artists(
    conn: &Connection,
    cache: &Mutex<Option<i64>>,
) -> Result<Option<i64>, rusqlite::Error> {
    // `Mutex<Option<i64>>` with the sentinel `-1` representing a
    // confirmed absence. Using `Option<Option<i64>>` would be cleaner
    // but doubles the cache-check overhead for no reason; -1 can't
    // collide with a real SQLite rowid (always positive).
    {
        let g = cache.lock().unwrap();
        if let Some(v) = *g {
            return Ok(if v < 0 { None } else { Some(v) });
        }
    }
    let looked_up: Option<i64> = conn
        .prepare_cached("SELECT id FROM artists WHERE name = 'Various Artists' LIMIT 1")?
        .query_row([], |row| row.get::<_, i64>(0))
        .optional()?;
    *cache.lock().unwrap() = Some(looked_up.unwrap_or(-1));
    Ok(looked_up)
}

/// Re-map user_album_stars rows from an old album id to a new one.
/// Used when a compilation collapses from N fragmented rows into a
/// single canonical row on rescan. Mirrors the JS migrateAlbumStars
/// helper in src/db/album-migration.js — same union semantics (earlier
/// starred_at wins when the user already had a star on the target).
fn migrate_album_stars(
    conn: &Connection, old_album_id: i64, new_album_id: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    if old_album_id == new_album_id { return Ok(()); }
    let mut stmt = conn.prepare(
        "SELECT user_id, starred_at FROM user_album_stars WHERE album_id = ?"
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map(rusqlite::params![old_album_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    for (user_id, starred_at) in rows {
        conn.execute(
            "INSERT INTO user_album_stars (user_id, album_id, starred_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id, album_id) DO UPDATE SET
               starred_at = MIN(user_album_stars.starred_at, excluded.starred_at)",
            rusqlite::params![user_id, new_album_id, starred_at],
        )?;
        conn.execute(
            "DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?",
            rusqlite::params![user_id, old_album_id],
        )?;
    }
    Ok(())
}

// ── Artist-list extraction helpers (mirror src/db/artist-extraction.js) ────

const ARTIST_DELIMITERS: &[&str] = &[
    " / ",
    " feat. ",
    " feat ",
    " ft. ",
    " ft ",
    "; ",
];

fn split_artist_string(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = vec![s.to_string()];
    for delim in ARTIST_DELIMITERS {
        let mut next = Vec::new();
        for p in &parts {
            if p.contains(delim) {
                for piece in p.split(delim) { next.push(piece.to_string()); }
            } else {
                next.push(p.clone());
            }
        }
        parts = next;
    }
    parts.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Returns the canonical ordered list of track-artist names. Each
/// value (whether from a multi-value tag or a single scalar) is split
/// on the delimiter list so `"A feat. B"` always becomes `["A", "B"]`
/// regardless of how the user tagged it. Duplicates dedup'd, order
/// preserved (first-seen wins).
fn resolve_artists_list(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    let values: Vec<String> = if !multi.is_empty() {
        multi.to_vec()
    } else {
        scalar.map(|s| vec![s.to_string()]).unwrap_or_default()
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for v in &values {
        for piece in split_artist_string(v) {
            if !seen.contains(&piece) {
                seen.insert(piece.clone());
                out.push(piece);
            }
        }
    }
    out
}

fn resolve_track_artists(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    resolve_artists_list(scalar, multi)
}

fn resolve_album_artists(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    resolve_artists_list(scalar, multi)
}

// ── Lyrics helpers (V19) ────────────────────────────────────────────────────
//
// Mirrors src/db/lyrics-extraction.js — keep the filename probe order
// and the language normalisation table byte-identical. Any change here
// MUST land on the JS side too.

const LYRICS_LANG_PROBE: &[&str] = &[
    "", "en", "eng", "ja", "jpn", "zh", "zho", "ko", "kor",
    "de", "deu", "fr", "fra", "es", "spa", "it", "ita",
    "pt", "por", "ru", "rus",
];

fn normalise_lang(raw: &str) -> Option<String> {
    let s = raw.trim().to_lowercase();
    if s.is_empty() { return None; }
    if s.len() == 2 { return Some(s); }
    let mapped = match s.as_str() {
        "eng" => "en", "jpn" => "ja", "zho" => "zh", "kor" => "ko",
        "deu" => "de", "fra" => "fr", "spa" => "es", "ita" => "it",
        "por" => "pt", "rus" => "ru", "ara" => "ar", "hin" => "hi",
        _ => return Some(s),
    };
    Some(mapped.to_string())
}

// Quick "is this LRC?" heuristic — matches any line whose first
// non-whitespace run is a `[mm:ss]` or `[mm:ss.xx]` timestamp.
// V36: Detect the `tracks.source` provenance label from embedded tags.
// Priority order (matches src/db/scanner.mjs::detectSource so the parity
// test snapshot is byte-identical between scanners):
//   1. Explicit `MSTREAM_SOURCE` tag — written by src/api/ytdl.js when
//      this server downloaded the file. Returns whatever value the tag
//      holds (today: 'ytdl'; future inserters may emit other labels).
//   2. yt-dlp's `purl` field (embedded automatically by `--embed-metadata`)
//      — when the URL points at youtube.com / youtu.be, return 'ytdl'.
//      Catches files downloaded via plain `yt-dlp` outside mStream.
//   3. None — no recognised marker.
//
// Lofty exposes per-container custom keys differently:
//   - ID3v2 TXXX frames        → `ItemKey::Unknown(description)`
//   - Vorbis comments          → `ItemKey::Unknown(field_name)`
//   - MP4 freeform atoms       → `ItemKey::Unknown("MSTREAM_SOURCE")`
// (Some lofty versions also normalise well-known descriptors like
// "PURL" to a known ItemKey variant — we iterate items and string-match
// the underlying key name to be tolerant of either path.)
fn detect_source_from_tag(tag: &lofty::tag::Tag) -> Option<String> {
    let mut purl: Option<String> = None;
    for item in tag.items() {
        let key_str: String = match item.key() {
            ItemKey::Unknown(s) => s.clone(),
            // Lofty may render some non-standard descriptors back through
            // their canonical key name for the active tag type — try that
            // path too. `map_key(false)` skips the Unknown fallback so we
            // only see real mappings.
            other => match other.map_key(tag.tag_type(), false) {
                Some(s) => s.to_string(),
                None => continue,
            },
        };
        let key_upper = key_str.to_ascii_uppercase();
        let text = match item.value() {
            ItemValue::Text(t) => t.clone(),
            ItemValue::Locator(t) => t.clone(),
            _ => continue,
        };
        if key_upper == "MSTREAM_SOURCE" {
            let t = text.trim();
            if !t.is_empty() { return Some(t.to_string()); }
        } else if purl.is_none() && key_upper == "PURL" {
            purl = Some(text);
        }
    }
    if let Some(p) = purl {
        let p_lower = p.to_ascii_lowercase();
        if p_lower.contains("youtube.com") || p_lower.contains("youtu.be") {
            return Some("ytdl".to_string());
        }
    }
    None
}

fn looks_like_lrc(text: &str) -> bool {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('[') { continue; }
        // Walk after the '['; we need `digit(s):digit(2)(.digits)?]`.
        let after = &trimmed[1..];
        let colon = match after.find(':') { Some(i) => i, None => continue };
        let mm = &after[..colon];
        if mm.is_empty() || !mm.chars().all(|c| c.is_ascii_digit()) { continue; }
        let rest = &after[colon + 1..];
        let close = match rest.find(']') { Some(i) => i, None => continue };
        let ss = &rest[..close];
        let ss_digits = ss.bytes().take_while(|b| b.is_ascii_digit()).count();
        if ss_digits >= 1 { return true; }
    }
    false
}

// Newest mtime across `<base>.lrc`, `<base>.<lang>.lrc`, `<base>.txt`
// siblings, in ms epoch. None if no sidecar exists. Standalone version
// used by the `--extract-lyrics` CLI subcommand. The scanner hot path
// uses `sidecar_mtime_cached` which amortises the directory read.
fn sidecar_mtime(audio_path: &Path) -> Option<i64> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    let mut newest: Option<i64> = None;
    let push = |candidate: PathBuf, newest: &mut Option<i64>| {
        if let Ok(meta) = fs::metadata(&candidate) {
            if meta.is_file() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        let ms = dur.as_millis() as i64;
                        if newest.map(|n| ms > n).unwrap_or(true) { *newest = Some(ms); }
                    }
                }
            }
        }
    };
    for suffix in LYRICS_LANG_PROBE {
        let name = if suffix.is_empty() {
            format!("{}.lrc", base)
        } else {
            format!("{}.{}.lrc", base, suffix)
        };
        push(dir.join(name), &mut newest);
    }
    push(dir.join(format!("{}.txt", base)), &mut newest);
    newest
}

// Lowercased set of filenames present in a directory. One `fs::read_dir`
// populates it; subsequent sidecar lookups for any audio file in that
// directory skip the probe entirely when no candidate filename exists.
// Lowercasing keeps behaviour parity with Windows/CIFS (case-insensitive)
// — on case-sensitive filesystems the subsequent `fs::metadata` with
// the exact-case name is what decides, the set is just a cheap filter.
pub(crate) struct DirListing {
    names: HashSet<String>,
    // Fast "are there any lyrics sidecars in this dir?" hint set at
    // load time. Lets sidecar probes short-circuit for directories that
    // contain zero `.lrc` / `.txt` files — the common case for most
    // libraries. Without this the probe still walks 22 candidate
    // filenames and HashSet-queries each, which adds up across a scan.
    has_lyric_sidecars: bool,
}

// One-time scan of the waveform cache directory into a set of filenames
// (`<hash>.bin`). Called once at scan start; the main loop then checks
// membership against the set instead of stat-ing the filesystem per
// track. Missing/unreadable cache dir → empty set, which degrades to
// "generate everything" — matches the previous behaviour.
fn load_waveform_cache_names(dir: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(fname) = entry.file_name().to_str() {
                if fname.ends_with(".bin") {
                    names.insert(fname.to_string());
                }
            }
        }
    }
    names
}

fn load_dir_listing(dir: &Path) -> DirListing {
    let mut names = HashSet::new();
    let mut has_lyric_sidecars = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name_lc = entry.file_name().to_string_lossy().to_lowercase();
            if !has_lyric_sidecars
                && (name_lc.ends_with(".lrc") || name_lc.ends_with(".txt"))
            {
                has_lyric_sidecars = true;
            }
            names.insert(name_lc);
        }
    }
    DirListing { names, has_lyric_sidecars }
}

// Check the cache for whether any filename candidate exists in the
// directory. The closure is given the exact filename it should stat
// if the cache reports a hit. Returns None when no directory exists
// (parent() is None) or read_dir failed — callers treat this as
// "no sidecars" same as before.
fn with_dir_listing<F, R>(
    dir: &Path,
    cache: &Mutex<HashMap<PathBuf, DirListing>>,
    f: F,
) -> Option<R>
where
    F: FnOnce(&DirListing) -> R,
{
    {
        let g = cache.lock().unwrap();
        if let Some(listing) = g.get(dir) {
            return Some(f(listing));
        }
    }
    // Load outside the lock so concurrent readers for other dirs don't
    // serialise behind a slow CIFS readdir on this one.
    let listing = load_dir_listing(dir);
    let mut g = cache.lock().unwrap();
    let listing_ref = g.entry(dir.to_path_buf()).or_insert(listing);
    Some(f(listing_ref))
}

// Cache-backed equivalent of `sidecar_mtime`. Same return contract; the
// only difference is that a directory with no matching sidecar filenames
// costs one `read_dir` (amortised across every track in the directory)
// and zero `fs::metadata` calls, instead of 22 stats per track.
fn sidecar_mtime_cached(
    audio_path: &Path,
    cache: &Mutex<HashMap<PathBuf, DirListing>>,
) -> Option<i64> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();

    // Fast path: directory contains zero `.lrc` / `.txt` files (the
    // common case). Skip the whole candidate build + HashSet queries.
    let has_sidecars = with_dir_listing(dir, cache, |l| l.has_lyric_sidecars)?;
    if !has_sidecars { return None; }

    // Collect the candidate filenames we'd probe with a stat otherwise.
    let mut candidates: Vec<String> = Vec::with_capacity(LYRICS_LANG_PROBE.len() + 1);
    for suffix in LYRICS_LANG_PROBE {
        candidates.push(if suffix.is_empty() {
            format!("{}.lrc", base)
        } else {
            format!("{}.{}.lrc", base, suffix)
        });
    }
    candidates.push(format!("{}.txt", base));

    // Filter down to names the directory actually contains. The listing
    // stores lowercase; we compare lowercase but keep the original case
    // for the subsequent stat so case-sensitive filesystems still agree.
    let to_stat: Vec<String> = with_dir_listing(dir, cache, |listing| {
        candidates.into_iter()
            .filter(|name| listing.names.contains(&name.to_lowercase()))
            .collect::<Vec<_>>()
    })?;

    let mut newest: Option<i64> = None;
    for name in &to_stat {
        let candidate = dir.join(name);
        if let Ok(meta) = fs::metadata(&candidate) {
            if meta.is_file() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        let ms = dur.as_millis() as i64;
                        if newest.map(|n| ms > n).unwrap_or(true) { newest = Some(ms); }
                    }
                }
            }
        }
    }
    newest
}

// Max sidecar size we're willing to read + store. Mirrors the JS
// helper (src/db/lyrics-extraction.js SIDECAR_MAX_BYTES). Real .lrc
// files are under 10KB; oversized sidecars are treated as "no
// sidecar" with a warning.
const SIDECAR_MAX_BYTES: u64 = 256 * 1024;

// Read a file at `path`, bailing on oversized content or read errors
// the same way the JS helper does. Returns the file contents (BOM-
// stripped) or None.
fn read_sidecar(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() { return None; }
    if meta.len() > SIDECAR_MAX_BYTES {
        eprintln!(
            "Warning: ignoring oversized lyrics sidecar ({} bytes, max {}): {}",
            meta.len(), SIDECAR_MAX_BYTES, path.display(),
        );
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let clean = if text.starts_with('\u{FEFF}') { text[3..].to_string() } else { text };
    Some(clean)
}

// Return (contents, inferred-language) for the first matching sidecar.
// BOM is stripped — Windows LRC editors add one and it breaks the first
// line's timestamp parse.
fn read_lrc_sidecar(audio_path: &Path) -> Option<(String, Option<String>)> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    for suffix in LYRICS_LANG_PROBE {
        let (name, lang) = if suffix.is_empty() {
            (format!("{}.lrc", base), None)
        } else {
            (format!("{}.{}.lrc", base, suffix), Some((*suffix).to_string()))
        };
        if let Some(clean) = read_sidecar(&dir.join(&name)) {
            if !clean.trim().is_empty() {
                return Some((clean, lang));
            }
        }
    }
    None
}

fn read_txt_sidecar(audio_path: &Path) -> Option<String> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    if let Some(clean) = read_sidecar(&dir.join(format!("{}.txt", base))) {
        if !clean.trim().is_empty() { return Some(clean); }
    }
    None
}

// Cache-aware variants. Consult the DirListing first; only touch the
// filesystem when a candidate filename is known to exist. Matches the
// precedence and behaviour of the non-cached versions exactly — tests
// in test/lyrics-parity.test.mjs cover both in aggregate via the
// `--extract-lyrics` CLI which uses the standalone path.
fn read_lrc_sidecar_cached(
    audio_path: &Path,
    cache: &Mutex<HashMap<PathBuf, DirListing>>,
) -> Option<(String, Option<String>)> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();

    // Short-circuit when we already know this directory has no
    // .lrc/.txt files at all.
    if !with_dir_listing(dir, cache, |l| l.has_lyric_sidecars)? {
        return None;
    }

    let mut plan: Vec<(String, Option<String>)> = Vec::with_capacity(LYRICS_LANG_PROBE.len());
    for suffix in LYRICS_LANG_PROBE {
        let (name, lang) = if suffix.is_empty() {
            (format!("{}.lrc", base), None)
        } else {
            (format!("{}.{}.lrc", base, suffix), Some((*suffix).to_string()))
        };
        plan.push((name, lang));
    }

    let to_try: Vec<(String, Option<String>)> = with_dir_listing(dir, cache, |listing| {
        plan.into_iter()
            .filter(|(name, _)| listing.names.contains(&name.to_lowercase()))
            .collect::<Vec<_>>()
    })?;

    for (name, lang) in to_try {
        if let Some(clean) = read_sidecar(&dir.join(&name)) {
            if !clean.trim().is_empty() {
                return Some((clean, lang));
            }
        }
    }
    None
}

fn read_txt_sidecar_cached(
    audio_path: &Path,
    cache: &Mutex<HashMap<PathBuf, DirListing>>,
) -> Option<String> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();

    if !with_dir_listing(dir, cache, |l| l.has_lyric_sidecars)? {
        return None;
    }

    let target = format!("{}.txt", base);
    let present = with_dir_listing(dir, cache, |listing| {
        listing.names.contains(&target.to_lowercase())
    }).unwrap_or(false);
    if !present { return None; }

    let clean = read_sidecar(&dir.join(&target))?;
    if clean.trim().is_empty() { None } else { Some(clean) }
}

// Standalone re-implementation of the scanner's lyrics extraction
// path, used by the `--extract-lyrics` CLI subcommand for the
// JS↔Rust parity test. Returns the four column values without
// touching a DB. MUST stay byte-identical with the scan-path logic
// above; any change to ordering or precedence belongs in both places.
fn extract_lyrics_for_cli(audio_path: &Path)
    -> Result<(Option<String>, Option<String>, Option<String>, Option<i64>), Box<dyn std::error::Error>>
{
    let mut embedded: Option<String> = None;
    let mut synced:   Option<String> = None;
    let mut lang:     Option<String> = None;

    // Pass 1: embedded tags (mirror of the in-scan block). Uses the
    // same lofty ItemKey values so USLT / Vorbis LYRICS / MP4 ©lyr /
    // APE Lyrics all normalise. Relaxed parse so partial-broken tags
    // don't drop the whole file.
    let parse_opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    if let Ok(tagged) = Probe::open(audio_path).and_then(|p| p.options(parse_opts).read()) {
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.get_string(&ItemKey::Lyrics) {
                let s = t.trim();
                if !s.is_empty() {
                    if looks_like_lrc(s) { synced   = Some(s.to_string()); }
                    else                 { embedded = Some(s.to_string()); }
                }
            }
            if let Some(l) = tag.get_string(&ItemKey::Language) {
                lang = normalise_lang(l);
            }
        }
    }

    // Pass 2: sidecars — probe only when we don't already have the
    // better variant. Same precedence as the in-scan block.
    let mtime = sidecar_mtime(audio_path);
    if synced.is_none() {
        if let Some((text, suffix_lang)) = read_lrc_sidecar(audio_path) {
            synced = Some(text);
            if lang.is_none() {
                lang = suffix_lang.and_then(|l| normalise_lang(&l));
            }
        }
    }
    if synced.is_none() && embedded.is_none() {
        if let Some(text) = read_txt_sidecar(audio_path) {
            if looks_like_lrc(&text) { synced   = Some(text); }
            else                      { embedded = Some(text); }
        }
    }

    Ok((embedded, synced, lang, mtime))
}

// ── Genre helpers ────────────────────────────────────────────────────────────

fn find_or_create_genre(
    conn: &Connection,
    cache: &Mutex<HashMap<String, i64>>,
    name: &str,
) -> Result<i64, rusqlite::Error> {
    if let Some(&id) = cache.lock().unwrap().get(name) {
        return Ok(id);
    }
    let existing: Option<i64> = conn
        .prepare_cached("SELECT id FROM genres WHERE name = ?")?
        .query_row([name], |row| row.get(0))
        .optional()?;
    let id = match existing {
        Some(id) => id,
        None => {
            conn.prepare_cached("INSERT INTO genres (name) VALUES (?)")?
                .execute([name])?;
            conn.last_insert_rowid()
        }
    };
    cache.lock().unwrap().insert(name.to_string(), id);
    Ok(id)
}

fn set_track_genres(
    conn: &Connection,
    cache: &Mutex<HashMap<String, i64>>,
    track_id: i64,
    genre_str: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let genre_str = match genre_str {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(()),
    };

    let mut stmt = conn.prepare_cached(
        "INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)",
    )?;
    for part in genre_str.split(&[',', ';', '/'][..]) {
        let name = part.trim();
        if name.is_empty() { continue; }
        let genre_id = find_or_create_genre(conn, cache, name)?;
        stmt.execute(rusqlite::params![track_id, genre_id])?;
    }
    Ok(())
}

// ── MD5 hash ────────────────────────────────────────────────────────────────

// ── Dual-hash: file_hash (whole file) + audio_hash (audio payload only) ────
//
// audio_hash strips tag regions so user-facing state (stars, play counts,
// bookmarks, play queue) survives tag-only edits. MUST produce the same
// output as src/db/audio-hash.js `computeHashes` — parity is enforced by
// test/audio-hash-parity.test.mjs. Any change to the byte-range logic must
// land in both implementations simultaneously.

// MP3 & AAC (ADTS): strip ID3v2 prefix + ID3v1 suffix + APEv2 suffix.
// See src/db/audio-hash.js for the spec references — this impl mirrors
// `mp3OrAacAudioRange` byte-for-byte.
//
// Generic over any `Read + Seek` so the same code serves both the
// file-backed path (fs::File) and the buffered path (Cursor<&[u8]>).
fn mp3_or_aac_audio_range<R: Read + Seek>(file: &mut R, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 10 { return None; }

    let mut head = [0u8; 10];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut head).ok()?;

    let mut start: u64 = 0;
    if head[0] == b'I' && head[1] == b'D' && head[2] == b'3' {
        let tag_size: u64 =
            ((head[6] & 0x7f) as u64) << 21 |
            ((head[7] & 0x7f) as u64) << 14 |
            ((head[8] & 0x7f) as u64) << 7  |
             (head[9] & 0x7f) as u64;
        start = 10 + tag_size;
        if head[5] & 0x10 != 0 { start += 10; }
    }

    let mut end: u64 = file_size;
    if file_size >= 128 {
        let mut trailer = [0u8; 3];
        file.seek(SeekFrom::Start(file_size - 128)).ok()?;
        file.read_exact(&mut trailer).ok()?;
        if trailer == *b"TAG" { end = file_size - 128; }
    }

    if end >= 32 {
        let footer_at = end - 32;
        let mut full = [0u8; 32];
        file.seek(SeekFrom::Start(footer_at)).ok()?;
        if file.read_exact(&mut full).is_ok() && &full[..8] == b"APETAGEX" {
            let sz = u32::from_le_bytes([full[12], full[13], full[14], full[15]]) as u64;
            let flags = u32::from_le_bytes([full[20], full[21], full[22], full[23]]);
            let has_header = (flags & 0x8000_0000) != 0;
            let ape_total = sz + if has_header { 32 } else { 0 };
            if end >= ape_total { end -= ape_total; }
        }
    }

    if start >= end { return None; }
    Some(vec![(start, end)])
}

// FLAC: walk metadata blocks until last_flag set, then audio follows.
fn flac_audio_range<R: Read + Seek>(file: &mut R, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 4 { return None; }
    let mut magic = [0u8; 4];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut magic).ok()?;
    if &magic != b"fLaC" { return None; }

    let mut cursor: u64 = 4;
    let mut hdr = [0u8; 4];
    loop {
        if cursor + 4 > file_size { return None; }
        file.seek(SeekFrom::Start(cursor)).ok()?;
        file.read_exact(&mut hdr).ok()?;
        let last = (hdr[0] & 0x80) != 0;
        let len: u64 = ((hdr[1] as u64) << 16) | ((hdr[2] as u64) << 8) | (hdr[3] as u64);
        cursor += 4 + len;
        if last { break; }
        if cursor > file_size { return None; }
    }
    if cursor >= file_size { return None; }
    Some(vec![(cursor, file_size)])
}

// WAV (RIFF/WAVE): walk chunks, return the `data` chunk payload. Other
// chunks (LIST/INFO, ID3, bext, iXML) are skipped.
fn wav_audio_range<R: Read + Seek>(file: &mut R, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 12 { return None; }
    let mut hdr = [0u8; 12];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" { return None; }

    let mut cursor: u64 = 12;
    let mut chunk_hdr = [0u8; 8];
    while cursor + 8 <= file_size {
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read_exact(&mut chunk_hdr).is_err() { return None; }
        let id = &chunk_hdr[0..4];
        let size = u32::from_le_bytes([chunk_hdr[4], chunk_hdr[5], chunk_hdr[6], chunk_hdr[7]]) as u64;
        let payload_start = cursor + 8;
        let payload_end = (payload_start + size).min(file_size);
        if id == b"data" { return Some(vec![(payload_start, payload_end)]); }
        // WAV chunks are word-aligned; odd-length payloads pad with one byte.
        cursor = payload_start + size + (size & 1);
    }
    None
}

// Ogg: walk pages; hash payloads of audio pages (from first page with
// granule_position > 0 onwards). Page headers are NOT hashed — their
// page_sequence_number drifts when header pages change size.
fn ogg_audio_range<R: Read + Seek>(file: &mut R, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 27 { return None; }
    let mut ranges = Vec::new();
    let mut audio_started = false;
    let mut cursor: u64 = 0;
    let mut page_hdr = [0u8; 27];

    while cursor + 27 <= file_size {
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read_exact(&mut page_hdr).is_err() { break; }
        if &page_hdr[0..4] != b"OggS" { break; }
        let granule = i64::from_le_bytes([
            page_hdr[6], page_hdr[7], page_hdr[8], page_hdr[9],
            page_hdr[10], page_hdr[11], page_hdr[12], page_hdr[13],
        ]);
        let page_segments = page_hdr[26] as usize;
        let mut seg_table = vec![0u8; page_segments];
        if file.read_exact(&mut seg_table).is_err() { return None; }
        let payload_size: u64 = seg_table.iter().map(|&b| b as u64).sum();
        let payload_start = cursor + 27 + page_segments as u64;
        let payload_end = payload_start + payload_size;
        if payload_end > file_size { return None; }  // truncated

        if audio_started {
            ranges.push((payload_start, payload_end));
        } else if granule > 0 {
            audio_started = true;
            ranges.push((payload_start, payload_end));
        }
        // granule == 0 or -1: pre-audio header region, skip.

        cursor = payload_end;
    }

    if ranges.is_empty() { None } else { Some(ranges) }
}

// MP4 / M4A / M4B: walk atom tree, hash `mdat` payload(s). `moov` (where
// metadata lives) is skipped automatically. Supports 64-bit extended
// sizes (size == 1) and extends-to-EOF (size == 0).
fn mp4_audio_range<R: Read + Seek>(file: &mut R, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 8 { return None; }
    let mut ranges = Vec::new();
    let mut cursor: u64 = 0;
    let mut atom_hdr = [0u8; 16];

    while cursor + 8 <= file_size {
        let to_read = 16usize.min((file_size - cursor) as usize);
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read(&mut atom_hdr[..to_read]).ok()? < 8 { break; }
        let sz32 = u32::from_be_bytes([atom_hdr[0], atom_hdr[1], atom_hdr[2], atom_hdr[3]]);
        let type_bytes = &atom_hdr[4..8];

        let (header_len, atom_end): (u64, u64) = if sz32 == 1 {
            // 64-bit extended size follows at bytes 8..16.
            if to_read < 16 { break; }
            let sz64 = u64::from_be_bytes([
                atom_hdr[8], atom_hdr[9], atom_hdr[10], atom_hdr[11],
                atom_hdr[12], atom_hdr[13], atom_hdr[14], atom_hdr[15],
            ]);
            (16, cursor + sz64)
        } else if sz32 == 0 {
            (8, file_size)
        } else {
            (8, cursor + sz32 as u64)
        };
        if atom_end > file_size || atom_end < cursor + header_len { break; }

        if type_bytes == b"mdat" && atom_end > cursor + header_len {
            ranges.push((cursor + header_len, atom_end));
        }
        cursor = atom_end;
    }

    if ranges.is_empty() { None } else { Some(ranges) }
}

fn audio_ranges_for_ext<R: Read + Seek>(
    file: &mut R, ext: &str, file_size: u64,
) -> Option<Vec<(u64, u64)>> {
    match ext {
        "mp3" | "aac"            => mp3_or_aac_audio_range(file, file_size),
        "flac"                   => flac_audio_range(file, file_size),
        "wav"                    => wav_audio_range(file, file_size),
        "ogg" | "opus"           => ogg_audio_range(file, file_size),
        "m4a" | "m4b" | "mp4"    => mp4_audio_range(file, file_size),
        _ => None,
    }
}

// ── Waveform generation (symphonia-powered) ───────────────────────────────
//
// Decodes the audio stream, downmixes to mono magnitudes, and emits NUM_BARS
// peak values (u8, 0-255). .opus is skipped because symphonia 0.5 lacks an
// Opus decoder. On any decoder/IO error we fall back to None so the scanner
// continues and the on-demand endpoint can try ffmpeg later.
//
// Two decode strategies:
//   (a) Streaming — when track.codec_params.n_frames is populated, map each
//       decoded frame directly to its bar by index (bar = frame_idx * N / total).
//       Memory: O(1). Used for most formats (MP3, FLAC, Ogg Vorbis, AAC/M4A).
//   (b) Buffered — when n_frames is None (notably WAV, where symphonia's
//       format reader doesn't populate it), collect mono magnitudes into a
//       Vec and bin by the actual count at the end. Memory: O(n_frames).
//       Capped at MAX_BUFFERED_FRAMES to keep worst-case memory bounded on
//       very long WAV files; past that we truncate.
const MAX_BUFFERED_FRAMES: usize = 30 * 1024 * 1024;  // ~10 min at 48 kHz

// Decode a media source directly. Both the file-backed and in-memory
// paths land here; the only difference is the concrete `MediaSource`
// behind the Box — `fs::File` for large files (streaming) or
// `Cursor<Vec<u8>>` for the buffered path (zero re-read because the
// bytes are already in RAM from the hashing pass).
// Decode result. `bars` is the 800-bar peak waveform the cache writes
// to disk; `samples` is the raw mono downmix (signed, source sample
// rate, capped at MAX_ANALYSIS_SAMPLES) that stratum-dsp consumes for
// BPM + key analysis when `retain_samples=true`. Samples is None
// when the caller didn't ask for them or the decode produced zero
// frames; `sample_rate` is 0 in the same edge case.
struct WaveformOutput {
    bars: [u8; NUM_BARS],
    samples: Option<Vec<f32>>,
    sample_rate: u32,
}

// Cap retained samples at ~5 minutes of mono audio at 44.1 kHz
// (≈ 52 MB f32). With ~8 rayon workers active that's a ~420 MB
// peak working set on top of the existing per-file buffer — fits
// comfortably on typical hardware, and stratum-dsp's BPM/key
// algorithms don't gain meaningful accuracy from longer windows
// (they're statistical over the whole input, so the first ~5 min
// of a track is plenty). For non-44.1kHz sources the wall-clock
// duration of the retained window scales with sample rate (48k →
// ~4.6 min, 22.05k → ~10 min) — still well above the floor that
// the algorithms need.
const MAX_ANALYSIS_SAMPLES: usize = 13_230_000;

fn waveform_from_source(
    source: Box<dyn symphonia::core::io::MediaSource>, ext: &str, retain_samples: bool,
) -> Option<WaveformOutput> {
    // Symphonia doesn't ship an Opus decoder in 0.5. We want to keep the
    // binary pure-Rust (no libopus), so skip .opus here and let the
    // on-demand endpoint handle it via ffmpeg on first playback.
    if ext == "opus" { return None; }

    let mss = MediaSourceStream::new(source, Default::default());

    let mut hint = Hint::new();
    hint.with_extension(ext);

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;

    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = track.id;
    let n_frames = track.codec_params.n_frames;   // None → buffered path
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    // Source sample rate. Defaults to 44.1k as a sensible fallback if
    // symphonia couldn't determine it (rare — most container headers
    // include sr). Used only by the analysis path; the waveform path
    // is sample-rate-agnostic (bins by frame index).
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    let mut peaks = [0f32; NUM_BARS];
    let mut buffered: Vec<f32> = Vec::new();
    // Raw signed mono downmix for stratum-dsp. Only populated when
    // the caller asked for analysis; kept independent from the
    // existing `buffered` magnitudes Vec because the abs-then-sum
    // waveform metric is lossy for chroma/key extraction.
    let mut raw_samples: Vec<f32> = Vec::new();
    if retain_samples {
        // Pre-reserve up to the cap when we know the frame count
        // (streaming path). Saves dozens of grow-and-memcpy cycles
        // mid-decode for a typical 3-5 min track. Falls back to
        // organic growth on the buffered (n_frames=None) path.
        if let Some(n) = n_frames {
            raw_samples.reserve_exact((n as usize).min(MAX_ANALYSIS_SAMPLES));
        }
    }
    let mut frame_idx: u64 = 0;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut truncated = false;

    'outer: loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,   // EOF or unrecoverable — whatever we have is what we get
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,   // skip corrupt packet, keep going
        };

        if sample_buf.is_none() {
            let spec = *decoded.spec();
            let capacity = decoded.capacity() as u64;
            sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
        }
        let buf = sample_buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);

        // Downmix interleaved samples to mono. The peak path uses
        // abs-sum/channels (perceived loudness, unchanged from the
        // original implementation); the analysis path uses
        // signed-sum/channels (preserves phase so stratum-dsp's
        // chroma extraction sees an unmangled signal). For channels
        // in-phase these collapse to the same number; for stereo
        // with out-of-phase content the difference matters.
        for chunk in buf.samples().chunks(channels) {
            let mut abs_sum = 0f32;
            let mut signed_sum = 0f32;
            for &s in chunk {
                abs_sum += s.abs();
                signed_sum += s;
            }
            let mag = abs_sum / (channels as f32);

            if retain_samples && raw_samples.len() < MAX_ANALYSIS_SAMPLES {
                raw_samples.push(signed_sum / (channels as f32));
            }

            match n_frames {
                Some(total) if total > 0 => {
                    let bar = (frame_idx.saturating_mul(NUM_BARS as u64) / total) as usize;
                    if bar < NUM_BARS && mag > peaks[bar] {
                        peaks[bar] = mag;
                    }
                }
                _ => {
                    if buffered.len() >= MAX_BUFFERED_FRAMES {
                        truncated = true;
                        break 'outer;
                    }
                    buffered.push(mag);
                }
            }
            frame_idx += 1;
        }
    }

    // Guard against symphonia emitting zero frames (unsupported codec that
    // probed OK but decoded empty). Distinguish from the buffered-truncated
    // path, which does have data.
    if frame_idx == 0 && !truncated { return None; }

    // If we went the buffered route, bin now that we know the true length.
    if n_frames.is_none() || n_frames == Some(0) {
        let total = buffered.len();
        if total == 0 { return None; }
        for i in 0..NUM_BARS {
            let start = i * total / NUM_BARS;
            let end = ((i + 1) * total / NUM_BARS).max(start + 1).min(total);
            let mut peak = 0f32;
            for &m in &buffered[start..end] {
                if m > peak { peak = m; }
            }
            peaks[i] = peak;
        }
    }

    let mut bars = [0u8; NUM_BARS];
    for i in 0..NUM_BARS {
        bars[i] = (peaks[i].clamp(0.0, 1.0) * 255.0).round() as u8;
    }

    let samples = if retain_samples && !raw_samples.is_empty() {
        Some(raw_samples)
    } else {
        None
    };
    Some(WaveformOutput { bars, samples, sample_rate })
}

// File-backed waveform entry point — retained for the streaming
// fall-back path (very large files, or when the buffered path chose
// not to load the file). Opens the file once; symphonia reads it as
// needed.
fn waveform_from_symphonia(path: &Path, ext: &str, retain_samples: bool) -> Option<WaveformOutput> {
    let file = fs::File::open(path).ok()?;
    waveform_from_source(Box::new(file), ext, retain_samples)
}

// In-memory waveform entry point — consumes the buffer we already
// allocated for hashing + lofty. Symphonia operates on `Cursor<Vec<u8>>`
// which is a zero-I/O MediaSource, so decode is bottlenecked only by
// CPU (the codec), not by disk/network.
fn waveform_from_bytes(buf: Vec<u8>, ext: &str, retain_samples: bool) -> Option<WaveformOutput> {
    waveform_from_source(Box::new(Cursor::new(buf)), ext, retain_samples)
}

// Genre-keyword filter for tracks that aren't music. stratum-dsp's
// BPM + key algorithms are tuned for music and produce noise on
// spoken-word / narrative content; flagging via the tagged genre is
// the cheapest reliable signal we have without delving into MP4-
// specific atoms (stik=2 / podcast / audiobook). Case-insensitive
// substring match so "Spoken Word", "Audio Book / Spoken Word",
// "Podcast - Tech" etc. all hit. The duration cap in extract_track
// catches the remainder (long-form spoken content nearly always
// exceeds 30 minutes per file).
fn is_audiobook_genre(genre: Option<&str>) -> bool {
    let Some(g) = genre else { return false; };
    let lower = g.to_lowercase();
    lower.contains("audiobook")
        || lower.contains("audio book")
        || lower.contains("spoken")
        || lower.contains("podcast")
        || lower.contains("audible")
        || lower.contains("lecture")
}

// Hash a whole-file buffer. Direct slice access means no seeks, no
// buffered reads, and no boundary-straddling bookkeeping — we already
// have every byte in memory.
//
// Single-pass dual-hash (matches the design of the streaming
// `compute_hashes` above): for each audio range we feed the bytes to
// both file_ctx and audio_ctx; gap bytes between ranges feed only
// file_ctx. The previous two-pass version did `Md5::digest(buf)`
// (one full pass) plus a second walk over the audio ranges,
// re-reading ~0.95×buf bytes from RAM. Single-pass cuts that second
// read entirely. On a typical 14 MB track that's ~13 MB of memory
// bandwidth saved per file — small but cumulative across a library.
fn compute_hashes_from_bytes(buf: &[u8], ext: &str) -> (String, Option<String>) {
    // audio_ranges_for_ext still needs a Read + Seek to walk headers;
    // a Cursor over the slice satisfies that without copying.
    let mut cursor = Cursor::new(buf);
    let ranges = audio_ranges_for_ext(&mut cursor, ext, buf.len() as u64)
        .unwrap_or_default();

    let mut file_ctx = Md5::new();

    if ranges.is_empty() {
        // No audio-range extractor for this format; just hash the
        // whole file. One MD5 call is faster than splitting into
        // per-range slices for no reason.
        file_ctx.update(buf);
        return (hex_lower(file_ctx.finalize()), None);
    }

    // Walk ranges in order. The ranges contract is the same as in
    // compute_hashes: monotonically increasing, non-overlapping. So
    // [last, rs) is always a valid gap region and we never rewind.
    let mut audio_ctx = Md5::new();
    let mut last = 0usize;
    for (rs, re) in &ranges {
        let s = *rs as usize;
        let e = *re as usize;
        if s > last {
            // Gap (header / tag bytes) — file-only.
            file_ctx.update(&buf[last..s]);
        }
        // In-range audio bytes — feed both contexts. The order
        // matches the original two-pass impl, preserving byte-for-
        // byte parity with src/db/audio-hash.js (enforced by
        // audio-hash-parity.test.mjs).
        let chunk = &buf[s..e];
        file_ctx.update(chunk);
        audio_ctx.update(chunk);
        last = e;
    }
    // Trailing gap (e.g. ID3v1 tag at file end).
    if last < buf.len() {
        file_ctx.update(&buf[last..]);
    }

    (hex_lower(file_ctx.finalize()), Some(hex_lower(audio_ctx.finalize())))
}

fn compute_hashes(
    filepath: &Path, ext: &str,
) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    let mut file = fs::File::open(filepath)?;
    let file_size = file.metadata()?.len();

    // Parse the audio byte ranges first. Each format's extractor only
    // reads headers/atom tables to locate the audio payload, so this is
    // cheap relative to a full-file read. The ranges returned are
    // monotonically increasing and non-overlapping (built by walking
    // the file linearly), which lets the single-pass loop below feed
    // them into the audio_hash context in the same order as the
    // previous two-pass impl — preserving byte-for-byte MD5 parity
    // with src/db/audio-hash.js (enforced by audio-hash-parity.test.mjs).
    let ranges: Vec<(u64, u64)> = audio_ranges_for_ext(&mut file, ext, file_size)
        .unwrap_or_default();
    let has_ranges = !ranges.is_empty();

    // Single-pass hash. Every byte is fed into `file_ctx`; bytes whose
    // file offset falls inside an audio range are also fed into
    // `audio_ctx`. For MP3/FLAC/WAV the audio range is ~95 % of the
    // file, so this halves total file I/O vs. the old two-pass approach
    // — most of the win on slow storage (CIFS, spinning disks).
    file.seek(SeekFrom::Start(0))?;
    let mut file_ctx = Md5::new();
    let mut audio_ctx = if has_ranges { Some(Md5::new()) } else { None };

    let mut buf = [0u8; 65536];
    let mut pos: u64 = 0;
    // Index of the first range that may still have bytes in front of
    // us. Advanced as we pass ranges entirely; never rewound.
    let mut range_idx = 0usize;

    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        file_ctx.update(&buf[..n]);

        if let Some(actx) = audio_ctx.as_mut() {
            let buf_start = pos;
            let buf_end   = pos + n as u64;

            // Drop ranges that ended on or before this buffer starts.
            while range_idx < ranges.len() && ranges[range_idx].1 <= buf_start {
                range_idx += 1;
            }

            // Feed every range that intersects [buf_start, buf_end).
            // A single buffer can cover many small ranges (Ogg pages)
            // or be fully contained inside one large range (FLAC mdat).
            let mut i = range_idx;
            while i < ranges.len() {
                let (rs, re) = ranges[i];
                if rs >= buf_end { break; }              // range is entirely past this buffer
                let s = rs.max(buf_start) - buf_start;   // buffer-relative start
                let e = re.min(buf_end)   - buf_start;   // buffer-relative end
                if e > s {
                    actx.update(&buf[s as usize..e as usize]);
                }
                if re > buf_end { break; }               // range continues into next buffer
                i += 1;
            }
        }

        pos += n as u64;
    }

    let file_hash  = hex_lower(file_ctx.finalize());
    let audio_hash = audio_ctx.map(|ctx| hex_lower(ctx.finalize()));
    Ok((file_hash, audio_hash))
}

// ── Album art: embedded ─────────────────────────────────────────────────────

fn save_embedded_art(pic: &lofty::picture::Picture, config: &ScanConfig) -> Option<String> {
    let data = pic.data();
    let ext = pic.mime_type().map(mime_to_ext).unwrap_or("jpeg");
    let hash = hex_lower(Md5::digest(data));
    let filename = format!("{}.{}", hash, ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);

    // The exists() check avoids redundant disk work when this hash
    // has already been written. It's racy under parallelism — two
    // workers from the same album typically have the same embedded
    // cover and both see "doesn't exist" — but write_atomic makes
    // the actual write race-safe (either rename wins, content is
    // correct in both outcomes, no 0-byte window for readers).
    if !art_path.exists() {
        write_atomic(&art_path, data)?;
        if config.compress_image {
            compress_album_art(data, &filename, &config.album_art_directory);
        }
    }

    Some(filename)
}

// ── Album art: directory fallback ───────────────────────────────────────────

fn check_directory_for_album_art(
    filepath: &Path,
    config: &ScanConfig,
    cache: &Mutex<HashMap<String, Option<String>>>,
) -> Option<String> {
    let dir = filepath.parent()?;
    let dir_key = dir.to_string_lossy().to_string();

    {
        let guard = cache.lock().unwrap();
        if let Some(cached) = guard.get(&dir_key) {
            return cached.clone();
        }
    }

    let mut images: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            // `entry.file_type()` uses `d_type` from `getdents` on
            // Unix / the cached FindNextFile metadata on Windows —
            // no per-entry stat. `p.is_file()` (the previous code)
            // calls `fs::metadata()`, one stat per entry.
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file { continue; }
            let p = entry.path();
            let e = file_ext(&p).to_ascii_lowercase();
            if e == "jpg" || e == "png" {
                images.push(p);
            }
        }
    }

    if images.is_empty() {
        cache.lock().unwrap().insert(dir_key, None);
        return None;
    }

    let priority = ["folder.jpg", "cover.jpg", "album.jpg", "folder.png", "cover.png", "album.png"];
    let chosen = images
        .iter()
        .find(|p| {
            p.file_name()
                .map(|n| priority.contains(&n.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .unwrap_or(&images[0]);

    let data = fs::read(chosen).ok()?;
    let pic_ext = file_ext(chosen);
    let hash = hex_lower(Md5::digest(&data));
    let filename = format!("{}.{}", hash, pic_ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);

    // Same race story as save_embedded_art: two workers in different
    // directories whose chosen folder.jpg happens to MD5 to the same
    // hash would both write to the same destination. write_atomic
    // makes that race-safe.
    let is_new = !art_path.exists();
    if is_new {
        write_atomic(&art_path, &data)?;
    }

    cache.lock().unwrap().insert(dir_key, Some(filename.clone()));

    if is_new && config.compress_image {
        compress_album_art(&data, &filename, &config.album_art_directory);
    }

    Some(filename)
}

// ── Image compression ───────────────────────────────────────────────────────

fn compress_album_art(data: &[u8], name: &str, art_dir: &str) {
    let Ok(img) = image::load_from_memory(data) else { return; };
    let large = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
    save_resized(&large, art_dir, &format!("zl-{}", name));
    let small = img.resize(92, 92, image::imageops::FilterType::Lanczos3);
    save_resized(&small, art_dir, &format!("zs-{}", name));
}

// Encode `img` in the format inferred from the filename's extension,
// then atomically write it to `<art_dir>/<filename>`. Going through
// a Vec<u8> + write_atomic instead of `img.save(path)` keeps the
// resize-variant writes race-safe for the same reason as the main
// art file: parallel workers can race past the exists()-check and
// both call compress_album_art for the same hash.
fn save_resized(img: &image::DynamicImage, art_dir: &str, filename: &str) {
    let path = Path::new(art_dir).join(filename);
    let Ok(format) = image::ImageFormat::from_path(&path) else { return; };
    let mut buf = Vec::new();
    if img.write_to(&mut Cursor::new(&mut buf), format).is_err() {
        return;
    }
    let _ = write_atomic(&path, &buf);
}

// ── Utilities ───────────────────────────────────────────────────────────────

// Borrowed extension — the old version eagerly allocated a String on
// every call, which for the main scan loop fires per-entry twice (once
// during the counting pass, once during processing). Callers that need
// lowercase use `.to_ascii_lowercase()` at the call site.
fn file_ext(p: &Path) -> &str {
    p.extension().and_then(|e| e.to_str()).unwrap_or("")
}

fn mime_to_ext(mime: &MimeType) -> &'static str {
    match mime {
        MimeType::Png => "png",
        MimeType::Jpeg => "jpeg",
        MimeType::Tiff => "tiff",
        MimeType::Bmp => "bmp",
        MimeType::Gif => "gif",
        _ => "jpeg",
    }
}

// Lowercase hex encode for hash outputs. RustCrypto's `Md5::finalize`
// returns a `GenericArray<u8, U16>` that doesn't directly implement
// `fmt::LowerHex` the way the old `md5` crate's `Digest` type did, so
// we do the two-chars-per-byte conversion ourselves. Matches Node's
// `crypto.createHash('md5').digest('hex')` byte-for-byte.
fn hex_lower(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write;
    let bytes = bytes.as_ref();
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(s, "{:02x}", b).unwrap();
    }
    s
}

fn parse_replaygain_db(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches("dB").trim_end_matches("db").trim();
    s.parse::<f64>().ok()
}
