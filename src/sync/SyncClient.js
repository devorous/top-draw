/**
 * @fileoverview Client-side canvas synchronization orchestration.
 * Handles full canvas state transfer between users, including layers,
 * stroke history, and redo stacks.
 */

/**
 * SyncClient manages the complex process of synchronizing the canvas state
 * from an existing user to a newly joined user.
 */
export class SyncClient {
  constructor() {
    /** @type {WebSocketClient|null} */
    this.wsClient = null;
    /** @type {Board|null} */
    this.board = null;
    /** @type {boolean} */
    this.initialized = false;

    /** @type {boolean} */
    this.syncing = false;
    /** @type {boolean} */
    this.hasCompletedSync = false;

    /**
     * Pending async import promises — createImageBitmap is async, and we must
     * wait for ALL imports to settle before replaying buffered events.
     * @private
     * @type {Array<Promise>}
     */
    this._pendingImports = [];

    /** @type {boolean} */
    this.buffering = false;
    /** @type {Array<Object>} */
    this.eventBuffer = [];
    /** @type {Map|null} */
    this.handlerMap = null;

    /** @type {HTMLElement|null} */
    this.overlayEl = null;
    /** @type {HTMLElement|null} */
    this.progressTextEl = null;
    /** @type {HTMLElement|null} */
    this.progressBarEl = null;
    /** @type {HTMLElement|null} */
    this.progressFillEl = null;

    /** @type {number} */
    this.expectedMessages = 0;
    /** @type {number} */
    this.receivedMessages = 0;
    /** @type {number|null} */
    this.syncTimeout = null;

    /** @type {Function|null} */
    this.onSyncComplete = null;

    /** @type {boolean} */
    this.compositeScheduled = false;
  }

  /**
   * Initializes the sync client with necessary dependencies.
   *
   * @param {Object} options - Configuration options
   * @param {WebSocketClient} options.wsClient - WebSocket client instance
   * @param {Board} options.board - Board instance for canvas operations
   * @returns {void}
   */
  init({ wsClient, board }) {
    this.wsClient = wsClient;
    this.board = board;
    this.overlayEl = document.getElementById('syncOverlay');
    this.progressTextEl = this.overlayEl?.querySelector('.sync-text');
    this.progressBarEl = this.overlayEl?.querySelector('.sync-progress-bar');
    this.progressFillEl = this.overlayEl?.querySelector('.sync-progress-fill');
    this.initialized = true;
    console.log('[SyncClient] Initialized');
  }

  /**
   * Requests a full canvas synchronization from the server.
   * Clears local state and prepares to buffer incoming remote events.
   *
   * @param {number|null} [targetUserId=null] - Optional specific user ID to sync from
   * @returns {void}
   */
  requestSync(targetUserId = null) {
    console.log('[SyncClient] requestSync called, current syncing state:', this.syncing);
    console.trace('[SyncClient] requestSync call stack');

    if (!this.wsClient) {
      console.warn('[SyncClient] Cannot request sync - no wsClient');
      return;
    }

    if (this.syncing) {
      console.warn('[SyncClient] Already syncing, ignoring duplicate requestSync call');
      return;
    }

    if (this.hasCompletedSync && targetUserId === null) {
      console.log('[SyncClient] Already completed initial sync, ignoring duplicate auto-sync request');
      return;
    }

    if (this.board?.layerManager) {
      console.log('[SyncClient] Clearing existing canvas before sync...');
      this.board.layerManager.clearAll();
      this.board.compositeAllLayers();
    }

    this.syncing = true;
    this.buffering = true;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.expectedMessages = 0;
    this.receivedMessages = 0;

    this.syncTimeout = setTimeout(() => {
      if (this.syncing) {
        console.warn('[SyncClient] Sync timeout - completing anyway');
        this.handleSyncComplete();
      }
    }, 30000);

    this.showOverlay();
    this.updateProgress();

    if (targetUserId !== null) {
      console.log(`[SyncClient] Requesting canvas sync from user ${targetUserId}...`);
    } else {
      console.log('[SyncClient] Requesting canvas sync (auto-select provider)...');
    }

    this.wsClient.requestSync(targetUserId);
  }

