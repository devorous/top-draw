/** @fileoverview IP identity and normalization for moderation enforcement and display. */

import { isIPv4, isIPv6 } from 'net';
import crypto from 'crypto';
import { Role } from './SessionManager.js';
import { getIpSalt as getConfiguredIpSalt } from './config.js';

export const IP_SCOPE_EXACT = 'exact';
export const IP_SCOPE_SUBNET = 'subnet';
export const IP_SCOPE_WIDE = 'wide';

function getIpSalt() {
  return getConfiguredIpSalt();
}

function hmacRangeKey(rangeKey) {
  return crypto.createHmac('sha256', getIpSalt()).update(rangeKey).digest('hex');
}

/**
 * Parses and normalizes an IP address string into a canonical form.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses.
 * @param {string} ip - The IP address to normalize
 * @returns {{family: 'ipv4'|'ipv6', canonical: string} | null}
 */
function normalizeIp(ip) {
  if (!ip) return null;
  let value = String(ip).trim();

  if (value.startsWith('[')) {
    const bracketEnd = value.indexOf(']');
    if (bracketEnd > 0) value = value.slice(1, bracketEnd);
  } else {
    const ipv4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4WithPort) value = ipv4WithPort[1];
  }

  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);

  // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x). The octets must be validated:
  // the pattern alone accepts `::ffff:999.1.1.1`, which used to yield a
  // well-formed "IPv4" identity in its own synthetic 999.1.1.0/24 — an endless
  // supply of distinct, unbanned ranges for anyone who can influence the
  // address. Fall through on a bad capture so the isIPv4/isIPv6 checks below
  // reject the value outright.
  const v4MappedMatch = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch && isIPv4(v4MappedMatch[1])) {
    return { family: 'ipv4', canonical: v4MappedMatch[1] };
  }

  // Try IPv4
  if (isIPv4(value)) {
    return { family: 'ipv4', canonical: value };
  }

  // Try IPv6 - normalize by expanding and then re-compressing
  if (isIPv6(value)) {
    const canonical = normalizeIpv6(value);
    return { family: 'ipv6', canonical };
  }

  return null;
}

/**
 * Expands an IPv6 `::` abbreviation into its explicit hextet groups.
 * Groups are returned as-is (not zero-padded or leading-zero-stripped).
 * @param {string} ip - IPv6 address (caller lowercases if needed).
 * @returns {string[]} The hextet groups.
 */
function expandIpv6ToGroups(ip) {
  const parts = ip.split('::');
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    return [...left, ...Array(missing).fill('0'), ...right];
  }
  return ip.split(':');
}

/**
 * Normalizes an IPv6 address to a canonical compressed form.
 * Expands :: notation and ensures consistent formatting.
 * @param {string} ip - IPv6 address
 * @returns {string} - Canonical IPv6 address
 */
function normalizeIpv6(ip) {
  // Expand :: notation
  let groups = expandIpv6ToGroups(ip.toLowerCase());

  // Pad each group to 4 hex digits for normalization
  groups = groups.map(g => g.padStart(4, '0'));

  // Find longest run of zeros for compression
  let maxZeroStart = -1;
  let maxZeroLen = 0;
  let currentZeroStart = -1;
  let currentZeroLen = 0;

  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === '0000') {
      if (currentZeroStart === -1) {
        currentZeroStart = i;
        currentZeroLen = 1;
      } else {
        currentZeroLen++;
      }
    } else {
      if (currentZeroLen > maxZeroLen) {
        maxZeroStart = currentZeroStart;
        maxZeroLen = currentZeroLen;
      }
      currentZeroStart = -1;
      currentZeroLen = 0;
    }
  }

  // Check final run
  if (currentZeroLen > maxZeroLen) {
    maxZeroStart = currentZeroStart;
    maxZeroLen = currentZeroLen;
  }

  // Compress longest zero run
  if (maxZeroLen > 1) {
    const before = groups.slice(0, maxZeroStart).map(g => g.replace(/^0+/, '') || '0');
    const after = groups.slice(maxZeroStart + maxZeroLen).map(g => g.replace(/^0+/, '') || '0');

    if (before.length === 0 && after.length === 0) {
      return '::';
    } else if (before.length === 0) {
      return '::' + after.join(':');
    } else if (after.length === 0) {
      return before.join(':') + '::';
    } else {
      return before.join(':') + '::' + after.join(':');
    }
  }

  // No compression, just remove leading zeros
  return groups.map(g => g.replace(/^0+/, '') || '0').join(':');
}

