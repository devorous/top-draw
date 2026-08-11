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
      //
      // NOTE this is a SECOND self-echo gate, independent of the one in
      // WebSocketClient._processMessage. A commit type must be exempted in BOTH
      // to reach its handler: exempting it there only, and forgetting here, gives
      // the worst of both worlds — observers sequence the commit from the
      // broadcast while the drawer's own copy is never reconciled and stays at
      // seq 0, so the two disagree permanently once it bakes.
      // 'text_apply' is reconcile-only for self — see DrawingHandlers.js.
      // 'sel_lift'/'sel_commit'/'sel_stamp'/'sel_fill' likewise: the lift-erase
      // and the stamp it pairs with are sequenced together, so both halves need
      // their echo to reconcile against — see SelectionHandlers.js.
      const allowSelf = eventName === 'mu' || eventName === 'undo' || eventName === 'fill' || eventName === 'glitch_result' || eventName === 'sel_delete' || eventName === 'sel_merge' || eventName === 'text_apply' || eventName === 'sel_lift' || eventName === 'sel_commit' || eventName === 'sel_stamp' || eventName === 'sel_fill';
      if (data && data.sessionIndex === app.sessionIndex && !allowSelf) {
        return;
      }

      // Checkpoint/resync tails can carry frames from authors who have since
      // LEFT and are therefore absent from our USERS list. The draw/tool-state
      // handlers bail on an unknown author (`users.get(sid) === undefined`),
      // silently dropping that user's replayed strokes (Issue 7). Materialize a
      // transient placeholder up front so the whole preamble (tool-state -> md
      // -> mm -> mu) applies to a real user and renders, including live-path tail
      // frames that arrive just after SYNC_COMPLETE and parity-resync replays.
      // The next authoritative USERS broadcast removes the placeholder,
      // preserving its baked visuals. ensureRemoteUser is idempotent, so this is
      // a no-op once the author exists.
      if (data &&
          data.sessionIndex !== undefined && data.sessionIndex !== null &&
          data.sessionIndex !== app.sessionIndex && !app.users?.has(data.sessionIndex)) {
        app.ensureRemoteUser?.(data.sessionIndex);
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
