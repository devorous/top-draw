/** @fileoverview Main entry point for the Top Draw application. Sets up error handling and initializes the DrawingApp. */

import './css/main.scss';
import { DrawingApp } from './App.js';
import initWasm from './wasm/ddraw_wasm.js';

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

/**
 * Initializes the application, sets up the DrawingApp, and handles the loading screen transition.
 * @async
 * @returns {Promise<void>}
 */
async function init() {
  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;
  
  // Keep this let here so it's accessible to window.app at the bottom
  let app; 

  try {

    await initWasm(); 
    console.log("WASM Module Initialized");

    app = new DrawingApp({
      dimensions: [1080, 1920],
      serverUrl: wsServerUrl
    });

    await app.init();

    const loadingScreen = document.getElementById('app-loading-screen');
    const mainContent = document.getElementById('main');
    if (loadingScreen && mainContent) {
      mainContent.style.opacity = '1';
      mainContent.style.transition = 'opacity 0.5s ease-out';
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.remove();
        const styleTag = document.getElementById('initial-loading-style');
        if (styleTag) styleTag.remove();
      }, 500);
    }
  } catch (err) {
    console.error('Failed to initialize app:', err);
    const loadingScreen = document.getElementById('app-loading-screen');
    if (loadingScreen) loadingScreen.remove();
  }

  // Expose app for debugging
  window.app = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
