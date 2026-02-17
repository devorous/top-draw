/**
 * SyncHandlers
 *
 * Handles canvas synchronization events:
 * - Sync provide request (server asking us to provide canvas)
 * - Sync canvas data (receiving canvas from another user)
 * - Sync complete (server finished sync process)
 */

export function setupSyncHandlers(wsClient, app) {
  // Sync provide - server asking us to provide our canvas for a new user
  wsClient.on('sync_provide', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncProvide(data);
    }
  });

  // Sync canvas - receiving canvas data from another user
  wsClient.on('sync_canvas', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncCanvas(data);
    }
  });

  // Sync complete - server finished sync process
  wsClient.on('sync_complete', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncComplete();
    }
  });
}
