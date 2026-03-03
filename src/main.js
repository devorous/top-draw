console.log('[main.js] Script loaded!');

// Import SCSS - Vite will compile and inject it
import '../public/css/main.scss';

import { DrawingApp } from './App.js';
console.log('[main.js] Import successful');

async function init() {
  console.log('[main.js] Init function called');
  // Get WebSocket server URL from environment or use default
  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;

  const app = new DrawingApp({
    dimensions: [1080, 1920],
    serverUrl: wsServerUrl
  });

  try {
    await app.init();
  } catch (err) {
    console.error('Failed to initialize app:', err);
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
