// Windows resources for the launcher exe: icon + version metadata. The
// launcher IS the double-click face of the bundle (staged as mStream.exe by
// scripts/build-bun.mjs), so it must carry the product icon itself — the
// server keeps its own via Bun's --windows-icon. Version/product strings are
// read from the repo's package.json so they can never drift from the release.
// No-op on every non-Windows target.
fn main() {
    #[cfg(target_os = "windows")]
    {
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
        res.compile().expect("compile windows resources");
    }
}
