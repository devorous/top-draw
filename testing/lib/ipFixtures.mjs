/**
 * @fileoverview Shared IP fixtures for the moderation test suites.
 *
 * Every address here comes from a range reserved for documentation, so nothing
 * in these suites can ever address a real host even if a bot leaks onto a real
 * network:
 *   IPv4 — RFC 5737 TEST-NET-1/2/3 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
 *   IPv6 — RFC 3849 documentation prefix 2001:db8::/32
 *
 * The fixtures are grouped by their relationship to a `base` address, because
 * that relationship is the whole point: a moderation action taken against
 * `base` at a given scope must catch exactly the addresses inside that scope's
 * range and no others. The `MEMBERSHIP` table below states that expectation
 * once, and both the unit suite (against `server/ipIdentity.js` directly) and
 * the live suite (against a running server) assert against it.
 *
 * Scope → prefix, per server/ipIdentity.js:
 *
 *   scope    IPv4            IPv6
 *   exact    /32             /128
 *   subnet   /24  (default)  /64  (default)
 *   wide     /24  (folds!)   /48
 *
 * Note the fold: IPv4 has no wider tier than /24, so `fingerprintForScope`
 * normalizes a 'wide' IPv4 request back to 'subnet'. A test that assumes
 * 'wide' always widens would silently pass for the wrong reason on IPv4.
 */

// ─── IPv4 ──────────────────────────────────────────────────────────────────

export const V4 = {
  /** The address moderation actions are taken against. */
  base: '203.0.113.10',
  /** Byte-identical to base — the trivial exact match. */
  identical: '203.0.113.10',
  /** Same /24, different host — caught by subnet, missed by exact. */
  sameSubnet: '203.0.113.99',
  /** Same /24, last host — boundary case for the /24 network computation. */
  sameSubnetEdge: '203.0.113.255',
  /** Same /24, network address itself. */
  sameSubnetZero: '203.0.113.0',
  /** Adjacent /24 inside the same /16 — must NOT be caught at any scope. */
  neighborSubnet: '203.0.114.10',
  /** Same /24 numerically one below — the other side of the boundary. */
  previousSubnet: '203.0.112.10',
  /** A wholly unrelated documentation range. */
  unrelated: '198.51.100.10',
  /** A third unrelated range, for multi-ban tests. */
  unrelatedAlt: '192.0.2.10',
};

/** Spellings of `V4.base` that must all canonicalize to the same identity. */
export const V4_ALIASES = [
  { label: 'plain', value: '203.0.113.10' },
  { label: 'v4-mapped v6', value: '::ffff:203.0.113.10' },
  { label: 'v4-mapped v6 uppercase', value: '::FFFF:203.0.113.10' },
  { label: 'with port', value: '203.0.113.10:54321' },
  { label: 'surrounding whitespace', value: '  203.0.113.10  ' },
];

// ─── IPv6 ──────────────────────────────────────────────────────────────────

export const V6 = {
  /** The address moderation actions are taken against. */
  base: '2001:db8:abcd:1200::1234',
  /** Byte-identical to base. */
  identical: '2001:db8:abcd:1200::1234',
  /** Same /64, different interface id — caught by subnet and wide. */
  sameSubnet: '2001:db8:abcd:1200:5678:90ab:cdef:0009',
  /** Same /64, all-zero interface id — the network address itself. */
  sameSubnetZero: '2001:db8:abcd:1200::',
  /** Same /48, different /64 — caught by wide only. */
  sameWide: '2001:db8:abcd:34ff::1',
  /** Same /48, /64 numerically adjacent to base's — boundary for the /64 cut. */
  sameWideAdjacent: '2001:db8:abcd:1201::1',
  /** Adjacent /48 — must NOT be caught at any scope. */
  neighborWide: '2001:db8:abce:1200::1',
  /** A wholly unrelated /48 inside the documentation prefix. */
  unrelated: '2001:db8:9999:0001::1',
  /** A third unrelated /48, for multi-ban tests. */
  unrelatedAlt: '2001:db8:4444:0001::1',
};

