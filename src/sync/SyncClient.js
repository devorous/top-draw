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
    this.hasCompletedSync = false;

    // Pending async import promises — createImageBitmap is async, and we must
    // wait for ALL imports to settle before replaying buffered events.
    this._pendingImports = [];

    // Event buffering during sync
    this.buffering = false;
    this.eventBuffer = [];
    this.handlerMap = null;

    // Overlay elements
    this.overlayEl = null;
    this.progressTextEl = null;
    this.progressBarEl = null;
    this.progressFillEl = null;

    // Progress tracking
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.syncTimeout = null;

    // Progressive rendering
    this.compositeScheduled = false;
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
    this.progressTextEl = this.overlayEl?.querySelector('.sync-text');
    this.progressBarEl = this.overlayEl?.querySelector('.sync-progress-bar');
    this.progressFillEl = this.overlayEl?.querySelector('.sync-progress-fill');
    this.initialized = true;
    console.log('[SyncClient] Initialized');
  }

  /**
   * Request sync from server (called after joining)
   * @param {number|null} targetUserId - Optional: specific user to sync from
   */
  requestSync(targetUserId = null) {
    console.log('[SyncClient] requestSync called, current syncing state:', this.syncing);
    console.trace('[SyncClient] requestSync call stack');

    if (!this.wsClient) {
      console.warn('[SyncClient] Cannot request sync - no wsClient');
      return;
    }

    // If already syncing, don't start a new sync
    if (this.syncing) {
      console.warn('[SyncClient] Already syncing, ignoring duplicate requestSync call');
      return;
    }

    // If we've already successfully synced, skip unless explicitly requesting from a specific user
    if (this.hasCompletedSync && targetUserId === null) {
      console.log('[SyncClient] Already completed initial sync, ignoring duplicate auto-sync request');
      return;
    }

    // Clear existing canvas before syncing to prevent double-up
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

    // Set a timeout to prevent indefinite hanging
    this.syncTimeout = setTimeout(() => {
      if (this.syncing) {
        console.warn('[SyncClient] Sync timeout - completing anyway');
        this.handleSyncComplete();
      }
    }, 30000); // 30 second timeout

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
   * Request sync from a specific user
   * @param {number} userId - User session index to sync from
   */
  requestSyncFrom(userId) {
    this.requestSync(userId);
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

      // Phase 0: Count total messages to send (batched sync)
      let totalCount = 0;

      // Count flatCanvas for layer 0 (contains all baked content for the base layer)
      if (groups[0]?.flatCanvas) {
        totalCount += 1;
      }

      // Count baked sequences (still sent individually)
      for (let gi = 0; gi < groups.length; gi++) {
        totalCount += groups[gi].bakedSequences.length;
      }

      // Count stroke batches (1 message per layer with strokes)
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].strokeStack.length > 0) {
          totalCount += 1; // One batched message per layer
        }
      }

      // Count redo batches (1 message per user per batch)
      for (const [userId, batches] of lm.redoStackByUser) {
        totalCount += batches.length; // One batched message per redo batch
      }

      // Send metadata with total count
      console.log(`[SyncClient] Sending sync metadata: ${totalCount} total messages (batched)`);
      this.wsClient.sendSyncMetadata(totalCount, targetUser);

      // Small delay to ensure metadata is processed before data starts arriving
      await new Promise(resolve => setTimeout(resolve, 100));

      // Phase A: send each layer group's baked sequences in chronological order
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];

        // Layer 0: send the flatCanvas first (contains all baked content)
        if (group.flatCanvas) {
          const img = await this._captureCanvasElement(group.flatCanvas);
          this.wsClient.sendSyncLayerBase(img, gi, 'source-over', targetUser);
        }

        // Send any additional baked sequences (upper layers use these)
        for (const seq of group.bakedSequences) {
          const img = await this._captureCanvasElement(seq.canvas);
          this.wsClient.sendSyncLayerBase(img, gi, seq.blendMode, targetUser);
        }
      }

      // Phase B: send strokeStack entries batched per layer group
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].strokeStack.length > 0) {
          console.log(`[Sync] Layer ${gi} strokeStack:`, groups[gi].strokeStack.map(s => ({
            userId: s.userId,
            timestamp: s.timestamp,
            x: s.x, y: s.y
          })));

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
              layerIdx: gi
            });
          }

          console.log(`[Sync] Sending batch for layer ${gi}:`, strokeRecords.map(s => ({
            userId: s.userId,
            timestamp: s.timestamp,
            x: s.x, y: s.y
          })));

          this.wsClient.sendSyncStrokeBatch(strokeRecords, gi, targetUser);
        }
      }

      // Phase C: send redo stack entries batched per user per batch
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
              layerIdx: groupIdx  // Each stroke has its own layer index
            });
          }
          // Use 0 as placeholder since each stroke now has its own layerIdx
          this.wsClient.sendSyncStrokeBatch(strokeRecords, 0, targetUser);
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
   * Handle receiving sync metadata (total message count).
   * Called before receiving any layer/stroke data.
   */
  handleSyncMetadata(data) {
    this.expectedMessages = data.totalCount || 0;
    console.log(`[SyncClient] METADATA RECEIVED - Expecting ${this.expectedMessages} total messages (current received: ${this.receivedMessages})`);
    console.log('[SyncClient] Progress elements:', {
      textEl: !!this.progressTextEl,
      fillEl: !!this.progressFillEl,
      expectedMessages: this.expectedMessages,
      receivedMessages: this.receivedMessages
    });
    this.updateProgress();
  }

  /**
   * Handle receiving a layer group's base bin.
   * Pushes the async import into _pendingImports so handleSyncComplete
   * can wait for all of them before replaying buffered events.
   */
  handleSyncLayerBin(data) {
    const p = this._importLayerBin(data);
    this._pendingImports.push(p);
    this.receivedMessages++;
    if (this.receivedMessages === 1) {
      console.log(`[SyncClient] First message received (expected: ${this.expectedMessages})`);
    }
    this.updateProgress();
  }

  async _importLayerBin(data) {
    if (!this.board?.layerManager) return;
    try {
      const blob = new Blob([data.imageData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      this.board.layerManager.importLayerBin(data.layerIdx, data.blendMode, bitmap);
      bitmap.close();
      // Schedule progressive render
      this._scheduleComposite();
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
    this.receivedMessages++;
    this.updateProgress();
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
        console.log(`[SyncClient] Importing stroke: layerIdx=${data.layerIdx}, userId=${data.userId}, timestamp=${data.timestamp}, x=${data.x}, y=${data.y}`);
        this.board.layerManager.importStroke(data.layerIdx, record);
      } else {
        console.log(`[SyncClient] Importing redo stroke: batchIdx=${data.redoBatchIdx}, layerIdx=${data.layerIdx}, userId=${data.userId}, timestamp=${data.timestamp}`);
        this.board.layerManager.importRedoStroke(data.userId, data.redoBatchIdx, data.layerIdx, record);
      }

      // Schedule progressive render
      this._scheduleComposite();
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
    // Clear timeout
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }

    const pending = this._pendingImports;
    this._pendingImports = [];

    const finalize = () => {
      console.log('[SyncClient] Imports settled, replaying', this.eventBuffer.length, 'buffered events');
      if (this.board) this.board.compositeAllLayers();
      this.replayBuffer();
      this.hideOverlay();
      this.syncing = false;
      this.buffering = false;
      this.hasCompletedSync = true;
      this.expectedMessages = 0;
      this.receivedMessages = 0;
    };

    if (pending.length > 0) {
      console.log('[SyncClient] Waiting for', pending.length, 'pending imports...');
      this.updateProgress('Processing images...');
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

  /**
   * Update progress display
   * @param {string} customText - Optional custom text to display
   */
  updateProgress(customText = null) {
    if (!this.progressTextEl || !this.progressFillEl) {
      console.warn('[SyncClient] Progress elements not found:', {
        textEl: !!this.progressTextEl,
        fillEl: !!this.progressFillEl
      });
      return;
    }

    if (customText) {
      this.progressTextEl.textContent = customText;
      // Keep progress bar at 100% when showing custom text
      if (this.progressFillEl) {
        this.progressFillEl.style.width = '100%';
      }
      return;
    }

    // Calculate progress percentage
    let percentage = 0;
    let text = 'Syncing...';

    if (this.expectedMessages > 0) {
      // We know the expected count, show accurate progress
      percentage = Math.min(100, Math.round((this.receivedMessages / this.expectedMessages) * 100));
      text = `Syncing... ${this.receivedMessages}/${this.expectedMessages} (${percentage}%)`;
      console.log(`[SyncClient] Progress: ${percentage}% (${this.receivedMessages}/${this.expectedMessages})`);
      if (this.progressFillEl) {
        this.progressFillEl.style.width = `${percentage}%`;
      }
    } else {
      // No expected count yet, start at 0% and wait for metadata
      text = 'Syncing...';
      console.log('[SyncClient] No expected count yet, waiting for metadata');
      if (this.progressFillEl) {
        this.progressFillEl.style.width = '0%';
      }
    }

    this.progressTextEl.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Schedule a composite on the next animation frame (throttled)
   * This allows multiple stroke imports to batch into one composite call
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
    this.hasCompletedSync = false;
  }
}
