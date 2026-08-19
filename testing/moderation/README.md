# IP Moderation Suites

Two suites that test the IP side of moderation — the half the existing
`testing/puppeteer/moderation_suite.js` structurally cannot reach, because a
browser cannot choose the source address of its own WebSocket handshake, so
every Puppeteer bot is 127.0.0.1 and every IP-scoped rule looks identical.

| Suite | Needs | Runs |
|---|---|---|
| `ip_identity.test.mjs` | nothing | `npm run test:ipidentity` |
| `ip_moderation_suite.mjs` | local server + mongo | `npm run test:ipmod` |

---

## How the bots spoof an IP

`server/security.js#getClientIp` honours `X-Forwarded-For` when the immediate
peer is a private/loopback address (or `TRUST_PROXY=true`). A bot connecting
from 127.0.0.1 to a local server is exactly that case, so the header becomes
`ws.clientIp` verbatim — the same string consumed by `checkBan`, `checkMute`,
`checkShadowBan`, `issueModAction`, the per-IP rate limiters, `getIpSubnet`,
and ASN/geo lookup.

Nothing is patched, stubbed, or injected: the address enters through the same
door a real client's does. `testing/lib/spoofBot.mjs` is a headless protobuf
client (no browser) so it can set that header, and it is fast enough to stand
up a dozen distinct "users" per case.

**The preflight is not optional.** If the header stopped being honoured, every
bot would share one address — and a subnet-ban case would then pass all its
"inside the range" checks and fail all its "outside" ones, a result shaped
exactly like a genuine over-broad-ban bug in a run where no IP logic ran at
all. So the suite proves the spoof reaches `ws.clientIp` (by asking a DEITY bot
what address the server reports for a target in the `vip` roster field) and
**aborts** rather than reporting anything if it does not.

---

## `ip_identity.test.mjs` — the range maths

Pure unit tests against `server/ipIdentity.js`. No server, no DB, no network,
~1s. Run this first when the live suite fails: it tells you whether the range
decision was wrong before you go looking at enforcement.

- **canonicalization** — every spelling of one address (v4-mapped, bracketed,
  zoned, uppercase, ported, fully expanded) lands on one identity *and* one set
  of fingerprints. A miss here means a ban silently stops applying when a
  client reconnects with a differently-formatted peer address.
- **membership** — for a ban at each scope against a base address, exactly the
  right neighbours are caught. Driven by the `MEMBERSHIP` table in
  `testing/lib/ipFixtures.mjs`, which the live suite reads too, so both halves
  assert the same expectation.
- **fingerprints** — stable across calls, distinct per tier, sha256-shaped, and
  carrying no plaintext address.
- **display masking** — monotone in role: a lower role can never see more than
  a higher one.

---

## `ip_moderation_suite.mjs` — enforcement

| Case | What it proves |
|---|---|
| `preflight` | the spoof reaches the server, in both families, and two bots are seen as two addresses |
| `ban_v4` / `ban_v6` | exact / subnet / wide each block the right neighbours and let the rest in |
| `mute_v4` / `mute_v6` | a range mute silences a *different* address in-range, and not one outside it |
| `unban_range` | revoking clears the whole range, not just the host acted against |
| `evasion` | a /64 ban is escapable one subnet over (by design), and /48 closes exactly that door without spilling into the next /48 |
| `canonicalization` | a ban laid down against `203.0.113.10` still catches `::ffff:203.0.113.10` |
| `malformed_source` | junk `X-Forwarded-For` values cannot each mint their own unbanned identity |
| `mute_gating` | per message type: a muted user cannot affect the board, and presence/tool state still flows |
| `shadowban` | applies by range, stays invisible to the target, and does not disconnect it |
| `shadowban_gating` | per message type: a shadowbanned user's output reaches nobody, and they are never told |
| `display` | mods see masked addresses, guests see none, and stored rows hold a CIDR range rather than the host |

### The gating cases

`mute_gating` and `shadowban_gating` send one representative, wire-accurate
message per type and ask a peer whether it arrived. Three things make the
result trustworthy, and all three were added because their absence produced a
false PASS during development:

- **A control arm.** An unsanctioned bot runs the identical probe set first, so
  "the peer saw nothing" cannot be confused with "the server never relays this
  type anyway". `shadowban_gating` goes further and uses the *same* bot before
  and after the sanction, so nothing but the sanction differs.
- **Match on sender AND type.** Matching by sender alone reported a bogus "a
  muted user can still IMG_PASTE": issuing a mute makes the server broadcast
  `{t: HIDE_CURSOR, u: <subject>}`, which is batchable and lands asynchronously
  inside whichever probe window is open.
- **Sender-survival assertion.** An invalid payload is not merely dropped — the
  server closes the socket with **1008 "Invalid message"**. A dead sender
  relays nothing, which reads exactly like perfect enforcement. `IMG_PASTE`
  needs a real data-URL in `g`; a placeholder killed the run and every later
  probe silently "passed". Probes after a death are now recorded as unprobed
  and fail the case.

Observers must also call `completeJoinSync()`. On joining an occupied room the
server sets `joinSyncPendingSince` and suppresses draw traffic to that socket
until `SyncCoordinator` serves the tail — a bot that never sends `SYNC_REQUEST`
is deaf for the 20s safety valve, and every "peer never received it" assertion
passes for the wrong reason.

