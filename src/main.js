// Import SCSS - Vite will compile and inject it
import '../public/css/main.scss';

import { DrawingApp } from './App.js';

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

async function init() {
  // Get WebSocket server URL from environment or use default
  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;

  const app = new DrawingApp({
    dimensions: [1080, 1920],
    serverUrl: wsServerUrl
  });

  try {
    await app.init();

    // Dismiss loading screen and show main app
    const loadingScreen = document.getElementById('app-loading-screen');
    const mainContent = document.getElementById('main');
    if (loadingScreen && mainContent) {
      mainContent.style.opacity = '1';
      mainContent.style.transition = 'opacity 0.5s ease-out';
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.remove();
        // Remove initial inline style tag to avoid potential conflicts
        const styleTag = document.getElementById('initial-loading-style');
        if (styleTag) styleTag.remove();
      }, 500);
    }
  } catch (err) {
    console.error('Failed to initialize app:', err);
    // Even on error, hide loading so user can potentially see error message or UI
    const loadingScreen = document.getElementById('app-loading-screen');
    if (loadingScreen) loadingScreen.remove();
  }

  // Expose app for debugging
  window.app = app;
}

// Handle both already-loaded and loading states
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded (e.g., with type="module" deferred)
  init();
}
