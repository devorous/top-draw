import { isTauriDesktop } from './desktop.js';

let startupCheckScheduled = false;
const UPDATER_DISABLED = false;
let updateCheckInFlight = null;
let mismatchPromptInFlight = null;
let mismatchPrompted = false;

function formatPublishedDate(rawDate) {
  if (!rawDate) return '';
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString();
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

export async function checkForDesktopUpdates({ silent = false } = {}) {
  if (!isTauriDesktop()) {
    return { status: 'not-desktop' };
  }

  if (UPDATER_DISABLED) {
    if (!silent) {
      console.info('[Updater] Desktop updater is temporarily disabled.');
    }

    return { status: 'disabled' };
  }

  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }

  updateCheckInFlight = runDesktopUpdateCheck({ silent });

  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

async function runDesktopUpdateCheck({ silent = false } = {}) {
  try {
    const [{ invoke }, { relaunch }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-process')
    ]);

    const update = await invoke('fetch_update');
    if (!update) {
      return { status: 'up-to-date' };
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
export async function promptUpdateForVersionMismatch() {
  if (UPDATER_DISABLED || mismatchPrompted || !isTauriDesktop()) {
    return { status: 'skipped' };
  }

  if (mismatchPromptInFlight) {
    return mismatchPromptInFlight;
  }

  mismatchPromptInFlight = (async () => {
    const result = await checkForDesktopUpdates({ silent: false });
    mismatchPrompted = true;
    mismatchPromptInFlight = null;
    return result;
  })();

  return mismatchPromptInFlight;
}
