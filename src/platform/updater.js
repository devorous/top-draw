import { isTauriDesktop } from './desktop.js';

let startupCheckScheduled = false;
const UPDATER_DISABLED = false;
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
      width: min(460px, 100%);
      padding: 28px 28px 24px;
      border-radius: 18px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #00d4aa) 32%, rgba(255, 255, 255, 0.1));
      background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary, #1f2430) 92%, black 8%), color-mix(in srgb, var(--bg-primary, #161b24) 95%, black 5%));
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
      color: var(--text-primary, #f3f5f7);
      font-family: inherit;
    }

    .desktopUpdaterEyebrow {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent-primary, #00d4aa);
    }

    .desktopUpdaterTitle {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.15;
    }

    .desktopUpdaterCopy {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-secondary, #c1c6cd);
    }

    .desktopUpdaterMeta {
      margin: 16px 0 0;
      padding: 14px 16px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--bg-tertiary, #252b36) 88%, black 12%);
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
    }

    .desktopUpdaterMetaRow {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      font-size: 13px;
      color: var(--text-secondary, #c1c6cd);
    }

    .desktopUpdaterMetaRow + .desktopUpdaterMetaRow {
      margin-top: 8px;
    }

    .desktopUpdaterMetaLabel {
      color: var(--text-muted, #8b93a1);
    }

    .desktopUpdaterNotes {
      margin: 16px 0 0;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(0, 212, 170, 0.08);
      border: 1px solid rgba(0, 212, 170, 0.18);
      font-size: 13px;
      line-height: 1.55;
      color: var(--text-secondary, #d1d7dd);
      white-space: pre-wrap;
    }

    .desktopUpdaterActions {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }

    .desktopUpdaterBtn {
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 12px 18px;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.16s ease, opacity 0.16s ease, background 0.16s ease;
    }

    .desktopUpdaterBtn:hover {
      transform: translateY(-1px);
    }

    .desktopUpdaterBtn:disabled {
      opacity: 0.6;
      cursor: progress;
      transform: none;
    }

    .desktopUpdaterBtnPrimary {
      flex: 1;
      background: linear-gradient(135deg, var(--accent-primary, #00d4aa), color-mix(in srgb, var(--accent-primary, #00d4aa) 70%, white 30%));
      color: #061317;
    }

    .desktopUpdaterBtnSecondary {
      background: color-mix(in srgb, var(--bg-tertiary, #252b36) 88%, white 12%);
      color: var(--text-primary, #f3f5f7);
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
    }

    .desktopUpdaterStatus {
      margin-top: 14px;
      min-height: 20px;
      font-size: 13px;
      color: var(--text-muted, #8b93a1);
    }

    .desktopUpdaterDialog.isInstalling .desktopUpdaterBtn {
      pointer-events: none;
    }

    .desktopUpdaterDialog.isInstalling .desktopUpdaterBtnPrimary {
      opacity: 0.72;
    }
  `;

  document.head.appendChild(style);
}

function promptForDesktopUpdate(update) {
  ensureUpdaterModalStyles();

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'desktopUpdaterBackdrop';

    const dialog = document.createElement('div');
    dialog.className = 'desktopUpdaterDialog';

    const publishedDate = formatPublishedDate(update.date);
    const notes = typeof update.notes === 'string' ? update.notes.trim() : '';

    dialog.innerHTML = `
      <p class="desktopUpdaterEyebrow">Desktop Update Ready</p>
      <h2 class="desktopUpdaterTitle">Update ${update.currentVersion} to ${update.version}</h2>
      <p class="desktopUpdaterCopy">A newer desktop build is available. You can keep drawing offline for now, but room joining will stay blocked until the app version is approved by the server.</p>
      <div class="desktopUpdaterMeta">
        <div class="desktopUpdaterMetaRow">
          <span class="desktopUpdaterMetaLabel">Installed</span>
          <strong>${update.currentVersion}</strong>
        </div>
        <div class="desktopUpdaterMetaRow">
          <span class="desktopUpdaterMetaLabel">Available</span>
          <strong>${update.version}</strong>
        </div>
        ${publishedDate ? `
        <div class="desktopUpdaterMetaRow">
          <span class="desktopUpdaterMetaLabel">Published</span>
          <strong>${publishedDate}</strong>
        </div>` : ''}
      </div>
      ${notes ? `<div class="desktopUpdaterNotes">${notes}</div>` : ''}
      <div class="desktopUpdaterActions">
        <button type="button" class="desktopUpdaterBtn desktopUpdaterBtnSecondary" data-action="later">Draw Offline</button>
        <button type="button" class="desktopUpdaterBtn desktopUpdaterBtnPrimary" data-action="install">Update Now</button>
      </div>
      <div class="desktopUpdaterStatus" aria-live="polite"></div>
    `;

    const statusEl = dialog.querySelector('.desktopUpdaterStatus');
    const laterBtn = dialog.querySelector('[data-action="later"]');
    const installBtn = dialog.querySelector('[data-action="install"]');

    function close() {
      backdrop.remove();
    }

    laterBtn.addEventListener('click', () => {
      close();
      resolve({ action: 'later' });
    });

    installBtn.addEventListener('click', () => {
      resolve({ action: 'install', statusEl, installBtn, laterBtn, dialog, close });
    });

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
  });
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

  try {
    const [{ invoke }, { relaunch }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-process')
    ]);

    const update = await invoke('fetch_update');
    if (!update) {
      return { status: 'up-to-date' };
    }

    const promptResult = await promptForDesktopUpdate(update);
    if (promptResult.action !== 'install') {
      return { status: 'deferred', version: update.version };
    }

    promptResult.dialog.classList.add('isInstalling');
    promptResult.installBtn.disabled = true;
    promptResult.laterBtn.disabled = true;
    promptResult.statusEl.textContent = 'Installing update... The app will restart when it finishes.';

    try {
      await invoke('install_update');
      await relaunch();
      return { status: 'installed', version: update.version };
    } catch (installError) {
      promptResult.dialog.classList.remove('isInstalling');
      promptResult.installBtn.disabled = false;
      promptResult.laterBtn.disabled = false;
      promptResult.statusEl.textContent = 'Update failed. Please try again in a moment.';
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
