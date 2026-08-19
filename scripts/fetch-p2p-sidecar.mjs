// Pre-fetch the p2p-sidecar binary for THIS platform from the release assets
// pinned by the committed manifest — the offline/airgap/image-build companion
// to the automatic fetch the server does at first discovery-network use.
//
// Usage: npm run fetch-p2p-sidecar
//   (or: node scripts/fetch-p2p-sidecar.mjs)
//
// When to use it:
//   - baking a Docker image that must never download at runtime
//     (RUN npm run fetch-p2p-sidecar at build time)
//   - preparing an air-gapped install: run it on a connected machine of the
//     SAME platform/libc, then carry bin/p2p-sidecar/ across; or point
//     MSTREAM_SIDECAR_BASE at an internal mirror serving the same asset
//     files (the manifest's sha256 pins still apply).
//
// The download is sha256-verified against bin/p2p-sidecar/manifest.json (or
// manifest-musl.json on musl) and execution-probed before install; a binary
// YOU placed there yourself is left untouched. Exits non-zero when nothing
// usable ends up on disk.

import winston from 'winston';
import { ensureSidecar, sidecarKey } from '../src/util/p2p-sidecar-bootstrap.js';

winston.configure({ transports: [new winston.transports.Console({ level: 'info' })] });

try {
  const installed = await ensureSidecar();
  if (!installed) {
    console.error(`no prebuilt p2p-sidecar is pinned for this platform (${sidecarKey()}) — build one from https://github.com/IrosTheBeggar/mstream-p2p-sidecar instead (see bin/p2p-sidecar/README.md)`);
    process.exit(2);
  }
  console.log(`p2p-sidecar ready: ${installed}`);
} catch (err) {
  console.error(`fetch failed: ${err.message}`);
  process.exit(1);
}