  /**
   * Convenience method to request sync from a specific user.
   *
   * @param {number} userId - User session index to sync from
   * @returns {void}
   */
  requestSyncFrom(userId) {
    this.requestSync(userId);
  }

  /**
   * Provider side: Handles a request to provide canvas state to a joining user.
   * Serializes the current layer state, stroke history, and redo stack.
   *
   * @param {Object} data - Request payload
   * @param {number} data.targetUser - The user ID who needs the state
   * @returns {Promise<void>}
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

      let totalCount = 0;

      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].flatCanvas) {
          totalCount += 1;
        }
        totalCount += groups[gi].bakedSequences.length;
      }

      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].strokeStack.length > 0) {
          totalCount += 1;
        }
      }

      for (const [userId, batches] of lm.redoStackByUser) {
        totalCount += batches.length;
      }

      console.log(`[SyncClient] Sending sync metadata: ${totalCount} total messages (batched)`);
      this.wsClient.sendSyncMetadata(totalCount, targetUser);

      await new Promise(resolve => setTimeout(resolve, 100));

      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];

        if (group.flatCanvas) {
          const img = await this._captureCanvasElement(group.flatCanvas);
          this.wsClient.sendSyncLayerBase(img, gi, 'source-over', targetUser);
        }

        for (const seq of group.bakedSequences) {
          const img = await this._captureCanvasElement(seq.canvas);
          this.wsClient.sendSyncLayerBase(img, gi, seq.blendMode, targetUser);
        }
      }

      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].strokeStack.length > 0) {
          const strokeRecords = [];
          for (const stroke of groups[gi].strokeStack) {
            const img = await this._captureCanvasElement(stroke.canvas);
            strokeRecords.push({
              img,
              userId: stroke.userId,
              x: stroke.x,
              y: stroke.y,
              width: stroke.width,
              height: stroke.height,
              blendMode: stroke.blendMode,
              timestamp: stroke.timestamp,
              eraseAll: stroke.eraseAll || false,
              isRedo: false,
              redoBatch: 0,
              layerIdx: gi,
              affectedTiles: stroke.affectedTiles ? Array.from(stroke.affectedTiles) : []
            });
          }
          this.wsClient.sendSyncStrokeBatch(strokeRecords, gi, targetUser);
        }
      }

      for (const [userId, batches] of lm.redoStackByUser) {
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
          const strokeRecords = [];
          for (const { groupIdx, record } of batches[batchIdx]) {
            const img = await this._captureCanvasElement(record.canvas);
            strokeRecords.push({
              img,
              userId: record.userId,
              x: record.x,
              y: record.y,
              width: record.width,
              height: record.height,
              blendMode: record.blendMode,
              timestamp: record.timestamp,
              eraseAll: record.eraseAll || false,
              isRedo: true,
              redoBatch: batchIdx,
              layerIdx: groupIdx,
              affectedTiles: record.affectedTiles ? Array.from(record.affectedTiles) : []
            });
          }
          // The first record's groupIdx can be used as a representative layerIdx for the batch
          const batchLayerIdx = batches[batchIdx][0]?.groupIdx ?? 0;
          this.wsClient.sendSyncStrokeBatch(strokeRecords, batchLayerIdx, targetUser);
        }
      }

      // Tile ownership is now sent by the server (authoritative) after SYNC_STROKES_DONE
      this.wsClient.sendSyncStrokesDone(targetUser);
      console.log('[SyncClient] Finished sending layer state to user', targetUser);
    } catch (error) {
      console.error('[SyncClient] Failed to provide layer state', error);
    }
  }

  /**
   * Receives synchronization metadata containing the total message count.
   *
   * @param {Object} data - Metadata payload
   * @param {number} data.totalCount - Total number of messages expected during sync
   * @returns {void}
   */
  handleSyncMetadata(data) {
    this.expectedMessages = data.totalCount || 0;
    this.updateProgress();
  }

