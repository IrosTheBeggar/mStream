Pre-built rust-parser binaries go here.

Binary naming convention: `rust-parser-{platform}-{arch}[-musl][.exe]`

Where `platform` and `arch` match Node.js `process.platform` and `process.arch`. The optional `-musl` suffix indicates a binary linked against musl libc (Alpine, Void Linux, distroless musl images, etc.) instead of glibc.

| File | Platform |
| --- | --- |
| `rust-parser-win32-x64.exe` | Windows x64 |
| `rust-parser-darwin-x64` | macOS Intel |
| `rust-parser-darwin-arm64` | macOS Apple Silicon |
| `rust-parser-linux-x64` | Linux x64 (glibc) |
| `rust-parser-linux-arm64` | Linux ARM64 (glibc) |
| `rust-parser-linux-arm` | Linux ARMv7 (glibc) |
| `rust-parser-linux-x64-musl` | Linux x64 (musl / Alpine) |
| `rust-parser-linux-arm64-musl` | Linux ARM64 (musl / Alpine) |
| `rust-parser-linux-arm-musl` | Linux ARMv7 (musl / Alpine) |

The loader at `src/db/task-queue.js` detects musl libc at runtime via `process.report.getReport().header.glibcVersionRuntime` (undefined on musl) and selects the matching binary automatically.

The Linux glibc binaries are linked against **glibc 2.28** (`.github/workflows/build-rust-parser.yml`: [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) with `--target <triple>.2.28`, asserted by `scripts/check-glibc-floor.sh` and self-tested inside a `debian:10` container), so they run on Debian 10, Ubuntu 20.04, RHEL/Rocky 8 and newer. Built natively on the runner they needed 2.34 and could not start on those hosts; the loader then reads the dynamic loader's complaint, logs it (`cannot run on this host (needs GLIBC_2.34, this host's glibc is 2.31)`) and falls back to the static musl sibling, which the glibc bundles ship for exactly that case.

To rebuild all binaries, cross-compile from the `rust-parser/` source directory or build natively on each target platform with `cargo build --release`. The musl binaries are produced by `.github/workflows/build-rust-parser-musl.yml`, which uses [`cross-rs/cross`](https://github.com/cross-rs/cross) to cross-compile statically-linked musl binaries that run on Alpine Linux and other musl distros.