/** Spellings of `V6.base` that must all canonicalize to the same identity. */
export const V6_ALIASES = [
  { label: 'compressed', value: '2001:db8:abcd:1200::1234' },
  { label: 'fully expanded', value: '2001:0db8:abcd:1200:0000:0000:0000:1234' },
  { label: 'uppercase', value: '2001:DB8:ABCD:1200::1234' },
  { label: 'mixed case + leading zeros', value: '2001:0DB8:AbCd:1200::1234' },
  { label: 'bracketed with port', value: '[2001:db8:abcd:1200::1234]:443' },
  { label: 'zone id', value: '2001:db8:abcd:1200::1234%eth0' },
  { label: 'surrounding whitespace', value: '  2001:db8:abcd:1200::1234  ' },
];

// ─── Membership expectations ───────────────────────────────────────────────

/**
 * For a moderation action taken against `base` at each scope, which fixture
 * addresses fall inside the resulting range.
 *
 * `inside` addresses must be caught (banned/muted/matched); `outside` addresses
 * must be let through. Anything not listed is simply not asserted.
 */
export const MEMBERSHIP = {
  ipv4: {
    base: V4.base,
    exact: {
      inside: [V4.identical],
      outside: [V4.sameSubnet, V4.sameSubnetEdge, V4.neighborSubnet, V4.unrelated],
    },
    subnet: {
      inside: [V4.identical, V4.sameSubnet, V4.sameSubnetEdge, V4.sameSubnetZero],
      outside: [V4.neighborSubnet, V4.previousSubnet, V4.unrelated, V4.unrelatedAlt],
    },
    // IPv4 'wide' folds to /24 — identical expectations to subnet, and that
    // fold is itself asserted separately.
    wide: {
      inside: [V4.identical, V4.sameSubnet, V4.sameSubnetEdge, V4.sameSubnetZero],
      outside: [V4.neighborSubnet, V4.previousSubnet, V4.unrelated, V4.unrelatedAlt],
    },
  },
  ipv6: {
    base: V6.base,
    exact: {
      inside: [V6.identical],
      outside: [V6.sameSubnet, V6.sameSubnetZero, V6.sameWide, V6.neighborWide, V6.unrelated],
    },
    subnet: {
      inside: [V6.identical, V6.sameSubnet, V6.sameSubnetZero],
      outside: [V6.sameWide, V6.sameWideAdjacent, V6.neighborWide, V6.unrelated],
    },
    wide: {
      inside: [V6.identical, V6.sameSubnet, V6.sameSubnetZero, V6.sameWide, V6.sameWideAdjacent],
      outside: [V6.neighborWide, V6.unrelated, V6.unrelatedAlt],
    },
  },
};

/** Inputs that must be rejected outright rather than producing an identity. */
export const INVALID_IPS = [
  '',
  '   ',
  'not-an-ip',
  '999.999.999.999',
  '203.0.113',
  '203.0.113.10.7',
  '2001:db8:::1',
  'gggg::1',
  '::ffff:999.1.1.1',
];

// ─── Address generation ────────────────────────────────────────────────────

/**
 * Deterministically derives a fresh documentation IP from an integer, so a
 * suite can hand every bot a distinct address without hand-maintaining a list.
 * Successive `n` walk the host octet first, then the third octet, keeping
 * everything inside 203.0.0.0/16 (a superset of TEST-NET-3's /24, used here
 * only because these addresses never leave the local process).
 *
 * @param {number} n
 * @returns {string}
 */
export function v4From(n) {
  const host = 1 + (n % 250);
  const third = Math.floor(n / 250) % 256;
  return `203.0.${third}.${host}`;
}

/**
 * IPv6 counterpart to {@link v4From}, inside 2001:db8::/32. Successive `n`
 * walk the interface id, so consecutive values share a /64 — use `stride` to
 * step whole /64s or /48s instead.
 *
 * @param {number} n
 * @param {{ subnetStride?: number, wideStride?: number }} [opts]
 * @returns {string}
 */
export function v6From(n, { subnetStride = 0, wideStride = 0 } = {}) {
  const hex = (v) => (v & 0xffff).toString(16);
  return `2001:db8:${hex(0x1000 + wideStride)}:${hex(0x2000 + subnetStride)}::${hex(1 + n)}`;
}
