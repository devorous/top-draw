#!/usr/bin/env node
/**
 * @fileoverview Unit suite for `server/ipIdentity.js` — the module every
 * IP-based moderation decision funnels through.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE LIVE SUITE. The live suite
 * (`ip_moderation_suite.mjs`) proves the server *enforces* what this module
 * decides, but it can only observe enforcement through a socket: a ban that
 * fails to catch an address looks exactly like a ban that was never stored, or
 * a bot that never connected. This suite pins the decision itself — no server,
 * no database, no network — so that when the live suite fails you already know
 * whether the range maths was right.
 *
 * It covers the four things the enforcement path depends on:
 *
 *   1. Canonicalization  — every spelling of one address (v4-mapped, bracketed,
 *      zoned, uppercase, ported, expanded) must land on ONE identity. A miss
 *      here means a ban silently stops applying when a client reconnects and
 *      the peer address is formatted differently.
 *   2. Range membership  — for a ban issued at exact/subnet/wide against a base
 *      address, exactly the right neighbours are caught. Driven by the shared
 *      MEMBERSHIP table in testing/lib/ipFixtures.mjs.
 *   3. Fingerprint hygiene — matching happens on HMACs, so the fingerprints must
 *      be stable across calls, distinct across ranges, and never leak the IP.
 *   4. Display masking   — obfuscation must be monotone in role: a lower role
 *      may never see more than a higher one.
 *
 * Usage:  node testing/moderation/ip_identity.test.mjs [--verbose]
 */

import {
  buildIpIdentity,
  fingerprintRangeKeys,
  fingerprintForScope,
  obfuscateIp,
  IP_SCOPE_EXACT,
  IP_SCOPE_SUBNET,
  IP_SCOPE_WIDE,
} from '../../server/ipIdentity.js';
import { Role } from '../../server/SessionManager.js';
import {
  V4, V6, V4_ALIASES, V6_ALIASES, MEMBERSHIP, INVALID_IPS,
} from '../lib/ipFixtures.mjs';

const VERBOSE = process.argv.includes('--verbose');

// ─── Micro test harness ────────────────────────────────────────────────────

const results = [];
let currentGroup = '(ungrouped)';

function group(name) { currentGroup = name; }

