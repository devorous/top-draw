/** @fileoverview Version checking and outdated client detection. */

import { isTauriDesktop } from './platform/desktop.js';

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

/**
 * Check if client version is supported by the server.
 * Returns null if compatible, or an object with version info if outdated.
 */
export async function checkVersionCompatibility() {
  try {
    // Fetch server's version requirements
    const response = await fetch('/api/version');
    if (!response.ok) {
      console.warn('[VersionChecker] Server version check failed:', response.status);
      return null;
    }

    const serverVersion = await response.json();
    const clientVersion = window.APP_VERSION;

    if (!clientVersion || !serverVersion.minRequired) {
      console.warn('[VersionChecker] Missing version info');
      return null;
    }

    const clientParsed = parseVersion(clientVersion);
    const minParsed = parseVersion(serverVersion.minRequired);

    if (!clientParsed || !minParsed) {
      console.warn('[VersionChecker] Invalid version format');
      return null;
    }

    const isCompatible = compareVersions(clientParsed, minParsed) >= 0;

    if (isCompatible) {
      console.info('[VersionChecker] Client version is compatible', {
        client: clientVersion,
        minRequired: serverVersion.minRequired
      });
      return null;
    }

    return {
      clientVersion,
      latestVersion: serverVersion.latest,
      minRequired: serverVersion.minRequired,
      releaseDate: serverVersion.releaseDate,
      notes: serverVersion.notes,
      downloadUrl: serverVersion.downloadUrl
    };
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
      ${versionInfo.releaseDate ? `<p style="margin: 8px 0 0; font-size: 12px; color: var(--text-muted, #888);">Released: ${versionInfo.releaseDate}</p>` : ''}
      ${versionInfo.notes ? `<p style="margin: 12px 0 0; padding: 8px; background: rgba(211, 47, 47, 0.1); border-radius: 4px; font-size: 13px;">${versionInfo.notes}</p>` : ''}
      <p style="margin: 12px 0 0;">You can still draw offline, but you won't be able to connect to rooms.</p>
    `;

    const downloadBtn = document.createElement('button');
    downloadBtn.style.cssText = `
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
    downloadBtn.textContent = 'Download Latest';
    downloadBtn.addEventListener('click', () => {
      if (versionInfo.downloadUrl) {
        window.open(versionInfo.downloadUrl, '_blank');
      }
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
    dialog.appendChild(downloadBtn);
    dialog.appendChild(continueBtn);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
  });
}

/**
 * Initialize version checking and show warning if needed.
 */
export async function initializeVersionCheck() {
  // Only do network checks if connected to internet
  if (!navigator.onLine) {
    console.info('[VersionChecker] Offline mode - skipping version check');
    return;
  }

  const outdatedInfo = await checkVersionCompatibility();
  if (outdatedInfo) {
    await showOutdatedClientWarning(outdatedInfo);
  }
}
