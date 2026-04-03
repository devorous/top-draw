/** @fileoverview ASN-based VPN/datacenter detection using a local MaxMind GeoLite2-ASN database. */

import maxmind from 'maxmind';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASN_DB_PATH = process.env.MAXMIND_ASN_DB_PATH || path.join(__dirname, '../data/GeoLite2-ASN.mmdb');
const ASN_SOURCE_URL = process.env.ASN_SOURCE_URL || 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/datacenter/ASN.txt';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let asnReader = null;
let blockedAsns = new Set();
let lastRefreshAt = 0;
let refreshTimer = null;
let refreshInFlight = null;

function parseAsnValue(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value).trim().replace(/^AS?/i, ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function lookupAsnForIp(ip) {
  if (!asnReader || !ip) return null;
  try {
    const result = asnReader.get(ip);
    return result?.autonomous_system_number ?? null;
  } catch {
    return null;
  }
}

export function isVpnAsn(asn) {
  const parsed = parseAsnValue(asn);
  if (!parsed) return false;
  return blockedAsns.has(parsed);
}

export function getAsnCheckStatus() {
  return {
    ready: asnReader !== null && blockedAsns.size > 0,
    dbLoaded: asnReader !== null,
    count: blockedAsns.size,
    lastRefreshAt
  };
}

function loadAsnDb() {
  try {
    asnReader = maxmind.openSync(ASN_DB_PATH);
    console.log(`[ASN] Loaded GeoLite2-ASN database from ${ASN_DB_PATH}`);
  } catch (error) {
    console.error(`[ASN] Failed to load GeoLite2-ASN database at ${ASN_DB_PATH}:`, error.message);
    console.error('[ASN] Download GeoLite2-ASN.mmdb from MaxMind (https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) and set MAXMIND_ASN_DB_PATH.');
  }
}

export async function refreshAsnList() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(ASN_SOURCE_URL, {
        headers: { 'user-agent': 'top-draw-asn-check' }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const nextSet = new Set();

      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/AS(\d+)/i);
        if (!match) continue;
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isInteger(parsed) && parsed > 0) nextSet.add(parsed);
      }

      blockedAsns = nextSet;
      lastRefreshAt = Date.now();
      console.log(`[ASN] Refreshed VPN ASN blocklist (${blockedAsns.size} entries)`);
    } catch (error) {
      console.error('[ASN] Failed to refresh VPN ASN blocklist:', error);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function initAsnCheck() {
  loadAsnDb();
  refreshAsnList().catch((error) => {
    console.error('[ASN] Initial ASN list refresh failed:', error);
  });
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshAsnList().catch((error) => {
      console.error('[ASN] Scheduled ASN list refresh failed:', error);
    });
  }, REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}
