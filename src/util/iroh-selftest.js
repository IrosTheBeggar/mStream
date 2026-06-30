// Self-dispatch worker that verifies the native @number0/iroh binding loads in
// THIS process. Under a Bun standalone binary it exercises loading the shipped
// bin/iroh/*.node via NAPI_RS_NATIVE_LIBRARY_PATH (see ../state/iroh.js); under
// Node it loads from node_modules. Prints a single IROH_OK / IROH_FAIL line and
// exits with the matching code — consumed by the build smoke test
// (.github/workflows/build-bun.yml) and ad-hoc local verification:
//
//   ./mStream --mstream-worker=iroh-selftest '{}'
import { selfTest } from '../state/iroh.js';

try {
  const r = await selfTest();
  console.log(`IROH_OK exports=${r.exports} native=${r.nativePath}`);
  process.exit(0);
} catch (e) {
  console.error(`IROH_FAIL ${e?.stack || e?.message || e}`);
  process.exit(1);
}