/**
 * Computes an IPv4 /24 network address.
 * @param {string} ip - IPv4 address (e.g., "203.0.113.42")
 * @returns {string} - Network address (e.g., "203.0.113.0")
 */
function getIpv4Network24(ip) {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/**
 * Computes an IPv6 /64 network prefix.
 * @param {string} ip - Canonical IPv6 address
 * @returns {string} - /64 network prefix (e.g., "2001:db8:abcd:1200::")
 */
function getIpv6Network64(ip) {
  // Expand to full form for easier manipulation
  const groups = expandIpv6ToGroups(ip);

  // Pad to 8 groups
  while (groups.length < 8) groups.push('0');

  // Take first 4 groups (64 bits), zero out the rest
  const network = [...groups.slice(0, 4), '0', '0', '0', '0'];

  // Convert back to standard notation
  return normalizeIpv6(network.join(':'));
}

/**
 * Computes an IPv6 /48 network prefix.
 * @param {string} ip - Canonical IPv6 address
 * @returns {string} - /48 network prefix
 */
function getIpv6Network48(ip) {
  const groups = expandIpv6ToGroups(ip);

  while (groups.length < 8) groups.push('0');

  // Take first 3 groups (48 bits), zero out the rest
  const network = [...groups.slice(0, 3), '0', '0', '0', '0', '0'];

  return normalizeIpv6(network.join(':'));
}

function expandIpv6Groups(ip) {
  const groups = expandIpv6ToGroups(ip);
  while (groups.length < 8) groups.push('0');
  return groups.slice(0, 8).map(g => (g.replace(/^0+/, '') || '0').toLowerCase());
}

function maskIpv4(ip, visibleOctets) {
  const parts = ip.split('.');
  return parts.map((part, index) => index < visibleOctets ? part : 'x').join('.');
}

function maskIpv6(ip, visibleGroups) {
  return expandIpv6Groups(ip)
    .map((group, index) => index < visibleGroups ? group : 'x')
    .join(':');
}

function getIpMaskTier(role = Role.GUEST) {
  if (role >= Role.DEITY) return 'full';
  if (role >= Role.NOBLE) return 'fine';
  return 'coarse';
}

function getDisplayIpForTier(identity, tier) {
  if (!identity) return 'unknown';
  if (tier === 'full') return identity.canonicalIp;

  if (identity.family === 'ipv4') {
    return maskIpv4(identity.canonicalIp, tier === 'fine' ? 3 : 2);
  }

  return maskIpv6(identity.canonicalIp, tier === 'fine' ? 7 : 4);
}

/**
 * Validates and canonicalizes an address string.
 *
 * Used at the trust boundary (`security.js#getClientIp`) to decide whether a
 * client-influenced address is usable at all, so that every downstream consumer
 * of `ws.clientIp` sees one representation of one real address — or the peer
 * address, never an attacker-chosen string.
 *
 * Accepts the forms a proxy realistically emits: bare addresses, `1.2.3.4:5678`,
 * `[2001:db8::1]:443`, zone-scoped, and IPv4-mapped IPv6.
 *
 * @param {string} ip
 * @returns {string|null} Canonical address, or null if it is not a valid IP.
 */
export function normalizeIpString(ip) {
  return normalizeIp(ip)?.canonical ?? null;
}

/**
 * Builds a complete IP identity object for enforcement and display.
 * @param {string} ip - Raw IP address from connection
 * @returns {Object|null} - IP identity object or null if invalid
 *
 * Example IPv4:
 * {
 *   family: "ipv4",
 *   canonicalIp: "203.0.113.42",
 *   exactKey: "ip4:203.0.113.42/32",
 *   rangeKeys: ["ip4:203.0.113.42/32", "ip4:203.0.113.0/24"],
 *   defaultRangeKey: "ip4:203.0.113.0/24",
 *   displayExact: "203.0.x.x",
 *   displayRange: "203.0.113.0/24"
 * }
 *
 * Example IPv6:
 * {
 *   family: "ipv6",
 *   canonicalIp: "2001:db8:abcd:1200::1234",
 *   exactKey: "ip6:2001:db8:abcd:1200::1234/128",
 *   rangeKeys: [
 *     "ip6:2001:db8:abcd:1200::1234/128",
 *     "ip6:2001:db8:abcd:1200::/64",
 *     "ip6:2001:db8:abcd::/48"
 *   ],
 *   defaultRangeKey: "ip6:2001:db8:abcd:1200::/64",
 *   displayExact: "2001:db8:abcd:1200:x:x:x:x",
 *   displayRange: "2001:db8:abcd:1200::/64"
 * }
 */
export function buildIpIdentity(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;

  const { family, canonical } = normalized;

  if (family === 'ipv4') {
    const network24 = getIpv4Network24(canonical);
    const parts = canonical.split('.');

    return {
      family: 'ipv4',
      canonicalIp: canonical,
      exactKey: `ip4:${canonical}/32`,
      rangeKeys: [
        `ip4:${canonical}/32`,
        `ip4:${network24}/24`
      ],
      defaultRangeKey: `ip4:${network24}/24`,
      displayExact: `${parts[0]}.${parts[1]}.x.x`,
      displayRange: `${network24}/24`
    };
  }

  // IPv6
  const network64 = getIpv6Network64(canonical);
  const network48 = getIpv6Network48(canonical);

  return {
    family: 'ipv6',
    canonicalIp: canonical,
    exactKey: `ip6:${canonical}/128`,
    rangeKeys: [
      `ip6:${canonical}/128`,
      `ip6:${network64}/64`,
      `ip6:${network48}/48`
    ],
    defaultRangeKey: `ip6:${network64}/64`,
    displayExact: maskIpv6(canonical, 4),
    displayRange: `${network64}/64`
  };
}

/**
 * Obfuscates an IP address for display to moderators.
 * Uses the IP identity system to ensure consistent obfuscation.
 *
 * MOD through OWNER: mask coarse host/location detail.
 *   IPv4: "203.0.x.x"
 *   IPv6: "2001:db8:abcd:1200:x:x:x:x"
 * NOBLE/HOLY: mask one final address part.
 *   IPv4: "203.0.113.x"
 *   IPv6: "2001:db8:abcd:1200:0:0:0:x"
 * DEITY: full canonical IP.
 *
 * @param {string} ip - The IP address to obfuscate
 * @param {number} [viewerRole=Role.GUEST] - Role of the viewer requesting display
 * @returns {string} - The obfuscated IP address
 */
export function obfuscateIp(ip, viewerRole = Role.GUEST) {
  if (!ip) return 'unknown';

  const identity = buildIpIdentity(ip);
  if (!identity) return 'unknown';

  return getDisplayIpForTier(identity, getIpMaskTier(viewerRole));
}

/**
 * Returns HMAC fingerprints for every range a given IP belongs to.
 * Used when checking whether a connecting IP matches any stored ban range.
 *
 * For IPv4: [hmac(/32), hmac(/24)]
 * For IPv6: [hmac(/128), hmac(/64), hmac(/48)]
 *
 * @param {string} ip - Raw or canonical IP address.
 * @returns {string[]} - Array of hex HMAC fingerprints; empty if IP invalid.
 */
export function fingerprintRangeKeys(ip) {
  const identity = buildIpIdentity(ip);
  if (!identity) return [];
  return identity.rangeKeys.map(hmacRangeKey);
}

/**
 * Returns the HMAC fingerprint, raw range key, and human-readable display
 * for a specific ban scope.
 *
 * Scopes:
 *   'exact'  → /32 (IPv4) or /128 (IPv6)
 *   'subnet' → /24 (IPv4) or /64 (IPv6)   ← default
 *   'wide'   → /24 (IPv4, same as subnet) or /48 (IPv6)
 *
 * @param {string} ip
 * @param {'exact'|'subnet'|'wide'} [scope='subnet']
 * @returns {{fingerprint: string, rangeKey: string, scope: string, displayRange: string, family: 'ipv4'|'ipv6'} | null}
 */
export function fingerprintForScope(ip, scope = IP_SCOPE_SUBNET) {
  const identity = buildIpIdentity(ip);
  if (!identity) return null;

  let rangeKey;
  let normalizedScope = scope;
  if (scope === IP_SCOPE_EXACT) {
    rangeKey = identity.exactKey;
  } else if (scope === IP_SCOPE_WIDE) {
    rangeKey = identity.family === 'ipv6' ? identity.rangeKeys[2] : identity.defaultRangeKey;
    if (identity.family === 'ipv4') normalizedScope = IP_SCOPE_SUBNET;
  } else {
    rangeKey = identity.defaultRangeKey;
    normalizedScope = IP_SCOPE_SUBNET;
  }

  return {
    fingerprint: hmacRangeKey(rangeKey),
    rangeKey,
    scope: normalizedScope,
    displayRange: rangeKey.replace(/^ip[46]:/, ''),
    family: identity.family
  };
}
