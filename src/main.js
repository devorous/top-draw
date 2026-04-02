/** @fileoverview Lightweight landing bootstrap that background-loads the drawing app. */

import './css/main.scss';

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

let app = null;
let appBootPromise = null;
let deferredActionPromise = null;

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
      dimensions: [1080, 1920],
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

  requestAnimationFrame(() => {
    setTimeout(startBackgroundBoot, 0);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
