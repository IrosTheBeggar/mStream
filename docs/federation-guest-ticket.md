# mStream Federation Guest Ticket (`mstrfedg<V>:`)

The string a server hands **one of its own devices** (the mobile app) so
the device can reach a federated peer directly — its bytes no longer
crossing the server's home link twice, and the peer staying usable while
the server is down. Sibling spec to [federation-ticket.md](federation-ticket.md)
(the admin-to-admin pairing ticket) and [iroh-pairing-code.md](iroh-pairing-code.md)
(the Quick Connect QR): same envelope mechanics, a different audience and a
different trust model (see [Security](#security)).

Builder/parser: `buildFederationGuestTicket` / `parseFederationGuestTicket`
in `src/state/federation.js`. Tokens: `src/state/federation-guest.js`.

## Envelope

```
mstrfedg<V>:<base64url(JSON payload)>
```

- `mstrfedg` — literal prefix. Disjoint from both `mstr<V>:` (the tunnel
  pairing code) and `mstrfed<V>:` (the federation ticket): `mstrfedg1:`
  never matches `^mstrfed(\d+):`, so a ticket handed to the wrong parser
  fails cleanly.
- `<V>` — integer payload version. This build emits and understands **v1**.
  A parser MUST reject a version newer than it understands with an
  actionable "update" error.
- No bare-body legacy form.

## v1 payload

```jsonc
{
  "t": "endpoint…",   // REQUIRED — the PEER's federation EndpointTicket
                      // (iroh: node id + relay + direct addresses)
  "g": "eyJ…"         // REQUIRED — a guest token the peer minted for the
                      // holder's key: a JWT signed by the peer, claims
                      // { federationGuest: true, federationKeyId, iat, exp }
}
```

Parsers MUST ignore unknown fields (forward compatibility) and MUST reject a
payload missing `t` or `g`.

## Flow

1. Server B (the *parent*) is paired with peer A through a federation
   ticket — A minted a `fedk_` key for B, B redeemed it over A's federation
   endpoint, and A TOFU-bound the key to B's endpoint id.
2. A device logged in to B asks B for direct access to A:
   `GET /api/v1/federation/peers/:id/access`.
3. B asks A, over the existing bound pipe, for a guest token:
   `POST /api/v1/federation/guest` (with B's `x-federation-key`). A signs a
   short-lived JWT for that key (24 h by default). B caches it and re-mints
   once three quarters of its life is gone (or on `?refresh=1`).
4. B answers the device with `{ direct: true, endpointTicket, endpointId,
   guestToken, expiresAt, directTicket }` — `directTicket` being this
   envelope. An A too old to mint (its allowlist 403s the route) makes B
   answer `{ direct: false, reason }`, and the device keeps using B's
   proxies (`/api/v1/federation/peers/:id/{api,art,stream}`).
5. The device dials `t` on ALPN `mstream/federation/1` and presents `g` on
   the first bi-stream. A verifies the token and replies `OK`; every later
   bi-stream is a plain TCP-over-QUIC bridge into A's HTTP server, where the
   device authenticates each request with the same token in the ordinary
   slots (`x-access-token` header, or `?token=` on stream and art URLs).
6. Before the token expires the device asks B again (step 2). B's cache
   hands out the same token until it is due for a re-mint, so this is
   cheap.

## Security

- **The standing key never leaves B.** The device only ever holds a guest
  token; B's `fedk_` key is not in the ticket, the access response, or any
  URL.
- **Scope is the key's.** A guest token resolves on A to the same synthetic
  read-only user as B's key: the same library grants, the same route
  allowlist, the same bandwidth caps — and guests share the key's caps
  (concurrent streams, daily quota, rate) rather than getting their own.
- **No TOFU; expiry instead.** A device dials from an ephemeral endpoint,
  so there is nothing stable to bind. A guest token is valid from any
  endpoint until it expires. The per-endpoint failed-handshake backoff
  still applies.
- **Revocation is through the key.** Deleting or expiring A's key for B
  rejects every guest of it at its next handshake and its next request, and
  severs their live pipes. B cannot revoke a single device's token early;
  the lifetime is the bound.
- **A guest cannot mint guests.** The mint route refuses a guest credential,
  and a guest token carries no `username`, so it cannot be replayed as an
  ordinary user token either.
- **Exposure class.** On the device the token sits in stream and art URLs
  exactly like B's own JWT does today; on the wire it is inside iroh's
  end-to-end encryption. Treat it like any session token.
