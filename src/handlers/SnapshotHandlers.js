/** @fileoverview WebSocket handlers for board snapshots (saving, listing, restoring). */

import { T } from '../../shared/MessageTypes.js';
import { appState } from '../state.svelte.js';

/**
 * Registers WebSocket event listeners for board snapshot messages.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {DrawingApp} app - The main application instance.
 */
export function setupSnapshotHandlers(wsClient, app) {
  // Handle snapshot list response
  wsClient.on('board_snapshot_list', (data) => {
    if (!data.snapshotList) return;

    app.snapshotManager.snapshots = data.snapshotList;
    appState.snapshots = data.snapshotList;

    console.log(`[Snapshot] Received list of ${data.snapshotList.length} snapshots`);
  });

  // Handle server requesting us to capture a snapshot
  wsClient.on('board_snapshot_request', () => {
    app.snapshotManager.handleServerRequest();
  });

  // Handle board restoration
  wsClient.on('board_snapshot_restore', (data) => {
    if (!data.snapshotData) return;

    const issuer = data.snapshotIssuer || 'Unknown';
    const ts = new Date(data.snapshotTs).toLocaleString();
    
    app.ui.showToast(`Board restored to snapshot by ${issuer} (${ts})`, 5000);
    
    // Apply the snapshot to the board
    app.board.restoreSnapshot(data.snapshotData);
    
    // Clear undo/redo history as the board has changed significantly
    app.board.layerManager.clearHistory();
    app.updateUndoRedoHud();
    
    // Re-request sync for everything else if needed
    // app.syncClient.requestSync();
  });
}
