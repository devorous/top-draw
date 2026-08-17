/** @fileoverview Country-code lookup for a client IP, backed by the bundled geoip-lite database. */

import geoip from 'geoip-lite';

export function lookupCountryForIp(ip) {
  if (!ip) return '';
  try {
    const result = geoip.lookup(ip);
    return result?.country || '';
  } catch {
    return '';
  }
}