  /**
   * Processes an incoming base layer bin.
   *
   * @param {Object} data - Layer data payload
   * @returns {void}
   */
  handleSyncLayerBin(data) {
    const p = this._importLayerBin(data);
    this._pendingImports.push(p);
    this.receivedMessages++;
    this.updateProgress();
  }

  /**
   * Internal helper to import a layer bin into the LayerManager.
   *
   * @private
   * @param {Object} data - Layer data
   * @returns {Promise<void>}
   */
  async _importLayerBin(data) {
    if (!this.board?.layerManager) return;
    try {
      const blob = new Blob([data.imageData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      this.board.layerManager.importLayerBin(data.layerIdx, data.blendMode, bitmap);
      bitmap.close();
      this._scheduleComposite();
    } catch (error) {
      console.error('[SyncClient] Failed to apply layer bin', data.layerIdx, data.blendMode, error);
    }
  }

  /**
   * Processes an individual incoming stroke record.
   *
   * @param {Object} data - Stroke data payload
   * @returns {void}
   */
  handleSyncStroke(data) {
    const p = this._importStroke(data);
    this._pendingImports.push(p);
    this.receivedMessages++;
    this.updateProgress();
  }

  /**
   * Internal helper to decode and import a stroke into the LayerManager.
   * Includes a 2-second timeout protection.
   *
   * @private
   * @param {Object} data - Stroke record data
   * @returns {Promise<void>}
   */
  async _importStroke(data) {
    if (!this.board?.layerManager) return;

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Stroke import timeout (>2s)')), 2000);
    });

    try {
      await Promise.race([
        (async () => {
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
            timestamp: data.timestamp,
            affectedTiles: data.affectedTiles || []
          };
          if (data.eraseAll) record.eraseAll = true;

          if (!data.isRedo) {
            this.board.layerManager.importStroke(data.layerIdx, record);
          } else {
            this.board.layerManager.importRedoStroke(data.userId, data.redoBatchIdx, data.layerIdx, record);
          }

          this._scheduleComposite();
        })(),
        timeout
      ]);
    } catch (error) {
      console.warn(`[SyncClient] Skipping stroke (User: ${data.userId}, Layer: ${data.layerIdx}):`, error.message || error);
    }
  }

  /**
   * Processes a batch of incoming stroke records.
   *
   * @param {Object} data - Batched stroke data payload
   * @returns {void}
   */
  handleSyncStrokeBatch(data) {
    if (!data.strokes || !Array.isArray(data.strokes)) return;

    for (const s of data.strokes) {
      // Note: s is already mapped by WebSocketClient to have imageData, w, h, etc.
      const p = this._importStroke(s);
      this._pendingImports.push(p);
    }

    this.receivedMessages++;
    this.updateProgress();
  }

  /**
   * Signal that all sync messages have been dispatched by the provider.
   * @returns {void}
   */
  handleSyncStrokesDone() {
    // No action needed here — handleSyncComplete waits for _pendingImports.
  }

  /**
   * Applies dirty tile data received from sync provider.
   * @param {Object} data - Tile occupancy payload
   * @param {Array} data.dirtyTiles - Array of dirty tile indices
   * @returns {void}
   */
  handleSyncDirtyTiles(data) {
    const tiles = data.dirtyTiles || data.tiles;
    if (!this.board?.tileTracker || !tiles) return;

    const tt = this.board.tileTracker;
    console.log(`[SyncClient] Applying ${tiles.length} dirty tile entries`);

    for (const tileIdx of tiles) {
      // Handle both formats: simple index or legacy {idx, users}
      const idx = typeof tileIdx === 'number' ? tileIdx : tileIdx.idx;
      tt.markTileDirty(idx);
    }
  }

  /**
   * Finalizes the synchronization process once all pending imports settle.
   * Composites layers and replays buffered remote events.
   *
   * @returns {void}
   */
  handleSyncComplete() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }

    const pending = this._pendingImports;
    this._pendingImports = [];

    const finalize = () => {
      if (this.board) this.board.compositeAllLayers();
      this.replayBuffer();
      this.hideOverlay();
      this.syncing = false;
      this.buffering = false;
      this.hasCompletedSync = true;
      this.expectedMessages = 0;
      this.receivedMessages = 0;

      if (this.onSyncComplete) {
        this.onSyncComplete();
      }
    };

    if (pending.length > 0) {
      this.updateProgress('Processing images...');
      Promise.all(pending).then(finalize).catch((err) => {
        console.error('[SyncClient] Error during stroke import:', err);
        finalize();
      });
    } else {
      finalize();
    }
  }

  /**
   * Buffers a remote event to be replayed after synchronization is complete.
   *
   * @param {string} eventName - Name of the event
   * @param {Object} data - Event payload
   * @returns {void}
   */
  bufferEvent(eventName, data) {
    this.eventBuffer.push({ eventName, data });
  }

  /**
   * Replays all buffered remote events in their original sequence.
   * @returns {void}
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
   * Registers the handler map used for replaying buffered events.
   *
   * @param {Map} map - Map of event names to handler functions
   * @returns {void}
   */
  setHandlerMap(map) {
    this.handlerMap = map;
  }

  /**
   * Shows the synchronization progress overlay.
   * @returns {void}
   */
  showOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.add('active');
    }
  }

  /**
   * Hides the synchronization progress overlay.
   * @returns {void}
   */
  hideOverlay() {
    if (this.overlayEl) {
      this.overlayEl.classList.remove('active');
    }
  }

  /**
   * Updates the visual progress indicators in the UI.
   *
   * @param {string|null} [customText=null] - Optional override text for the progress message
   * @returns {void}
   */
  updateProgress(customText = null) {
    if (!this.progressTextEl || !this.progressFillEl) {
      return;
    }

    if (customText) {
      this.progressTextEl.textContent = customText;
      if (this.progressFillEl) {
        this.progressFillEl.style.width = '100%';
      }
      return;
    }

    let percentage = 0;
    let text = 'Syncing...';

    if (this.expectedMessages > 0) {
      percentage = Math.min(100, Math.round((this.receivedMessages / this.expectedMessages) * 100));
      text = `Syncing... ${this.receivedMessages}/${this.expectedMessages} (${percentage}%)`;
      if (this.progressFillEl) {
        this.progressFillEl.style.width = `${percentage}%`;
      }
    } else {
      text = 'Syncing...';
      if (this.progressFillEl) {
        this.progressFillEl.style.width = '0%';
      }
    }

    this.progressTextEl.textContent = text;
  }

  /**
   * Schedules a canvas composition on the next animation frame.
   * Throttles multiple calls to prevent redundant compositing.
   *
   * @private
   * @returns {void}
   */
  _scheduleComposite() {
    if (this.compositeScheduled || !this.board) return;
    this.compositeScheduled = true;
    requestAnimationFrame(() => {
      if (this.board) {
        this.board.compositeAllLayers();
      }
      this.compositeScheduled = false;
    });
  }

  /**
   * Captures a canvas element's content as a PNG encoded Uint8Array.
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas to capture
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
   * Checks if a synchronization process is currently active.
   *
   * @returns {boolean}
   */
  isSyncing() {
    return this.syncing;
  }

  /**
   * Cleans up resources and resets the sync client state.
   * @returns {void}
   */
  destroy() {
    this.wsClient = null;
    this.board = null;
    this.initialized = false;
    this.hasCompletedSync = false;
  }
}
