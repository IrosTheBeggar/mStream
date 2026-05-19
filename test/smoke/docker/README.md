# All-Docker smoke (mStream + torrent daemons in containers)

The other smoke harnesses in `test/smoke/` cover native mStream
against various daemon configurations. This one targets the standard
deployment shape we hadn't previously tested live: **mStream itself
running in a Linux container**, talking to **Linux-container
daemons** on the same Docker host.

What it verifies
----------------
- mStream-in-container ↔ daemon-in-container RPC works via
  `host.docker.internal` (Docker's published-port gateway).
- A shared host volume mounted into both containers makes the
  file-existence check produce a `seeded` outcome — mStream sees
  `/music/testlib/<file>`, the daemon sees `/downloads/testlib/<file>`,
  both backed by the same Windows-host source directory.
- The path-handling helpers added in this PR for native-Windows
  daemons (`_normalizeDaemonPath`, `_joinDaemonPath`,
  `_candidateMatchesKnownPath`) remain idempotent on POSIX inputs
  — i.e. the all-Docker combo isn't regressed by the cross-platform
  fixes.

Pre-reqs
--------
1. Daemon containers running on the Docker host:
   - `mstream-deluge`         (host port `8112`)
   - `mstream-qbittorrent`    (host port `8085`)
   - `mstream-transmission`   (host port `9091` — usually shadowed
     by a native install on Windows; stop the native daemon to
     test the Docker one)
2. Their `/downloads` mount points at `C:/tmp/transmission-downloads`
   on the host (the smoke mounts the same source into mStream as
   `/music`).
3. A `tier3-test.flac` fixture (1000 bytes) at
   `C:/tmp/transmission-downloads/testlib/tier3-test.flac` so the
   shared-volume content-existence check succeeds.

Running it
----------
```powershell
docker compose -f test/smoke/docker/compose.smoke.yaml up --build -d

# Deluge runs out of the box (its docker container ships with a known
# password). qBit's linuxserver image generates a random admin
# password on first boot — find it in:
#   docker logs mstream-qbittorrent
# and pass it explicitly to test that branch:
$env:QBIT_DOCKER_PASS = "<password>"
node test/smoke/docker/run-docker-stack-smoke.mjs

docker compose -f test/smoke/docker/compose.smoke.yaml down
```

Expected baseline (Deluge only, the always-runnable case):
```
=== DELUGE (Docker) ===
  PASS  deluge · test connection
  PASS  deluge · connect (save creds)
  PASS  deluge · auto-detect produces a daemonPath  — /downloads/testlib
  PASS  deluge · daemonPath is canonical POSIX
  PASS  deluge · seed-existing → seeded
  PASS  deluge · daemon registered the torrent
TOTAL: 6 pass / 0 fail
```

What's NOT covered
------------------
- End-to-end download completion (no real swarm, no peers).
- Linux-mStream + native-Linux daemons (the all-POSIX combo —
  effectively equivalent to this one).
- Operators running a community Docker image of mStream (e.g.
  `linuxserver/mstream`) — the Dockerfile here is purpose-built
  for the smoke; not a release artefact.
