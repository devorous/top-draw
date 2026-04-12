/** @fileoverview Lightweight landing bootstrap that background-loads the drawing app. */

import './css/main.scss';
import { scheduleStartupUpdateCheck } from './platform/updater.js';

// Auto-reload once when a dynamically imported chunk fails to load (stale cache after deploy)
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.message?.includes('dynamically imported module') ||
      event.reason?.message?.includes('Failed to fetch')) {
    if (!sessionStorage.getItem('chunk-reload')) {
      sessionStorage.setItem('chunk-reload', '1');
      window.location.reload();
    }
  }
});
// Clear the reload flag on successful load
sessionStorage.removeItem('chunk-reload');

const isFirefox = /Firefox\//i.test(navigator.userAgent) && !/Seamonkey\//i.test(navigator.userAgent);

let app = null;
let appBootPromise = null;
let deferredActionPromise = null;
function showFirefoxWarning() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'display:flex;justify-content:center;align-items:center;position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);z-index:99999;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'padding:32px 40px;background:var(--bg-secondary, #1e1e2e);border:1px solid var(--border-subtle, #333);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;max-width:380px;font-family:inherit;color:var(--text-primary, #e0e0e0);';
    dialog.innerHTML = `
      <div style="font-size:36px;margin-bottom:12px;">&#9888;&#65039;</div>
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;">Firefox Performance Warning</h2>
      <p style="margin:0 0 20px;font-size:14px;color:var(--text-secondary, #aaa);line-height:1.5;">
        Firefox will lag a lot with this app!<br>
        Try using a Chromium-based browser for the best experience:<br>
        <strong style="color:var(--text-primary, #e0e0e0);">Chrome, Edge, Brave, Opera</strong>
      </p>
      <button id="firefoxContinueBtn" style="padding:10px 24px;font-size:14px;font-weight:500;background:var(--bg-tertiary, #2a2a3e);color:var(--text-secondary, #aaa);border:1px solid var(--border-subtle, #333);border-radius:8px;cursor:pointer;">
        Continue anyway
      </button>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    document.getElementById('firefoxContinueBtn').addEventListener('click', () => {
      backdrop.remove();
      resolve();
    });
  });
}

function updateShellStatus(status, text) {
  const statusEl = document.getElementById('landingConnectionStatus');
  const textEl = statusEl?.querySelector('.connectionText');
  if (!statusEl || !textEl) return;

  statusEl.classList.remove('connected', 'disconnected', 'connecting');
  statusEl.classList.add(status);
  textEl.textContent = text;
}

function revealLandingShell() {
  const mainContent = document.getElementById('main');
  const loadingScreen = document.getElementById('app-loading-screen');
  const styleTag = document.getElementById('initial-loading-style');
  const overlay = document.getElementById('overlay');
  const landingPage = document.getElementById('landingPage');
  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  const roomIdInput = document.getElementById('roomIdInput');
  const roomMatch = window.location.pathname.match(/^\/go\/([a-zA-Z0-9_-]+)$/);

  if (roomIdInput && roomMatch && roomMatch[1] !== 'offline') {
    roomIdInput.value = roomMatch[1];
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.style.background = 'transparent';
    overlay.style.backdropFilter = 'none';
  }
  if (landingPage) {
    landingPage.style.display = 'flex';
  }
  if (refreshRoomsBtn) {
    refreshRoomsBtn.disabled = true;
    refreshRoomsBtn.classList.add('disabled');
  }

  updateShellStatus('connecting', 'Loading app...');

  if (mainContent) {
    mainContent.style.opacity = '1';
    mainContent.style.transition = 'opacity 0.35s ease-out';
  }
  if (loadingScreen) {
    loadingScreen.style.opacity = '0';
    setTimeout(() => {
      loadingScreen.remove();
      styleTag?.remove();
    }, 350);
  } else {
    styleTag?.remove();
  }
}

async function bootApp() {
  if (app) return app;
  if (appBootPromise) return appBootPromise;

  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;

  appBootPromise = (async () => {
    const [{ DrawingApp }] = await Promise.all([
      import('./App.js'),
    ]);

    const instance = new DrawingApp({
      dimensions: [2160, 1920],
      serverUrl: wsServerUrl
    });

    await instance.init();
    app = instance;
    window.app = app;
    return app;
  })().catch((err) => {
    appBootPromise = null;
    throw err;
  });

  return appBootPromise;
}

function startBackgroundBoot() {
  void bootApp().catch((err) => {
    console.error('Failed to initialize app:', err);
    updateShellStatus('disconnected', 'Failed to load');
  });
}

async function runDeferredAction(action) {
  if (app) {
    await action(app);
    return;
  }

  if (deferredActionPromise) return deferredActionPromise;

  updateShellStatus('connecting', 'Loading app...');

  deferredActionPromise = (async () => {
    const readyApp = await bootApp();
    await action(readyApp);
  })().finally(() => {
    deferredActionPromise = null;
  });

  return deferredActionPromise;
}

function attachDeferredLandingHandlers() {
  const loginForm = document.getElementById('loginForm');
  const loginJoinBtn = document.getElementById('loginJoinBtn');
  const joinBtnLoggedIn = document.getElementById('joinBtnLoggedIn');
  const loginOfflineBtn = document.getElementById('loginOfflineBtn');
  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  const registerBtn = document.getElementById('registerBtn');
  const roomIdInput = document.getElementById('roomIdInput');
  const loginPassword = document.getElementById('loginPassword');

  const runDeferredPrimaryAuthAction = () => {
    const passwordValue = loginPassword?.value;
    if (passwordValue) {
      return runDeferredAction((readyApp) => readyApp.handleLandingLogin());
    }

    return runDeferredAction((readyApp) => readyApp.handleJoin());
  };

  loginForm?.addEventListener('submit', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginJoinBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredPrimaryAuthAction();
  });

  joinBtnLoggedIn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginOfflineBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleOffline());
  });

  refreshRoomsBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.connectForRoomDiscovery());
  });

  registerBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.auth?.showRegisterPanel());
  });

  roomIdInput?.addEventListener('keydown', (event) => {
    if (app || event.key !== 'Enter') return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginPassword?.addEventListener('keydown', (event) => {
    if (app || event.key !== 'Enter') return;
    event.preventDefault();
    void runDeferredPrimaryAuthAction();
  });
}

function init() {
  revealLandingShell();
  attachDeferredLandingHandlers();

  // Open external links in the default browser when running in Tauri
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
  if (isTauri) {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link && link.href) {
        // Resolve the URL to handle relative links correctly
        const url = new URL(link.href, window.location.origin);
        const isExternal = url.origin !== window.location.origin;

        if (isExternal || link.target === '_blank') {
          e.preventDefault();
          e.stopImmediatePropagation();
          
          import('@tauri-apps/plugin-shell').then(({ open }) => {
            open(link.href);
          }).catch(err => {
            console.error('Failed to open external link via Tauri shell:', err);
            // Fallback: only if really needed, but tauri should handle it
            window.open(link.href, '_blank');
          });
        }
      }
    }, true); // Use capture phase to intercept before other handlers
  }

  if (isFirefox) {
    showFirefoxWarning().then(() => {
      requestAnimationFrame(() => setTimeout(startBackgroundBoot, 0));
    });
  } else {
    requestAnimationFrame(() => {
      setTimeout(startBackgroundBoot, 0);
    });
  }

  scheduleStartupUpdateCheck();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
