/** @fileoverview Orchestrates the setup of all WebSocket message handlers for the application. */

import { setupUserHandlers } from '../handlers/UserHandlers.js';
import { setupChatHandlers } from '../handlers/ChatHandlers.js';
import { setupAuthModHandlers } from '../handlers/AuthModHandlers.js';
import { setupSyncHandlers } from '../handlers/SyncHandlers.js';
import { setupDrawingHandlers } from '../handlers/DrawingHandlers.js';
import { setupSelectionHandlers } from '../handlers/SelectionHandlers.js';
import { setupSnapshotHandlers } from '../handlers/SnapshotHandlers.js';

/**
 * Sets up all WebSocket message handlers for the app.
 * @param {App} app - The main application instance.
 */
export function setupWebSocketHandlers(app) {
  const { wsClient } = app;

  // Handler map for event replay during sync buffering
  const handlerMap = new Map();

  /**
   * Wraps a handler to support event buffering during canvas synchronization.
   * @param {string} eventName - The name of the WebSocket event.
   * @param {Function} handler - The original event handler function.
   */
  function wrapHandler(eventName, handler) {
    handlerMap.set(eventName, handler);
    wsClient.on(eventName, (data) => {
      // Ignore messages from self to prevent double-processing/echo issues.
      // EXCEPTION: 'mu', 'undo', and 'fill' are allowed through to facilitate
      // server-side sequence number reconciliation and global ordering. The
      // 'fill' self branch is reconcile-only (it assigns the authoritative FILL
      // seq to the already-committed local fill stroke; it does NOT recompute or
      // re-draw the fill) — see the 'fill' handler in DrawingHandlers.js.
      const allowSelf = eventName === 'mu' || eventName === 'undo' || eventName === 'fill' || eventName === 'glitch_result';
      if (data && data.sessionIndex === app.sessionIndex && !allowSelf) {
        return;
      }

      if (app.syncClient?.buffering) {
        app.syncClient.bufferEvent(eventName, data);
        return;
      }
      handler(data);
    });
  }

  setupUserHandlers(wsClient, app);
  setupChatHandlers(wsClient, app);
  setupAuthModHandlers(wsClient, app);
  setupSyncHandlers(wsClient, app);
  setupSnapshotHandlers(wsClient, app);

  wsClient.on('global_message', (data) => {
    if (data.kind === 'restart' || data.kind === 'update') {
      app.handleServerUpdateNotice?.(data);
      return;
    }
    app.ui?.showToast?.(data.message, data.persistent ? 8000 : 6000, 'global');
  });

  wsClient.on('floating_art_update', (data) => {
    app.handleFloatingArtUpdate?.(data.item);
  });

  // Setup buffered handlers (all events that modify canvas state)
  setupDrawingHandlers(wrapHandler, app);
  setupSelectionHandlers(wrapHandler, app);

  if (app.syncClient) {
    app.syncClient.setHandlerMap(handlerMap);
  }
}
