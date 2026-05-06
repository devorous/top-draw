/** @fileoverview Pre-join orchestration module. Handles auth + landing page + discovery WS connection. */

import { WebSocketClient } from './network/WebSocketClient.js';
import { Auth } from './auth/Auth.js';
import { LandingPage } from './ui/LandingPage.js';
import { loadAppPreferences } from './config/AppPreferences.js';
import { appState } from './state.svelte.js';

/**
 * Initializes the pre-join landing phase: auth forms + room discovery.
 * Runs early in main.js before the full DrawingApp loads.
 *
 * @param {Object} options
 * @param {Function} [options.onRoomSelected] - Called when user selects a room
 * @param {Function} [options.onOffline] - Called when user enters offline mode
 * @param {string} [options.serverUrl] - WebSocket server URL
 * @returns {Promise<{wsClient, auth, landingPage, appPreferences}>}
 */
export async function initLandingPhase(options = {}) {
  const { onRoomSelected, onOffline, serverUrl } = options;

  // Create a WebSocket client for discovery + auth (shared with DrawingApp later)
  const wsClient = new WebSocketClient({
    serverUrl,
    onConnect: (sessionIndex) => {
      // Connection established, no special action needed here
    },
    onDisconnect: (code, reason) => {
      // Handled by App.js after handoff
    }
  });

  // Create Auth instance
  const auth = new Auth({
    wsClient,
    onSuccess: (token, role, username, globalRole, roomRole) => {
      // Auth success handled by App.js after handoff
    },
    onError: (error) => {
      // Auth error — landing page will show retry option
    },
    onLoggedInStateChange: () => {
      // Update landing page UI if needed
    }
  });

  // Create LandingPage instance
  const landingPage = new LandingPage({
    wsClient,
    auth,
    onRoomSelected: (roomId, password, settings) => {
      onRoomSelected?.(roomId, password, settings);
    },
    onOffline: () => {
      onOffline?.();
    }
  });

  // Initialize auth and landing page
  auth.init();
  landingPage.init();

  // Load and apply preferences
  const appPreferences = loadAppPreferences();
  appState.appPreferences = appPreferences;

  // Connect to discovery room to fetch room list
  wsClient.connect('_discovery');

  return {
    wsClient,
    auth,
    landingPage,
    appPreferences
  };
}