function check(name, fn) {
  let pass = false;
  let detail = '';
  try {
    const outcome = fn();
    if (outcome === undefined || outcome === true) {
      pass = true;
    } else if (typeof outcome === 'string') {
      detail = outcome;
    } else if (outcome && typeof outcome === 'object') {
      pass = !!outcome.pass;
      detail = outcome.detail || '';
    }
  } catch (err) {
    detail = err.message;
  }
  results.push({ group: currentGroup, name, pass, detail });
  if (VERBOSE || !pass) {
    const icon = pass ? '  ok  ' : ' FAIL ';
    console.log(`${icon} ${currentGroup} › ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Returns a failure detail string when `cond` is false, otherwise true. */
function expect(cond, detail) {
  return cond ? true : detail;
}

// ─── Range membership oracle ───────────────────────────────────────────────

/**
 * Mirrors exactly what `moderation.js` does at enforcement time: expand the
 * connecting IP into every range fingerprint it belongs to, and ask whether the
 * stored ban's single fingerprint is among them.
 *
 * @param {string} bannedIp - IP the moderator acted against.
 * @param {'exact'|'subnet'|'wide'} scope
 * @param {string} connectingIp - IP now trying to connect.
 * @returns {boolean}
 */
function wouldBeCaught(bannedIp, scope, connectingIp) {
  const stored = fingerprintForScope(bannedIp, scope);
  if (!stored) throw new Error(`fingerprintForScope returned null for ${bannedIp}`);
  return fingerprintRangeKeys(connectingIp).includes(stored.fingerprint);
}

// ─── 1. Canonicalization ───────────────────────────────────────────────────

group('canonicalization');

for (const family of [
  { label: 'ipv4', base: V4.base, aliases: V4_ALIASES, expectFamily: 'ipv4' },
  { label: 'ipv6', base: V6.base, aliases: V6_ALIASES, expectFamily: 'ipv6' },
]) {
  const baseIdentity = buildIpIdentity(family.base);

  check(`${family.label}: base address resolves`, () =>
    expect(!!baseIdentity, `buildIpIdentity("${family.base}") returned null`));

  check(`${family.label}: family is ${family.expectFamily}`, () =>
    expect(baseIdentity?.family === family.expectFamily,
      `got ${baseIdentity?.family}`));

  for (const alias of family.aliases) {
    check(`${family.label}: "${alias.label}" canonicalizes to base`, () => {
      const identity = buildIpIdentity(alias.value);
      if (!identity) return `buildIpIdentity("${alias.value}") returned null`;
      if (identity.canonicalIp !== baseIdentity.canonicalIp) {
        return `canonical "${identity.canonicalIp}" !== "${baseIdentity.canonicalIp}"`;
      }
      // Canonical equality is not enough — enforcement compares fingerprints,
      // so those must agree too.
      const aliasKeys = fingerprintRangeKeys(alias.value).join(',');
      const baseKeys = fingerprintRangeKeys(family.base).join(',');
      return expect(aliasKeys === baseKeys, 'range fingerprints differ despite equal canonical form');
    });
  }
}

check('ipv4-mapped ipv6 is reported as the ipv4 family', () =>
  expect(buildIpIdentity('::ffff:203.0.113.10')?.family === 'ipv4',
    'a v4-mapped address kept the ipv6 family, so it would get /64 and /48 ranges'));

check('ipv6 zone id is stripped before hashing', () => {
  const withZone = fingerprintRangeKeys('fe80::1%eth0');
  const without = fingerprintRangeKeys('fe80::1');
  return expect(withZone.length > 0 && withZone.join() === without.join(),
    'zone-scoped address hashed differently than the same address without a zone');
});

group('canonicalization/rejection');

for (const bad of INVALID_IPS) {
  check(`rejects ${JSON.stringify(bad)}`, () => {
    const identity = buildIpIdentity(bad);
    if (identity) {
      return `accepted as ${identity.family} "${identity.canonicalIp}"`;
    }
    // A rejected IP must also produce no fingerprints and no display, or a
    // caller that skips the null check would ban an empty range.
    if (fingerprintRangeKeys(bad).length !== 0) return 'produced range fingerprints anyway';
    if (fingerprintForScope(bad, IP_SCOPE_SUBNET) !== null) return 'produced a scope fingerprint anyway';
    return expect(obfuscateIp(bad, Role.DEITY) === 'unknown', 'display did not fall back to "unknown"');
  });
}

// ─── 2. Range membership ───────────────────────────────────────────────────

for (const [familyLabel, table] of Object.entries(MEMBERSHIP)) {
  group(`membership/${familyLabel}`);

  for (const scope of [IP_SCOPE_EXACT, IP_SCOPE_SUBNET, IP_SCOPE_WIDE]) {
    const { inside, outside } = table[scope];

    for (const ip of inside) {
      check(`${scope}: catches ${ip}`, () =>
        expect(wouldBeCaught(table.base, scope, ip),
          `ban on ${table.base} @${scope} did NOT match ${ip}`));
    }
    for (const ip of outside) {
      check(`${scope}: lets ${ip} through`, () =>
        expect(!wouldBeCaught(table.base, scope, ip),
          `ban on ${table.base} @${scope} wrongly matched ${ip} — over-broad`));
    }
  }
}

group('membership/scope-widening');

check('each scope is a superset of the narrower one (ipv6)', () => {
  const exact = fingerprintForScope(V6.base, IP_SCOPE_EXACT);
  const subnet = fingerprintForScope(V6.base, IP_SCOPE_SUBNET);
  const wide = fingerprintForScope(V6.base, IP_SCOPE_WIDE);
  const keys = fingerprintRangeKeys(V6.base);
  return expect(
    keys.includes(exact.fingerprint) && keys.includes(subnet.fingerprint) && keys.includes(wide.fingerprint),
    'the base address is not a member of all three of its own scopes',
  );
});

check('ipv4 "wide" folds to subnet and says so', () => {
  const wide = fingerprintForScope(V4.base, IP_SCOPE_WIDE);
  const subnet = fingerprintForScope(V4.base, IP_SCOPE_SUBNET);
  if (wide.fingerprint !== subnet.fingerprint) {
    return 'ipv4 wide produced a different range than subnet — ipIdentity grew a wider v4 tier';
  }
  // The reported scope must reflect the fold, so the mod panel does not claim
  // a breadth the ban does not have.
  return expect(wide.scope === IP_SCOPE_SUBNET,
    `reported scope "${wide.scope}" claims to be wider than the /24 it actually stored`);
});

check('ipv6 "wide" really is wider than "subnet"', () => {
  const wide = fingerprintForScope(V6.base, IP_SCOPE_WIDE);
  const subnet = fingerprintForScope(V6.base, IP_SCOPE_SUBNET);
  if (wide.fingerprint === subnet.fingerprint) return 'ipv6 wide collapsed onto subnet';
  return expect(
    wouldBeCaught(V6.base, IP_SCOPE_WIDE, V6.sameWide) && !wouldBeCaught(V6.base, IP_SCOPE_SUBNET, V6.sameWide),
    'the /48 does not actually cover a sibling /64',
  );
});

check('an unknown scope string falls back to subnet, not exact', () => {
  const bogus = fingerprintForScope(V6.base, 'planet');
  const subnet = fingerprintForScope(V6.base, IP_SCOPE_SUBNET);
  // Falling back to `exact` would quietly narrow every malformed request,
  // letting a ban miss the whole subnet a moderator meant to hit.
  return expect(bogus.fingerprint === subnet.fingerprint && bogus.scope === IP_SCOPE_SUBNET,
    `unknown scope produced "${bogus.scope}"`);
});

check('the two families never share a fingerprint', () => {
  const v4 = new Set(fingerprintRangeKeys(V4.base));
  const overlap = fingerprintRangeKeys(V6.base).filter(k => v4.has(k));
  return expect(overlap.length === 0, `${overlap.length} shared fingerprint(s)`);
});

// ─── 3. Fingerprint hygiene ────────────────────────────────────────────────

group('fingerprints');

check('range key counts match the documented tiers', () => {
  const v4 = buildIpIdentity(V4.base).rangeKeys;
  const v6 = buildIpIdentity(V6.base).rangeKeys;
  if (v4.length !== 2) return `ipv4 has ${v4.length} range keys, expected 2 (/32, /24)`;
  return expect(v6.length === 3, `ipv6 has ${v6.length} range keys, expected 3 (/128, /64, /48)`);
});

check('fingerprints are stable across calls', () => {
  const a = fingerprintRangeKeys(V6.base).join(',');
  const b = fingerprintRangeKeys(V6.base).join(',');
  return expect(a === b, 'two calls produced different fingerprints');
});

check('fingerprints are distinct per range', () => {
  const keys = fingerprintRangeKeys(V6.base);
  return expect(new Set(keys).size === keys.length, 'duplicate fingerprints across tiers');
});

check('fingerprints look like sha256 hex and contain no plaintext IP', () => {
  for (const scope of [IP_SCOPE_EXACT, IP_SCOPE_SUBNET, IP_SCOPE_WIDE]) {
    for (const ip of [V4.base, V6.base]) {
      const { fingerprint } = fingerprintForScope(ip, scope);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return `"${fingerprint}" is not 64 hex chars`;
      // The stored fingerprint is what survives in the database; if any part of
      // the address survived alongside it, the hashing bought nothing.
      if (fingerprint.includes(ip.replace(/[:.]/g, ''))) return 'fingerprint embeds the address';
    }
  }
  return true;
});

check('displayRange is human-readable CIDR, not a fingerprint', () => {
  const v4 = fingerprintForScope(V4.base, IP_SCOPE_SUBNET);
  const v6 = fingerprintForScope(V6.base, IP_SCOPE_WIDE);
  if (v4.displayRange !== '203.0.113.0/24') return `ipv4 subnet display "${v4.displayRange}"`;
  return expect(v6.displayRange === '2001:db8:abcd::/48', `ipv6 wide display "${v6.displayRange}"`);
});

check('displayRange never carries the host portion', () => {
  // The whole point of a /24 or /64 ban row is that it does not record which
  // host inside the range was acted against.
  const v4 = fingerprintForScope(V4.base, IP_SCOPE_SUBNET).displayRange;
  const v6 = fingerprintForScope(V6.base, IP_SCOPE_SUBNET).displayRange;
  if (v4.startsWith(V4.base)) return `ipv4 /24 display retained the host octet: ${v4}`;
  return expect(!v6.startsWith(V6.base), `ipv6 /64 display retained the interface id: ${v6}`);
});

// ─── 4. Display masking ────────────────────────────────────────────────────

group('display masking');

const ROLE_LADDER = [
  ['GUEST', Role.GUEST],
  ['USER', Role.USER],
  ['MOD', Role.MOD],
  ['OWNER', Role.OWNER],
  ['NOBLE', Role.NOBLE],
  ['HOLY', Role.HOLY],
  ['DEITY', Role.DEITY],
];

/** Counts how many address parts are revealed rather than masked with `x`. */
function revealedParts(display, separator) {
  return display.split(separator).filter(p => p !== 'x').length;
}

for (const [ip, separator, label] of [[V4.base, '.', 'ipv4'], [V6.base, ':', 'ipv6']]) {
  check(`${label}: masking never decreases as role increases`, () => {
    let previous = -1;
    for (const [roleName, role] of ROLE_LADDER) {
      const display = obfuscateIp(ip, role);
      const revealed = display === buildIpIdentity(ip).canonicalIp
        ? Number.MAX_SAFE_INTEGER
        : revealedParts(display, separator);
      if (revealed < previous) {
        return `${roleName} sees less (${revealed} parts) than the role below it (${previous})`;
      }
      previous = revealed;
    }
    return true;
  });

  check(`${label}: DEITY sees the canonical address`, () =>
    expect(obfuscateIp(ip, Role.DEITY) === buildIpIdentity(ip).canonicalIp,
      `DEITY got "${obfuscateIp(ip, Role.DEITY)}"`));

  check(`${label}: MOD sees a masked address, not the raw one`, () => {
    const display = obfuscateIp(ip, Role.MOD);
    if (display === buildIpIdentity(ip).canonicalIp) return 'MOD got the unmasked address';
    return expect(display.includes('x'), `no masking applied: "${display}"`);
  });

  check(`${label}: GUEST sees no more than MOD`, () =>
    expect(obfuscateIp(ip, Role.GUEST) === obfuscateIp(ip, Role.MOD),
      `GUEST "${obfuscateIp(ip, Role.GUEST)}" vs MOD "${obfuscateIp(ip, Role.MOD)}"`));

  check(`${label}: masked display is not enough to reconstruct the address`, () => {
    const display = obfuscateIp(ip, Role.MOD);
    return expect(!display.includes(buildIpIdentity(ip).canonicalIp),
      'the coarse display contains the full address');
  });
}

check('an omitted viewer role defaults to the most masked tier', () =>
  expect(obfuscateIp(V6.base) === obfuscateIp(V6.base, Role.GUEST),
    'a missing role argument revealed more than GUEST would see'));

check('display masking agrees across address spellings', () => {
  for (const alias of V6_ALIASES) {
    if (obfuscateIp(alias.value, Role.MOD) !== obfuscateIp(V6.base, Role.MOD)) {
      return `"${alias.label}" displayed differently`;
    }
  }
  return true;
});

// ─── Report ────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);

console.log('');
console.log('Top Draw — IP identity unit suite');
console.log('─'.repeat(72));

const groups = [...new Set(results.map(r => r.group))];
for (const g of groups) {
  const rows = results.filter(r => r.group === g);
  const ok = rows.filter(r => r.pass).length;
  const icon = ok === rows.length ? '✅' : '❌';
  console.log(`  ${icon} ${g.padEnd(32)} ${String(ok).padStart(3)}/${rows.length}`);
}

console.log('─'.repeat(72));
console.log(`  ${passed}/${results.length} checks passed`);

if (failed.length) {
  console.log('');
  console.log('Failures:');
  for (const f of failed) {
    console.log(`  • ${f.group} › ${f.name}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
}
console.log('');

process.exit(failed.length ? 1 : 0);
