/**
 * SyncClient - Client-side canvas sync orchestration
 *
 * Handles full canvas sync between users:
 * - New users request sync on join
 * - Existing users provide their full layer state when asked:
 *     1. Base bins (categorized baked history) for each layer group
 *     2. All stroke stack entries (each as a cropped PNG + metadata)
 *     3. All redo stack entries (same format, with batch index)
 * - Received data reconstructs the LayerManager identically on the joiner
 * - Remote drawing events are buffered during sync and replayed after
 */

export class SyncClient {
  constructor() {
    this.wsClient = null;
    this.board = null;
    this.initialized = false;

    // Track sync state
    this.syncing = false;

    // Pending async import promises — createImageBitmap is async, and we must
    // wait for ALL imports to settle before replaying buffered events.
    this._pendingImports = [];

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
    this._pendingImports = [];
    this.showOverlay();
    console.log('[SyncClient] Requesting canvas sync...');
    this.wsClient.requestSync();
  }

  // ---------------------------------------------------------------------------
  // Provider side — called when another user joins and we must send our state
  // ---------------------------------------------------------------------------

  /**
   * Handle server asking us to provide our canvas state.
   * Sends base bins, stroke records, and redo stacks to the joiner.
   * @param {Object} data
   * @param {number} data.targetUser - The user who needs the state
   */
  async handleSyncProvide(data) {
    const { targetUser } = data;
    console.log('[SyncClient] Asked to provide layer state for user', targetUser);

    if (!this.board?.layerManager) {
      console.warn('[SyncClient] No layer manager to provide');
      return;
    }

    try {
      const lm = this.board.layerManager;
      const groups = lm.layerGroups;

      // Phase A: send each layer group's baked sequences in chronological order
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        for (const seq of group.bakedSequences) {
          const img = await this._captureCanvasElement(seq.canvas);
          this.wsClient.sendSyncLayerBin(img, gi, seq.blendMode, targetUser);
        }
      }

      // Phase B: send all strokeStack entries across all layer groups
      for (let gi = 0; gi < groups.length; gi++) {
        for (const stroke of groups[gi].strokeStack) {
          const img = await this._captureCanvasElement(stroke.canvas);
          this.wsClient.sendSyncStroke({
            targetUser,
            layerIdx: gi,
            userId: stroke.userId,
            x: stroke.x,
            y: stroke.y,
            w: stroke.width,
            h: stroke.height,
            blendMode: stroke.blendMode,
            timestamp: stroke.timestamp,
            eraseAll: stroke.eraseAll || false,
            isRedo: false,
            redoBatchIdx: 0,
            imageData: img
          });
        }
      }

      // Phase C: send all redo stack entries (per user, per batch)
      for (const [userId, batches] of lm.redoStackByUser) {
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
          for (const { groupIdx, record } of batches[batchIdx]) {
            const img = await this._captureCanvasElement(record.canvas);
            this.wsClient.sendSyncStroke({
              targetUser,
              layerIdx: groupIdx,
              userId: record.userId,
              x: record.x,
              y: record.y,
              w: record.width,
              h: record.height,
              blendMode: record.blendMode,
              timestamp: record.timestamp,
              eraseAll: record.eraseAll || false,
              isRedo: true,
              redoBatchIdx: batchIdx,
              imageData: img
            });
          }
        }
      }

      // Phase D: signal completion
      this.wsClient.sendSyncStrokesDone(targetUser);
      console.log('[SyncClient] Finished sending layer state to user', targetUser);
    } catch (error) {
      console.error('[SyncClient] Failed to provide layer state', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Receiver side — called when we are the joiner receiving state
  // ---------------------------------------------------------------------------

  /**
   * Handle receiving a layer group's base bin.
   * Pushes the async import into _pendingImports so handleSyncComplete
   * can wait for all of them before replaying buffered events.
   */
  handleSyncLayerBin(data) {
    const p = this._importLayerBin(data);
    this._pendingImports.push(p);
  }

  async _importLayerBin(data) {
    if (!this.board?.layerManager) return;
    try {
      const blob = new Blob([data.imageData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      this.board.layerManager.importLayerBin(data.layerIdx, data.blendMode, bitmap);
      bitmap.close();
    } catch (error) {
      console.error('[SyncClient] Failed to apply layer bin', data.layerIdx, data.blendMode, error);
    }
  }

  /**
   * Handle receiving a stroke record (either strokeStack or redo stack).
   * Pushes the async import into _pendingImports so handleSyncComplete
   * can wait for all of them before replaying buffered events.
   */
  handleSyncStroke(data) {
    const p = this._importStroke(data);
    this._pendingImports.push(p);
  }

  async _importStroke(data) {
    if (!this.board?.layerManager) return;
    try {
      const blob = new Blob([data.imageData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);

      const strokeCanvas = document.createElement('canvas');
      strokeCanvas.width = data.w;
      strokeCanvas.height = data.h;
      const strokeCtx = strokeCanvas.getContext('2d');
      strokeCtx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const record = {
        canvas: strokeCanvas,
        ctx: strokeCtx,
        x: data.x,
        y: data.y,
        width: data.w,
        height: data.h,
        blendMode: data.blendMode,
        userId: data.userId,
        timestamp: data.timestamp
      };
      if (data.eraseAll) record.eraseAll = true;

      if (!data.isRedo) {
        this.board.layerManager.importStroke(data.layerIdx, record);
      } else {
        this.board.layerManager.importRedoStroke(data.userId, data.redoBatchIdx, data.layerIdx, record);
      }
    } catch (error) {
      console.error('[SyncClient] Failed to apply stroke', error);
    }
  }

  /**
   * Handle sync strokes done signal — all messages have been sent by the provider.
   * The actual work happens in handleSyncComplete once pending imports settle.
   */
  handleSyncStrokesDone() {
    // No action needed here — handleSyncComplete waits for _pendingImports.
    console.log('[SyncClient] All stroke messages received, waiting for imports...');
  }

  /**
   * Handle sync complete from server.
   * Waits for all pending async stroke imports (createImageBitmap calls) to
   * finish before compositing and replaying buffered events. This guarantees
   * the stroke stack is fully populated before any UNDO/REDO events are processed.
   */
  handleSyncComplete() {
    const pending = this._pendingImports;
    this._pendingImports = [];

    const finalize = () => {
      console.log('[SyncClient] Imports settled, replaying', this.eventBuffer.length, 'buffered events');
      if (this.board) this.board.compositeAllLayers();
      this.replayBuffer();
      this.hideOverlay();
      this.syncing = false;
      this.buffering = false;
    };

    if (pending.length > 0) {
      console.log('[SyncClient] Waiting for', pending.length, 'pending imports...');
      Promise.all(pending).then(finalize).catch((err) => {
        console.error('[SyncClient] Error during stroke import:', err);
        finalize(); // Still finalize so the client isn't stuck
      });
    } else {
      finalize();
    }
  }

  // ---------------------------------------------------------------------------
  // Event buffering
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  showOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.add('active');
    }
  }

  hideOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.remove('active');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Capture a canvas element as a PNG Uint8Array.
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Uint8Array>}
   */
  _captureCanvasElement(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          if (!blob) {
            reject(new Error('Failed to create blob from canvas'));
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
