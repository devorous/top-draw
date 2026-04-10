import FingerprintJS from '@fingerprintjs/fingerprintjs';

const DEVICE_ID_KEY = 'topDrawDeviceId';
const FINGERPRINT_ID_KEY = 'topDrawFingerprintId';
const IDENTITY_SUMMARY_KEY = 'topDrawIdentitySummary';
const MAX_IDENTITY_JSON_BYTES = 2048;

function safeGetStorageItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorageItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in private mode / quota issues.
  }
}

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `td-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function getOrCreateDeviceId() {
  const existing = safeGetStorageItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const created = randomId();
  safeSetStorageItem(DEVICE_ID_KEY, created);
  return created;
}

function buildIdentitySummary(visitorId) {
  const screenData = typeof window !== 'undefined' && window.screen
    ? {
        width: window.screen.width || 0,
        height: window.screen.height || 0,
        colorDepth: window.screen.colorDepth || 0,
      }
    : null;

  const summary = {
    version: 1,
    visitorId: visitorId || '',
    platform: navigator.platform || '',
    language: navigator.language || '',
    languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 4) : [],
    timezone: Intl.DateTimeFormat?.().resolvedOptions?.().timeZone || '',
    screen: screenData,
    pixelRatio: typeof window !== 'undefined' ? Number(window.devicePixelRatio || 1) : 1,
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    deviceMemory: Number(navigator.deviceMemory || 0),
    maxTouchPoints: Number(navigator.maxTouchPoints || 0),
  };

  const json = JSON.stringify(summary);
  if (json.length <= MAX_IDENTITY_JSON_BYTES) {
    return json;
  }

  delete summary.languages;
  delete summary.screen;
  return JSON.stringify(summary).slice(0, MAX_IDENTITY_JSON_BYTES);
}

export class ClientIdentity {
  constructor() {
    this.deviceId = getOrCreateDeviceId();
    this.cachedFingerprintId = safeGetStorageItem(FINGERPRINT_ID_KEY) || '';
    this.cachedIdentityJson = safeGetStorageItem(IDENTITY_SUMMARY_KEY) || '';
    this._fingerprintPromise = null;
  }

  _ensureFingerprintStarted() {
    if (this._fingerprintPromise) return this._fingerprintPromise;

    this._fingerprintPromise = (async () => {
      try {
        const agent = await FingerprintJS.load();
        const result = await agent.get();
        const visitorId = typeof result?.visitorId === 'string' ? result.visitorId : '';
        const identityJson = buildIdentitySummary(visitorId);

        if (visitorId) {
          this.cachedFingerprintId = visitorId;
          safeSetStorageItem(FINGERPRINT_ID_KEY, visitorId);
        }
        if (identityJson) {
          this.cachedIdentityJson = identityJson;
          safeSetStorageItem(IDENTITY_SUMMARY_KEY, identityJson);
        }
      } catch (error) {
        console.warn('[ClientIdentity] Failed to compute fingerprint', error);
      }

      return {
        clientDeviceId: this.deviceId,
        clientFingerprintId: this.cachedFingerprintId,
        clientIdentityJson: this.cachedIdentityJson,
        client_device_id: this.deviceId,
        client_fingerprint_id: this.cachedFingerprintId,
        client_identity_json: this.cachedIdentityJson,
      };
    })();

    return this._fingerprintPromise;
  }

  async getPayload({ waitForFingerprintMs = 0 } = {}) {
    const fallback = {
      clientDeviceId: this.deviceId,
      clientFingerprintId: this.cachedFingerprintId,
      clientIdentityJson: this.cachedIdentityJson,
      client_device_id: this.deviceId,
      client_fingerprint_id: this.cachedFingerprintId,
      client_identity_json: this.cachedIdentityJson,
    };

    const fingerprintPromise = this._ensureFingerprintStarted();
    if (!waitForFingerprintMs || waitForFingerprintMs <= 0) {
      return fallback;
    }

    try {
      return await Promise.race([
        fingerprintPromise,
        new Promise((resolve) => {
          window.setTimeout(() => resolve(fallback), waitForFingerprintMs);
        })
      ]);
    } catch {
      return fallback;
    }
  }
}
