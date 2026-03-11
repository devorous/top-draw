/**
 * SyncHandlers
 *
 * Handles canvas synchronization events:
 * - Sync provide request (server asking us to provide state)
 * - Sync layer bin (receiving a baked history bin for a specific blend mode)
 * - Sync stroke (receiving a stroke record — stack or redo)
 * - Sync strokes done (all stroke data received)
 * - Sync complete (server finished sync process)
 */

export function setupSyncHandlers(wsClient, app) {
  // Server asking us to provide our full layer state for a new user
  wsClient.on('sync_provide', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncProvide(data);
    }
  });

  // Receiving sync metadata (total message count)
  wsClient.on('sync_metadata', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncMetadata(data);
    }
  });

  // Receiving a layer group's baked history bin
  wsClient.on('sync_layer_bin', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncLayerBin(data);
    }
  });

  // Backward-compat: handle legacy sync_layer_base events
  wsClient.on('sync_layer_base', (data) => {
    if (app.syncClient) {
      // route to same bin logic (defaults to source-over if blendMode is missing)
      app.syncClient.handleSyncLayerBin(data);
    }
  });

  // Receiving a stroke record (strokeStack or redo stack)
  wsClient.on('sync_stroke', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncStroke(data);
    }
  });

  // Receiving a batch of stroke records
  wsClient.on('sync_stroke_batch', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncStrokeBatch(data);
    }
  });

  // All stroke data received — recomposite before SYNC_COMPLETE arrives
  wsClient.on('sync_strokes_done', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncStrokesDone();
    }
  });

  // Sync complete — replay buffered events
  wsClient.on('sync_complete', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncComplete();
    }
  });
}
