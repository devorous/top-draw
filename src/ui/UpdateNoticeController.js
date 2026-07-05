/**
 * @fileoverview Update-notice controller — runtime version checks, "update
 * available/required" banners, server restart notices, and the desktop updater
 * polling loop. State flags (_versionUpdateNoticed, _reloadRecommended,
 * _awaitingServerRestart, …) stay on App because the reconnect flow reads them.
 * Extracted from App.js.
 */

import { compareVersionStrings, formatOutdatedClientMessage, getVersionStatus } from '../VersionChecker.js';
import { isTauriDesktop } from '../platform/desktop.js';
import {
  checkForDesktopUpdates,
  dismissDesktopUpdateForOffline,
  isDesktopUpdateDismissedForOffline
} from '../platform/updater.js';

export class UpdateNoticeController {
  constructor(app) {
    this.app = app;
    this._desktopUpdatePollTimer = null;
    this._desktopUpdatePollActive = false;
  }

  get ui() { return this.app.ui; }

  async checkForRuntimeUpdate({ force = true } = {}) {
    const app = this.app;
    // Keep both desktop and browser clients honest after deploys. Desktop can
    // hand off to the native updater; browser clients need the durable reload
    // banner even when they stayed connected through an update notice.
    // Only run if WebSocket is connected (new server is reachable)
    if (!app.wsClient?.connected) return;
    // Only show the prompt once per restart cycle
    if (app._versionUpdateNoticed) return;
    // This fetch only succeeds if the new server is responding with its version info
    const status = await getVersionStatus({ force });
    if (app._versionUpdateNoticed) return;
    if (status?.allowed === false) {
      app._versionUpdateNoticed = true;
      this.showUpdateRequiredNotice(status);
      return;
    }
    const latest = status?.serverVersion?.latest || status?.latestVersion;
    if (!latest || !status.clientVersion) return;
    // Only prompt when the client is strictly older than the advertised latest.
    // String inequality alone produces false positives (e.g. client 1.6.3-beta
    // vs. server-advertised latest 1.6.2-beta — the client is newer, no update needed).
    const cmp = compareVersionStrings(status.clientVersion, latest);
    if (cmp === null || cmp >= 0) return;
    if (this._isUpdateDismissedForOffline(latest)) return;

    app._versionUpdateNoticed = true;
    this.showUpdateAvailableNotice(status);
  }

  async showUpdateAvailableNotice(versionStatus = {}) {
    const app = this.app;
    const latest = versionStatus.latestVersion || versionStatus.serverVersion?.latest || 'the latest version';
    if (this._isUpdateDismissedForOffline(latest)) return;
    app._versionUpdateNoticed = true;
    app._reloadRecommended = true;
    app._lastUpdateNoticeVersion = latest;
    this.ui.showDisconnectionBanner({
      message: `A new Ddraw version is available (${latest}). Reload to update, or continue offline.`,
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Refresh',
      offlineLabel: 'Continue Offline'
    });

    if (isTauriDesktop()) {
      await this._promptDesktopUpdateFromRuntimeNotice();
    }
  }

  showUpdateRequiredNotice(versionStatus = {}) {
    const app = this.app;
    const latest = versionStatus.latestVersion || versionStatus.serverVersion?.latest || versionStatus.minRequired || '';
    if (this._isUpdateDismissedForOffline(latest)) return;
    app._versionUpdateNoticed = true;
    app._reloadRecommended = true;
    app._lastUpdateNoticeVersion = latest || null;
    this.ui.showToast('Update required before connecting online', 3500, 'error');
    this.ui.showDisconnectionBanner({
      message: `${formatOutdatedClientMessage(versionStatus)} You can still draw offline.`,
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Refresh',
      offlineLabel: 'Continue Offline'
    });

    if (isTauriDesktop() && !versionStatus.desktopUpdateResult) {
      void this._promptDesktopUpdateFromRuntimeNotice({ force: true });
    }
  }

  async handleServerUpdateNotice(data = {}) {
    const app = this.app;
    const latest = data.latestVersion || data.version || data.serverVersion?.latest || '';
    if (data.kind === 'restart') {
      app._awaitingServerRestart = true;
      app._versionUpdateNoticed = false;
      this.ui.showToast(data.message || 'Ddraw server is updating soon', 5000);
      this.ui.showDisconnectionBanner({
        message: data.message || 'Server is updating soon. Keep drawing for now; we will refresh/update once the new server is live.',
        icon: '!',
        retryVisible: false,
        offlineLabel: 'Continue Offline'
      });
      return;
    }

    if (app._versionUpdateNoticed && !app._awaitingServerRestart) return;
    if (this._isUpdateDismissedForOffline(latest)) return;
    app._versionUpdateNoticed = true;
    app._reloadRecommended = true;
    app._lastUpdateNoticeVersion = latest || null;
    this.ui.showToast(data.message || 'Ddraw is updating', 5000);
    this.ui.showDisconnectionBanner({
      message: data.message || 'Ddraw is updating. Reload in a moment, or continue offline.',
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Refresh',
      offlineLabel: 'Continue Offline'
    });

    if (isTauriDesktop()) {
      await this._promptDesktopUpdateFromRuntimeNotice();
    }
  }

  async _promptDesktopUpdateFromRuntimeNotice({ force = false } = {}) {
    if (force && this._desktopUpdatePollTimer) {
      window.clearInterval(this._desktopUpdatePollTimer);
      this._desktopUpdatePollTimer = null;
    }
    if (force) {
      this._desktopUpdatePollActive = false;
    }
    if (this._desktopUpdatePollActive) return;
    this._desktopUpdatePollActive = true;

    const attempt = async ({ silent = true } = {}) => {
      const result = await checkForDesktopUpdates({
        silent,
        ignoreOfflineDismissal: force
      });
      if (!result || result.status === 'up-to-date') {
        return false;
      }
      if (result.status === 'server-not-ready') {
        this.ui.showDisconnectionBanner({
          message: 'Server is updating soon. Keep drawing for now; we will offer the app update once the new server is live.',
          icon: '!',
          retryVisible: false,
          offlineLabel: 'Continue Offline'
        });
        return false;
      }
      if (result.status === 'offline-dismissed') {
        return true;
      }
      if (result.status === 'error') {
        this.ui.showToast('Desktop update check failed. Restart the app to try again.', 4500, 'error');
      }
      return true;
    };

    if (await attempt({ silent: !force })) {
      this._desktopUpdatePollActive = false;
      return;
    }

    this._desktopUpdatePollTimer = window.setInterval(async () => {
      if (await attempt()) {
        window.clearInterval(this._desktopUpdatePollTimer);
        this._desktopUpdatePollTimer = null;
        this._desktopUpdatePollActive = false;
      }
    }, 15000);
  }

  _dismissCurrentUpdateForOffline() {
    const app = this.app;
    const latest = app._lastUpdateNoticeVersion || null;
    if (latest) {
      app._offlineDismissedUpdateVersion = latest;
      if (isTauriDesktop()) {
        dismissDesktopUpdateForOffline(latest);
      }
    }
    app._versionUpdateNoticed = true;
    app._reloadRecommended = false;
    app._awaitingServerRestart = false;
    if (this._desktopUpdatePollTimer) {
      window.clearInterval(this._desktopUpdatePollTimer);
      this._desktopUpdatePollTimer = null;
    }
    this._desktopUpdatePollActive = false;
  }

  _isUpdateDismissedForOffline(version = '') {
    return !!version && (
      this.app._offlineDismissedUpdateVersion === version ||
      (isTauriDesktop() && isDesktopUpdateDismissedForOffline(version))
    );
  }
}
