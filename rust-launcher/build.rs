// Windows resources for the launcher exe: icon + version metadata. The
// launcher IS the double-click face of the bundle (staged as mStream.exe by
// scripts/build-bun.mjs), so it must carry the product icon itself — the
// server keeps its own via Bun's --windows-icon. Version/product strings are
// read from the repo's package.json so they can never drift from the release.
//
// Keyed off CARGO_CFG_TARGET_OS, not #[cfg(target_os)]: build scripts compile
// FOR THE HOST, so a cfg here asks "building ON Windows" — which silently
// skipped resources for any cross-compiled windows target and would have run
// winresource for non-windows targets built on a Windows host. No-op for
// every non-Windows TARGET.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    println!("cargo:rerun-if-changed=../build/mstream-logo-cut.ico");
    println!("cargo:rerun-if-changed=../package.json");
    let pkg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../package.json").expect("read ../package.json"),
    )
    .expect("parse package.json");
    let version = pkg["version"].as_str().unwrap_or("0.0.0");

    let mut res = winresource::WindowsResource::new();
    res.set_icon("../build/mstream-logo-cut.ico");
    res.set("ProductName", "mStream");
    res.set("FileDescription", "mStream Desktop");
    res.set("ProductVersion", version);
    res.set("FileVersion", version);
    res.set("LegalCopyright", "Paul Sori (GPL-3.0)");
    // A cross-build host without a Windows resource compiler (rc.exe /
    // llvm-rc / windres) can still produce a WORKING exe — just an iconless,
    // versionless one. Warn instead of failing so `cargo check --target
    // x86_64-pc-windows-msvc` stays usable from any host, but make the
    // degradation impossible to miss in a build log: shipped Windows
    // launchers must come from a host with a resource compiler (CI builds
    // win-on-win, which always has one).
    if let Err(e) = res.compile() {
        println!(
            "cargo:warning=windows resources NOT embedded ({e}) — this mStream.exe will \
             lack its icon and VersionInfo; ship builds must run where rc.exe/llvm-rc exists"
        );
    }
}
