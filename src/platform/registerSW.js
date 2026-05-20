/** @fileoverview Service worker registration. Skipped on Tauri (uses its own updater). */

import { registerSW } from 'virtual:pwa-register';

export function setupServiceWorker() {
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
  if (isTauri || !('serviceWorker' in navigator)) return;

  registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent('pwa:update-available'));
    },
    onOfflineReady() {
      window.dispatchEvent(new CustomEvent('pwa:offline-ready'));
    },
    onRegisterError(err) {
      console.warn('[pwa] SW registration failed', err);
    },
  });
}
