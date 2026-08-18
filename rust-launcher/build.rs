// Windows resources for the launcher exe: icon + version metadata. The
// launcher IS the double-click face of the bundle (staged as mStream.exe by
// scripts/build-bun.mjs), so it must carry the product icon itself — the
// server keeps its own via Bun's --windows-icon. Version/product strings are
// read from the repo's package.json so they can never drift from the release
// (and build-bun.yml's tag build asserts the baked version against the tag).
//
// VERSIONINFO CONTRACT — identical for every PE the win-x64 bundle ships
// (server: Bun --windows-* flags; sidecars: stamped at bundle time by
// scripts/win-versioninfo.mjs; all asserted by
// scripts/check-win-versioninfo.ps1 on the win-x64 CI leg):
//   ProductName "mStream" · ProductVersion = FileVersion = package version as
//   FOUR numeric parts (prerelease suffix dropped) in both the string table
//   AND the fixed-info numbers · CompanyName = package author ·
//   LegalCopyright "<author> (<license>)". FileDescription is per file.
// Keep the four in lockstep: uniform metadata is also what code signing's
// artifact-configuration restrictions will enforce on each signed file.
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
    let author = pkg["author"]["name"].as_str().unwrap_or("");
    let license = pkg["license"].as_str().unwrap_or("");

    // "6.21.0-beta.1" -> [6, 21, 0, 0]: same rule as win-versioninfo.mjs.
    let mut parts: Vec<u64> = version
        .split('-')
        .next()
        .unwrap_or("0")
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect();
    parts.resize(4, 0);
    let version4 = format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], parts[3]);
    // VS_FIXEDFILEINFO packs the four parts into one u64, high word first.
    // Without this, winresource fills the numeric fields from Cargo.toml's
    // 0.1.0 while the strings say the real version — Explorer shows the
    // strings, but signing tools and `VersionInfo.FileVersionRaw` see 0.1.0.0.
    let packed = (parts[0] << 48) | (parts[1] << 32) | (parts[2] << 16) | parts[3];

    let mut res = winresource::WindowsResource::new();
    res.set_icon("../build/mstream-logo-cut.ico");
    res.set_language(0x0409); // en-US string block (the default is "neutral")
    res.set("ProductName", "mStream");
    res.set("FileDescription", "mStream Desktop");
    res.set("ProductVersion", &version4);
    res.set("FileVersion", &version4);
    res.set("CompanyName", author);
    res.set("LegalCopyright", &format!("{author} ({license})"));
    // The crate builds as mstream-launcher but ships as mStream.exe — name
    // the shipped identity, which is what the bundle (and any signature) carries.
    res.set("OriginalFilename", "mStream.exe");
    res.set("InternalName", "mStream");
    res.set_version_info(winresource::VersionInfo::FILEVERSION, packed);
    res.set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed);
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
