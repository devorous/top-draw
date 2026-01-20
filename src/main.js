import { DrawingApp } from './App.js';

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', async () => {
  // Get WebSocket server URL from environment or use default
  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;

  const app = new DrawingApp({
    dimensions: [720, 1280],
    serverUrl: wsServerUrl
  });

  try {
    await app.init();
  } catch (err) {
    console.error('Failed to initialize app:', err);
  }

  // Expose app for debugging
  window.app = app;
});
