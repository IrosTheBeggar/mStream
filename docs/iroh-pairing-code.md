# mStream Iroh pairing-code format

Source-of-truth spec for the QR / pairing code that connects an mStream client
(e.g. the Android app) to a server's Iroh remote-access tunnel.

- Server implementation: mStream [PR #643](https://github.com/IrosTheBeggar/mStream/pull/643)
  (`src/state/iroh.js`).
- Client implementation: mstream_music [PR #76](https://github.com/IrosTheBeggar/mstream_music/pull/76)
  (`rust/iroh_tunnel/src/lib.rs`).

Two **independent** version axes exist — don't conflate them:

| Axis | Where | What it versions | Current |
|---|---|---|---|
| **Pairing-code version** | the `mstr<V>:` prefix below | what fields are in the QR | **v1** |
| **Tunnel ALPN version** | `mstream/tunnel/N` | the on-wire connection protocol | `mstream/tunnel/2` |

A v1 and a (future) v2 pairing code both currently dial over ALPN `mstream/tunnel/2`.

---

## Envelope

```
mstr<V>:<base64url( JSON payload )>
```

- `mstr` — fixed magic namespace. A scanner that doesn't see it should reject the
  QR as "not an mStream pairing code" (don't try to parse it).
- `<V>` — a positive integer **schema version** (the version of the JSON payload).
- `:` — separator.
- `<base64url(...)>` — the JSON payload, base64url-encoded, no padding. Decoders
  SHOULD accept both base64url and standard base64, padded or not (Node's
  `Buffer.from(x, 'base64'|'base64url')` and Rust's tolerant decoder both do).

`t` and `s` are **stable across all versions** (they're the connection essentials);
new versions only **add** fields. The version number tells a scanner what to expect.

### Legacy / transition
Codes emitted before this spec were bare `base64url(JSON{t,s})` with **no prefix**.
Parsers SHOULD treat a payload with no `mstr<V>:` prefix as **implicit v1**. Generators
SHOULD always emit the prefix going forward.

---

## Scanner / parser algorithm

```
code = scanned string, trimmed
m = code.match(/^mstr(\d+):(.*)$/)
if m:
    version = int(m[1]); body = m[2]
else if code looks like bare base64url:
    version = 1; body = code            # legacy
else:
    error "Not an mStream pairing code."

if version > MAX_VERSION_THIS_CLIENT_SUPPORTS:
    error "This pairing code needs a newer version of the app. Please update."

payload = JSON.parse(base64url_decode(body))
# read the fields defined for `version` (below); ignore unknown extra fields
```

The `version > MAX_SUPPORTED` check is the whole point of the prefix: an older
client meeting a newer code fails with a clear **"update the app"** message instead
of crashing or silently mis-parsing.

---

## Payload schemas

### v1 — connection only  (implemented)
```jsonc
{
  "t": "<EndpointTicket>",   // iroh EndpointTicket, base32 "endpoint…" string (id + relay [+ direct addrs])
  "s": "<base64>"            // 32-byte connect secret (the pipe gate)
}
```
Example: `mstr1:eyJ0IjoiZW5kcG9pbnQ…IiwicyI6Ii…In0`

### v2 — connection + one-time credential  (PROPOSED, not yet implemented)
```jsonc
{
  "t": "<EndpointTicket>",
  "s": "<base64>",
  "c": "<opaque pairing token>"   // SHORT-LIVED, SINGLE-USE — see Security
}
```
v2 lets the client become logged-in automatically after pairing, without the user
typing a password. The credential is **not** a session token — see below.

---

## Connection protocol (after decoding the code)

Same for every pairing-code version:

1. Parse `t` as an iroh `EndpointTicket` → `EndpointAddr`.
2. `endpoint.connect(addr, ALPN = b"mstream/tunnel/2")`.
3. **Secret handshake on the FIRST bi-stream:** open a bi-stream, write the raw
   32-byte secret (decoded from `s`), `finish()` the send side, then read the reply:
   - `"OK"` (ASCII) → authorized; proceed.
   - `"NO"` or the stream/connection closing → rejected (wrong/rotated secret).
   The server compares the secret in constant time.
4. **Tunnel:** thereafter, **one bi-stream == one TCP connection** to the server's
   local HTTP port. Plain HTTP rides the pipe (range/seek, keep-alive, parallel
   requests all work). Clients typically run a local TCP listener and open a fresh
   bi-stream per inbound connection.
5. **(v2 only, proposed)** Over the tunnel, exchange `c` for a real session token —
   `POST /api/v1/auth/pair { code: c }` → returns the standard mStream JWT — then
   the server marks `c` used. From then on the client authenticates like any other
   client (the normal JWT). This endpoint does not exist yet.

---

## Security notes

- **The secret `s` gates the pipe, not the API.** Knowing it lets you open the
  tunnel; mStream's normal auth wall still applies behind it. `s` rides inside the
  encrypted QUIC handshake data, never the (sniffable) ALPN.
- **Revocation = rotate the secret** (admin panel → Remote Access). This is the
  same coarse, all-devices model mStream uses for its JWT secret. Per-device revoke
  is a separate, opt-in feature (the EndpointId device registry).
- **v2's `c` MUST be short-lived and single-use** — NOT the 5-year session JWT.
  A QR can be photographed or shoulder-surfed; if it carried a standing credential,
  that credential would live forever in a photo. A one-time token (≈5–10 min TTL,
  burned on first exchange) makes a leaked v2 code useless after it's used or
  expires, while still giving "scan and you're logged in." This is why v2 exchanges
  `c` for the real token over the tunnel rather than embedding the token directly.

---

## Status

- **v1:** implemented server-side (PR #643) and client-side (PR #76).
- **v2:** specified here; requires a server-side one-time-token store + the
  `/api/v1/auth/pair` exchange endpoint. Not yet built.
