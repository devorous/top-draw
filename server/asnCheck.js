/** @fileoverview Maintains an in-memory ASN denylist used to flag VPN/datacenter traffic. */

const ASN_SOURCE_URL = process.env.ASN_SOURCE_URL || 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/datacenter/ASN.txt';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let blockedAsns = new Set();
let lastRefreshAt = 0;
let refreshTimer = null;
let refreshInFlight = null;

function parseAsnValue(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^AS?(\d+)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getRequestAsn(req) {
  const directHeader = req?.headers?.['cf-ipasn'];
  const customHeader = req?.headers?.['x-client-asn'];
  const candidate = Array.isArray(directHeader) ? directHeader[0] : directHeader;
  const fallback = Array.isArray(customHeader) ? customHeader[0] : customHeader;
  return parseAsnValue(candidate) ?? parseAsnValue(fallback);
}

export function isVpnAsn(asn) {
  const parsed = parseAsnValue(asn);
  if (!parsed) return false;
  return blockedAsns.has(parsed);
}

export function getAsnCheckStatus() {
  return {
    ready: blockedAsns.size > 0,
    count: blockedAsns.size,
    lastRefreshAt
  };
}

export async function refreshAsnList() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(ASN_SOURCE_URL, {
        headers: {
          'user-agent': 'top-draw-asn-check'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      const nextSet = new Set();

      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/AS(\d+)/i);
        if (!match) continue;
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          nextSet.add(parsed);
        }
      }

      blockedAsns = nextSet;
      lastRefreshAt = Date.now();
      console.log(`[ASN] Refreshed VPN ASN list (${blockedAsns.size} entries)`);
    } catch (error) {
      console.error('[ASN] Failed to refresh VPN ASN list:', error);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function initAsnCheck() {
  if (refreshTimer) return;
  refreshAsnList().catch((error) => {
    console.error('[ASN] Initial refresh failed:', error);
  });
  refreshTimer = setInterval(() => {
    refreshAsnList().catch((error) => {
      console.error('[ASN] Scheduled refresh failed:', error);
    });
  }, REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}
