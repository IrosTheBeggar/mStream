# Subsonic API — removed

**Status: removed in v6.26.0 (2026-09). It had been deprecated since v6.20.0
(2026-08).**

mStream no longer serves the Subsonic / OpenSubsonic REST API (`/rest/*`),
the bundled Airsonic Refix web client (`ui: 'subsonic'`), per-user API keys
(`/api/v1/user/api-keys`), or the separate, recoverable Subsonic password.
Third-party Subsonic clients (DSub, Symfonium, play:Sub, Feishin, Sonixd,
Substreamer, …) can no longer connect to an mStream server.

## Why

mStream's development focus is the first-party apps. They carry the one
feature no third-party Subsonic client can offer: **iroh-based Quick
Connect** — scan a QR code and stream from your server anywhere, with no
port forwarding, no reverse proxy, no dynamic DNS.

The Subsonic surface was a me-too feature in a field with dedicated
implementations whose whole project is that protocol. Every client has its
own quirks, and matching that ecosystem's expectations was a maintenance
commitment that competed directly with the first-party work. It also
carried a standing security cost: classic Subsonic token auth needs a
recoverable password, which is why the surface kept a separate encrypted
password column and a second authentication wall in front of the library.

## What happens when you upgrade

- **config.json** — on first boot the server logs one warning and rewrites
  the file: `ui: 'subsonic'` becomes `ui: 'default'`, and the `subsonic`
  block and `subsonicSecret` are removed. Nothing else changes.
- **Ports** — nothing listens on the separate Subsonic port (default 3012)
  any more. Firewall rules, Docker port mappings, and reverse-proxy routes
  for `/rest/` can be deleted.
- **Admin panel** — the "Subsonic API" page is gone. The Lyrics Cache card
  that used to live there is under **Lyrics**.
- **Database** — the tables the Subsonic surface populated (per-user stars,
  bookmarks, play queue, API keys) are left in place and are inert. The
  encrypted Subsonic password column is dropped by the V68 migration on
  first boot; the secret that could decrypt it is removed from the config
  at the same time.

## If you need a Subsonic server

Run a dedicated one — Navidrome, Gonic, or Airsonic-Advanced — against the
same music folders. They can coexist with mStream on the same machine.

mStream's own apps are the supported clients:

- Android: <https://play.google.com/store/apps/details?id=mstream.music>
- iOS: <https://apps.apple.com/us/app/mstream-player/id1605378892>
