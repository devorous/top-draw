/**
 * @fileoverview Setup and configuration of WebSocket handlers for canvas synchronization.
 * Connects the SyncClient to the binary WebSocket message stream.
 */

/**
 * Registers WebSocket event listeners for all synchronization-related messages.
 * Routes incoming sync data to the application's SyncClient.
 *
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 * @returns {void}
 */
export function setupSyncHandlers(wsClient, app) {
  wsClient.on('sync_provide', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncProvide(data);
    }
  });

  wsClient.on('sync_metadata', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncMetadata(data);
    }
  });

  wsClient.on('sync_layer_bin', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncLayerBin(data);
    }
  });

  wsClient.on('sync_layer_base', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncLayerBin(data);
    }
  });

  wsClient.on('sync_stroke', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncStroke(data);
    }
  });

  wsClient.on('sync_stroke_batch', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncStrokeBatch(data);
    }
  });

  wsClient.on('sync_strokes_done', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncStrokesDone();
    }
  });

  wsClient.on('sync_complete', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncComplete();
    }
  });

  wsClient.on('sync_tile_ownership', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncDirtyTiles(data);
    }
  });

  // Real-time tile updates from other users
  wsClient.on('tile_update', (data) => {
    const tt = app.board?.tileTracker;
    if (!tt || !data.tiles) return;

    for (const tile of data.tiles) {
      const idx = typeof tile === 'number' ? tile : tile.idx;
      if (typeof idx === 'number') {
        tt.markTileDirty(idx);
      }
    }
  });

  // Tiles cleared by erasing (remove from tracker on all clients)
  wsClient.on('tile_clear', (data) => {
    const tt = app.board?.tileTracker;
    if (!tt || !data.clearedTiles) return;

    for (const tileIdx of data.clearedTiles) {
      tt.clearTile(tileIdx);
    }
  });
}
