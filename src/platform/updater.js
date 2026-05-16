import { isTauriDesktop } from './desktop.js';
import { resolveApiUrl } from '../config/serverEndpoints.js';

let startupCheckScheduled = false;
const UPDATER_DISABLED = false;
let updateCheckInFlight = null;
let updateCheckInFlightNeedsForeground = false;
let updateCheckInFlightId = 0;
let mismatchPromptInFlight = null;
let mismatchPrompted = false;
let serverUpdatingSoonPrompted = false;
const AUTO_UPDATE_PREF_KEY = 'desktopAutoUpdates';
const OFFLINE_UPDATE_DISMISSAL_KEY = 'desktopUpdateOfflineDismissedVersion';
const SERVER_VERSION_CHECK_TIMEOUT_MS = 5000;

function formatPublishedDate(rawDate) {
  if (!rawDate) return '';
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString();
}

function getAutoUpdatePreference() {
  try {
    return localStorage.getItem(AUTO_UPDATE_PREF_KEY) === '1';
  } catch (error) {
    console.warn('[Updater] Failed to read auto-update preference:', error);
    return false;
  }
}

function setAutoUpdatePreference(enabled) {
  try {
    localStorage.setItem(AUTO_UPDATE_PREF_KEY, enabled ? '1' : '0');
  } catch (error) {
    console.warn('[Updater] Failed to store auto-update preference:', error);
  }
}

function getServerVersionEndpointUrl() {
  return resolveApiUrl('/api/version');
}

