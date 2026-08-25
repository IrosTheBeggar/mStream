# Smoke harnesses

Manual, opt-in checks against **live external systems** — Docker'd or
natively-installed daemons, or the real desktop launcher binary. They are
deliberately **not** part of `npm test`: they don't match `*.test.mjs`, they
need infrastructure the unit/integration suite doesn't, and they talk to
real processes. Run them by hand when working on the matching code.

| Harness | Script | Needs |
| --- | --- | --- |
| All-Docker torrent stack (`docker/`) | `npm run test:smoke:docker` | the compose stack up — see [docker/README.md](docker/README.md) |
| Native-Windows daemons (`windows-native-daemons.mjs`) | `npm run test:smoke:windows` | Transmission / qBittorrent installed on Windows, plus env config |
| Boot-watchdog rollback (`update-watchdog-smoke.sh`) | `npm run test:smoke:update-watchdog` | a built launcher (`cd rust-launcher && cargo build --release`); Linux headless needs `xvfb-run` |
| Boot-watchdog rollback, Windows (`update-watchdog-smoke.ps1`) | `npm run test:smoke:update-watchdog:win` | a built launcher plus `rustc` on PATH (the stub servers are compiled on the spot) |

Each script just runs the harness; bringing the daemons up (and tearing them
down) is the operator's job. The setup, credentials and env knobs are
documented at:

- **All-Docker:** [docker/README.md](docker/README.md) — `compose.smoke.yaml` up/down, daemon creds.
- **Native-Windows:** the header comment of
  [windows-native-daemons.mjs](windows-native-daemons.mjs) — ports, download
  dirs, and the `MSTREAM_SECRET` / per-daemon env vars (set a daemon's config
  to `null` to skip it).
- **Boot-watchdog rollback:** the header comment of
  [update-watchdog-smoke.sh](update-watchdog-smoke.sh) — fabricates a managed
  root whose `current` version crashes at boot and asserts the launcher's
  rollback (re-pointed `current`, recorded hold, takeover into the previous
  version). Scratch HOME; never touches real data or login items.

The CLI-audio adapter routing harness is a sibling but self-contained (it runs
mpv/vlc/mplayer/mpd inside Docker, no external daemons): `npm run test:cli-audio`
— see [../cli-audio/](../cli-audio/).
