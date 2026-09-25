// Pre-fetch yt-dlp for THIS platform — the offline / air-gap / image-build
// companion to the automatic fetch the server does the first time YouTube is
// used (src/util/yt-dlp-bootstrap.js).
//
// Usage: npm run fetch-yt-dlp [-- --pin-only]
//   (or: node scripts/fetch-yt-dlp.mjs [--pin-only])
//
// Installs the release pinned by bin/yt-dlp/manifest.json (manifest-musl.json
// on musl), sha256-verified and execution-probed, then moves it to yt-dlp's
// newest release the way the server's daily check does — verified against
// that release's own SHA2-256SUMS. --pin-only stops at the pin (a
// reproducible image bake). A copy YOU placed at the managed path is left
// untouched. MSTREAM_YTDLP_BASE points both steps at a mirror. Exits
// non-zero when nothing usable ends up on disk.

import winston from 'winston';
import { ensureYtDlp, refresh, ytDlpKey } from '../src/util/yt-dlp-bootstrap.js';

winston.configure({ transports: [new winston.transports.Console({ level: 'info' })] });
const pinOnly = process.argv.includes('--pin-only');

try {
  const installed = await ensureYtDlp();
  if (!installed) {
    console.error(`no yt-dlp build is pinned for this platform (${ytDlpKey()}) — install yt-dlp yourself (see bin/yt-dlp/README.md)`);
    process.exit(2);
  }
  if (!pinOnly) {
    const r = await refresh();
    if (r.updated) { console.log(`moved to the newest release: ${r.version}`); } else if (r.skipped) { console.log(`not updated: ${r.skipped}`); } else { console.log(`already the newest release (${r.version})`); }
  }
  console.log(`yt-dlp ready: ${installed}`);
} catch (err) {
  console.error(`fetch failed: ${err.message}`);
  process.exit(1);
}
