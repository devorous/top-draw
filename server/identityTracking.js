/** @fileoverview Helpers for collecting first-party device identity and connection telemetry. */

const HISTORY_LIMIT = 20;
const MAX_IDENTITY_JSON_LENGTH = 2048;

function trimString(value, maxLength = 256) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

export function mergeHistory(existingValues = [], nextValue, limit = HISTORY_LIMIT) {
  const values = Array.isArray(existingValues) ? existingValues.filter(Boolean) : [];
  const normalizedNext = typeof nextValue === 'string' ? nextValue.trim() : '';
  if (!normalizedNext) {
    return values.slice(-limit);
  }

  const deduped = values.filter(value => value !== normalizedNext);
  deduped.push(normalizedNext);
  return deduped.slice(-limit);
}

export function getIpSubnet(ip) {
  const value = trimString(ip, 128);
  if (!value) return '';

  const v4Match = value.match(/(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+/i);
  if (v4Match) {
    return `${v4Match[1]}.${v4Match[2]}.${v4Match[3]}.0/24`;
  }

  const expanded = value.split('%')[0];
  const segments = expanded.split(':').filter(Boolean);
  if (segments.length >= 4) {
    return `${segments.slice(0, 4).join(':')}::/64`;
  }
  return expanded.slice(0, 64);
}

export function normalizeIdentityPayload(raw = {}) {
  const identityJson = trimString(
    raw.clientIdentityJson || raw.client_identity_json,
    MAX_IDENTITY_JSON_LENGTH
  );
  let identitySummary = null;
  if (identityJson) {
    try {
      const parsed = JSON.parse(identityJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        identitySummary = parsed;
      }
    } catch {
      identitySummary = null;
    }
  }

  return {
    deviceId: trimString(raw.clientDeviceId || raw.client_device_id, 128),
    fingerprintId: trimString(raw.clientFingerprintId || raw.client_fingerprint_id, 128),
    identityJson,
    identitySummary,
  };
}

export async function recordConnectionEvent(db, event) {
  if (!db || !event) return;

  try {
    await db.collection('connection_events').insertOne({
      ...event,
      createdAt: event.createdAt instanceof Date ? event.createdAt : new Date(),
    });
  } catch (error) {
    console.warn('[IdentityTracking] Failed to record connection event:', error.message);
  }
}