Each case reports per-check results, because "the /64 ban worked" is far less
useful than "caught 3/3 in-range, leaked 1/4 out-of-range" — which points
straight at over- vs under-matching. Reports land in
`testing/moderation_results/IP_MOD_REPORT_<run>.md`.

### Running

```bash
npm run dev:reset          # fresh local mongo + minio
npm run server:local       # server on :8030 against that stack
npm run test:ipmod         # the suite

npm run test:ipmod -- --only=ban_v6,evasion    # subset
npm run test:ipmod -- --trace                  # log every bot message
npm run test:ipmod -- --keep                   # leave rows in the DB to inspect
```

**The local-DB guard is deliberate.** `server/config.js` loads `.env`, whose
`MONGODB_URI` points at the **production Atlas cluster** — so a suite that
registers accounts and writes ban rows would write them to production. The
suite refuses any non-local database; `npm run test:ipmod` bakes in the local
URI, and `ALLOW_REMOTE_DB=i-know-what-im-doing` overrides if you ever mean it.

---

## Bugs these suites found (all fixed 2026-08-19)

Both suites were red on first run. All four fixes are in, and both suites are
now green (92/92 and 125/125), with `npm run test:moderation` still 5/5.

**0. A mute did not stop a user affecting the board.** `MUTED_BLOCKED` in
`server/index.js` is an **allowlist by omission** — anything absent from it
falls through `handleBroadcast`'s default path to `broadcastToRoom`. `FILL`,
`TEXT_REMOVE`, `UNDO` and `REDO` had never been added, so a muted user could
flood-fill the canvas. All four are now in the set (undo/redo included, the
strict reading of "muted means cannot affect the board"), and `mute_gating`
probes every type so the next omission fails a test instead of shipping.
Shadowban was already airtight — `handleBroadcast` returns on
`ws.isShadowBanned` before `broadcastToRoom`, so it blocks everything.

*Known and accepted, not a bug to fix:* `case T.TEXT_REMOVE` does an
owner-or-mod check but `break`s rather than returning, so an unauthorized
removal is still relayed, and the client's `TextOverlay.removeRemote()` does
not re-check ownership — any user can clear any other user's ephemeral text.
Deliberate call by Kyle (2026-08-19); the text overlay is ephemeral anyway.

**1. Shadowban was completely inert and reported success.**
`server/validation.js` clamped `modActionType` to `0..5`, but `MOD_ACTION_MAP`
in `server/index.js` has eight entries. Shadowban (6) and unshadowban (7) were
rewritten to **5 = `MOD_UPDATE`**, which ran, broadcast a `MOD_NOTIFY`, and fell
through to the unconditional `MOD_RESULT a=true` — so a moderator was told the
shadowban worked while no row was written and nothing was hidden. Fixed by
widening the clamp to `0..7`. Same class as the `MOD_LIST` search and
`modIpScope` bugs already commented in that file: **a whitelist sanitizer
silently rewrites whatever it wasn't updated for, and the action still acks
success.** Grep `server/validation.js` whenever an enum value or field is added.

**2. `::ffff:999.1.1.1` was accepted as an address.** `normalizeIp` matched
v4-mapped addresses with `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` and returned the
capture without validating the octets, *before* the `isIPv4`/`isIPv6` checks
that would have rejected it — yielding a well-formed "IPv4" identity in its own
synthetic `999.1.1.0/24`. Fixed by validating the capture with `isIPv4` and
falling through otherwise.

**3. The general case, and the reason #2 alone was not enough.** Any
unparseable `X-Forwarded-For` value also evaded every IP control — not by
minting a fake range, but by producing *no* range fingerprints, so no stored
ban could match it. `getClientIp` took the leftmost forwarded entry unvalidated,
and that entry is client-supplied whenever the proxy appends rather than
overwrites. Measured on the unpatched server: `::ffff:999.1.1.1`→`999.1.1.1`,
`::ffff:888.2.2.2`→`888.2.2.2`, `not-an-ip`→unknown, `203.0.113.10.7`→unknown —
four junk headers, three distinct un-bannable identities.

Fixed by validating and canonicalizing at the trust boundary: `getClientIp` now
accepts a forwarded value only if it parses as a real IP (via the new
`normalizeIpString` export, which still accepts `1.2.3.4:5678`,
`[2001:db8::1]:443`, zone-scoped and v4-mapped forms), and otherwise falls back
to the socket peer. Junk now collapses to one shared, bannable identity instead
of an endless supply of unbannable ones. Ban semantics are unchanged —
`buildIpIdentity` already canonicalized before hashing, so stored ranges still
match.

`malformed_source` is the regression test, and it asserts the property that
actually matters: not "junk is rejected" (falling back to the peer is a fine
answer) but "junk cannot mint *distinct* identities".

---

## Fixtures

`testing/lib/ipFixtures.mjs` holds every address, all from ranges reserved for
documentation (RFC 5737 for IPv4, RFC 3849's `2001:db8::/32` for IPv6), so
nothing here can address a real host even if a bot escapes onto a real network.

Scope → prefix, per `server/ipIdentity.js`:

| scope | IPv4 | IPv6 |
|---|---|---|
| `exact` | /32 | /128 |
| `subnet` (default) | /24 | /64 |
| `wide` | /24 — **folds**, no wider v4 tier | /48 |

The IPv4 fold matters: a test that assumes `wide` always widens passes on IPv4
for the wrong reason. `fingerprintForScope` reports the folded scope back as
`subnet`, and `ip_identity.test.mjs` asserts that it does.