async function fetchServerVersionPolicy() {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => abortController.abort(), SERVER_VERSION_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(getServerVersionEndpointUrl(), {
      cache: 'no-store',
      signal: abortController.signal
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, policy: await response.json() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function confirmServerVersionReady(update) {
  const updateVersion = String(update?.version || '').trim();
  if (!updateVersion) {
    return { ready: false, reason: 'missing-update-version' };
  }

  const server = await fetchServerVersionPolicy();
  if (!server.ok) {
    console.warn('[Updater] Could not verify server version; allowing desktop update check to continue.', server);
    return { ready: true, reason: 'server-version-unavailable', updateVersion, server };
  }

  const serverLatest = String(server.policy?.latest || '').trim();
  const serverMinRequired = String(server.policy?.minRequired || '').trim();
  const serverVersions = [serverLatest, serverMinRequired].filter(Boolean);
  const serverVersion = serverLatest || serverMinRequired;

  if (serverVersions.length && !serverVersions.includes(updateVersion)) {
    return {
      ready: false,
      reason: 'server-version-not-ready',
      updateVersion,
      serverVersion,
      serverPolicy: server.policy
    };
  }

  return { ready: true, updateVersion, serverVersion, serverPolicy: server.policy };
}

function getOfflineUpdateDismissal() {
  try {
    return localStorage.getItem(OFFLINE_UPDATE_DISMISSAL_KEY) || '';
  } catch (error) {
    console.warn('[Updater] Failed to read offline update dismissal:', error);
    return '';
  }
}

export function isDesktopUpdateDismissedForOffline(version = '') {
  return !!version && getOfflineUpdateDismissal() === version;
}

export function dismissDesktopUpdateForOffline(version = '') {
  if (!version) return;
  try {
    localStorage.setItem(OFFLINE_UPDATE_DISMISSAL_KEY, version);
  } catch (error) {
    console.warn('[Updater] Failed to store offline update dismissal:', error);
  }
}

function setLandingJoinDisabled(disabled) {
  const joinButtons = [
    document.getElementById('loginJoinBtn'),
    document.getElementById('joinBtnLoggedIn'),
    document.getElementById('authLoggedInJoinBtn')
  ];

  joinButtons.forEach((btn) => {
    if (!btn) return;
    if (disabled) {
      btn.dataset.prevDisabled = btn.disabled ? '1' : '0';
      btn.disabled = true;
      btn.classList.add('disabled');
    } else {
      const wasDisabled = btn.dataset.prevDisabled === '1';
      btn.disabled = wasDisabled;
      btn.classList.toggle('disabled', wasDisabled);
      delete btn.dataset.prevDisabled;
    }
  });
}

function ensureUpdaterModalStyles() {
  if (document.getElementById('desktopUpdaterModalStyles')) return;

  const style = document.createElement('style');
  style.id = 'desktopUpdaterModalStyles';
  style.textContent = `
    .desktopUpdaterBackdrop {
      position: fixed;
      top: var(--desktop-titlebar-height, 0px);
      right: 0;
      bottom: 0;
      left: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(7, 10, 14, 0.72);
      backdrop-filter: blur(8px);
      z-index: 12000;
      padding: 20px;
    }

    .desktopUpdaterDialog {
      width: min(340px, 100%);
      padding: 22px 22px 20px;
      border-radius: 18px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #00d4aa) 32%, rgba(255, 255, 255, 0.1));
      background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary, #1f2430) 92%, black 8%), color-mix(in srgb, var(--bg-primary, #161b24) 95%, black 5%));
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
      color: var(--text-primary, #f3f5f7);
      font-family: inherit;
      text-align: center;
    }

    .desktopUpdaterSpinnerWrap {
      width: 56px;
      height: 56px;
      margin: 0 auto 12px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--accent-primary, #00d4aa) 14%, transparent);
    }

    .desktopUpdaterSpinner {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 3px solid color-mix(in srgb, var(--accent-primary, #00d4aa) 32%, transparent);
      border-top-color: var(--accent-primary, #00d4aa);
      animation: desktopUpdaterSpin 0.8s linear infinite;
      will-change: transform;
    }

    @keyframes desktopUpdaterSpin {
      to { transform: rotate(360deg); }
    }

    .desktopUpdaterTitle {
      margin: 0;
      font-size: 22px;
      line-height: 1.15;
    }

    .desktopUpdaterCopy {
      margin: 10px 0 0;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-secondary, #c1c6cd);
    }

    .desktopUpdaterStatus {
      margin-top: 10px;
      min-height: 20px;
      font-size: 13px;
      color: var(--text-muted, #8b93a1);
    }

    .desktopUpdaterDialog.isError .desktopUpdaterSpinner {
      animation: none;
      border-color: color-mix(in srgb, #ff6d6d 35%, transparent);
      border-top-color: #ff6d6d;
    }

    .desktopUpdaterActions {
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-top: 16px;
    }

    .desktopUpdaterButton {
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #00d4aa) 40%, transparent);
      background: color-mix(in srgb, var(--accent-primary, #00d4aa) 18%, transparent);
      color: var(--text-primary, #f3f5f7);
      font-size: 13px;
      cursor: pointer;
    }

    .desktopUpdaterButton.secondary {
      border-color: color-mix(in srgb, var(--text-muted, #8b93a1) 40%, transparent);
      background: transparent;
      color: var(--text-secondary, #c1c6cd);
    }

    .desktopUpdaterToggle {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-muted, #8b93a1);
    }

    .desktopUpdaterToggle input {
      accent-color: var(--accent-primary, #00d4aa);
    }
  `;

  document.head.appendChild(style);
}

function showDesktopUpdaterProgress(update) {
  ensureUpdaterModalStyles();
  const backdrop = document.createElement('div');
  backdrop.className = 'desktopUpdaterBackdrop';

  const dialog = document.createElement('div');
  dialog.className = 'desktopUpdaterDialog';

  const publishedDate = formatPublishedDate(update.date);
  dialog.innerHTML = `
    <div class="desktopUpdaterSpinnerWrap" aria-hidden="true">
      <div class="desktopUpdaterSpinner"></div>
    </div>
    <h2 class="desktopUpdaterTitle">Updating Ddraw</h2>
    <p class="desktopUpdaterCopy">Installing ${update.version} ${publishedDate ? `(${publishedDate})` : ''}</p>
    <div class="desktopUpdaterStatus" aria-live="polite">Downloading update package...</div>
  `;

  const statusEl = dialog.querySelector('.desktopUpdaterStatus');
  const copyEl = dialog.querySelector('.desktopUpdaterCopy');

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  return {
    setStatus(message) {
      if (statusEl) statusEl.textContent = message;
    },
    setCopy(message) {
      if (copyEl) copyEl.textContent = message;
    },
    setError(message) {
      dialog.classList.add('isError');
      if (statusEl) statusEl.textContent = message;
    },
    close() {
      backdrop.remove();
    }
  };
}

function showDesktopUpdatePrompt(update) {
  ensureUpdaterModalStyles();
  const backdrop = document.createElement('div');
  backdrop.className = 'desktopUpdaterBackdrop';

  const dialog = document.createElement('div');
  dialog.className = 'desktopUpdaterDialog';

  const publishedDate = formatPublishedDate(update.date);
  const autoUpdatesEnabled = getAutoUpdatePreference();
  dialog.innerHTML = `
    <div class="desktopUpdaterSpinnerWrap" aria-hidden="true">
      <div class="desktopUpdaterSpinner"></div>
    </div>
    <h2 class="desktopUpdaterTitle">Update Ready</h2>
    <p class="desktopUpdaterCopy">Install ${update.version} ${publishedDate ? `(${publishedDate})` : ''} now?</p>
    <div class="desktopUpdaterStatus" aria-live="polite">The app will restart after updating.</div>
    <div class="desktopUpdaterActions">
      <button class="desktopUpdaterButton" data-action="install">Install Update</button>
      <button class="desktopUpdaterButton secondary" data-action="offline">Draw Offline</button>
    </div>
    <label class="desktopUpdaterToggle">
      <input type="checkbox" data-role="auto-updates" ${autoUpdatesEnabled ? 'checked' : ''}>
      Automatically install updates
    </label>
  `;

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  setLandingJoinDisabled(true);

  return new Promise((resolve) => {
    const cleanup = () => {
      backdrop.remove();
      setLandingJoinDisabled(false);
    };

    const handleClick = (event) => {
      const action = event.target?.getAttribute('data-action');
      if (!action) return;
      cleanup();
      resolve(action === 'install' ? 'install' : 'offline');
    };

    const toggle = dialog.querySelector('[data-role="auto-updates"]');
    if (toggle) {
      toggle.addEventListener('change', (event) => {
        setAutoUpdatePreference(event.target?.checked === true);
      });
    }

    dialog.addEventListener('click', handleClick);
  });
}

function showDesktopServerUpdatingSoon(update, serverStatus = {}) {
  ensureUpdaterModalStyles();
  const backdrop = document.createElement('div');
  backdrop.className = 'desktopUpdaterBackdrop';

  const dialog = document.createElement('div');
  dialog.className = 'desktopUpdaterDialog';

  const updateVersion = String(update?.version || '').trim() || 'the next version';
  const serverVersion = String(serverStatus.serverVersion || '').trim();
  dialog.innerHTML = `
    <div class="desktopUpdaterSpinnerWrap" aria-hidden="true">
      <div class="desktopUpdaterSpinner"></div>
    </div>
    <h2 class="desktopUpdaterTitle">Server Updating Soon</h2>
    <p class="desktopUpdaterCopy">App update ${updateVersion} is ready, but the server ${serverVersion ? `is still on ${serverVersion}` : 'is not ready yet'}.</p>
    <div class="desktopUpdaterStatus" aria-live="polite">Keep drawing for now. We will offer the update once the new server is live.</div>
    <div class="desktopUpdaterActions">
      <button class="desktopUpdaterButton" data-action="ok">OK</button>
    </div>
  `;

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  return new Promise((resolve) => {
    dialog.addEventListener('click', (event) => {
      if (event.target?.getAttribute('data-action') !== 'ok') return;
      backdrop.remove();
      resolve();
    });
  });
}

export async function checkForDesktopUpdates({ silent = false, ignoreOfflineDismissal = false } = {}) {
  if (!isTauriDesktop()) {
    return { status: 'not-desktop' };
  }

  if (UPDATER_DISABLED) {
    if (!silent) {
      console.info('[Updater] Desktop updater is temporarily disabled.');
    }

    return { status: 'disabled' };
  }

  const needsForeground = !silent || ignoreOfflineDismissal;
  if (updateCheckInFlight && (!needsForeground || updateCheckInFlightNeedsForeground)) {
    return updateCheckInFlight;
  }

  updateCheckInFlightNeedsForeground = needsForeground;
  const requestId = ++updateCheckInFlightId;
  updateCheckInFlight = runDesktopUpdateCheck({ silent, ignoreOfflineDismissal });

  try {
    return await updateCheckInFlight;
  } finally {
    if (requestId === updateCheckInFlightId) {
      updateCheckInFlight = null;
      updateCheckInFlightNeedsForeground = false;
    }
  }
}

async function runDesktopUpdateCheck({ silent = false, ignoreOfflineDismissal = false } = {}) {
  try {
    const [{ invoke }, { relaunch }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-process')
    ]);

    const update = await invoke('fetch_update');
    if (!update) {
      return { status: 'up-to-date' };
    }

    if (update.version && !ignoreOfflineDismissal && getOfflineUpdateDismissal() === update.version) {
      return { status: 'offline-dismissed', version: update.version };
    }

    const serverReady = await confirmServerVersionReady(update);
    if (!serverReady.ready) {
      if (!silent && !serverUpdatingSoonPrompted) {
        serverUpdatingSoonPrompted = true;
        await showDesktopServerUpdatingSoon(update, serverReady);
      }
      return {
        status: 'server-not-ready',
        version: update.version,
        reason: serverReady.reason,
        serverVersion: serverReady.serverVersion || ''
      };
    }
    serverUpdatingSoonPrompted = false;

    if (getAutoUpdatePreference()) {
      const updaterProgress = showDesktopUpdaterProgress(update);
      updaterProgress.setStatus('Installing update... The app will restart when it finishes.');

      try {
        await invoke('install_update');
        updaterProgress.setCopy(`Update ${update.version} installed.`);
        updaterProgress.setStatus('Restarting app...');
        window.setTimeout(() => updaterProgress.close(), 250);
        await relaunch();
        return { status: 'installed', version: update.version, auto: true };
      } catch (installError) {
        updaterProgress.setError('Update failed. Please try again in a moment.');
        window.setTimeout(() => updaterProgress.close(), 2000);
        return {
          status: 'error',
          error: installError instanceof Error ? installError.message : String(installError)
        };
      }
    }

    const choice = await showDesktopUpdatePrompt(update);
    if (choice === 'offline') {
      dismissDesktopUpdateForOffline(update.version);
      document.getElementById('loginOfflineBtn')?.click();
      if (window.app?.handleOffline) {
        void window.app.handleOffline();
      }
      return { status: 'offline', version: update.version };
    }

    const updaterProgress = showDesktopUpdaterProgress(update);
    updaterProgress.setStatus('Installing update... The app will restart when it finishes.');

    try {
      await invoke('install_update');
      updaterProgress.setCopy(`Update ${update.version} installed.`);
      updaterProgress.setStatus('Restarting app...');
      window.setTimeout(() => updaterProgress.close(), 250);
      await relaunch();
      return { status: 'installed', version: update.version };
    } catch (installError) {
      updaterProgress.setError('Update failed. Please try again in a moment.');
      window.setTimeout(() => updaterProgress.close(), 2000);
      return {
        status: 'error',
        error: installError instanceof Error ? installError.message : String(installError)
      };
    }
  } catch (error) {
    if (!silent) {
      console.warn('[Updater] Desktop update check failed:', error);
    }

    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function scheduleStartupUpdateCheck() {
  if (UPDATER_DISABLED || startupCheckScheduled || !isTauriDesktop()) {
    return;
  }

  startupCheckScheduled = true;
  window.setTimeout(() => {
    void checkForDesktopUpdates({ silent: true });
  }, 4000);
}

/**
 * Trigger a one-time desktop update check when server version policy rejects the client.
 * This avoids relying only on the delayed silent startup check for mismatch cases.
 */
export async function promptUpdateForVersionMismatch({ force = false } = {}) {
  if (UPDATER_DISABLED || (!force && mismatchPrompted) || !isTauriDesktop()) {
    return { status: 'skipped' };
  }

  if (mismatchPromptInFlight) {
    return mismatchPromptInFlight;
  }

  mismatchPromptInFlight = (async () => {
    const result = await checkForDesktopUpdates({
      silent: false,
      ignoreOfflineDismissal: true
    });
    if (result?.status !== 'error') {
      mismatchPrompted = true;
    }
    mismatchPromptInFlight = null;
    return result;
  })();

  return mismatchPromptInFlight;
}
