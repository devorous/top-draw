import { isTauriDesktop } from './desktop.js';

let startupCheckScheduled = false;
const UPDATER_DISABLED = true;

function formatUpdatePrompt(update) {
  const parts = [`A new desktop build is available: ${update.currentVersion} -> ${update.version}.`];

  if (update.date) {
    parts.push(`Published: ${new Date(update.date).toLocaleString()}`);
  }

  if (typeof update.body === 'string' && update.body.trim()) {
    parts.push(update.body.trim());
  }

  parts.push('Install now? The app will restart after the update is applied.');
  return parts.join('\n\n');
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

    const shouldInstall = window.confirm(formatUpdatePrompt(update));
    if (!shouldInstall) {
      return { status: 'deferred', version: update.version };
    }

    await invoke('install_update');
    window.alert(`Version ${update.version} is installed. The app will restart now.`);
    await relaunch();
    return { status: 'installed', version: update.version };
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
