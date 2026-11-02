// Camelot wheel ↔ raw key-name spellings — the one table every key-aware
// route reads (the Auto-DJ picker's key filter in src/api/random.js, the flow
// orderer's key parser in src/db/flow-order.js).
//
// Lives in its own dependency-free module, like src/db/track-order.js: the
// flow orderer is a pure module, and importing the table from random.js
// would drag the database, discovery and config modules in behind it.
//
// Clients send Camelot codes (1A, 8B, etc.) because that's what the
// Auto-DJ panel sends (a habit inherited from the velvet fork's UI) and
// what most DJ-tagged libraries use as the user-
// facing key notation. The DB stores whatever the scanner found
// verbatim — TKEY frames in the wild are a mix of Camelot codes and
// raw key names ("A minor", "C major"), with enharmonic spellings
// ("Ab" vs "G#") thrown in. This map covers all three forms so a
// `musicalKeys: ['8A']` filter matches "A minor" / "Am" / "Amin" /
// raw "8A" alike.
//
// Ported from _CAMELOT_TO_KEYS in the velvet fork (aroundmyroom/mStream,
// its src/db/sqlite-backend.js — a file this tree never had). The fork is
// no longer tracked, so this table is the only copy to maintain.
export const CAMELOT_TO_KEYS = Object.freeze({
  '1A':  ['1A', 'Ab minor', 'Abmin', 'G# minor', 'G#min', 'Abm', 'G#m'],
  '1B':  ['1B', 'B major',  'Bmaj',  'B'],
  '2A':  ['2A', 'Eb minor', 'Ebmin', 'D# minor', 'D#min', 'Ebm', 'D#m'],
  '2B':  ['2B', 'F# major', 'F#maj', 'Gb major', 'Gbmaj', 'F#', 'Gb'],
  '3A':  ['3A', 'Bb minor', 'Bbmin', 'A# minor', 'A#min', 'Bbm', 'A#m'],
  '3B':  ['3B', 'Db major', 'Dbmaj', 'C# major', 'C#maj', 'Db', 'C#'],
  '4A':  ['4A', 'F minor',  'Fmin',  'Fm'],
  '4B':  ['4B', 'Ab major', 'Abmaj', 'G# major', 'G#maj', 'Ab', 'G#'],
  '5A':  ['5A', 'C minor',  'Cmin',  'Cm'],
  '5B':  ['5B', 'Eb major', 'Ebmaj', 'D# major', 'D#maj', 'Eb', 'D#'],
  '6A':  ['6A', 'G minor',  'Gmin',  'Gm'],
  '6B':  ['6B', 'Bb major', 'Bbmaj', 'A# major', 'A#maj', 'Bb', 'A#'],
  '7A':  ['7A', 'D minor',  'Dmin',  'Dm'],
  '7B':  ['7B', 'F major',  'Fmaj',  'F'],
  '8A':  ['8A', 'A minor',  'Amin',  'Am'],
  '8B':  ['8B', 'C major',  'Cmaj',  'C'],
  '9A':  ['9A', 'E minor',  'Emin',  'Em'],
  '9B':  ['9B', 'G major',  'Gmaj',  'G'],
  '10A': ['10A', 'B minor', 'Bmin',  'Bm'],
  '10B': ['10B', 'D major', 'Dmaj',  'D'],
  '11A': ['11A', 'F# minor','F#min', 'Gb minor', 'Gbmin', 'F#m', 'Gbm'],
  '11B': ['11B', 'A major', 'Amaj',  'A'],
  '12A': ['12A', 'C# minor','C#min', 'Db minor', 'Dbmin', 'C#m', 'Dbm'],
  '12B': ['12B', 'E major', 'Emaj',  'E'],
});
