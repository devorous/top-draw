/**
 * SyncClient - Client-side canvas sync orchestration
 *
 * Handles full canvas sync between users:
 * - New users request sync on join
 * - Existing users provide their canvas when asked
 * - Received canvas is drawn to the main canvas
 * - Overlay shown and local input blocked during sync
 * - Remote drawing events buffered and replayed after sync
 */

export class SyncClient {
  constructor() {
    this.wsClient = null;
    this.board = null;
    this.initialized = false;

    // Track sync state
    this.syncing = false;

    // Event buffering during sync
    this.buffering = false;
    this.eventBuffer = [];
    this.handlerMap = null;

    // Overlay element
    this.overlayEl = null;
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
    this.overlayEl = document.getElementById('syncOverlay');
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
    this.buffering = true;
    this.eventBuffer = [];
    this.showOverlay();
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
    this.replayBuffer();
    this.hideOverlay();
    this.syncing = false;
    this.buffering = false;
  }

  /**
   * Buffer a remote event for replay after sync
   * @param {string} eventName - The event name
   * @param {Object} data - The event data
   */
  bufferEvent(eventName, data) {
    this.eventBuffer.push({ eventName, data });
  }

  /**
   * Replay all buffered events in order
   */
  replayBuffer() {
    if (!this.handlerMap || this.eventBuffer.length === 0) {
      this.eventBuffer = [];
      return;
    }

    console.log('[SyncClient] Replaying', this.eventBuffer.length, 'buffered events');
    for (const { eventName, data } of this.eventBuffer) {
      const handler = this.handlerMap.get(eventName);
      if (handler) {
        handler(data);
      }
    }
    this.eventBuffer = [];
  }

  /**
   * Set the handler map for event replay
   * @param {Map} map - Map of eventName -> handler function
   */
  setHandlerMap(map) {
    this.handlerMap = map;
  }

  /**
   * Show the sync overlay
   */
  showOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.add('active');
    }
  }

  /**
   * Hide the sync overlay
   */
  hideOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.remove('active');
    }
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
   * Clears the canvas first to replace (not overlay) existing content
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

      // Draw to main canvas at origin - clear first to replace, not overlay
      const ctx = this.board.mainCtx;
      if (ctx) {
        ctx.clearRect(0, 0, this.board.mainCanvas.width, this.board.mainCanvas.height);
        ctx.drawImage(imageBitmap, 0, 0);
        console.log('[SyncClient] Drew synced canvas (replaced)');
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
