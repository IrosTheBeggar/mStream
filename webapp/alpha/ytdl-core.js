// Add from YouTube's pure half: what a pasted link is and the one URL the
// server gets for it, the tags a lookup reads into (the title cleaned of
// upload noise, the artist split off it, every removal kept so it can be
// put back), where the song lands (the YouTube layouts and their bracket
// traps, on top of the Discover picker's copy of the server's template
// engine in alpha/discover-jobs.js), the formats the menu offers, the file
// name the server named and whether the folder already has it, how a
// failed lookup, folder-make or add reads, and why Add is off. No DOM, no
// Vue, no fetch, no storage — the panel, the window and the job tracker
// wire it to the app; the unit test (test/unit/webapp-ytdl-core.test.mjs)
// drives it on node, with the phone's own fixtures, and holds the title
// readers to the server's (src/discovery-plugins/plugins/youtube.js) and
// the request to the route's rules (src/api/ytdl.js).
//
// A port of the phone's lib/util/ytdl_{link,guess,layout,formats,errors}.dart
// and of the Add block in lib/screens/ytdl/ytdl_draft.dart — behaviour, not
// syntax: Dart's RegExp has JS semantics, and its strings index by UTF-16
// code unit as JS does. Where the web differs on purpose (its server is
// always its own version, a browser can't tell a refused connection from a
// dropped one), the comment says so.
//
// Text never leaves here as English: a label is an i18n KEY with its
// params ({ key, params }); every key is in KEYS below. The caller
// translates (t(label.key, label.params)) and escapes.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./discover-jobs.js')); }
  else { root.YTDLCORE = factory(root.DISCOVERJOBS); }
}(typeof self !== 'undefined' ? self : this, function (discoverJobs) {
  // The layout engine (sanitizeSegment, validateLayout, previewTarget,
  // normalizeBase, pathCrumbs, foldBase). index.html loads discover-jobs.js
  // first; read late as well, so a page that loads them the other way round
  // still works.
  function engine() {
    if (discoverJobs) { return discoverJobs; }
    if (typeof DISCOVERJOBS !== 'undefined') { return DISCOVERJOBS; }
    throw new Error('ytdl-core.js needs alpha/discover-jobs.js (window.DISCOVERJOBS)');
  }

  function label(key, params) { return params ? { key, params } : { key }; }

  function str(v) { return v == null ? '' : String(v); }

  // ── links ──────────────────────────────────────────────────────────────
  // The server's /api/v1/ytdl routes take a URL whose host is youtube.com, a
  // subdomain of it, or youtu.be, then keep its scheme, host and path with
  // only the `v` parameter (src/api/ytdl.js sanitizeYoutubeUrl). A
  // youtu.be, /shorts/, /live/ or /embed/ link has no `v`, so the server
  // answers 400 "missing video ID": those are rewritten to a watch link
  // first. The URL sent is one sanitizeYoutubeUrl leaves as it is, so the
  // job's `url` and the download record's `origin` match it character for
  // character.

  // A YouTube host inside free text: "youtu.be", "youtube.com" or a
  // subdomain of either it or youtube-nocookie.com, with an optional scheme,
  // port and path — not the tail of a longer name ("notyoutube.com"). The
  // path is ASCII, as a copied YouTube link is, so a link run straight into
  // text ("…/dQw4w9WgXcQ。看看") ends where the text starts. The phone's
  // pattern opens with the lookbehind (?<![\w.@/-]); a regex literal with
  // one is a parse error in an older Safari, which would take the whole
  // module down, so the character before a match is checked by hand.
  const CANDIDATE = /(https?:\/\/)?((?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com))(?![a-z0-9-]|\.[a-z0-9])(:\d+)?([/?#][^\x00-\x20<>"\x7f-\uffff]*)?/gi; // eslint-disable-line no-control-regex
  const NOT_BEFORE = /[\w.@/-]/;
  // Punctuation a link in a sentence ends with that is not part of it.
  const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"»”’]+$/;
  const VIDEO_ID = /^[A-Za-z0-9_-]{6,}$/;

  function firstCandidate(text) {
    CANDIDATE.lastIndex = 0;
    let m;
    while ((m = CANDIDATE.exec(text)) !== null) {
      if (m.index === 0 || !NOT_BEFORE.test(text[m.index - 1])) { return m; }
      CANDIDATE.lastIndex = m.index + 1;
    }
    return null;
  }

  function linkOf(kind, fields) {
    const f = fields || {};
    const url = f.url || null;
    let shown = '';
    if (url) {
      const bare = url.slice(url.indexOf('://') + 3);
      shown = bare.startsWith('www.') ? bare.slice(4) : bare;
    }
    return {
      kind, url, videoId: f.videoId || null,
      shortForm: f.shortForm === true, schemeAdded: f.schemeAdded === true, live: f.live === true, inPlaylist: f.inPlaylist === true,
      // For a helper line: the URL minus its scheme and a leading "www.".
      shown,
    };
  }

  function segmentsOf(pathname) {
    return pathname.split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch (_) { return s; }
    });
  }

  // The first YouTube link in `text`, with or without a scheme →
  //   { kind: 'empty' | 'notYoutube' | 'playlist' | 'video', url, videoId,
  //     shortForm, schemeAdded, live, inPlaylist, shown }
  // `url` (video only) is what the server gets: `<scheme>://<host>/watch?v=<id>`,
  // the host lower-cased, a default port dropped, every other parameter and
  // the fragment gone. youtu.be, /shorts/, /live/, /embed/ and
  // youtube-nocookie.com are rewritten to https://www.youtube.com/watch?v=<id>
  // (shortForm); music.youtube.com keeps its host and http stays http.
  function parseLink(text) {
    const input = str(text);
    if (input.trim() === '') { return linkOf('empty'); }
    const m = firstCandidate(input);
    if (!m) { return linkOf('notYoutube'); }
    const schemeAdded = m[1] === undefined;
    const raw = m[0].replace(TRAILING_PUNCTUATION, '');
    let uri;
    // new URL lower-cases the scheme and the host and drops a default port,
    // as the server's own new URL() does.
    try { uri = new URL(schemeAdded ? `https://${raw}` : raw); } catch (_) { return linkOf('notYoutube'); }
    const host = uri.hostname;
    const segments = segmentsOf(uri.pathname);
    const v = uri.searchParams.get('v');
    const inPlaylist = (uri.searchParams.get('list') || '') !== '';

    const rewritten = (id, live) => {
      if (id == null || !VIDEO_ID.test(id)) { return linkOf('notYoutube'); }
      return linkOf('video', { url: `https://www.youtube.com/watch?v=${id}`, videoId: id, shortForm: true, schemeAdded, live, inPlaylist });
    };
    const playlistOrNothing = () => linkOf(inPlaylist ? 'playlist' : 'notYoutube');

    if (host === 'youtu.be' || host === 'www.youtu.be') { return rewritten(segments.length ? segments[0] : null, false); }
    const first = segments.length ? segments[0] : '';
    const second = segments.length > 1 ? segments[1] : null;
    // An embedded playlist names no video: /embed/videoseries?list=…, on
    // either host. (The phone checks this after the nocookie host, so its
    // privacy-mode playlist embed reads as a video with the id
    // "videoseries"; the web reads it as the playlist it is.)
    if (first === 'embed' && second === 'videoseries') { return playlistOrNothing(); }
    if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      // Only embeds live there; the server refuses the host, so even a
      // watch link on it is sent as www.youtube.com.
      return rewritten(first === 'embed' ? second : (first === 'watch' ? v : null), false);
    }
    if (first === 'shorts' || first === 'embed') { return rewritten(second, false); }
    if (first === 'live') { return rewritten(second, true); }
    if (first === 'playlist') { return playlistOrNothing(); }
    if (first === 'watch' && segments.length === 1) {
      if (v == null) { return playlistOrNothing(); }
      if (!VIDEO_ID.test(v)) { return linkOf('notYoutube'); }
      // Scheme and host kept, a port only when it is not the scheme's own.
      const port = uri.port ? `:${uri.port}` : '';
      return linkOf('video', { url: `${uri.protocol.replace(/:$/, '')}://${host}${port}/watch?v=${v}`, videoId: v, schemeAdded, inPlaylist });
    }
    return linkOf('notYoutube');
  }

  // A lookup answer for a stream (the server's isLiveEntry): live now,
  // upcoming, or just ended and not yet processed.
  const LIVE_STATUSES = ['is_live', 'is_upcoming', 'post_live'];
  function isLiveMeta(meta) {
    return !!meta && (meta.isLive === true || LIVE_STATUSES.indexOf(meta.liveStatus) !== -1);
  }

  // The lines under the link field, in order, each { tone, label }:
  // a refusal ('err': not YouTube, a playlist), "Just this video, not the
  // playlist." ('note') and the live-stream warning ('warn') — a /live/
  // link, or a lookup that says the video is a stream. A rewritten link is
  // just sent: no "Sent as …" (spec §2, cut on the web).
  function linkNotes(link, meta) {
    const l = link || linkOf('empty');
    if (l.kind === 'notYoutube') { return [{ tone: 'err', label: label('ytdl.link.notYoutube') }]; }
    if (l.kind === 'playlist') { return [{ tone: 'err', label: label('ytdl.link.playlist') }]; }
    if (l.kind !== 'video') { return []; }
    const out = [];
    if (l.inPlaylist) { out.push({ tone: 'note', label: label('ytdl.link.inPlaylist') }); }
    if (l.live || isLiveMeta(meta)) { out.push({ tone: 'warn', label: label('ytdl.link.live') }); }
    return out;
  }

  // A GET /ytdl/metadata answer, normalised: '' and non-strings are null,
  // the year a string of its integer digits (2001 or "2001"), isLive a
  // boolean, durationSec a number or null.
  function readMetadata(answer) {
    const m = answer && typeof answer === 'object' ? answer : {};
    const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
    const year = typeof m.year === 'number'
      ? (Number.isFinite(m.year) && m.year === Math.trunc(m.year) ? String(m.year) : null)
      : text(m.year);
    const dur = Number(m.durationSec);
    return {
      title: text(m.title), artist: text(m.artist), album: text(m.album), year, thumbnail: text(m.thumbnail),
      fileStem: text(m.fileStem), isLive: m.isLive === true, liveStatus: text(m.liveStatus),
      durationSec: m.durationSec != null && Number.isFinite(dur) && dur >= 0 ? dur : null, channel: text(m.channel),
    };
  }

  // ── the title readers, the server's own ────────────────────────────────
  // src/discovery-plugins/plugins/youtube.js, verbatim, so Discover and Add
  // from YouTube read a title the same way (the test holds them to it).

  // Bracketed or trailing edition noise YouTube uploads carry that a
  // catalogue title never does.
  const BRACKET_NOISE = /[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|1080p|720p|explicit|clean|full\s+(song|track))\b[^)\]]*[)\]]/gi;
  const TRAILING_NOISE = /\s*[-–—|:]\s*(official\s+)?(hd\s+|hq\s+)?(music\s+video|lyric\s+video|lyrics?|audio|video|visuali[sz]er|audio\s+only)\s*$/i;
  // The server's split, with the separator captured (group 2) so the guess
  // can make it a fragment; the title is group 3.
  const ARTIST_TITLE = /^(.{1,80}?)\s+([-–—:])\s+(.{1,160})$/;

  function squeeze(s) { return s.replace(/\s+/g, ' ').trim(); }

  function cleanTitle(raw) {
    let s = String(raw || '');
    s = s.replace(BRACKET_NOISE, ' ');
    s = s.replace(TRAILING_NOISE, '');
    return squeeze(s);
  }

  // "Artist - Title" → { artist, title }, else null.
  function splitArtistTitle(title) {
    const m = ARTIST_TITLE.exec(String(title || '').trim());
    return m ? { artist: m[1].trim(), title: m[3].trim() } : null;
  }

  function isTopicChannel(channel) {
    return /-\s*Topic$/i.test(String(channel || '').trim());
  }

  function channelArtist(channel) {
    const s = String(channel || '').replace(/\s*-\s*Topic$/i, '').trim();
    return s || null;
  }

  // ── the guess ──────────────────────────────────────────────────────────
  // A lookup read into tags (lib/util/ytdl_guess.dart), with the phone's
  // deliberate differences from the server: 【…】 groups and the word MV
  // count as noise, a noise group that also says Remix, Live, Remaster(ed)
  // or Version keeps those words, and a trailing "ft. X" becomes
  // "(feat. X)". Every removal is a fragment that can be put back.
  //
  // tier: 'music'          the lookup had an album (yt-dlp sets one only for
  //                        music tracks): "Tags from YouTube Music"
  //       'split'          "Artist - Title" in the video title
  //       'youtubeArtist'  YouTube's artist field, maybe the channel: "check it"
  //       'none'           no lookup; the fields are the user's
  // fragment: { text, kind: 'noise' | 'split' } — "(Official Video)", "[HD]",
  //           "-" for the split — in the order they stand in the raw title.

  const PHONE_GROUP = /[([][^)\]]*\b(?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|1080p|720p|explicit|clean|full\s+(?:song|track)|mv|m\/v)\b[^)\]]*[)\]]|【[^】]*\b(?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|1080p|720p|explicit|clean|full\s+(?:song|track)|mv|m\/v)\b[^】]*】/gi;
  const PHONE_TRAILING = /\s*[-–—|:]\s*(official\s+)?(hd\s+|hq\s+)?(music\s+video|lyric\s+video|lyrics?|audio|video|visuali[sz]er|audio\s+only|mv|m\/v)\s*$/i;
  // A word that makes a noise group worth keeping in part.
  const KEEP_WORD = /\b(?:remix|live|remaster(?:ed)?|version)\b/i;
  const NOISE_PHRASE = /\b(?:official|full\s+(?:song|track)|(?:music|lyrics?)\s+video|audio\s+only|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|1080p|720p|explicit|clean|mv|m\/v)\b/gi;
  const SEPARATOR_RUN = /\s*([-–—|:,/&+·])(?:\s*[-–—|:,/&+·])+/g;
  const EDGE_SEPARATORS = /^[\s\-–—|:,/&+·]+|[\s\-–—|:,/&+·]+$/g;
  const FEAT_TAIL = /^(.*?\S)\s+(?:feat\.|ft\.|featuring)\s+([^()[\]【】]+)$/i;
  const VEVO = /^(.*?\S)\s*VEVO$/i;
  const OFFICIAL = /^(.*?\S)\s+(?:[-–—|:·]\s+)?Official$/i;
  const SPACE = /^\s$/;
  const FOUR_DIGITS = /^\d{4}$/;

  // What a noise group keeps: "(Official Live Video)" → "(Live)". null when
  // it goes whole — no keep word, or nothing but "Version" left ("(Clean
  // Version)" says nothing once "Clean" is gone).
  function keepOf(group) {
    const inner = group.slice(1, -1);
    if (!KEEP_WORD.test(inner)) { return null; }
    let kept = inner.replace(NOISE_PHRASE, ' ');
    kept = kept.replace(SEPARATOR_RUN, (m, sep) => ` ${sep} `);
    kept = squeeze(kept).replace(EDGE_SEPARATORS, '');
    if (kept === '' || kept.toLowerCase() === 'version') { return null; }
    return group[0] + kept + group[group.length - 1];
  }

  // "Song ft. X" → "Song (feat. X)", only for a credit at the very end and
  // outside brackets. "feat" and "ft" need their dots: "A Feat of Strength"
  // and "6 ft under" are titles, and the rewrite has no chip to undo it.
  function featured(title) {
    const m = FEAT_TAIL.exec(title);
    if (!m) { return title; }
    const who = m[2].trim();
    return who === '' ? title : `${m[1]} (feat. ${who})`;
  }

  // YouTube's artist field with a trailing " - Topic", "VEVO" or word
  // "Official" removed, and which one. A leading "Official" is a name
  // ("Official髭男dism"), never removed. → [artist, strip | null]
  function stripArtist(raw) {
    const s = squeeze(raw);
    if (isTopicChannel(s)) {
      const a = channelArtist(s);
      return a == null ? [s, null] : [a, '- Topic'];
    }
    const vevo = VEVO.exec(s);
    if (vevo) { return [vevo[1], 'VEVO']; }
    const official = OFFICIAL.exec(s);
    if (official) { return [official[1], 'Official']; }
    return [s, null];
  }

  function yearOf(year) {
    if (year == null) { return ''; }
    const s = String(year).trim();
    return FOUR_DIGITS.test(s) ? s : '';
  }

  // The cutting of one raw title: which code units each fragment owns.
  // Fragments are added as found (groups, the trailing noise, the split);
  // laidOut() orders them as they stand in the title.
  function cutTitle(raw) {
    const owner = new Array(raw.length).fill(-1);
    const kinds = [];
    const texts = [];
    const stands = [];
    const starts = [];
    const add = (kind, text, stand, start) => {
      kinds.push(kind); texts.push(text); stands.push(stand); starts.push(start);
      return kinds.length - 1;
    };

    // `raw` with every fragment replaced by what stands in for it, and for
    // each code unit the raw index it came from (-1: stand-in text).
    const render = () => {
      let out = '';
      const from = [];
      for (let i = 0; i < raw.length; i++) {
        const f = owner[i];
        if (f < 0) {
          out += raw[i];
          from.push(i);
        } else if (i === 0 || owner[i - 1] !== f) {
          const stand = i === starts[f] ? stands[f] : ' ';
          out += stand;
          for (let k = 0; k < stand.length; k++) { from.push(-1); }
        }
      }
      return { text: out, from };
    };

    for (const m of raw.matchAll(PHONE_GROUP)) {
      const keep = keepOf(m[0]);
      const f = add('noise', m[0], keep == null ? ' ' : keep, m.index);
      owner.fill(f, m.index, m.index + m[0].length);
    }
    // The trailing rule reads the title with its groups replaced, as the
    // server's second step does; what it matches goes back to the raw
    // characters it came from.
    const first = render();
    const trailing = PHONE_TRAILING.exec(first.text);
    if (trailing) {
      const owned = [];
      for (let j = trailing.index; j < trailing.index + trailing[0].length; j++) {
        if (first.from[j] >= 0) { owned.push(first.from[j]); }
      }
      if (owned.length) {
        const f = add('noise', squeeze(owned.map((i) => raw[i]).join('')), ' ', owned[0]);
        for (const i of owned) { owner[i] = f; }
      }
    }

    return {
      // The server's split, run on the cleaned title: the separator becomes
      // a fragment. false when the title does not split (or would split at
      // a separator inside kept bracket text, which the raw title lacks).
      split() {
        const { text, from } = render();
        // The cleaned title keeping each character's raw index: whitespace
        // runs squeezed, the ends trimmed.
        let chars = '';
        const at = [];
        let gap = false;
        for (let j = 0; j < text.length; j++) {
          if (SPACE.test(text[j])) { gap = chars.length > 0; continue; }
          if (gap) { chars += ' '; at.push(-1); gap = false; }
          chars += text[j];
          at.push(from[j]);
        }
        const m = ARTIST_TITLE.exec(chars);
        if (!m) { return false; }
        let k = m[1].length;
        while (SPACE.test(chars[k])) { k++; }
        const p = at[k];
        if (p < 0) { return false; }
        owner[p] = add('split', m[2], '', p);
        return true;
      },
      // The fragments in raw order, the pieces titles are rebuilt from (runs
      // of one owner; `owner` is the fragment's index in raw order, -1 for
      // kept text, `stand` what shows while it is out), and the split's
      // index among the fragments (-1 without one).
      laidOut() {
        const order = kinds.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
        const rank = [];
        order.forEach((f, r) => { rank[f] = r; });
        const pieces = [];
        let i = 0;
        while (i < raw.length) {
          const f = owner[i];
          let j = i + 1;
          while (j < raw.length && owner[j] === f) { j++; }
          pieces.push(f < 0
            ? { text: raw.slice(i, j), owner: -1, stand: '' }
            : { text: raw.slice(i, j), owner: rank[f], stand: i === starts[f] ? stands[f] : ' ' });
          i = j;
        }
        const split = kinds.indexOf('split');
        return {
          fragments: order.map((f) => Object.freeze({ text: texts[f], kind: kinds[f] })),
          pieces,
          split: split < 0 ? -1 : rank[split],
        };
      },
    };
  }

  // The raw title rebuilt from `pieces` with the `restored` fragments back,
  // cut at the separator (the fragment `split`) while the split is out.
  function rebuild(pieces, split, restored) {
    const splitOut = split >= 0 && !restored.has(split);
    let left = '';
    let right = '';
    let past = !splitOut;
    for (const p of pieces) {
      if (splitOut && p.owner === split) { past = true; continue; }
      const piece = p.owner < 0 || restored.has(p.owner) ? p.text : p.stand;
      if (past) { right += piece; } else { left += piece; }
    }
    return { left, right };
  }

  // The title half of the rebuilt title, "ft. X" made "(feat. X)" — or,
  // with all `count` fragments back, the raw title itself.
  function titleOf(rawTitle, count, pieces, split, restored) {
    let all = count > 0;
    for (let i = 0; all && i < count; i++) { all = restored.has(i); }
    if (all) { return squeeze(rawTitle); }
    return featured(squeeze(rebuild(pieces, split, restored).right));
  }

  function restoredSet(restored) {
    if (restored instanceof Set) { return restored; }
    return new Set(Array.isArray(restored) ? restored : []);
  }

  // A guess is plain frozen data; the pieces its titles are rebuilt from
  // ride along out of sight (not enumerable, so neither JSON nor Vue walks
  // them, and two readings of one answer compare equal).
  function makeGuess(fields, pieces, split) {
    const g = {
      tier: fields.tier,
      rawTitle: fields.rawTitle || '',
      title: fields.title || '',
      artist: fields.artist || '',
      album: fields.album || '',
      year: fields.year || '',
      fragments: Object.freeze((fields.fragments || []).slice()),
      youtubeArtistRaw: fields.youtubeArtistRaw || '',
      youtubeArtist: fields.youtubeArtist || '',
      artistStrip: fields.artistStrip || null,
      artistAgrees: fields.artistAgrees === true,
      cleaned: (fields.fragments || []).length > 0,
    };
    Object.defineProperty(g, '_pieces', { value: pieces || [], enumerable: false });
    Object.defineProperty(g, '_split', { value: split == null ? -1 : split, enumerable: false });
    return Object.freeze(g);
  }

  // The empty guess, for details entered by hand.
  const GUESS_NONE = makeGuess({ tier: 'none' });

  // Read a GET /ytdl/metadata answer ({ title, artist, album, year }; the
  // year an int or a string) →
  //   { tier, rawTitle, title, artist, album, year, fragments,
  //     youtubeArtistRaw, youtubeArtist, artistStrip, artistAgrees, cleaned }
  // `title` is cleaned (and the right half after a split); `artist` '' when
  // none; `year` four digits or ''; `youtubeArtist` is YouTube's artist
  // with a trailing " - Topic", "VEVO" or "Official" removed (`artistStrip`
  // says which); `artistAgrees`: the split's artist is YouTube's, ignoring
  // case.
  function guess(answer) {
    const a = answer || {};
    const rawTitle = str(a.title);
    const youtubeArtistRaw = str(a.artist);
    const albumIn = squeeze(str(a.album));
    const y = yearOf(a.year);
    const [youtubeArtist, strip] = stripArtist(youtubeArtistRaw);

    if (squeeze(rawTitle) === '' && squeeze(youtubeArtistRaw) === '' && albumIn === '') {
      return y === '' ? GUESS_NONE : makeGuess({ tier: 'none', year: y });
    }

    const cut = cutTitle(rawTitle);
    // The split tier needs no album and a title the server's rule splits.
    const tier = albumIn !== '' ? 'music' : (cut.split() ? 'split' : 'youtubeArtist');
    const { fragments, pieces, split } = cut.laidOut();
    let artistNow = youtubeArtist;
    if (tier === 'music') { artistNow = squeeze(youtubeArtistRaw); }
    else if (tier === 'split') { artistNow = squeeze(rebuild(pieces, split, new Set()).left); }
    return makeGuess({
      tier, rawTitle,
      title: titleOf(rawTitle, fragments.length, pieces, split, new Set()),
      artist: artistNow, album: albumIn, year: y, fragments, youtubeArtistRaw, youtubeArtist, artistStrip: strip,
      artistAgrees: tier === 'split' && youtubeArtist !== '' && youtubeArtist.toLowerCase() === artistNow.toLowerCase(),
    }, pieces, split);
  }

  // The title with the `restored` fragment indexes put back (a Set or an
  // array; the others still out). With every fragment back it is the
  // video's own title (its spacing squeezed), "ft." and all.
  function titleWith(g, restored) {
    const s = restoredSet(restored);
    return titleOf(g.rawTitle, g.fragments.length, g._pieces || [], g._split == null ? -1 : g._split, s);
  }

  // The artist when the split fragment is put back (YouTube's artist,
  // stripped) or not (the text left of the separator, with any of its
  // restored fragments back). Outside the split tier: the guess's artist.
  function artistWith(g, restored) {
    if (g.tier !== 'split') { return g.artist; }
    const s = restoredSet(restored);
    if (s.has(g._split)) { return g.youtubeArtist; }
    return squeeze(rebuild(g._pieces || [], g._split, s).left);
  }

  // Two readings of the same answer (a late lookup that read the same).
  function sameGuess(a, b) {
    if (a === b) { return true; }
    if (!a || !b) { return false; }
    const keys = ['tier', 'rawTitle', 'title', 'artist', 'album', 'year', 'youtubeArtistRaw', 'youtubeArtist', 'artistStrip', 'artistAgrees'];
    if (keys.some((k) => a[k] !== b[k])) { return false; }
    if (a.fragments.length !== b.fragments.length) { return false; }
    return a.fragments.every((f, i) => f.text === b.fragments[i].text && f.kind === b.fragments[i].kind);
  }

  // ── the card's reading of a guess ──────────────────────────────────────
  // The draft state the card keeps beside a guess (ytdl_draft.dart):
  //   { restored: Set|array of fragment indexes put back (chips, Undo all),
  //     swapped: "Swap artist and title" is on,
  //     stripRestored: "↶ VEVO" put the strip back on YouTube's artist }

  function splitIndexOf(g) { return g.fragments.findIndex((f) => f.kind === 'split'); }

  function readState(state) {
    const s = state || {};
    return { restored: restoredSet(s.restored), swapped: s.swapped === true, stripRestored: s.stripRestored === true };
  }

  // The title and artist the guess gives now → { title, artist }.
  function guessFields(g, state) {
    const s = readState(state);
    const title = titleWith(g, s.restored);
    const youtube = s.stripRestored ? g.youtubeArtistRaw.trim() : g.youtubeArtist;
    const splitOut = g.tier === 'split' && !s.restored.has(splitIndexOf(g));
    let artist = '';
    if (g.tier === 'music') { artist = g.artist; }
    else if (g.tier === 'split') { artist = splitOut ? artistWith(g, s.restored) : youtube; }
    else if (g.tier === 'youtubeArtist') { artist = youtube; }
    return s.swapped ? { title: artist, artist: title } : { title, artist };
  }

  // What the card offers around the fields →
  //   { splitOut, noiseOut, canSwap, canUndoAll, cleaned (a noise fragment is
  //     out: "Cleaned from “…”" shows), chips: [{ index, kind, text }] (the
  //     pieces still out, noise first, none while swapped), canRestoreStrip,
  //     orYoutubeArtist (the split's artist differs from YouTube's: its name) }
  // `artistEdited`: the user typed in the Artist field.
  function guessView(g, state, artistEdited) {
    const s = readState(state);
    const splitOut = g.tier === 'split' && !s.restored.has(splitIndexOf(g));
    const noiseOut = g.fragments.some((f, i) => f.kind === 'noise' && !s.restored.has(i));
    const canUndoAll = g.cleaned && s.restored.size < g.fragments.length;
    const chips = [];
    if (!s.swapped) {
      for (const kind of ['noise', 'split']) {
        g.fragments.forEach((f, i) => { if (f.kind === kind && !s.restored.has(i)) { chips.push({ index: i, kind, text: f.text }); } });
      }
    }
    return {
      splitOut, noiseOut, canSwap: splitOut, canUndoAll,
      cleaned: canUndoAll && g.fragments.some((f) => f.kind === 'noise'),
      chips,
      canRestoreStrip: g.artistStrip != null && !s.stripRestored && artistEdited !== true
        && (g.tier === 'youtubeArtist' || (g.tier === 'split' && !splitOut)),
      orYoutubeArtist: g.tier === 'split' && splitOut && !g.artistAgrees && g.youtubeArtist !== '' && artistEdited !== true
        ? g.youtubeArtist : null,
    };
  }

  // The source line under the fields → { tone, label } or null (no
  // lookup): ✓ 'ok' "Tags from YouTube Music"; 'auto' "Artist and title
  // from the video title" while the split stands (with "· matches the
  // artist YouTube lists" when YouTube's artist agrees, as on the phone);
  // ⚠ 'warn' "Artist may be the channel name — check it" — YouTube's
  // artist field, also once a split is undone. The cleaned line ("Cleaned
  // from “…”") is its own: guessView's `cleaned` and cleanedLabel.
  function sourceLine(g, state) {
    if (!g || g.tier === 'none') { return null; }
    if (g.tier === 'music') { return { tone: 'ok', label: label('ytdl.source.ytMusic') }; }
    const s = readState(state);
    if (g.tier === 'split' && !s.restored.has(splitIndexOf(g))) {
      return { tone: 'auto', label: label(g.artistAgrees ? 'ytdl.source.videoTitleAgrees' : 'ytdl.source.videoTitle') };
    }
    return { tone: 'warn', label: label('ytdl.source.channel') };
  }

  function cleanedLabel(g) { return label('ytdl.source.cleaned', { title: g.rawTitle }); }

  const FIELDS = ['title', 'artist', 'album', 'year'];

  // The focused field's one help line (spec §3.1.4): its source, "Edited"
  // once typed in, or — empty, typed or not — what a blank field does.
  //   ctx: { guess, state, edited: Set|array of field names typed in,
  //          value: the field's text, lookupAlbum: the lookup's album }
  function fieldHelp(field, ctx) {
    const c = ctx || {};
    const g = c.guess || GUESS_NONE;
    const s = readState(c.state);
    const edited = c.edited instanceof Set ? c.edited : new Set(Array.isArray(c.edited) ? c.edited : []);
    const blank = str(c.value).trim() === '';
    if (!blank && edited.has(field)) { return label('ytdl.help.edited'); }
    const splitOut = g.tier === 'split' && !s.restored.has(splitIndexOf(g));
    const noiseOut = g.fragments.some((f, i) => f.kind === 'noise' && !s.restored.has(i));
    if (field === 'title') {
      if (blank) { return label('ytdl.blank.title'); }
      if (s.swapped) { return label('ytdl.help.videoTitle'); }
      if (noiseOut) { return label('ytdl.help.videoTitleCleaned'); }
      return label(g.tier === 'music' ? 'ytdl.help.music' : 'ytdl.help.videoTitle');
    }
    if (field === 'artist') {
      if (blank) {
        if (g.tier === 'music') { return label('ytdl.blank.artistMusic'); }
        const raw = g.youtubeArtistRaw.trim();
        return raw === '' ? label('ytdl.blank.artistGuessUnnamed') : label('ytdl.blank.artistGuess', { name: raw });
      }
      // Swapped, the artist holds the title's half — cleaned, if noise came
      // out of it.
      if (s.swapped) { return label(noiseOut ? 'ytdl.help.videoTitleCleaned' : 'ytdl.help.videoTitle'); }
      if (g.tier === 'music') { return label('ytdl.help.music'); }
      if (g.tier === 'split' && splitOut) { return label('ytdl.help.videoTitle'); }
      if (g.artistStrip != null && !s.stripRestored) { return label('ytdl.help.youtubeArtistStripped', { removed: g.artistStrip }); }
      return label(g.tier === 'youtubeArtist' ? 'ytdl.help.youtubeArtistCheck' : 'ytdl.help.youtubeArtist');
    }
    if (field === 'album') {
      if (blank) { return label(g.album !== '' || str(c.lookupAlbum) !== '' ? 'ytdl.blank.albumKeeps' : 'ytdl.blank.albumSingle'); }
      // An album only ever comes with the music tier.
      return label('ytdl.help.music');
    }
    if (field === 'year') {
      if (blank) { return label('ytdl.blank.year'); }
      return label(g.tier === 'music' ? 'ytdl.help.music' : 'ytdl.help.videoRelease');
    }
    return null;
  }

  // Non-empty and not four digits: "A year is 4 digits, like 2001".
  function yearInvalid(year) {
    const y = str(year).trim();
    return y !== '' && !FOUR_DIGITS.test(y);
  }

  // The fields as the layout reads them (trimmed): { artist, album, year }.
  function tagsOf(fields) {
    const f = fields || {};
    return { artist: str(f.artist).trim(), album: str(f.album).trim(), year: str(f.year).trim() };
  }

  // The POST /api/v1/ytdl/ body: `metadata` only with the non-blank
  // title/artist/album and a four-digit year, and no `metadata` key at all
  // when nothing is left — the route's Joi refuses any other key, and null,
  // and with it the whole add.
  function addRequest({ url, directory, codec, fields } = {}) {
    const f = fields || {};
    const metadata = {};
    for (const key of ['title', 'artist', 'album']) {
      const v = str(f[key]).trim();
      if (v !== '') { metadata[key] = v; }
    }
    const year = str(f.year).trim();
    if (FOUR_DIGITS.test(year)) { metadata.year = year; }
    const body = { directory, url, outputCodec: codec };
    if (Object.keys(metadata).length) { body.metadata = metadata; }
    return body;
  }

  // ── where the song lands ───────────────────────────────────────────────
  // The server's /ytdl takes a finished directory and renders nothing, so
  // the client renders the layout with the Discover picker's copy of the
  // server's engine (DISCOVERJOBS.previewTarget): the folders shown are the
  // folders mkdir makes and the add names. (lib/util/ytdl_layout.dart.)

  const YTDL_VARS = Object.freeze(['ARTIST', 'ALBUMARTIST', 'ALBUM', 'YEAR']); // chip order
  const NEVER_VARS = Object.freeze(['GENRE', 'PEER', 'SERVERFOLDER']); // always empty for a YouTube song
  const LAYOUT_ARTIST_ALBUM = '{{ALBUMARTIST}}/{{ALBUM}}';
  const LAYOUT_ARTIST = '{{ALBUMARTIST}}';
  const LAYOUT_ALBUM = '{{ALBUM}}';
  // "Top of the library" / "Right here": no folders. Never handed to
  // validateLayout or previewTarget, which refuse an empty layout.
  const LAYOUT_TOP = '';
  // The engine's token pattern (discover-jobs.js keeps its own private).
  const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  // Characters a folder name cannot hold on Windows. The engine folds them
  // out of tag values but keeps them in literal text, and the mkdir route
  // only normalises the path, so a Windows server would answer a bare 500.
  const BAD_LITERAL = /[:*?"<>|]/;

  // A layout as typed → { valid, issue, token, engine }:
  //   issue 'none' | 'unknownVariable' (token as typed, "{{ title }}") |
  //   'neverVariable' ("{{GENRE}}") | 'badChars' (token: the first refused
  //   character) | 'engine' (engine: validateLayout's { error, … })
  // validateLayout first, then the YouTube allow-list, then : * ? " < > |
  // in the literal text. '' is valid here (Top of the library).
  function layoutCheck(layout) {
    const ok = { valid: true, issue: 'none', token: null, engine: null };
    if (layout === '') { return ok; }
    const check = engine().validateLayout(layout);
    if (!check.valid) {
      if (check.error === 'unknown_variable') {
        return { valid: false, issue: 'unknownVariable', token: check.token || `{{${check.variable}}}`, engine: null };
      }
      return { valid: false, issue: 'engine', token: null, engine: check };
    }
    for (const m of layout.matchAll(TOKEN_RE)) {
      if (NEVER_VARS.indexOf(m[1].toUpperCase()) !== -1) { return { valid: false, issue: 'neverVariable', token: m[0], engine: null }; }
    }
    const bad = BAD_LITERAL.exec(layout.replace(TOKEN_RE, ''));
    if (bad) { return { valid: false, issue: 'badChars', token: bad[0], engine: null }; }
    return ok;
  }

  // The engine's refusals, worded for a YouTube layout (a literal table, so
  // every key is findable). drive_letter_segment and absolute_path read as
  // their template twins, as the Discover picker reads them.
  const ENGINE_ERROR_KEYS = {
    unbalanced_braces: 'ytdl.where.err.braces',
    absolute_template: 'ytdl.where.err.absolute',
    absolute_path: 'ytdl.where.err.absolute',
    traversal: 'ytdl.where.err.traversal',
    empty_path: 'ytdl.where.err.empty',
    home_string: 'ytdl.where.err.home',
    drive_letter: 'ytdl.where.err.drive',
    drive_letter_segment: 'ytdl.where.err.drive',
    template_too_long: 'ytdl.where.err.tooLong',
    path_too_long: 'ytdl.where.err.tooLong',
    invalid_chars: 'ytdl.where.err.control',
  };

  // Custom's error line for a layoutCheck → label, or null when valid.
  function layoutProblem(check) {
    if (!check || check.valid) { return null; }
    const vars = YTDL_VARS.join(', ');
    if (check.issue === 'unknownVariable') { return label('ytdl.where.err.unknownVar', { token: check.token, vars }); }
    if (check.issue === 'neverVariable') { return label('ytdl.where.err.neverVar', { token: check.token, vars }); }
    if (check.issue === 'badChars') { return label('ytdl.where.err.badChar'); }
    const code = check.engine && check.engine.error;
    const key = ENGINE_ERROR_KEYS[code];
    return key ? label(key, { example: '{{ARTIST}}', max: engine().MAX_TEMPLATE_LEN }) : label('ytdl.where.err.generic');
  }

  // previewTarget's tags for a YouTube song: ALBUMARTIST and ARTIST are both
  // the Artist field (the card has one); GENRE and the rest have no value,
  // so they land in missingVars.
  function metaOf(tags) {
    const t = tags || {};
    const artist = str(t.artist);
    return { artist, album: str(t.album), year: str(t.year), albumartist: artist, genre: null };
  }

  function dirOf(library, segments) {
    return segments.length ? `/${library}/${segments.join('/')}/` : `/${library}/`;
  }

  function neverIn(layout) {
    const out = [];
    for (const m of layout.matchAll(TOKEN_RE)) {
      const name = m[1].toUpperCase();
      if (NEVER_VARS.indexOf(name) !== -1 && out.indexOf(name) === -1) { out.push(name); }
    }
    return out;
  }

  function withoutNever(vars) { return (vars || []).filter((v) => NEVER_VARS.indexOf(v) === -1); }

  function invalidTarget(library, error, missingVars, neverVars) {
    return {
      valid: false, library, segments: [], relDir: '', directory: '', crumbs: [library],
      missingVars: missingVars || [], neverVars: neverVars || [], trap: null, error,
    };
  }

  function validTarget(library, segments, missingVars, neverVars, trap) {
    return {
      valid: true, library, segments, relDir: segments.join('/'), directory: dirOf(library, segments), crumbs: [library, ...segments],
      missingVars: missingVars || [], neverVars: neverVars || [], trap: trap || null, error: null,
    };
  }

  const ONLY_BRACKETS = /^[\s()[\]{}【】\-–—_.,·&+]+$/;
  const EMPTY_PAIR = /[([{【]\s*[)\]}】]/;
  const EMPTY_PAIRS = /[([{【]\s*[)\]}】]/g;
  const DANGLING_EDGE = /^[-–—_,·&+]|[-–—_,·&+]$/;

  // A folder made only of brackets and separators ("()", "【】", "-"): what
  // an empty variable can leave of a folder — and how such a folder is read
  // aloud ("empty brackets").
  function onlyBrackets(folder) {
    const f = str(folder);
    return f.trim() !== '' && ONLY_BRACKETS.test(f);
  }

  // `folder` with its empty bracket pairs taken out ("Discovery ()" →
  // "Discovery"), or null when it has none: the name a flagged folder is
  // read aloud with ("Discovery with empty brackets").
  function withoutEmptyPairs(folder) {
    const f = str(folder);
    if (!EMPTY_PAIR.test(f)) { return null; }
    return f.replace(EMPTY_PAIRS, ' ').replace(/\s+/g, ' ').trim();
  }

  // The first folder of `layout` an empty variable leaves as only brackets
  // or separators, or with an empty bracket pair or a separator at its edge
  // → { kind: 'emptyFolder' | 'missingYear' | 'other', folder } or null.
  // Each folder renders as the engine renders it (a value never holds a
  // '/', so a template folder is one rendered folder); one with no empty
  // variable in it is the user's own text and never a trap.
  function trapIn(layout, tags) {
    const J = engine();
    const t = tags || {};
    const values = {
      ARTIST: J.sanitizeSegment(t.artist), ALBUMARTIST: J.sanitizeSegment(t.artist),
      ALBUM: J.sanitizeSegment(t.album), YEAR: J.sanitizeSegment(t.year),
    };
    for (const folder of layout.split(/[/\\]+/)) {
      const emptied = [];
      const rendered = folder.replace(TOKEN_RE, (m, name) => {
        const n = name.toUpperCase();
        const v = values[n] || '';
        if (v === '') { emptied.push(n); }
        return v;
      }).trim();
      if (rendered === '' || emptied.length === 0) { continue; }
      if (ONLY_BRACKETS.test(rendered)) { return { kind: 'emptyFolder', folder: rendered }; }
      if (EMPTY_PAIR.test(rendered) || DANGLING_EDGE.test(rendered)) {
        return { kind: emptied.every((n) => n === 'YEAR') ? 'missingYear' : 'other', folder: rendered };
      }
    }
    return null;
  }

  // The panel's target: library `vpath`, Discover's base folders `base` for
  // "Same as Discover" ('' otherwise), `layout`, the song's `tags`
  // ({ artist, album, year }) →
  //   { valid, library, segments (below the library: base + rendered),
  //     relDir, directory ('/<vpath>/<relDir>/' or '/<vpath>/', what POST
  //     /ytdl gets; '' when invalid), crumbs ([library, ...segments]),
  //     missingVars (upper-case, never-variables left out), neverVars (the
  //     GENRE/PEER/SERVERFOLDER tokens present), trap, error }
  // `error` is the engine's code, or 'bad_chars' for a literal layoutCheck
  // refuses. layout '' is Top of the library: the base folders only.
  function target({ vpath, base = '', layout, tags } = {}) {
    const J = engine();
    const library = str(vpath);
    const l = layout == null ? LAYOUT_TOP : layout;
    if (typeof l !== 'string') { return invalidTarget(library, 'invalid_type'); }
    if (l === LAYOUT_TOP) {
      const b = J.normalizeBase(base);
      if (!b.valid) { return invalidTarget(library, b.error); }
      return validTarget(library, J.pathCrumbs(b.base));
    }
    const never = neverIn(l);
    if (layoutCheck(l).issue === 'badChars') { return invalidTarget(library, 'bad_chars', [], never); }
    const p = J.previewTarget({ vpath: library, base, layout: l, tags: metaOf(tags) });
    const missing = withoutNever(p.missingVars);
    if (!p.valid) { return invalidTarget(library, p.error, missing, never); }
    return validTarget(library, J.pathCrumbs(p.relDir), missing, never, trapIn(l, tags));
  }

  // The explorer window's target under the folder on screen. `currentPath`
  // is the explorer's path, either spelling ('Music/Daft Punk/' as
  // getFileExplorerPath() gives it, or '/Music/Daft Punk/'); layout '' is
  // "Right here". The folder on screen exists, so its names go in front of
  // the rendered layout as they are, unchecked: the base-folder rules are
  // for folders a layout would create. `directory` is always spelled
  // '/<vpath>/…/'. A path that names no library makes no target.
  function folderTarget({ currentPath, layout, tags } = {}) {
    const J = engine();
    const here = J.pathCrumbs(currentPath);
    const library = here.length ? here[0] : '';
    const below = here.slice(1);
    if (library === '') { return invalidTarget('', 'no_library'); }
    const l = layout == null ? LAYOUT_TOP : layout;
    if (typeof l !== 'string') { return invalidTarget(library, 'invalid_type'); }
    if (l === LAYOUT_TOP) { return validTarget(library, below); }
    const never = neverIn(l);
    if (layoutCheck(l).issue === 'badChars') { return invalidTarget(library, 'bad_chars', [], never); }
    const p = J.previewTarget({ vpath: library, layout: l, tags: metaOf(tags) });
    const missing = withoutNever(p.missingVars);
    if (!p.valid) { return invalidTarget(library, p.error, missing, never); }
    return validTarget(library, [...below, ...J.pathCrumbs(p.relDir)], missing, never, trapIn(l, tags));
  }

  // The crumbs as drawn: [{ text, isNew, trap }] — the library first; a
  // folder that will be made (`newSegments`: indexes into target.segments,
  // checkFolders' answer) carries the NEW pill; the trap's folder is drawn
  // in the warning tone.
  function crumbItems(t, newSegments) {
    if (!t) { return []; }
    const fresh = new Set(Array.isArray(newSegments) ? newSegments : []);
    const out = [{ text: t.library, isNew: false, trap: false }];
    let trapped = false;
    t.segments.forEach((text, i) => {
      const trap = !trapped && !!t.trap && t.trap.folder === text;
      if (trap) { trapped = true; }
      out.push({ text, isNew: fresh.has(i), trap });
    });
    return out;
  }

  // The bracket warning for a trap → { label, link: { label, focus } }:
  // 'emptyFolder' → "Edit tags" (Album), 'missingYear' → "Add a year"
  // (Year), 'other' → no link. Save stays allowed: songs with every tag
  // render fine with that layout.
  function trapLabel(trap) {
    if (!trap) { return null; }
    if (trap.kind === 'emptyFolder') {
      return { label: label('ytdl.where.trap.empty', { folder: trap.folder }), link: { label: label('ytdl.where.trap.editTags'), focus: 'album' } };
    }
    if (trap.kind === 'missingYear') {
      return { label: label('ytdl.where.trap.year', { folder: trap.folder }), link: { label: label('ytdl.where.trap.addYear'), focus: 'year' } };
    }
    return { label: label('ytdl.where.trap.other', { folder: trap.folder }), link: null };
  }

  function namesOf(list) {
    if (!Array.isArray(list)) { return []; }
    const out = [];
    for (const e of list) {
      const n = typeof e === 'string' ? e : (e && typeof e.name === 'string' ? e.name : null);
      if (n != null) { out.push(n); }
    }
    return out;
  }

  // The new-folder check (carryover §1.10): list the target folder; on any
  // error walk up until a listing works. The folder below the one that
  // listed is new when that listing has no entry of its name (ignoring
  // case), and so is every folder after it. A file of that name, or no
  // listing at all, is unknown.
  //   list(directory) → Promise<{ directories, files }> (names, or entries
  //     with .name — MSTREAMAPI.dirparser's answer); throws for a folder
  //     that isn't there
  //   stale() → true once the answer is no longer wanted → resolves null
  //   shown(directory) → the target's rows already on screen (the explorer
  //     window's "Right here"), or null — used when the target won't list
  // → Promise<{ state: 'known' | 'unknown', newSegments: [index…],
  //     deepest: the deepest directory that listed | null,
  //     files: the target's own file names (the name check) | null }>
  async function checkFolders({ target: t, list, stale, shown } = {}) {
    const isStale = typeof stale === 'function' ? stale : () => false;
    if (!t || !t.valid || typeof list !== 'function') { return { state: 'unknown', newSegments: [], deepest: null, files: null }; }
    const segments = t.segments;
    for (let depth = segments.length; depth >= 0; depth--) {
      const dir = dirOf(t.library, segments.slice(0, depth));
      let listing;
      try {
        listing = await list(dir);
      } catch (_) {
        if (isStale()) { return null; }
        const seen = depth === segments.length && typeof shown === 'function' ? shown(dir) : null;
        if (Array.isArray(seen)) { return { state: 'known', newSegments: [], deepest: dir, files: namesOf(seen) }; }
        continue;
      }
      if (isStale()) { return null; }
      const l = listing || {};
      if (depth === segments.length) { return { state: 'known', newSegments: [], deepest: dir, files: namesOf(l.files) }; }
      const next = segments[depth].toLowerCase();
      const there = namesOf(l.directories).some((d) => d.toLowerCase() === next) || namesOf(l.files).some((f) => f.toLowerCase() === next);
      const fresh = [];
      if (!there) { for (let i = depth; i < segments.length; i++) { fresh.push(i); } }
      return { state: there ? 'unknown' : 'known', newSegments: fresh, deepest: dir, files: null };
    }
    if (isStale()) { return null; }
    return { state: 'unknown', newSegments: [], deepest: null, files: null };
  }

  // ── "Where new songs land": the presets ────────────────────────────────
  // `view` is GET /api/v1/discovery/collection/destination
  // (destination.js describeDestination): { destination: { vpath, base,
  // layout, source } | null, saved, libraries: [{ vpath, template }] (the
  // writable ones), … }. Read only: the account destination is never
  // written. A choice is { library, layout, kind, base }, kind one of
  // 'artistAlbum' | 'artist' | 'top' | 'discover' | 'library' | 'custom'.

  const LAYOUT_KINDS = Object.freeze(['artistAlbum', 'artist', 'top', 'discover', 'library', 'custom']);
  const PRESET_KEYS = {
    artistAlbum: 'ytdl.where.preset.artistAlbum',
    artist: 'ytdl.where.preset.artist',
    top: 'ytdl.where.preset.top',
    discover: 'ytdl.where.preset.discover',
    library: 'ytdl.where.preset.library',
    custom: 'ytdl.where.preset.custom',
  };

  function librariesOf(view) {
    const libs = view && Array.isArray(view.libraries) ? view.libraries : [];
    return libs.map((l) => (l && typeof l.vpath === 'string' ? l.vpath : null)).filter((v) => v != null);
  }

  // "Same as Discover": the account's own destination (source 'user'), else
  // null.
  function discoverPreset(view) {
    const d = view && view.destination;
    if (!d || d.source !== 'user' || typeof d.vpath !== 'string') { return null; }
    return { vpath: d.vpath, base: str(d.base), layout: str(d.layout) };
  }

  // The library's admin template, or null when it has none.
  function templateOf(view, vpath) {
    const libs = view && Array.isArray(view.libraries) ? view.libraries : [];
    const lib = libs.find((l) => l && l.vpath === vpath);
    const t = lib && typeof lib.template === 'string' ? lib.template : null;
    return t == null || t.trim() === '' ? null : t;
  }

  // The "Library layout" radio's layout, or null: the library's admin
  // template, unless it is one of the presets above it (Artist / Album,
  // Artist) — still offered on the library a 'library' choice was saved
  // for (`saved`).
  function libraryTemplate(view, vpath, saved) {
    const t = templateOf(view, vpath);
    if (t == null) { return null; }
    const kept = !!saved && saved.kind === 'library' && saved.library === vpath;
    const dupe = t === LAYOUT_ARTIST_ALBUM || t === LAYOUT_ARTIST;
    return dupe && !kept ? null : t;
  }

  // The layout radios for `library`, in order →
  //   [{ kind, layout, base, library, label }]
  // Artist / Album, Artist, Top of the library, Same as Discover (its
  // library is Discover's, locked), Library layout (only when the library
  // has its own), Custom (layout null: the field's).
  function layoutChoices({ view, library, saved } = {}) {
    const lib = str(library);
    const out = [
      { kind: 'artistAlbum', layout: LAYOUT_ARTIST_ALBUM, base: '', library: lib, label: label(PRESET_KEYS.artistAlbum) },
      { kind: 'artist', layout: LAYOUT_ARTIST, base: '', library: lib, label: label(PRESET_KEYS.artist) },
      { kind: 'top', layout: LAYOUT_TOP, base: '', library: lib, label: label(PRESET_KEYS.top) },
    ];
    const d = discoverPreset(view);
    if (d) { out.push({ kind: 'discover', layout: d.layout, base: d.base, library: d.vpath, label: label(PRESET_KEYS.discover) }); }
    const t = libraryTemplate(view, lib, saved);
    if (t != null) { out.push({ kind: 'library', layout: t, base: '', library: lib, label: label(PRESET_KEYS.library) }); }
    out.push({ kind: 'custom', layout: null, base: '', library: lib, label: label(PRESET_KEYS.custom) });
    return out;
  }

  function kindOfLayout(layout) {
    if (layout === LAYOUT_TOP) { return 'top'; }
    if (layout === LAYOUT_ARTIST_ALBUM) { return 'artistAlbum'; }
    if (layout === LAYOUT_ARTIST) { return 'artist'; }
    return 'custom';
  }

  // The choice new songs land by, from what this browser remembers for the
  // server and account (`saved`: { library, layout, kind } or null) and the
  // destination view (null while it hasn't answered).
  // Library: the remembered one while the account still has it; else
  // Discover's when its destination is the user's own; else the first.
  // Layout: the remembered one, else Artist / Album — never inherited, so
  // the first song can't make an "Album ()" folder. "Same as Discover" and
  // "Library layout" follow their preset while the view knows it, and read
  // 'custom' once the view answered without it.
  function rememberedChoice({ view, saved, libraries } = {}) {
    const libs = Array.isArray(libraries) ? libraries : librariesOf(view);
    const s = saved && typeof saved === 'object' ? saved : {};
    const d = discoverPreset(view);
    let library = '';
    if (typeof s.library === 'string' && libs.indexOf(s.library) !== -1) { library = s.library; }
    else if (d && libs.indexOf(d.vpath) !== -1) { library = d.vpath; }
    else if (libs.length) { library = libs[0]; }
    const layout = typeof s.layout === 'string' ? s.layout : LAYOUT_ARTIST_ALBUM;
    let kind = LAYOUT_KINDS.indexOf(s.kind) !== -1 ? s.kind : kindOfLayout(layout);
    const loaded = !!view;
    const template = templateOf(view, library);
    if (kind === 'discover' && loaded && !d) { kind = 'custom'; }
    if (kind === 'library' && loaded && template == null) { kind = 'custom'; }
    if (kind === 'discover' && d) { return { library: d.vpath, layout: d.layout, kind, base: d.base }; }
    if (kind === 'library' && template != null) { return { library, layout: template, kind, base: '' }; }
    return { library, layout, kind, base: '' };
  }

  // What to remember for a choice ("Save"): a "Same as Discover" choice
  // keeps its base folders in front of the layout (foldBase), the copy used
  // while Discover's destination is not known.
  function choiceToSave(choice) {
    const c = choice || {};
    const layout = c.kind === 'discover' ? engine().foldBase(c.base, str(c.layout)) : str(c.layout);
    return { library: str(c.library), layout, kind: LAYOUT_KINDS.indexOf(c.kind) !== -1 ? c.kind : 'custom' };
  }

  // A choice's target for the song's tags.
  function choiceTarget(choice, tags) {
    const c = choice || {};
    return target({ vpath: c.library, base: c.kind === 'discover' ? c.base : '', layout: c.layout, tags });
  }

  // "Sort into subfolders…" in the explorer window (not remembered).
  const FOLDER_SORTS = Object.freeze([
    Object.freeze({ kind: 'here', layout: LAYOUT_TOP, label: Object.freeze(label('ytdl.sort.here')) }),
    Object.freeze({ kind: 'album', layout: LAYOUT_ALBUM, label: Object.freeze(label('ytdl.sort.album')) }),
    Object.freeze({ kind: 'artistAlbum', layout: LAYOUT_ARTIST_ALBUM, label: Object.freeze(label('ytdl.sort.artistAlbum')) }),
    Object.freeze({ kind: 'custom', layout: null, label: Object.freeze(label('ytdl.sort.custom')) }),
  ]);

  // ── formats ────────────────────────────────────────────────────────────
  // From the server's `supportedAudioFiles` map (MSTREAMAPI.currentServer,
  // from the ping): the route validates `outputCodec` against its `true`
  // keys, so the menu offers nothing else. m4b and m3u never appear (an
  // audiobook container is no choice for a song, m3u is a playlist); AAC
  // lands as an .m4a, so it is offered only in M4A's place.
  // (lib/util/ytdl_formats.dart.)

  const FORMAT_ORDER = Object.freeze(['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav']);
  const FORMAT_HELP_KEYS = {
    mp3: 'ytdl.format.mp3',
    m4a: 'ytdl.format.m4a',
    opus: 'ytdl.format.opus',
    flac: 'ytdl.format.flac',
    wav: 'ytdl.format.wav',
  };

  // The `true` keys of a supportedAudioFiles map — or a list of keys as it
  // is — else null (unknown or malformed).
  function enabledFormats(supported) {
    if (Array.isArray(supported)) { return supported.filter((k) => typeof k === 'string'); }
    if (supported && typeof supported === 'object') { return Object.keys(supported).filter((k) => supported[k] === true); }
    return null;
  }

  // In FORMAT_ORDER; 'aac' after m4a's slot only when m4a is off; ['mp3']
  // when nothing usable is known.
  function formatOptions(supported) {
    const enabled = enabledFormats(supported);
    if (enabled == null) { return ['mp3']; }
    const on = new Set(enabled);
    const out = [];
    for (const f of FORMAT_ORDER) {
      if (on.has(f)) { out.push(f); }
      if (f === 'm4a' && !on.has('m4a') && on.has('aac')) { out.push('aac'); }
    }
    return out.length ? out : ['mp3'];
  }

  // mp3 when on, else the first option.
  function defaultFormat(supported) {
    const options = formatOptions(supported);
    return options.indexOf('mp3') !== -1 ? 'mp3' : options[0];
  }

  // `remembered` while it is still an option, else the default.
  function effectiveFormat(remembered, supported) {
    return remembered != null && formatOptions(supported).indexOf(remembered) !== -1 ? remembered : defaultFormat(supported);
  }

  // A format's name as menus and rows show it — not translated, like the
  // transcode panel's codec names.
  const FORMAT_NAMES = { mp3: 'MP3', m4a: 'M4A', opus: 'Opus', ogg: 'OGG Vorbis', flac: 'FLAC', wav: 'WAV', aac: 'AAC' };
  function formatName(codec) {
    const c = str(codec).toLowerCase();
    return FORMAT_NAMES[c] || c.toUpperCase();
  }

  // The menu item's help line, or null (OGG Vorbis and AAC have none).
  function formatHelp(codec) {
    const key = FORMAT_HELP_KEYS[str(codec).toLowerCase()];
    return key ? label(key) : null;
  }

  // ── the file name ──────────────────────────────────────────────────────
  // The server names the file: yt-dlp's restricted rule over the RAW video
  // title (never the edited one — the route re-tags the file, it does not
  // rename it), and GET /ytdl/metadata says the stem it got (`fileStem`).
  // The extension follows the format: yt-dlp writes AAC into an .m4a
  // (OUTPUT_EXT_MAP) and is asked for m4a when the codec is m4b.

  function outputExtension(codec) {
    const c = str(codec).toLowerCase();
    return c === 'aac' || c === 'm4b' ? 'm4a' : c;
  }

  // "One_More_Time.mp3", or '' without a stem.
  function fileNameFor(fileStem, codec) {
    const stem = str(fileStem);
    return stem === '' ? '' : `${stem}.${outputExtension(codec)}`;
  }

  // yt-dlp's transliteration table (utils ACCENT_CHARS): these keep their
  // letters; every other letter outside A–Z becomes '_' or goes.
  const ACCENT_FROM = 'ÂÃÄÀÁÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖŐØŒÙÚÛÜŰÝÞßàáâãäåæçèéêëìíîïðñòóôõöőøœùúûüűýþÿ';
  const ACCENT_TO = [...'AAAAAA', 'AE', ...'CEEEEIIIIDNOOOOOOO', 'OE', ...'UUUUUY', 'TH', 'ss',
    ...'aaaaaa', 'ae', ...'ceeeeiiiionooooooo', 'oe', ...'uuuuuy', 'th', 'y'];
  const ACCENT = new Map(Array.from(ACCENT_FROM).map((c, i) => [c, ACCENT_TO[i]]));
  const LETTER = /^\p{L}$/u;
  const ASCII_LETTER = /^[A-Za-z]$/;

  // "letters outside A–Z are dropped from file names": the restricted rule
  // lost letters of the raw title. With the server's `fileStem` the stem
  // decides: each letter of the title (after the NFKC step yt-dlp starts
  // with) gives at least one letter of the stem — its own, or yt-dlp's
  // spelling of it (ß → ss) — and a lost one gives none, so a stem with
  // fewer letters than the title's lost some. That holds whatever letters
  // a newer yt-dlp learns to spell. Without a stem, the title alone: a
  // letter neither ASCII nor in yt-dlp's table (the phone's rule).
  function lettersDropped(title, fileStem) {
    const t = str(title);
    if (t === '') { return false; }
    let expected = 0;
    let foreign = false;
    for (const c of t.normalize('NFKC')) {
      if (ASCII_LETTER.test(c)) { expected += 1; continue; }
      if (!LETTER.test(c)) { continue; }
      const spelled = ACCENT.get(c);
      if (spelled === undefined) { foreign = true; }
      expected += spelled === undefined ? 1 : spelled.length;
    }
    if (typeof fileStem !== 'string' || fileStem === '') { return foreign; }
    let kept = 0;
    for (const c of fileStem) { if (LETTER.test(c)) { kept += 1; } }
    return kept < expected;
  }

  // The name check: `fileStem` + the format's extension is in the folder's
  // listing (`files`: names or entries with .name — checkFolders' `files`,
  // null when the target didn't list or is new), ignoring case as the phone
  // does. The server refuses it with 409 before downloading.
  function clashes({ fileStem, codec, files } = {}) {
    const name = fileNameFor(fileStem, codec).toLowerCase();
    if (name === '' || !Array.isArray(files)) { return false; }
    return namesOf(files).some((f) => f.toLowerCase() === name);
  }

  // The card's file line (decision 14: no file name unless letters drop
  // or it clashes) → { name, clash, lettersDropped, line } where line is
  //   clash:   { tone: 'warn', label: "Something like “{{name}}” looks to be
  //            in this folder already…", link: { label: "Change format",
  //            action: 'changeFormat' } } — the primary reads "Add anyway"
  //   dropped: { tone: 'note', label: "about {{name}} · letters outside A–Z…" }
  //   or null.
  function nameCheck({ title, fileStem, codec, files } = {}) {
    const name = fileNameFor(fileStem, codec);
    const clash = clashes({ fileStem, codec, files });
    const dropped = lettersDropped(title, fileStem);
    let line = null;
    if (clash) { line = { tone: 'warn', label: label('ytdl.clash', { name }), link: { label: label('ytdl.changeFormat'), action: 'changeFormat' } }; }
    else if (dropped && name !== '') { line = { tone: 'note', label: label('ytdl.file.lettersDropped', { name }), link: null }; }
    return { name, clash, lettersDropped: dropped, line };
  }

  // `fileName` cut in the middle to at most `max` characters, keeping its
  // start, and its end with the extension and up to eight characters before
  // it: "Gorillaz_-_Feel_Good…Video_HD.mp3". Unchanged when it fits.
  // Counts code points, so an emoji is never split.
  function middleEllipsis(fileName, max) {
    const runes = Array.from(str(fileName));
    if (runes.length <= max) { return runes.join(''); }
    if (max <= 0) { return ''; }
    const keep = max - 1; // one goes to the ellipsis
    const dot = runes.lastIndexOf('.');
    // ".mp3", ".opus": a dot further back is part of the title.
    const extLen = dot > 0 && runes.length - dot <= 6 ? runes.length - dot : 0;
    const end = (n) => runes.slice(runes.length - n).join('');
    if (keep <= extLen) { return `…${end(keep)}`; }
    // The extension and up to eight characters before it, but not more than
    // half of what fits, so a short limit still shows how the name starts.
    const tail = Math.min(Math.min(extLen + 8, Math.max(extLen + 2, Math.floor(keep / 2))), keep - 1);
    return `${runes.slice(0, keep - tail).join('')}…${end(tail)}`;
  }

  // ── failures ───────────────────────────────────────────────────────────
  // Why a lookup, a folder-make or an add failed, or why a job did — by the
  // status, the server's `{ error }` words and, from this release, its
  // `reason` code (lib/util/ytdl_errors.dart, plus the new shapes). The
  // error is what MSTREAMAPI's req() throws: `err.status` and `err.body`
  // (the parsed envelope, or null) for an answer; fetch's TypeError for no
  // connection at all; an AbortError / TimeoutError for a bound the caller
  // set (or `err.timedOut`); a SyntaxError for a 2xx whose body would not
  // parse.
  //
  // A failure is { problem, detail, reason, text, phase }:
  //   problem  'ytdlpMissing' | 'ffmpegNotReady' | 'uploadsOff' | 'mkdirOff' |
  //            'mkdirFailed' | 'libraryGone' | 'noRoute' | 'badFormat' |
  //            'badRequest' | 'serverError' | 'lookupFailed' | 'timedOut' |
  //            'offline' | 'unreachable' | 'startUnsure' | 'exists' |
  //            'tooBig' | 'tooLong' | 'live' | 'unavailable' | 'other' |
  //            'unknown'
  //   detail   'other': the words to quote (the server's, or "HTTP <status>");
  //            'exists': the file name; 'libraryGone': the library;
  //            'mkdirFailed' / 'mkdirOff': the folder; else null
  //   reason   the server's reason code when it sent one, else null
  //   text     the server's own words, when it sent any, else null
  //   phase    'start' (the add or its mkdir), 'lookup', 'download' (a job)

  function failure(problem, detail, extra) {
    const e = extra || {};
    return { problem, detail: detail == null ? null : detail, reason: e.reason || null, text: e.text == null ? null : e.text, phase: e.phase || 'start' };
  }

  // The server's answer → { status, fromServer, message, reason, fileName },
  // or null when there was none (no connection, a timeout, an unreadable
  // body, a thrown bug). An `error` of only spaces is no words (the phone's
  // rule): a bare 400/404/500 reads as one, never as an empty quote.
  function answerOf(err) {
    const e = err || {};
    if (e.timedOut === true || e.name === 'AbortError' || e.name === 'TimeoutError') { return null; }
    const status = Number.isInteger(e.status) && e.status > 0 ? e.status : 0;
    if (status === 0) { return null; }
    const body = e.body && typeof e.body === 'object' ? e.body : null;
    const fromServer = !!body && typeof body.error === 'string' && body.error.trim() !== '';
    return {
      status, fromServer, message: fromServer ? body.error : '',
      reason: body && typeof body.reason === 'string' ? body.reason : null,
      fileName: body && typeof body.fileName === 'string' && body.fileName !== '' ? body.fileName : null,
    };
  }

  // No answer: 'timedOut' (the caller's bound), 'network' (fetch's
  // TypeError: refused, dropped, DNS — a browser can't tell which),
  // 'unreadable' (a 2xx whose body would not parse) or 'other' (not a
  // request failure at all).
  function unansweredKind(err) {
    const e = err || {};
    if (e.timedOut === true || e.name === 'AbortError' || e.name === 'TimeoutError') { return 'timedOut'; }
    if (e.name === 'TypeError' || e.status === 0) { return 'network'; }
    if (e.name === 'SyntaxError') { return 'unreadable'; }
    return 'other';
  }

  // No connection: navigator.onLine says whose ("You're offline" vs "Can't
  // reach {server}"); not knowing reads as the server.
  function noConnection(opts, phase) {
    return failure(opts && opts.online === false ? 'offline' : 'unreachable', null, { phase });
  }

  // "yt-dlp is not installed" (6.30+) · "Error - failed to find yt-dlp" (older).
  function ytdlpMissing(a) {
    if (!a.fromServer) { return false; }
    const m = a.message.toLowerCase();
    return m.indexOf('yt-dlp') !== -1 && (m.indexOf('not installed') !== -1 || m.indexOf('failed to find') !== -1);
  }

  function ffmpegNotReady(a) { return a.fromServer && a.message.toLowerCase().startsWith('ffmpeg is not available'); }

  // The server's catch-all ("Server Error"), or a 500 with no words at all.
  function bareServerError(a) { return !a.fromServer || a.message.trim() === 'Server Error'; }

  function wordsOf(a) { return a.fromServer ? a.message : null; }

  function otherOf(a, phase) {
    return failure('other', a.fromServer ? a.message : `HTTP ${a.status}`, { text: wordsOf(a), phase });
  }

  function libraryOf(directory) {
    const crumbs = engine().pathCrumbs(directory);
    return crumbs.length ? crumbs[0] : null;
  }

  function lastFolderOf(directory) {
    const crumbs = engine().pathCrumbs(directory);
    return crumbs.length ? crumbs[crumbs.length - 1] : '';
  }

  // vpath.js's two 404s, with the library's name in them.
  const LIBRARY_NOT_FOUND = /^Library '(.+)' not found$/;
  const NO_ACCESS = /^User does not have access to path (.+)$/;

  // A 404. Express's own (no words) is no such route. One naming the
  // library is a lost library — its name from the words, else from the
  // folder asked for. Any other 404 with words is quoted: on the phone it
  // read as a lost library too, but this server also says "Folder not
  // found" for a folder that went away, which a lost library would misname.
  function notFound(a, directory, phase) {
    if (!a.fromServer) { return failure('noRoute', null, { phase }); }
    const m = a.message.trim();
    const named = LIBRARY_NOT_FOUND.exec(m) || NO_ACCESS.exec(m);
    if (named) { return failure('libraryGone', named[1] || libraryOf(directory), { text: a.message, phase }); }
    return otherOf(a, phase);
  }

  // Joi's own message starts with the quoted field (`"url" must be …`); the
  // sanitizer says "Invalid YouTube URL - missing video ID". A 400 with no
  // words is taken as the same. Anything else ("Not A Directory") is quoted.
  function badRequestOf(a, phase) {
    const m = a.message.trim();
    if (!a.fromServer || m.startsWith('"') || m.indexOf('missing video ID') !== -1) { return failure('badRequest', null, { text: wordsOf(a), phase }); }
    return otherOf(a, phase);
  }

  // `err` from POST /api/v1/ytdl/. opts: { directory } (the folder asked
  // for; names a lost library the words don't). Every request failure
  // without an answer is 'startUnsure': a browser can't tell a refused
  // connection from a dropped one, a client timeout doesn't stop a job the
  // server took, and an unreadable 2xx did start — so the add may be
  // running, and is looked for rather than retried (a second POST is a
  // second job).
  function classifyAdd(err, opts) {
    const o = opts || {};
    const a = answerOf(err);
    if (!a) { return unansweredKind(err) === 'other' ? failure('other', null) : failure('startUnsure', null); }
    if (ytdlpMissing(a)) { return failure('ytdlpMissing', null, { text: a.message }); }
    switch (a.status) {
      case 409:
        // The name check, before anything downloaded: { reason: 'exists', fileName }.
        if (a.reason === 'exists' || a.fileName) { return failure('exists', a.fileName, { reason: 'exists', text: wordsOf(a) }); }
        break;
      case 403:
        // Uploads off: the server's gate, the account's, a jukebox session.
        return failure('uploadsOff', null, { text: wordsOf(a) });
      case 404:
        return notFound(a, o.directory, 'start');
      case 400:
        if (a.message.indexOf('outputCodec') !== -1) { return failure('badFormat', null, { text: a.message }); }
        return badRequestOf(a, 'start');
      case 500:
        if (ffmpegNotReady(a)) { return failure('ffmpegNotReady', null, { text: a.message }); }
        if (bareServerError(a)) { return failure('serverError', null, { text: wordsOf(a) }); }
        break;
    }
    return otherOf(a, 'start');
  }

  // `err` from GET /api/v1/ytdl/metadata. opts: { online } (navigator.onLine).
  // The route has no upload or ffmpeg gate, so a 403 or a 404 with words is
  // quoted.
  function classifyLookup(err, opts) {
    const a = answerOf(err);
    if (!a) {
      const kind = unansweredKind(err);
      if (kind === 'timedOut') { return failure('timedOut', null, { phase: 'lookup' }); }
      if (kind === 'network') { return noConnection(opts, 'lookup'); }
      // A 200 this client could not read: as good as no reading.
      if (kind === 'unreadable') { return failure('lookupFailed', null, { phase: 'lookup' }); }
      return failure('other', null, { phase: 'lookup' });
    }
    if (ytdlpMissing(a)) { return failure('ytdlpMissing', null, { text: a.message, phase: 'lookup' }); }
    if (a.status === 404 && !a.fromServer) { return failure('noRoute', null, { phase: 'lookup' }); }
    // Any 400 here is about the link: the query takes nothing else.
    if (a.status === 400) { return failure('badRequest', null, { text: wordsOf(a), phase: 'lookup' }); }
    // yt-dlp exiting non-zero is a plain throw on the server: a 500 without
    // words reads the same way.
    if ((a.status === 500 && bareServerError(a)) || (a.status >= 200 && a.status <= 299)) {
      return failure('lookupFailed', null, { text: wordsOf(a), phase: 'lookup' });
    }
    return otherOf(a, 'lookup');
  }

  // `err` from POST /api/v1/file-explorer/mkdir, as the server answered it.
  // opts: { online, directory }.
  function classifyMkdir(err, opts) {
    const o = opts || {};
    const a = answerOf(err);
    if (!a) {
      const kind = unansweredKind(err);
      if (kind === 'timedOut') { return failure('timedOut', null); }
      if (kind === 'network') { return noConnection(o, 'start'); }
      return failure('other', null);
    }
    switch (a.status) {
      case 403: return failure('mkdirOff', null, { text: wordsOf(a) });
      case 404: return notFound(a, o.directory, 'start');
      case 400: return badRequestOf(a, 'start');
      case 500:
        // A file in the way of the folder.
        if (bareServerError(a)) { return failure('serverError', null, { text: wordsOf(a) }); }
        break;
    }
    return otherOf(a, 'start');
  }

  // A failed mkdir as the add shows it: refused (403: mkdirOff, the folder
  // named), a lost library, or no connection stay what they are; anything
  // else is "Couldn't make the folder “Discovery”." (mkdirFailed) — the
  // folder named, not the status. opts: { folder (the first new folder's
  // name), directory (the mkdir's path), online }.
  // null for a 2xx whose body would not parse: any 2xx means the folder is
  // there (the phone's rule; the route answers `{}`), so the add goes on.
  function mkdirFailure(err, opts) {
    const o = opts || {};
    if (!answerOf(err) && unansweredKind(err) === 'unreadable') { return null; }
    const f = classifyMkdir(err, o);
    const folder = o.folder || lastFolderOf(o.directory);
    if (f.problem === 'mkdirOff') { return failure('mkdirOff', folder || null, { text: f.text }); }
    if (f.problem === 'offline' || f.problem === 'unreachable' || f.problem === 'libraryGone') { return f; }
    return failure('mkdirFailed', folder, { text: f.text });
  }

  // A job entry's failure (GET /api/v1/ytdl/downloads: status 'error',
  // `reason`, `error`, `fileName`), or null while it hasn't failed. A reason
  // code reads as its own copy; without one the server's words are the
  // answer ("The server said: “Sign in to confirm you're not a bot.”" —
  // the bot check and a stale yt-dlp are deliberately null); without words
  // either, 'unknown'.
  const REASON_PROBLEMS = { exists: 'exists', 'too-big': 'tooBig', 'too-long': 'tooLong', live: 'live', unavailable: 'unavailable' };
  function entryFailure(entry) {
    if (!entry || entry.status !== 'error') { return null; }
    const text = typeof entry.error === 'string' && entry.error.trim() !== '' ? entry.error.trim() : null;
    const problem = Object.prototype.hasOwnProperty.call(REASON_PROBLEMS, entry.reason) ? REASON_PROBLEMS[entry.reason] : null;
    if (problem) {
      const name = problem === 'exists' && typeof entry.fileName === 'string' && entry.fileName !== '' ? entry.fileName : null;
      return failure(problem, name, { reason: entry.reason, text, phase: 'download' });
    }
    return text ? failure('other', text, { text, phase: 'download' }) : failure('unknown', null, { phase: 'download' });
  }

  const BARE_STATUS = /^HTTP \d+$/;

  // The server's own words to quote for 'other' ("The server said: “…”");
  // null when it sent none ("HTTP 502") — "Something went wrong on the
  // server." then.
  function serverWords(f) {
    if (!f || f.problem !== 'other') { return null; }
    const d = str(f.detail).trim();
    return d === '' || BARE_STATUS.test(d) ? null : d;
  }

  // Where the lookup stands after a failure: 'ytdlpMissing' | 'timedOut' |
  // 'offline' | 'unreachable' | 'failed'.
  function lookupStateOf(f) {
    const p = f && f.problem;
    return p === 'ytdlpMissing' || p === 'timedOut' || p === 'offline' || p === 'unreachable' ? p : 'failed';
  }

  // A failure in words → label. ctx:
  //   surface  'panel' (default: inline above the panel's footer) |
  //            'window' (the explorer window: a lost library's first
  //            sentence only) | 'row' (a Needs a look row) | 'lookup' (the
  //            card's lookup line; a failure from classifyLookup always is)
  //   server   the server's name ("Can't reach Home server…")
  //   codec    the format the failed add asked for ("doesn't save Opus")
  // A job's failure (phase 'download') reads the same everywhere: its row
  // line, "Failed · …".
  function failureLabel(f, ctx) {
    if (!f) { return null; }
    const c = ctx || {};
    const surface = c.surface || 'panel';
    const server = str(c.server);
    const p = f.problem;
    // The server's words quoted, or — with none — that it went wrong there.
    const said = (words) => (words == null ? label('ytdl.err.server') : label('ytdl.err.said', { text: words }));
    const text = f.text == null || str(f.text).trim() === '' ? null : str(f.text).trim();
    if (f.phase === 'download') {
      switch (p) {
        case 'exists': return f.detail ? label('ytdl.reason.exists', { name: f.detail }) : label('ytdl.reason.existsUnnamed');
        case 'tooBig': return label('ytdl.reason.tooBig');
        case 'tooLong': return label('ytdl.reason.tooLong');
        case 'live': return label('ytdl.reason.live');
        case 'unavailable': return label('ytdl.reason.unavailable');
        case 'other': {
          const words = serverWords(f);
          return words == null ? label('ytdl.row.failedUnknown') : label('ytdl.row.failedSaid', { text: words });
        }
        default: return label('ytdl.row.failedUnknown');
      }
    }
    // A lookup's failure reads as one wherever it shows.
    if (surface === 'lookup' || f.phase === 'lookup') {
      switch (p) {
        case 'timedOut': return label('ytdl.lookup.timedOut');
        case 'ytdlpMissing': return label('ytdl.server.noYtdlp');
        case 'offline': return label('ytdl.server.offline');
        case 'unreachable': return label('ytdl.server.unreachable', { server });
        case 'noRoute': return label('ytdl.err.noRoute');
        case 'badRequest': return label('ytdl.err.badRequest');
        case 'other': return said(serverWords(f));
        default: return label('ytdl.lookup.failed');
      }
    }
    const row = surface === 'row';
    switch (p) {
      case 'ytdlpMissing': return label('ytdl.server.noYtdlp');
      case 'ffmpegNotReady': return label('ytdl.err.ffmpeg');
      case 'uploadsOff': return label('ytdl.err.uploadsOff');
      case 'mkdirOff': return f.detail ? label('ytdl.noMkdir.new', { folder: f.detail }) : label('ytdl.noMkdir.unchecked');
      case 'mkdirFailed': return label('ytdl.err.mkdir', { folder: str(f.detail) });
      case 'libraryGone':
        // A row can't pick another library either: the first sentence only.
        return label(surface === 'panel' ? 'ytdl.err.libraryGone' : 'ytdl.err.libraryGoneShort', { library: str(f.detail) });
      case 'noRoute': return label('ytdl.err.noRoute');
      case 'badFormat': return label('ytdl.err.formatOff', { format: formatName(c.codec) });
      case 'badRequest': return label('ytdl.err.badRequest');
      case 'exists': return f.detail ? label('ytdl.err.exists', { name: f.detail }) : said(text);
      case 'offline': return label(row ? 'ytdl.row.didntStart' : 'ytdl.err.addOffline');
      case 'unreachable': return row ? label('ytdl.row.didntStart') : label('ytdl.err.addUnreachable', { server });
      case 'startUnsure': return label('ytdl.row.startUnsure');
      case 'other': return said(serverWords(f));
      default: return label('ytdl.err.server');
    }
  }

  // A failure's ways on, as action names the row (or the inline line) maps
  // to buttons, Dismiss last: 'retry' (Try again) · 'changeFormat' (Change
  // format and retry) · 'chooseFolder' (Choose a folder…) · 'topOfLibrary'
  // · 'checkAgain' · 'dismiss'. A retry that would fail the same way after
  // another full download is not offered (the phone's rule for a clash):
  // a name taken or a file over the cap gets Change format instead — and
  // that only when the server has another format (`formats`, the menu's
  // options); a video YouTube won't give the server, nothing but Dismiss.
  function failureActions(f, ctx) {
    if (!f) { return []; }
    const c = ctx || {};
    const formats = Array.isArray(c.formats) ? c.formats : null;
    const another = formats == null || formats.length > 1;
    const changeFormat = another ? ['changeFormat', 'dismiss'] : ['dismiss'];
    if (f.phase === 'download') {
      if (f.problem === 'exists' || f.problem === 'tooBig') { return changeFormat; }
      if (f.problem === 'unavailable') { return ['dismiss']; }
      return ['retry', 'dismiss'];
    }
    switch (f.problem) {
      case 'mkdirFailed': return ['retry', 'chooseFolder', 'dismiss'];
      case 'mkdirOff': return ['topOfLibrary', 'chooseFolder', 'dismiss'];
      case 'uploadsOff': case 'libraryGone': case 'noRoute': return ['dismiss'];
      case 'badFormat': case 'exists': return changeFormat;
      case 'startUnsure': return ['checkAgain', 'dismiss'];
      default: return ['retry', 'dismiss'];
    }
  }

  // ── why Add is off ─────────────────────────────────────────────────────
  // The first reason that holds, in the phone's order (ytdl_draft.dart
  // YtdlBlock), → 'none' | 'convertOff' (the button goes) | 'noLink' |
  // 'offline' | 'unreachable' | 'ytdlpMissing' | 'lookingUp' (until found,
  // or "Enter details yourself") | 'uploadsOff' | 'alreadyAdding' |
  // 'invalidLayout' | 'yearInvalid' | 'mkdirBlocked'.
  // The phone's last one, a clash on a server before 6.30, has no web
  // twin: the webapp's server is always its own release, which refuses a
  // clash before downloading, so a clash is "Add anyway", never a block.
  //   s: { convertOff, link (parseLink's) or linkKind, lookup ('idle' |
  //        'loading' | 'slow' | 'found' | 'failed' | 'timedOut' |
  //        'ytdlpMissing' | 'offline' | 'unreachable'), manual, uploadsOff,
  //        starting (this surface's own add is starting), alreadyAdding,
  //        targetValid, year (the Year field) or yearInvalid, mkdirBlocked }
  function addBlock(s) {
    const st = s || {};
    if (st.convertOff === true) { return 'convertOff'; }
    const kind = st.link ? st.link.kind : st.linkKind;
    if (kind !== 'video') { return 'noLink'; }
    if (st.lookup === 'offline') { return 'offline'; }
    if (st.lookup === 'unreachable') { return 'unreachable'; }
    if (st.lookup === 'ytdlpMissing') { return 'ytdlpMissing'; }
    if (st.manual !== true && (st.lookup == null || st.lookup === 'idle' || st.lookup === 'loading' || st.lookup === 'slow')) { return 'lookingUp'; }
    if (st.uploadsOff === true) { return 'uploadsOff'; }
    // While this surface's add starts, the open job is its own: "Adding…"
    // says so (the note is for an earlier add).
    if (st.starting !== true && st.alreadyAdding === true) { return 'alreadyAdding'; }
    if (st.targetValid === false) { return 'invalidLayout'; }
    if (st.yearInvalid === true || (st.yearInvalid == null && yearInvalid(st.year))) { return 'yearInvalid'; }
    if (st.mkdirBlocked === true) { return 'mkdirBlocked'; }
    return 'none';
  }

  // The line a block shows on screen (the reason is never only in a
  // tooltip) → label, or null where something else says it: lookingUp
  // (the reading line), noLink (the link line), mkdirBlocked (the
  // can't-make-folders card), none. ctx: { server }.
  function blockLabel(block, ctx) {
    const server = str(ctx && ctx.server);
    switch (block) {
      case 'convertOff': return label('ytdl.err.ffmpeg');
      case 'offline': return label('ytdl.server.offline');
      case 'unreachable': return label('ytdl.server.unreachable', { server });
      case 'ytdlpMissing': return label('ytdl.server.noYtdlp');
      case 'uploadsOff': return label('ytdl.err.uploadsOff');
      case 'alreadyAdding': return label('ytdl.alreadyAdding');
      case 'invalidLayout': return label('ytdl.where.fixLayout');
      case 'yearInvalid': return label('ytdl.yearInvalid');
      default: return null;
    }
  }

  // The primary's words: "Add to library" (panel) / "Add here" (window),
  // "Add anyway" on a clash, "Adding…" while the server hasn't answered.
  function addButtonLabel({ surface, clash, starting } = {}) {
    if (starting === true) { return label('ytdl.adding'); }
    if (clash === true) { return label('ytdl.addAnyway'); }
    return label(surface === 'window' ? 'ytdl.addHere' : 'ytdl.add');
  }

  // Every i18n key this module can return, for the locale tests: en.json
  // (and the other eleven) must carry each one.
  const KEYS = Object.freeze([
    'ytdl.link.notYoutube', 'ytdl.link.playlist', 'ytdl.link.inPlaylist', 'ytdl.link.live',
    'ytdl.source.ytMusic', 'ytdl.source.videoTitle', 'ytdl.source.videoTitleAgrees', 'ytdl.source.channel', 'ytdl.source.cleaned',
    'ytdl.help.music', 'ytdl.help.videoTitle', 'ytdl.help.videoTitleCleaned', 'ytdl.help.youtubeArtist', 'ytdl.help.youtubeArtistCheck',
    'ytdl.help.youtubeArtistStripped', 'ytdl.help.videoRelease', 'ytdl.help.edited',
    'ytdl.blank.title', 'ytdl.blank.artistMusic', 'ytdl.blank.artistGuess', 'ytdl.blank.artistGuessUnnamed', 'ytdl.blank.albumSingle',
    'ytdl.blank.albumKeeps', 'ytdl.blank.year',
    'ytdl.where.err.unknownVar', 'ytdl.where.err.neverVar', 'ytdl.where.err.badChar', 'ytdl.where.err.braces', 'ytdl.where.err.absolute',
    'ytdl.where.err.traversal', 'ytdl.where.err.empty', 'ytdl.where.err.home', 'ytdl.where.err.drive', 'ytdl.where.err.tooLong',
    'ytdl.where.err.control', 'ytdl.where.err.generic', 'ytdl.where.fixLayout',
    'ytdl.where.trap.empty', 'ytdl.where.trap.year', 'ytdl.where.trap.other', 'ytdl.where.trap.editTags', 'ytdl.where.trap.addYear',
    'ytdl.where.preset.artistAlbum', 'ytdl.where.preset.artist', 'ytdl.where.preset.top', 'ytdl.where.preset.discover',
    'ytdl.where.preset.library', 'ytdl.where.preset.custom',
    'ytdl.sort.here', 'ytdl.sort.album', 'ytdl.sort.artistAlbum', 'ytdl.sort.custom',
    'ytdl.format.mp3', 'ytdl.format.m4a', 'ytdl.format.opus', 'ytdl.format.flac', 'ytdl.format.wav',
    'ytdl.clash', 'ytdl.changeFormat', 'ytdl.file.lettersDropped',
    'ytdl.server.noYtdlp', 'ytdl.server.offline', 'ytdl.server.unreachable',
    'ytdl.lookup.failed', 'ytdl.lookup.timedOut',
    'ytdl.err.ffmpeg', 'ytdl.err.uploadsOff', 'ytdl.err.mkdir', 'ytdl.err.libraryGone', 'ytdl.err.libraryGoneShort', 'ytdl.err.noRoute',
    'ytdl.err.formatOff', 'ytdl.err.badRequest', 'ytdl.err.server', 'ytdl.err.said', 'ytdl.err.exists', 'ytdl.err.addOffline',
    'ytdl.err.addUnreachable',
    'ytdl.noMkdir.new', 'ytdl.noMkdir.unchecked',
    'ytdl.reason.exists', 'ytdl.reason.existsUnnamed', 'ytdl.reason.tooBig', 'ytdl.reason.tooLong', 'ytdl.reason.live', 'ytdl.reason.unavailable',
    'ytdl.row.failedSaid', 'ytdl.row.failedUnknown', 'ytdl.row.didntStart', 'ytdl.row.startUnsure',
    'ytdl.alreadyAdding', 'ytdl.yearInvalid',
    'ytdl.add', 'ytdl.addHere', 'ytdl.addAnyway', 'ytdl.adding',
  ]);

  return {
    KEYS,
    // links
    parseLink, linkNotes, isLiveMeta, readMetadata,
    // the title readers (the server's) and the guess
    cleanTitle, splitArtistTitle, isTopicChannel, channelArtist,
    GUESS_NONE, guess, titleWith, artistWith, sameGuess,
    guessFields, guessView, sourceLine, cleanedLabel, FIELDS, fieldHelp, yearInvalid, tagsOf, addRequest,
    // where it lands
    YTDL_VARS, NEVER_VARS, LAYOUT_ARTIST_ALBUM, LAYOUT_ARTIST, LAYOUT_ALBUM, LAYOUT_TOP,
    layoutCheck, layoutProblem, target, folderTarget, crumbItems, onlyBrackets, withoutEmptyPairs, trapLabel, checkFolders,
    LAYOUT_KINDS, discoverPreset, libraryTemplate, layoutChoices, rememberedChoice, choiceToSave, choiceTarget, FOLDER_SORTS,
    // formats and the file name
    FORMAT_ORDER, enabledFormats, formatOptions, defaultFormat, effectiveFormat, formatName, formatHelp,
    outputExtension, fileNameFor, lettersDropped, clashes, nameCheck, middleEllipsis,
    // failures
    REASON_PROBLEMS, classifyAdd, classifyLookup, classifyMkdir, mkdirFailure, entryFailure, serverWords, lookupStateOf,
    failureLabel, failureActions,
    // Add
    addBlock, blockLabel, addButtonLabel,
  };
}));
