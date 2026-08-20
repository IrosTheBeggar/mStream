// Pre-fetch the mstream-player binary for THIS platform from the release
// assets pinned by the committed manifest — the offline/airgap/image-build
// companion to the automatic fetch the server does when autoBootServerAudio
// is enabled and no binary is present.
//
// Usage: npm run fetch-mstream-player
//   (or: node scripts/fetch-mstream-player.mjs)
//
// When to use it:
//   - baking a Docker image that must never download at runtime
//     (RUN npm run fetch-mstream-player at build time — though note server
//     audio needs a sound device, which containers rarely have)
//   - preparing an air-gapped install: run it on a connected machine of the
//     SAME platform/libc, then carry bin/mstream-player/ across; or point
//     MSTREAM_PLAYER_BASE at an internal mirror serving the same asset
//     files (the manifest's sha256 pins still apply).
//
// The download is sha256-verified against bin/mstream-player/manifest.json
// and execution-probed before install; a binary YOU placed there yourself is
// left untouched. Exits non-zero when nothing usable ends up on disk.

import winston from 'winston';
import { ensurePlayer, playerKey } from '../src/util/mstream-player-bootstrap.js';

winston.configure({ transports: [new winston.transports.Console({ level: 'info' })] });

try {
  const installed = await ensurePlayer();
  if (!installed) {
    console.error(`no prebuilt mstream-player is pinned for this platform (${playerKey()}) — build one from https://github.com/IrosTheBeggar/mstream-terminal-player instead (see bin/mstream-player/README.md)`);
    process.exit(2);
  }
  console.log(`mstream-player ready: ${installed}`);
} catch (err) {
  console.error(`fetch failed: ${err.message}`);
  process.exit(1);
}
