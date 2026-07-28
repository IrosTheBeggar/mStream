# mStream Federation Ticket (`mstrfed<V>:`)

The string two admins swap to pair their servers for read-only federation.
Sibling spec to [iroh-pairing-code.md](iroh-pairing-code.md) — same envelope
mechanics, different payload and, importantly, a different trust model (see
[Security](#security)).

Builder/parser: `buildFederationTicket` / `parseFederationTicket` in
`src/state/federation.js`, on top of the shared envelope helpers in
`src/state/iroh-common.js`.

## Envelope

```
mstrfed<V>:<base64url(JSON payload)>
```

- `mstrfed` — literal prefix. Distinct from the tunnel pairing code's `mstr`
  so a ticket pasted into the wrong UI fails cleanly (`mstrfed1:` never
  matches `^mstr(\d+):`, and vice versa).
- `<V>` — integer payload version. This build emits and understands **v1**.
  A parser MUST reject a version newer than it understands with an
  actionable "update your server" error.
- No bare-body legacy form: unlike the tunnel pairing code, a missing prefix
  is invalid (this is a brand-new format with no deployed history).

## v1 payload

```jsonc
{
  "t": "endpoint…",        // REQUIRED — the minting server's federation
                           // EndpointTicket (iroh: node id + relay +
                           // direct addresses)
  "k": "fedk_…",           // REQUIRED — the minted read-only API key
                           // ('fedk_' + 32 random bytes base64url)
  "n": "Paul's mStream",   // optional — display name for the add-peer UI
  "l": ["Music", "Vinyl"]  // optional — granted library (vpath) names.
                           // Informational preview only: the live grant
                           // list comes from GET /api/v1/federation/health
                           // after pairing.
}
```

Parsers MUST ignore unknown fields (forward compatibility) and MUST reject a
payload missing `t` or `k`.

## Pairing flow

1. Admin A mints a key on server A (admin → Federation → New ticket),
   choosing which libraries it grants. The response carries the full
   `mstrfed1:` ticket.
2. A sends the ticket to admin B over a private channel.
3. B pastes it into server B's add-peer UI. B's server stores the peer row
   and dials A's endpoint (ALPN `mstream/federation/1`), presenting `k` on
   the first bi-stream.
4. A verifies the key, **binds it to B's EndpointId (TOFU)**, and replies
   `OK`. Every subsequent bi-stream is a plain TCP-over-QUIC bridge to A's
   HTTP server; B authenticates each HTTP request with the
   `x-federation-key: fedk_…` header.
5. For mutual federation, B mints a ticket for A the same way. The two
   directions are fully independent grants.

## Security

- **The ticket carries a standing credential.** Unlike the tunnel QR (whose
  secret only gates the pipe, with mStream's login wall still behind it),
  `k` IS the API credential for the granted libraries. Swap tickets over a
  private channel (in person, E2E-encrypted chat), not a public paste.
- **TOFU burn-on-redeem.** The first endpoint to complete the handshake owns
  the key; afterwards the same key from any other endpoint is rejected and
  logged. A ticket that leaks after the legitimate peer redeemed it is dead
  on arrival. A ticket that leaks *before* redemption is a race — revoke and
  re-mint if in doubt.
- **Scope.** The key resolves to a synthetic read-only user restricted to
  the granted libraries (`api/federation-auth.js`): no writes, no admin, no
  other libraries, plus a route allowlist as defense-in-depth.
- **Revocation** is per-key: deleting the key kills the pipe handshake,
  every HTTP request, and any live connections. Rotating the server's
  `federation.secretKey` changes its EndpointId and invalidates the `t` in
  every issued ticket (peers must re-add).
- **"Friend reinstalled" case:** their endpoint identity changed, so TOFU
  rejects them. The admin UI's reset-binding action clears the binding
  without re-minting; the next successful handshake re-binds.
