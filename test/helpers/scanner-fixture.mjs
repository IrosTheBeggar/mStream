/**
 * Build a "diverse" fixture library that exercises every per-file
 * codepath the parallel scanner will touch. Designed so that:
 *
 *   - Multiple tracks share the same artist (artist_cache contention)
 *   - Multiple tracks share the same album (album upsert + art coalesce)
 *   - A compilation album with mixed track artists exists (Various
 *     Artists fallback, M2M position)
 *   - At least one track has multi-value artist tags ("Foo feat. Bar")
 *   - At least one track per supported format (mp3 / flac / ogg / m4a / wav)
 *   - A directory carries an embedded album-art track AND a folder.jpg
 *   - At least two tracks share an audio_hash (waveform dedup race)
 *   - There's a sidecar .lrc and a sidecar .txt
 *   - Enough files to actually distribute across N workers — 30+
 *
 * Generation is ffmpeg-based, identical pattern to the other parity
 * tests. Each file gets ~1 second of silence with whatever metadata
 * the table specifies; that's enough for symphonia to decode and
 * produce a valid waveform.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { FFMPEG } from './scanner-runner.mjs';
import { appendId3v23TextFrames } from './id3.mjs';

// Exported so focused fixture builders (scanner-multi-art.test.mjs)
// can reuse the same ffmpeg plumbing without re-rolling it.
export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)); }
    });
  });
}

// `meta` is a flat object {tag: value}. Multi-value tags can be passed
// as arrays — ffmpeg accepts repeated -metadata flags but only the last
// wins for most formats; for our purposes the parity test cares about
// what the SCANNER reads back, so single-value-per-tag is enough to
// drive the codepaths.
export async function makeAudio(filepath, codecArgs, meta = {}, durationSec = 1) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const metaArgs = [];
  for (const [k, v] of Object.entries(meta)) {
    metaArgs.push('-metadata', `${k}=${v}`);
  }
  await ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:duration=${durationSec}`,
    ...codecArgs, ...metaArgs,
    filepath,
  ]);
}

// MP3 with one or more EMBEDDED APIC pictures: tone + lavfi solid-color
// images muxed with the attached_pic disposition (the standard ffmpeg
// cover-embedding recipe). Distinct colors → distinct image bytes →
// distinct content-addressed cache names. Exported for the multi-art
// scanner tests.
export async function makeAudioWithArt(filepath, colors, meta = {}) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const colorList = Array.isArray(colors) ? colors : [colors];
  const inputs = [];
  const maps = [];
  for (let i = 0; i < colorList.length; i++) {
    inputs.push('-f', 'lavfi', '-i', `color=color=${colorList[i]}:size=64x64:duration=0.1`);
    maps.push('-map', `${i + 1}:v`);
  }
  const metaArgs = [];
  for (const [k, v] of Object.entries(meta)) { metaArgs.push('-metadata', `${k}=${v}`); }
  await ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:duration=1',
    ...inputs,
    '-map', '0:a', ...maps, '-frames:v', '1',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-c:v', 'mjpeg',
    ...colorList.map((_, i) => [`-disposition:v:${i}`, 'attached_pic']).flat(),
    '-id3v2_version', '3',
    ...metaArgs,
    filepath,
  ]);
}

const MP3   = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const FLAC  = ['-c:a', 'flac'];
const OGG   = ['-c:a', 'libvorbis', '-q:a', '2'];
const M4A   = ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'];
const WAV   = ['-c:a', 'pcm_s16le'];

// MP3 with a REAL ID3v2.3 TCMP (compilation) frame. ffmpeg writes the
// rest of the tags, then TCMP is appended by hand — its mp3 muxer maps
// `-metadata compilation=1` to a TXXX:compilation frame that NEITHER
// music-metadata's common.compilation nor lofty's FlagCompilation
// reads. (Vorbis is different: there ffmpeg writes a real COMPILATION
// comment both scanners honour.) Exported for compilation-flag tests.
export async function makeCompilationMp3(filepath, meta = {}) {
  await makeAudio(filepath, MP3, meta);
  await appendId3v23TextFrames(filepath, { TCMP: '1' });
}

export async function buildFixtureLibrary(rootDir) {
  await fs.mkdir(rootDir, { recursive: true });

  // ── Album 1: "Echoes" by Solo Artist (5 tracks, single artist) ────
  // Exercises the simplest case: one album, one artist, several
  // tracks. The artist_cache should hit on tracks 2-5; the album
  // upsert should hit on tracks 2-5.
  const a1 = path.join(rootDir, 'Solo Artist', 'Echoes');
  for (let i = 1; i <= 5; i++) {
    // V32: BPM + key tags on a subset of tracks so both scanners are
    // forced to extract them and the parity test compares non-NULL
    // values. ffmpeg writes BPM / INITIALKEY into the FLAC Vorbis
    // comment; music-metadata + Lofty both surface them via the
    // common.bpm / common.key path. Out-of-range / mistyped values
    // here would fail parity, so keep them within 20..=300 / ≤12 chars.
    const tags = {
      title:   `Track ${i}`,
      artist:  'Solo Artist',
      album:   'Echoes',
      date:    '2021',
      track:   `${i}/5`,
      genre:   'Ambient',
    };
    // music-metadata reads Vorbis-comment `KEY`; Lofty reads
    // `INITIALKEY`. Tagging the file with both names ensures BOTH
    // scanners extract '8A' so the parity snapshot has a non-NULL
    // musical_key column on this row (rather than trivially-equal
    // NULLs). This Vorbis-tag-name divergence is a real production
    // gap — files in the wild tagged with only one variant land in
    // exactly one scanner's column. Following PRs in the velvet port
    // should reconcile, but the data path is in place here.
    if (i === 1) { tags.BPM = '124'; tags.KEY = '8A'; tags.INITIALKEY = '8A'; }
    if (i === 2) { tags.BPM = '90';  /* no key — bpm_source still 'tag' */ }
    await makeAudio(path.join(a1, `${i.toString().padStart(2, '0')} Track ${i}.flac`), FLAC, tags);
  }

  // ── Album 2: "Collab" by Foo & Bar (6 tracks, two album-artists) ──
  // ALBUMARTIST splits to multiple values via the " / " delimiter
  // honoured by both scanners. Tests the M2M album_artists position
  // column ordering.
  const a2 = path.join(rootDir, 'Foo & Bar', 'Collab');
  for (let i = 1; i <= 6; i++) {
    // V32: ID3v2 path — ffmpeg maps the generic `TBPM` / `TKEY`
    // metadata onto the corresponding ID3v2 text frames. Track 1
    // carries both; track 2 carries a deliberately out-of-range BPM
    // (5) so both scanners must drop it to NULL (range check is
    // 20..=300).
    const tags = {
      title:        `Collab ${i}`,
      artist:       i % 2 === 0 ? 'Foo feat. Bar' : 'Bar feat. Foo',
      album:        'Collab',
      album_artist: 'Foo / Bar',
      date:         '2022',
      track:        `${i}/6`,
      genre:        'Electronic',
    };
    if (i === 1) { tags.TBPM = '128'; tags.TKEY = '7A'; }
    if (i === 2) { tags.TBPM = '5';   /* below range → both scanners drop to NULL */ }
    await makeAudio(path.join(a2, `${i.toString().padStart(2, '0')}.mp3`), MP3, tags);
  }

  // ── Album 3: "Various" compilation (10 tracks, different artists) ──
  // Compilation flag + no ALBUMARTIST → falls back to Various Artists.
  // Tests the various_artists_id cache and the album-artist fallback.
  // The flag is carried two ways so BOTH tag paths stay covered: tracks
  // 1-8 are OGG (ffmpeg writes a real Vorbis COMPILATION comment),
  // tracks 9-10 are MP3 with a hand-appended ID3v2.3 TCMP frame. All
  // ten must converge on ONE Various-Artists-owned album row.
  const a3 = path.join(rootDir, 'Various Artists', 'Various');
  const compilationArtists = [
    'Aria', 'Boris', 'Cleo', 'Drake', 'Eve', 'Frank', 'Gina', 'Hugo',
    'Iris', 'Jules',
  ];
  for (let i = 0; i < compilationArtists.length; i++) {
    const meta = {
      title:       `Comp Track ${i + 1}`,
      artist:      compilationArtists[i],
      album:       'Various',
      date:        '2023',
      track:       `${i + 1}/${compilationArtists.length}`,
      genre:       'Compilation',
    };
    const base = path.join(a3, `${(i + 1).toString().padStart(2, '0')}`);
    if (i < 8) {
      await makeAudio(`${base}.ogg`, OGG, { ...meta, compilation: '1' });
    } else {
      await makeCompilationMp3(`${base}.mp3`, meta);
    }
  }

  // ── Album 4: "Acoustic" by Solo Artist again (3 tracks) ───────────
  // Same artist as album 1, different album — exercises the album
  // cache miss for an existing artist.
  const a4 = path.join(rootDir, 'Solo Artist', 'Acoustic');
  for (let i = 1; i <= 3; i++) {
    await makeAudio(path.join(a4, `${i.toString().padStart(2, '0')}.m4a`), M4A, {
      title:  `Acoustic ${i}`,
      artist: 'Solo Artist',
      album:  'Acoustic',
      date:   '2024',
      track:  `${i}/3`,
      genre:  'Folk',
    });
  }

  // ── Album 5: "Mixed Format" — one track per format (5 tracks) ─────
  // Forces the per-format extractor codepaths in the same scan.
  const a5 = path.join(rootDir, 'Format Test', 'Mixed');
  await makeAudio(path.join(a5, '01.mp3'),  MP3,  { title: 'Test MP3',  artist: 'Format Test', album: 'Mixed', track: '1/5' });
  await makeAudio(path.join(a5, '02.flac'), FLAC, { title: 'Test FLAC', artist: 'Format Test', album: 'Mixed', track: '2/5' });
  await makeAudio(path.join(a5, '03.ogg'),  OGG,  { title: 'Test OGG',  artist: 'Format Test', album: 'Mixed', track: '3/5' });
  await makeAudio(path.join(a5, '04.m4a'),  M4A,  { title: 'Test M4A',  artist: 'Format Test', album: 'Mixed', track: '4/5' });
  await makeAudio(path.join(a5, '05.wav'),  WAV,  { title: 'Test WAV',  artist: 'Format Test', album: 'Mixed', track: '5/5' });

  // ── Album 6: directory album-art + sidecar lyrics (3 tracks) ──────
  // Drop a folder.jpg next to the tracks so check_directory_for_album_art
  // fires on every track in this directory; also drop a .lrc sidecar
  // so the lyrics codepath runs.
  const a6 = path.join(rootDir, 'Lyrics & Art', 'Album Six');
  await makeAudio(path.join(a6, '01.flac'), FLAC, { title: 'Lyrics A', artist: 'Lyric Artist', album: 'Album Six', track: '1/3' });
  await makeAudio(path.join(a6, '02.flac'), FLAC, { title: 'Lyrics B', artist: 'Lyric Artist', album: 'Album Six', track: '2/3' });
  await makeAudio(path.join(a6, '03.flac'), FLAC, { title: 'Lyrics C', artist: 'Lyric Artist', album: 'Album Six', track: '3/3' });

  // 1×1 white JPEG via ffmpeg's color filter — small and valid so the
  // album-art writer doesn't reject it.
  await ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=color=white:size=64x64:duration=0.1',
    '-frames:v', '1',
    path.join(a6, 'folder.jpg'),
  ]);

  // Synced LRC sidecar — matches the LRC heuristic in
  // looks_like_lrc (rust-parser) / src/db/lyrics-extraction.js.
  await fs.writeFile(path.join(a6, '01.lrc'),
    '[00:01.00]Lyric line one\n[00:02.50]Lyric line two\n');
  // Plain text sidecar on a different track.
  await fs.writeFile(path.join(a6, '02.txt'),
    'Plain unsynced lyrics for track two.\n');

  // EMBEDDED-art track in the same directory as folder.jpg — the mixed
  // embedded+folder case the V48 multi-art capture must keep
  // deterministic (the default election + the reference rows for
  // folder.jpg all flow into the parity snapshot's art tables).
  await makeAudioWithArt(path.join(a6, '04.mp3'), 'orange',
    { title: 'Lyrics D', artist: 'Lyric Artist', album: 'Album Six', track: '4/4' });

  // Return summary the test can sanity-check against.
  return {
    expectedAudioFiles: 5 + 6 + 10 + 3 + 5 + 4,
    expectedArtists: new Set([
      'Solo Artist', 'Foo', 'Bar', 'Format Test', 'Lyric Artist',
      ...compilationArtists,
      // Various Artists is seeded by the schema; not added by the scanner
      // but counted in the artists table.
    ]).size + 1, // +1 for Various Artists seed
    // One row per album above — the compilation MUST collapse to a single
    // Various-Artists-owned 'Various' row, not per-track-artist fragments.
    expectedAlbums: 6,
    compilationTracks: compilationArtists.length,
  };
}
