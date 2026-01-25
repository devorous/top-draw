/**
 * SyncClient - Client-side canvas sync orchestration
 *
 * Handles full canvas sync between users:
 * - New users request sync on join
 * - Existing users provide their canvas when asked
 * - Received canvas is drawn to the main canvas
 */

export class SyncClient {
  constructor() {
    this.wsClient = null;
    this.board = null;
    this.initialized = false;

    // Track sync state
    this.syncing = false;
  }

  /**
   * Initialize the sync client
   * @param {Object} options
   * @param {WebSocketClient} options.wsClient - WebSocket client instance
   * @param {Board} options.board - Board instance for canvas operations
   */
  init({ wsClient, board }) {
    this.wsClient = wsClient;
    this.board = board;
    this.initialized = true;
    console.log('[SyncClient] Initialized');
  }

  /**
   * Request sync from server (called after joining)
   */
  requestSync() {
    if (!this.wsClient) {
      console.warn('[SyncClient] Cannot request sync - no wsClient');
      return;
    }

    this.syncing = true;
    console.log('[SyncClient] Requesting canvas sync...');
    this.wsClient.requestSync();
  }

  /**
   * Handle server asking us to provide our canvas
   * Called when another user joins and needs our canvas state
   * @param {Object} data
   * @param {number} data.targetUser - The user who needs the canvas
   */
  async handleSyncProvide(data) {
    const { targetUser } = data;
    console.log('[SyncClient] Asked to provide canvas for user', targetUser);

    if (!this.board || !this.board.mainCanvas) {
      console.warn('[SyncClient] No canvas to provide');
      return;
    }

    try {
      // Capture the main canvas as PNG
      const imageData = await this._captureCanvas();

      // Send to server
      this.wsClient.sendCanvasData(imageData, targetUser);
      console.log('[SyncClient] Sent canvas data, size:', imageData.length, 'bytes');
    } catch (error) {
      console.error('[SyncClient] Failed to capture/send canvas', error);
    }
  }

  /**
   * Handle receiving canvas data from another user
   * @param {Object} data
   * @param {number} data.sessionIndex - User who provided the canvas
   * @param {Uint8Array} data.imageData - PNG image data
   */
  async handleSyncCanvas(data) {
    const { sessionIndex, imageData } = data;
    console.log('[SyncClient] Received canvas from user', sessionIndex, 'size:', imageData?.length || 0);

    if (!imageData || imageData.length === 0) {
      console.warn('[SyncClient] Received empty canvas data');
      return;
    }

    await this._drawCanvasData(imageData);
  }

  /**
   * Handle sync complete from server
   */
  handleSyncComplete() {
    console.log('[SyncClient] Sync complete');
    this.syncing = false;
  }

  /**
   * Capture the main canvas as PNG
   * @returns {Promise<Uint8Array>}
   */
  async _captureCanvas() {
    const canvas = this.board.mainCanvas;

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          if (!blob) {
            reject(new Error('Failed to create blob'));
            return;
          }

          const arrayBuffer = await blob.arrayBuffer();
          resolve(new Uint8Array(arrayBuffer));
        },
        'image/png'
      );
    });
  }

  /**
   * Draw received canvas data to the main canvas
   * @param {Uint8Array} imageData - PNG data
   */
  async _drawCanvasData(imageData) {
    if (!this.board) {
      console.warn('[SyncClient] No board reference');
      return;
    }

    try {
      // Convert Uint8Array to Blob
      const blob = new Blob([imageData], { type: 'image/png' });

      // Create ImageBitmap from blob
      const imageBitmap = await createImageBitmap(blob);

      // Draw to main canvas at origin
      const ctx = this.board.mainCtx;
      if (ctx) {
        ctx.drawImage(imageBitmap, 0, 0);
        console.log('[SyncClient] Drew synced canvas');
      }

      imageBitmap.close();
    } catch (error) {
      console.error('[SyncClient] Failed to draw canvas data', error);
    }
  }

  /**
   * Check if currently syncing
   * @returns {boolean}
   */
  isSyncing() {
    return this.syncing;
  }

  /**
   * Destroy the sync client
   */
  destroy() {
    this.wsClient = null;
    this.board = null;
    this.initialized = false;
  }
}
