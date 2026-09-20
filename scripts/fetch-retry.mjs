// Release-asset download for the bundler (build-bun.mjs), with a short retry
// for what is plausibly transient.
//
// The bundle stages three sha256-pinned assets per target (p2p-sidecar,
// mstream-player, the ghostty console), and each used to get exactly ONE
// fetch. GitHub's release CDN answers the odd request with a 5xx; on
// 2026-09-20 a single HTTP 500 for mstream-player-darwin-arm64 failed the whole
// darwin-arm64 bundle job of an unrelated PR while the seven other targets in
// the same run fetched theirs fine, and a plain re-run fixed it.
//
// What is retried, and what is not:
//   - network errors (fetch rejects) and a body that dies mid-read — the
//     helper returns the BYTES, not the Response, so a connection reset
//     halfway through a 25 MB download is retried like a bad status line;
//   - HTTP 408, 429, 500, 502, 503, 504;
//   - NOTHING else. A 404 (or any other 4xx) means a wrong pin or a missing
//     asset: retrying cannot fix it and would only delay the loud failure.
//
// Verification is deliberately not this module's business. It hands back
// whatever bytes the URL finally served; the caller's size + sha256 check
// against the committed manifest runs on them exactly as before, and the URL
// is never swapped for another source between attempts.

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// One initial attempt plus one retry per entry — 17 s of patience at most,
// which outlasts a CDN blip without hiding a real outage for long.
export const RETRY_DELAYS_MS = [2000, 5000, 10000];

// Node reports every network failure as a bare "fetch failed" and keeps the
// reason (ECONNRESET, ENOTFOUND, ...) on err.cause; surface it in the retry
// line, where it is the whole story.
function describe(err) {
  const code = err?.cause?.code || err?.code;
  return code ? `${err.message} (${code})` : String(err?.message || err);
}

/**
 * Download `url` and resolve with its body as a Buffer.
 *
 * Rejects with the same messages the single-shot fetch produced (`HTTP 500`,
 * the fetch error's own message), so the callers' "download failed: …" lines
 * and their MSTREAM_ALLOW_MISSING_* escape hatches are unchanged — a
 * persistent outage still fails, just three retries later.
 *
 * `label` names the asset in the retry lines. `delaysMs`, `sleep` and `log`
 * exist for the unit tests.
 */
export async function fetchBytesWithRetry(url, {
  label = 'asset',
  delaysMs = RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    let retryable;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) { return Buffer.from(await res.arrayBuffer()); }
      // Release the connection; the error body is of no use to anyone.
      try { await res.body?.cancel(); } catch (_err) { /* already closed */ }
      failure = new Error(`HTTP ${res.status}`);
      retryable = RETRYABLE_STATUS.has(res.status);
    } catch (err) {
      failure = err;
      retryable = true;
    }

    const delay = delaysMs[attempt - 1];
    if (!retryable || delay === undefined) { throw failure; }
    log(`  ${label} download attempt ${attempt} of ${delaysMs.length + 1} failed: ${describe(failure)} — retrying in ${delay / 1000} s`);
    await sleep(delay);
  }
}
