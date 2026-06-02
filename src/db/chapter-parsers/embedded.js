// Chapter extraction: M4B / MP4 embedded chapters.
// music-metadata exposes embedded chapters on parsed.native or parsed.format
// depending on the container. For MP4/M4B the canonical place is the
// 'iTunes' chapter atom which music-metadata surfaces as parsed.format.chapters
// (newer builds) or via the 'chap' tag list.
//
// Returns an array of { title, start_ms, end_ms } or null if no chapters found.
// The caller will compute end_ms gaps if music-metadata only gave us start
// times (some old builds did this).

export function extractEmbeddedChapters(parsed, totalDurationMs) {
  // newer music-metadata: parsed.format.chapters is the canonical surface
  const fmtChapters = parsed?.format?.chapters;
  if (Array.isArray(fmtChapters) && fmtChapters.length > 0) {
    return normalizeChapters(fmtChapters, totalDurationMs);
  }

  // older music-metadata: chapters may appear on parsed.native['iTunes']
  // as 'chap' atoms. We grep through the native tag list for anything
  // shaped like { id: 'chap', value: { ... } } and reconstruct.
  if (parsed?.native) {
    for (const tagFormat of Object.keys(parsed.native)) {
      const chapItems = parsed.native[tagFormat].filter(t => t.id === 'chap' || t.id === 'CHAP');
      if (chapItems.length > 0) {
        const normalized = chapItems.map(item => ({
          title: item.value?.title || item.value?.label || null,
          start: item.value?.start ?? item.value?.startTime ?? null,
        })).filter(c => c.start != null);
        if (normalized.length > 0) {
          return normalizeChapters(normalized, totalDurationMs);
        }
      }
    }
  }

  return null;
}

function normalizeChapters(rawChapters, totalDurationMs) {
  // music-metadata gives `start` in seconds (float) for parsed.format.chapters;
  // for raw 'chap' atoms it's milliseconds. We assume seconds (float) when
  // values are small (< 1e6) and ms otherwise. This is hacky but matches
  // what we actually see from the lib in practice.
  const looksLikeSeconds = rawChapters.every(c => {
    const v = c.start ?? c.sampleOffset;
    return typeof v === 'number' && v < 1e6;
  });

  const sorted = rawChapters
    .map((c, i) => {
      const raw = c.start ?? c.sampleOffset ?? 0;
      return {
        title: c.title || c.label || `Chapter ${i + 1}`,
        start_ms: Math.round(looksLikeSeconds ? raw * 1000 : raw),
      };
    })
    .sort((a, b) => a.start_ms - b.start_ms);

  // Fill in end_ms from the next chapter's start_ms; the last chapter
  // ends at totalDurationMs.
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].start_ms;
    const end = i < sorted.length - 1
      ? sorted[i + 1].start_ms
      : (totalDurationMs ?? start + 1000);
    if (end <= start) { continue; }
    out.push({ title: sorted[i].title, start_ms: start, end_ms: end });
  }
  return out.length > 0 ? out : null;
}
