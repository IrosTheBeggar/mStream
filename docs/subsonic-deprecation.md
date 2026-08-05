# Subsonic API — deprecation notice

**Status: deprecated as of v6.20 (2026-08). Removal is planned for a future
major release, once the first-party mStream apps are released.**

## Why

mStream's development focus is the first-party apps. They carry the one
feature no third-party Subsonic client can offer: **iroh-based Quick
Connect** — scan a QR code and stream from your server anywhere, with no
port forwarding, no reverse proxy, no dynamic DNS.

The Subsonic surface, by contrast, is a me-too feature in a field with
dedicated implementations (Navidrome, Gonic, Airsonic-Advanced) whose whole
project is that protocol. Every subsonic client has its own quirks, and
matching that ecosystem's expectations is a maintenance commitment that
competes directly with the first-party work. It also carries a standing
security cost mStream would rather not keep: classic Subsonic token auth
requires a recoverable password, which is why the surface keeps a separate
encrypted password column and a second authentication wall.

## What deprecation means today

- The API keeps working exactly as before. Nothing is removed yet.
- The surface is **frozen**: crash and security fixes only, no new
  endpoints, no OpenSubsonic extension work.
- A warning is logged at boot when the API is enabled, and the admin panel
  shows a deprecation notice on the Subsonic page.
- The bundled Subsonic web UI (`ui: 'subsonic'`) is deprecated with it.

## If you rely on it

Say so — real usage reports are what decide the removal timeline:

- <https://github.com/IrosTheBeggar/mStream/issues>
- The mStream Discord (link in the README)

## Timeline

Removal will not happen before the first-party apps are generally
available, and will be announced in release notes at least one release
before it happens.
