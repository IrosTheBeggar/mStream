# iroh native binding (`bin/iroh/`)

Quick Connect (the remote-access tunnel) and the federation endpoint run on
[`@number0/iroh`](https://www.npmjs.com/package/@number0/iroh), a NAPI-RS
native addon. A Bun standalone binary can't resolve it from `node_modules`,
so `scripts/build-bun.mjs` stages the bundle target's prebuilt
`iroh.<triple>.node` into `<bundle>/bin/iroh/` and the server points the
loader at it via `NAPI_RS_NATIVE_LIBRARY_PATH` (`src/state/iroh-common.js`).

**Nothing native is committed here.** Only this README and the source pin
are tracked; a `.node` in this directory is a build product (gitignored).

## Where each bundle's `.node` comes from

| Bundle | Source |
| --- | --- |
| native legs (darwin-arm64, linux-x64, win-x64, …) | the platform package `npm ci` installed |
| cross legs with an npm prebuilt (linux-arm64, musl) | `npm pack @number0/iroh-<triple>@<lockfile version>`, integrity-checked against `package-lock.json` |
| **darwin-x64 (Intel Mac)** | **built from source in CI** — see below |

## Why darwin-x64 is built from source

Upstream publishes no `@number0/iroh-darwin-x64` package: `x86_64-apple-darwin`
is not in the napi target list of `iroh-ffi`'s `iroh-js/package.json` at all
(their macOS CI is a self-hosted Apple-silicon runner), and the registry's
last darwin-x64 package is `0.22.1-test3`. So `npm install` on an Intel Mac
gets no binary, and through v6.29.0 the darwin-x64 bundle shipped without one:
Quick Connect was silently unavailable on every Intel Mac.

The fix is to build the *same crate upstream publishes* ourselves.
`build-bun.yml`'s darwin-x64 leg (an Apple-silicon runner) cross-compiles
`iroh-js` for `x86_64-apple-darwin` from the tag pinned in
[`iroh-ffi-pin.json`](iroh-ffi-pin.json), drops the result at
`bin/iroh/iroh.darwin-x64.node`, and the bundler's `stageIroh()` picks a
pre-placed binding up first. The leg's Rosetta smoke then asserts the shipped
x64 server actually loads it (`--mstream-worker=iroh-selftest` → `IROH_OK`),
and a CI bundle for darwin-x64 with no `.node` is a build error.

The pin is enforced, not advisory:

- `tag` must equal `v` + the `@number0/iroh` version in `package-lock.json`
  (the JS half and the native half must be one release — a unit test and the
  CI step both check).
- `commit` must be what the tag resolves to when cloned (a moved tag fails
  the build rather than compiling something else).
- The build runs `cargo build --locked` against upstream's own `Cargo.lock`.
- Non-tag runs restore the built `.node` from the Actions cache, keyed by
  the pin file's hash. **Tag builds never use the cache** — the shipped
  binding is always compiled from the pinned commit on the release run
  (about five minutes on the runner).

### Bumping `@number0/iroh`

1. Bump the dependency as usual (`package.json` + `package-lock.json`).
2. Update `iroh-ffi-pin.json`: `tag` = `v<new version>`, `commit` = the tag's
   commit (`gh api repos/n0-computer/iroh-ffi/git/ref/tags/v<ver> --jq .object.sha`,
   and check it's a `commit`, not an annotated `tag` object).
3. `npm run test:unit` — `test/unit/iroh-ffi-pin.test.mjs` fails until the
   two agree.

If a `@number0/iroh-darwin-x64` package ever appears in the lockfile, that
same test fails on purpose: upstream now ships the binary, and this
source build (the CI step, the pin, this README) should be retired in favour
of the ordinary `npm pack` path.

## Building it yourself

The exact CI recipe, runnable on any Mac with rustup and Xcode CLT
(Apple-silicon Macs cross-compile; Rosetta is not needed to build):

```bash
git clone --depth 1 --branch v1.1.0 https://github.com/n0-computer/iroh-ffi.git
cd iroh-ffi && git rev-parse HEAD        # must match iroh-ffi-pin.json's commit
rustup target add x86_64-apple-darwin
MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release --locked \
  --target x86_64-apple-darwin -p number0_iroh
strip -x target/x86_64-apple-darwin/release/libnumber0_iroh.dylib
cp target/x86_64-apple-darwin/release/libnumber0_iroh.dylib \
   <mStream>/bin/iroh/iroh.darwin-x64.node
```

Uses:

- **A local darwin-x64 bundle**: with the file in place,
  `bun scripts/build-bun.mjs --target=darwin-x64 --bundle` stages it.
- **A source / npm install on an Intel Mac**: point the loader at the file
  directly — `NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/iroh.darwin-x64.node` in
  the server's environment (the loader honours it ahead of `node_modules`).
- **Any other triple** upstream drops in future: same recipe with that
  target; a `bin/iroh/iroh.<triple>.node` is staged ahead of npm.

The binding is a plain cdylib (`napi-build` adds the `-undefined
dynamic_lookup` link flag), so `cargo build` output renamed to `.node` is
exactly what `napi build` would produce; `strip -x` only drops local symbols.
Verified 2026-09-21 on an Apple-silicon Mac: the v6.29.0 darwin-x64 server
loads the cross-built binding under Rosetta (`IROH_OK`), and an arm64 client
dials the resulting Quick Connect code through the iroh network.
