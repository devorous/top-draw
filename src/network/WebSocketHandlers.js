import { setupUserHandlers } from '../handlers/UserHandlers.js';
import { setupChatHandlers } from '../handlers/ChatHandlers.js';
import { setupAuthModHandlers } from '../handlers/AuthModHandlers.js';
import { setupSyncHandlers } from '../handlers/SyncHandlers.js';
import { setupDrawingHandlers } from '../handlers/DrawingHandlers.js';
import { setupSelectionHandlers } from '../handlers/SelectionHandlers.js';

/**
 * Sets up all WebSocket message handlers for the app
 *
 * Handlers are organized into feature modules:
 * - UserHandlers: user lifecycle, settings, cursor visibility
 * - ChatHandlers: messages, DMs, images
 * - AuthModHandlers: authentication, moderation
 * - SyncHandlers: canvas synchronization
 * - DrawingHandlers: mouse, tools, properties (buffered)
 * - SelectionHandlers: selection operations (buffered)
 */
export function setupWebSocketHandlers(app) {
  const { wsClient } = app;

  // Handler map for event replay during sync buffering
  const handlerMap = new Map();

  /**
   * Wrap a handler so that during sync buffering, events are queued
   * instead of processed immediately. The handlerMap stores the original
   * handler so replayBuffer() can call it after sync completes.
   */
  function wrapHandler(eventName, handler) {
    handlerMap.set(eventName, handler);
    wsClient.on(eventName, (data) => {
      if (app.syncClient?.buffering) {
        app.syncClient.bufferEvent(eventName, data);
        return;
      }
      handler(data);
    });
  }

  // Setup non-buffered handlers (metadata, chat, sync control)
  setupUserHandlers(wsClient, app);
  setupChatHandlers(wsClient, app);
  setupAuthModHandlers(wsClient, app);
  setupSyncHandlers(wsClient, app);

  // Setup buffered handlers (all events that modify canvas state)
  setupDrawingHandlers(wrapHandler, app);
  setupSelectionHandlers(wrapHandler, app);

  // Pass handler map to sync client for replay
  if (app.syncClient) {
    app.syncClient.setHandlerMap(handlerMap);
  }
}
