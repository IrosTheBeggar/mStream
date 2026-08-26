# Bundled Ghostty console (macOS)

`manifest.json` pins the [Ghostty](https://ghostty.org) release the macOS
bundles ship as `console/Ghostty.app`, beside `mStream.app`. The .pkg
installer carries the same app as its own component (`io.mstream.console`,
payload at `/Library/Application Support/mStream/console/` — a pkg install
has no versioned bundle dir, so the launcher checks that fixed system path
third). The bundler
(`scripts/build-bun.mjs`) downloads the pinned `Ghostty.dmg` from
`https://release.files.ghostty.org/<version>/`, refuses anything that does
not hash to the pinned sha256, extracts the app, and asserts its
Developer ID TeamIdentifier matches the pinned one — the app itself ships
**byte-identical and untouched**, keeping Mitchell Hashimoto's notarization
intact (verified: `spctl -t exec` accepts the extracted app as "Notarized
Developer ID"; Ghostty staples the dmg, not the app, so the check is
online — irrelevant to us, because the tray launches the inner binary
directly, which involves no Gatekeeper prompt).

Why it exists: Apple's Terminal.app has no pixel protocol at all, so the
setup wizard's wordmark and Quick Connect QR degrade to character art for
every default-terminal mac user. Ghostty speaks kitty graphics, truecolor,
and OSC 11, and its config-file-declared commands launch with **no**
"Allow Ghostty to execute…" dialog (commands passed as CLI arguments
trigger it — the launcher must never use `-e`). The tray's "Set up
mStream" item writes a config (command, title, 120×42, `auto-update =
off`, `macos-icon = custom` pointing at mStream.icns so the Dock shows the
mStream mark) and spawns the bundled app's binary with `XDG_CONFIG_HOME`
scoped to that config — the user's own Ghostty install, if any, keeps its
own config untouched. No bundled Ghostty (or a non-mac platform) falls
back to the previous behavior (Terminal.app `.command` / `wt.exe` /
emulator walk).

`LICENSE` is Ghostty's MIT license at the pinned tag, staged into the
bundle as `console/GHOSTTY-LICENSE.txt` — the app bundle itself carries no
license file, and MIT asks the notice to travel with the software.

Updating the pin: download the new `Ghostty.dmg`, `shasum -a 256` it,
update `manifest.json` (version, sha256, size — teamId only if their
signing identity genuinely changed), refresh `LICENSE` from the matching
tag, and re-validate the trust probes recorded in the player repo's
PLAN.md Phase 8 (config-command consent-free launch, `macos-custom-icon`,
kitty graphics) before shipping.
