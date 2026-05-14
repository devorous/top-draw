/** @fileoverview Version checking and outdated client detection. */

import { isTauriDesktop } from './platform/desktop.js';
import { promptUpdateForVersionMismatch } from './platform/updater.js';

let cachedVersionStatus = null;
let versionStatusPromise = null;
let shownWarningKey = null;
const VERSION_CHECK_TIMEOUT_MS = 5000;

function getVersionEndpointUrl() {
  const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (isTauriDesktop() && configuredApiBase) {
    return `${configuredApiBase}/api/version`;
  }
  const wsServerUrl = String(import.meta.env.VITE_WS_SERVER_URL || '').trim();
  if (wsServerUrl) {
    try {
      const parsed = new URL(wsServerUrl, window.location.href);
      const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      return `${protocol}//${parsed.host}/api/version`;
    } catch (error) {
      console.warn('[VersionChecker] Failed to parse VITE_WS_SERVER_URL:', error);
    }
  }
  return '/api/version';
}

function isLocalDevWithoutVersionEndpoint() {
  const host = window.location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocalHost) return false;

  return !String(import.meta.env.VITE_API_BASE_URL || '').trim() &&
    !String(import.meta.env.VITE_WS_SERVER_URL || '').trim();
}

function formatReleaseDate(releaseDate) {
  if (!releaseDate) return '';
  const parsed = new Date(releaseDate);
  if (Number.isNaN(parsed.getTime())) {
    return String(releaseDate);
  }
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  });
}

/**
 * Parse a version string into { major, minor, patch, prerelease }
 * Supports semver: "1.2.3", "1.2.3-beta", "1.2.0-beta.1", etc.
 */
function parseVersion(versionStr) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(versionStr || ''));
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  };
}

/**
 * Compare two version strings.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b, or null if either is unparseable.
 */
export function compareVersionStrings(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return compareVersions(pa, pb);
}

/**
 * Compare two parsed versions.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // Stable versions come after prerelease
  const aIsStable = a.prerelease === null;
  const bIsStable = b.prerelease === null;

  if (aIsStable && !bIsStable) return 1;
  if (!aIsStable && bIsStable) return -1;

  // Both stable or both prerelease
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1; // a is stable, b is prerelease
  if (!b.prerelease) return -1; // b is stable, a is prerelease

  // Compare prerelease strings lexicographically
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

function buildVersionStatus(serverVersion, clientVersion) {
  if (!clientVersion || !serverVersion?.minRequired) {
    return { allowed: true, reason: 'missing-version-info', clientVersion, serverVersion };
  }

  const clientParsed = parseVersion(clientVersion);
  const minParsed = parseVersion(serverVersion.minRequired);

  if (!clientParsed || !minParsed) {
    console.warn('[VersionChecker] Invalid version format');
    return { allowed: true, reason: 'invalid-version-format', clientVersion, serverVersion };
  }

  const isCompatible = compareVersions(clientParsed, minParsed) >= 0;
  const latestVersion = String(serverVersion.latest || '').trim();
  if (isCompatible && latestVersion && clientVersion !== latestVersion) {
    return {
      allowed: false,
      reason: 'version-mismatch',
      clientVersion,
      latestVersion,
      minRequired: serverVersion.minRequired,
      releaseDate: serverVersion.releaseDate,
      notes: serverVersion.notes,
      downloadUrl: serverVersion.downloadUrl,
      serverVersion
    };
  }

  if (isCompatible) {
    return { allowed: true, reason: 'compatible', clientVersion, serverVersion };
  }

  return {
    allowed: false,
    reason: 'outdated-client',
    clientVersion,
    latestVersion: serverVersion.latest,
    minRequired: serverVersion.minRequired,
    releaseDate: serverVersion.releaseDate,
    notes: serverVersion.notes,
    downloadUrl: serverVersion.downloadUrl,
    serverVersion
  };
}

/**
 * Fetch and compare client/server versions, with a small in-memory cache.
 */
export async function getVersionStatus({ force = false } = {}) {
  if (!force && cachedVersionStatus) {
    return cachedVersionStatus;
  }

  if (!force && versionStatusPromise) {
    return versionStatusPromise;
  }

  versionStatusPromise = (async () => {
    const clientVersion = window.APP_VERSION;

    if (!navigator.onLine) {
      return {
        allowed: true,
        reason: 'offline',
        clientVersion
      };
    }

    if (isLocalDevWithoutVersionEndpoint()) {
      return {
        allowed: true,
        reason: 'local-dev',
        clientVersion
      };
    }

    let status;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), VERSION_CHECK_TIMEOUT_MS);
    const endpointUrl = getVersionEndpointUrl();
    try {
      const response = await fetch(endpointUrl, {
        cache: 'no-store',
        signal: abortController.signal
      });
      if (!response.ok) {
        console.warn('[VersionChecker] Server version check failed:', response.status);
        status = {
          allowed: true,
          reason: 'version-endpoint-unavailable',
          clientVersion,
          httpStatus: response.status
        };
      } else {
        const serverVersion = await response.json();
        status = buildVersionStatus(serverVersion, clientVersion);
      }
    } catch (err) {
      console.warn('[VersionChecker] Failed to check version:', err);
      status = {
        allowed: true,
        reason: 'version-check-failed',
        clientVersion,
        error: err
      };
    } finally {
      clearTimeout(timeoutId);
    }

    cachedVersionStatus = status;
    versionStatusPromise = null;
    return status;
  })();

  return versionStatusPromise;
}

