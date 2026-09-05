// BtbN/FFmpeg-Builds release retention, as their util/prunetags.sh enforces
// it after every build: of the dated `autobuild-YYYY-MM-DD-HH-MM` releases,
// only the KEEP_LATEST newest and the newest build of each of the KEEP_MONTHLY
// most recent months survive — every other release is deleted, tag and
// assets, and its download URLs answer 404 from then on. So a pin is durable
// only when it is the FINAL build of a COMPLETED month: the current month's
// newest build is superseded (and, two weeks later, pruned) by tomorrow's.
//
// Pure helpers shared by scripts/update-ffmpeg-manifest.mjs and its tests.
export const KEEP_LATEST = 14;
export const KEEP_MONTHLY = 24;

const TAG_RE = /^autobuild-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;

export function parseAutobuildTag(tag) {
  const m = TAG_RE.exec(tag || '');
  if (!m) { return null; }
  return { tag, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
}

// Zero-padded dated tags sort chronologically as strings.
function newest(parsed) {
  return parsed.slice().sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0))[0] || null;
}

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function currentMonthIndex(now) {
  return monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/**
 * The newest autobuild tag from the most recent COMPLETED (UTC) month — the
 * pin BtbN keeps for ~KEEP_MONTHLY months. `tags` is any mix of release tag
 * names (non-autobuild names are ignored); `now` is the reference time.
 * Returns null when no completed month has a build.
 */
export function pickRetainedTag(tags, now = new Date()) {
  const cutoff = currentMonthIndex(now);
  const eligible = tags.map(parseAutobuildTag).filter((t) => t && monthIndex(t.year, t.month) < cutoff);
  const pick = newest(eligible);
  return pick ? pick.tag : null;
}

/**
 * Whether `tag` is the final build of a completed month among `tags` — the
 * only kind of pin BtbN retains long-term. A current-month tag is never
 * final (tomorrow's build supersedes it), and a tag with a later sibling in
 * its month has already lost that month's slot.
 */
export function isRetainedTag(tag, tags, now = new Date()) {
  const t = parseAutobuildTag(tag);
  if (!t) { return false; }
  if (monthIndex(t.year, t.month) >= currentMonthIndex(now)) { return false; }
  const sameMonth = tags.map(parseAutobuildTag).filter((o) => o && o.year === t.year && o.month === t.month);
  const top = newest(sameMonth);
  return !!top && top.tag === tag;
}