/**
 * Check if client version is supported by the server.
 * Returns null if compatible, or an object with version info if outdated.
 */
export async function checkVersionCompatibility() {
  try {
    const status = await getVersionStatus();
    return status.allowed ? null : status;
  } catch (err) {
    console.warn('[VersionChecker] Failed to check version:', err);
    return null;
  }
}

/**
 * Show an outdated client warning modal.
 * Allows user to dismiss and continue with offline drawing.
 */
export function showOutdatedClientWarning(versionInfo) {
  // Desktop uses the dedicated updater prompt in src/platform/updater.js.
  // Skip this legacy red warning modal to avoid duplicate update dialogs.
  if (isTauriDesktop()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      display: flex;
      justify-content: center;
      align-items: center;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      z-index: 99999;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      padding: 32px 40px;
      background: var(--bg-secondary, #1e1e2e);
      border: 1px solid var(--border-error, #d32f2f);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      max-width: 420px;
      font-family: inherit;
      color: var(--text-primary, #e0e0e0);
    `;

    const heading = document.createElement('h2');
    heading.style.cssText = 'margin: 0 0 12px; font-size: 20px; font-weight: 600; color: #d32f2f;';
    heading.textContent = '⚠️ Client Outdated';

    const body = document.createElement('div');
    body.style.cssText = 'margin: 0 0 20px; font-size: 14px; color: var(--text-secondary, #aaa); line-height: 1.6;';
    body.innerHTML = `
      <p><strong>Your client version is outdated.</strong></p>
      <p style="margin: 8px 0 0;">
        <strong>Your version:</strong> ${versionInfo.clientVersion}<br>
        <strong>Latest version:</strong> ${versionInfo.latestVersion}<br>
        <strong>Minimum required:</strong> ${versionInfo.minRequired}
      </p>
      ${versionInfo.releaseDate ? `<p style="margin: 8px 0 0; font-size: 12px; color: var(--text-muted, #888);">Released: ${formatReleaseDate(versionInfo.releaseDate)}</p>` : ''}
      ${versionInfo.notes ? `<p style="margin: 12px 0 0; padding: 8px; background: rgba(211, 47, 47, 0.1); border-radius: 4px; font-size: 13px;">${versionInfo.notes}</p>` : ''}
      <p style="margin: 12px 0 0;">Refresh the page to load the latest version. You can still draw offline, but you won't be able to connect to rooms.</p>
    `;

    const refreshBtn = document.createElement('button');
    refreshBtn.style.cssText = `
      display: inline-block;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 500;
      background: #d32f2f;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 8px;
    `;
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => {
      window.location.reload();
    });

    const continueBtn = document.createElement('button');
    continueBtn.style.cssText = `
      display: inline-block;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 500;
      background: var(--bg-tertiary, #2a2a3e);
      color: var(--text-secondary, #aaa);
      border: 1px solid var(--border-subtle, #333);
      border-radius: 6px;
      cursor: pointer;
    `;
    continueBtn.textContent = 'Continue Offline';
    continueBtn.addEventListener('click', () => {
      backdrop.remove();
      resolve();
    });

    dialog.appendChild(heading);
    dialog.appendChild(body);
    dialog.appendChild(refreshBtn);
    dialog.appendChild(continueBtn);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
  });
}

export function formatOutdatedClientMessage(versionInfo) {
  if (!versionInfo || versionInfo.allowed !== false) {
    return 'This client is out of date. Update to continue online.';
  }

  const latest = versionInfo.latestVersion || 'the latest release';
  const minimum = versionInfo.minRequired || latest;
  if (versionInfo.reason === 'version-mismatch') {
    return `This client version (${versionInfo.clientVersion || 'unknown'}) does not match the server. Refresh or update to ${latest} to connect.`;
  }
  return `This client is out of date (${versionInfo.clientVersion || 'unknown'}). Update to ${latest} to connect. Minimum supported version is ${minimum}.`;
}

export async function ensureClientCanConnect({ showWarning = true } = {}) {
  const status = await getVersionStatus();
  if (status.allowed) {
    return status;
  }

  if (isTauriDesktop()) {
    try {
      await promptUpdateForVersionMismatch();
    } catch (err) {
      console.warn('[VersionChecker] Failed to prompt desktop updater on mismatch:', err);
    }
  }

  const warningKey = `${status.clientVersion || 'unknown'}->${status.minRequired || 'unknown'}`;
  if (showWarning && shownWarningKey !== warningKey) {
    shownWarningKey = warningKey;
    await showOutdatedClientWarning(status);
  }

  return status;
}

