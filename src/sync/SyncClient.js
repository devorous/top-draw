/**
 * @fileoverview Client-side canvas synchronization orchestration.
 * Handles full canvas state transfer between users, including layers,
 * stroke history, and redo stacks.
 */

import { appState } from '../state.svelte.js';

/**
 * SyncClient manages the complex process of synchronizing the canvas state
 * from an existing user to a newly joined user.
 */
export class SyncClient {
  constructor() {
    /** @type {number} */
    this.SYNC_IDLE_TIMEOUT_MS = 15000;
    /** @type {number} */
    this.SYNC_INITIAL_TIMEOUT_MS = 30000;

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
    /** @type {HTMLElement|null} */
    this.progressHintEl = null;
    /** @type {HTMLElement|null} */
    this.overlayContentEl = null;
    /** @type {HTMLDivElement|null} */
    this.inactiveControlsEl = null;
    /** @type {HTMLSelectElement|null} */
    this.inactiveTargetSelectEl = null;
    /** @type {HTMLButtonElement|null} */
    this.inactiveSyncButtonEl = null;
    /** @type {boolean} */
    this.inactive = false;

    /** @type {number} */
    this.expectedMessages = 0;
    /** @type {number} */
    this.receivedMessages = 0;
    /** @type {number|null} */
    this.syncTimeout = null;
    /** @type {number|null} */
    this.currentSyncTargetId = null;

    /** @type {Function|null} */
    this.onSyncComplete = null;

    /** @type {boolean} */
    this.compositeScheduled = false;

    /** @type {number} */
    this._syncSessionId = 0;
  }

  /**
   * Initializes the sync client with necessary dependencies.
   *
   * @param {Object} options - Configuration options
   * @param {WebSocketClient} options.wsClient - WebSocket client instance
   * @param {Board} options.board - Board instance for canvas operations
   * @param {App} options.app - App instance for buffer management
   * @returns {void}
   */
  init({ wsClient, board, app }) {
    this.wsClient = wsClient;
    this.board = board;
    this.app = app;
    this.overlayEl = document.getElementById('syncOverlay');
    this.overlayContentEl = this.overlayEl?.querySelector('.sync-content');
    this.progressTextEl = this.overlayEl?.querySelector('.sync-text');
    this.progressBarEl = this.overlayEl?.querySelector('.sync-progress-bar');
    this.progressFillEl = this.overlayEl?.querySelector('.sync-progress-fill');
    this.progressHintEl = this.overlayEl?.querySelector('.sync-hint');
    this._ensureInactiveControls();
    this.initialized = true;
  }

  /**
   * Creates the AFK controls inside the existing canvas overlay.
   * @private
   * @returns {void}
   */
  _ensureInactiveControls() {
    if (!this.overlayContentEl || this.inactiveControlsEl) return;

    const controls = document.createElement('div');
    controls.className = 'sync-inactive-controls';
    Object.assign(controls.style, {
      display: 'none',
      width: 'min(320px, calc(100% - 24px))',
      padding: '16px',
      borderRadius: '14px',
      background: 'rgba(16, 19, 24, 0.84)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)'
    });

    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Sync source user');
    Object.assign(select.style, {
      width: '100%',
      height: '40px',
      marginBottom: '12px',
      padding: '0 12px',
      borderRadius: '10px',
      border: '1px solid rgba(255, 255, 255, 0.16)',
      background: 'rgba(255, 255, 255, 0.10)',
      color: '#ffffff'
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Sync';
    Object.assign(button.style, {
      display: 'block',
      width: '100%',
      height: '42px',
      border: 'none',
      borderRadius: '999px',
      background: 'linear-gradient(135deg, #00d4aa, #4ae3bf)',
      color: '#081711',
      fontSize: '15px',
      fontWeight: '700',
      cursor: 'pointer'
    });

    button.addEventListener('click', () => {
      const value = select.value;
      this.requestSync(value ? Number(value) : null);
    });

    controls.appendChild(select);
    controls.appendChild(button);
    this.overlayContentEl.appendChild(controls);

    this.inactiveControlsEl = controls;
    this.inactiveTargetSelectEl = select;
    this.inactiveSyncButtonEl = button;
  }

  /**
   * Populates the AFK sync target list.
   * @private
   * @returns {void}
   */
  _populateInactiveTargets() {
    if (!this.inactiveTargetSelectEl) return;

    const previousValue = this.inactiveTargetSelectEl.value;
    this.inactiveTargetSelectEl.innerHTML = '';

    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'Auto-select best user';
    autoOption.style.color = '#101317';
    this.inactiveTargetSelectEl.appendChild(autoOption);

    const users = [...appState.users.values()]
      .filter((user) => user && user.id !== appState.sessionIndex)
      .sort((a, b) => {
        if (!!a.afk !== !!b.afk) return Number(!!a.afk) - Number(!!b.afk);
        return ((a.username || a.name || '')).localeCompare(b.username || b.name || '');
      });

    for (const user of users) {
      const option = document.createElement('option');
      option.value = String(user.id);
      const label = user.username || user.name || `User ${user.id}`;
      option.textContent = user.afk ? `${label} (inactive)` : label;
      option.style.color = '#101317';
      this.inactiveTargetSelectEl.appendChild(option);
    }

    if ([...this.inactiveTargetSelectEl.options].some((option) => option.value === previousValue)) {
      this.inactiveTargetSelectEl.value = previousValue;
    }
  }

  /**
   * Shows the AFK UI while leaving the rest of the app interactive.
   * @returns {void}
   */
  showInactiveUi() {
    this._ensureInactiveControls();
    this._populateInactiveTargets();
    if (this.overlayEl) {
      this.overlayEl.classList.add('active');
      this.overlayEl.style.pointerEvents = 'auto';
    }
    if (this.progressTextEl) {
      this.progressTextEl.textContent = 'You are inactive - please resync';
    }
    if (this.progressBarEl) {
      this.progressBarEl.style.display = 'none';
    }
    if (this.inactiveControlsEl) {
      this.inactiveControlsEl.style.display = 'block';
    }
  }

  /**
   * Hides the AFK UI.
   * @returns {void}
   */
  hideInactiveUi() {
    if (this.inactiveControlsEl) {
      this.inactiveControlsEl.style.display = 'none';
    }
    if (!this.syncing && this.overlayEl) {
      this.overlayEl.classList.remove('active');
      this.overlayEl.style.pointerEvents = '';
    }
  }

  /**
   * Marks whether the local user is inactive and should resync.
   * @param {boolean} inactive - Whether the local user is inactive.
   * @returns {void}
   */
  setInactive(inactive) {
    this.inactive = !!inactive;
    if (this.inactive) {
      this.showInactiveUi();
    } else {
      this.hideInactiveUi();
    }
  }

  /**
   * Whether canvas interactions should be blocked.
   * @returns {boolean}
   */
  isCanvasInputBlocked() {
    return !!this.inactive;
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

    const normalizedTarget = targetUserId !== null && targetUserId !== undefined
      ? Number(targetUserId)
      : null;

    if (this.syncing) {
      if (normalizedTarget === null) {
        console.warn('[SyncClient] Already syncing, ignoring duplicate auto-sync request');
        return;
      }
      console.log(`[SyncClient] Switching sync provider from ${this.currentSyncTargetId ?? 'auto'} to ${normalizedTarget}`);
    }

    if (this.hasCompletedSync && normalizedTarget === null && !this.inactive) {
      console.log('[SyncClient] Already completed initial sync, ignoring duplicate auto-sync request');
      return;
    }

    this._resetSyncAttempt();

    if (this.app?.users && this.app?.remoteUserHandler) {
      for (const [userId, user] of this.app.users.entries()) {
        if (userId === this.app.sessionIndex) continue;
        this.app.remoteUserHandler._cleanupTransientUserState?.(user);
      }
      this.app.remoteUserHandler.resetTransientState?.();
    }

    if (this.board?.layerManager) {
      console.log('[SyncClient] Clearing existing canvas before sync...');
      this.board.layerManager.clearAll();
      this.board.markCompositeFull();
      this.board.compositeAllLayers();
    }

    this.syncing = true;
    this._syncSessionId += 1;
    this.inactive = false;
    this.buffering = true;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = normalizedTarget;

    this._armSyncTimeout(this.SYNC_INITIAL_TIMEOUT_MS);

    this.showOverlay();
    this.updateProgress();

    if (normalizedTarget !== null) {
      console.log(`[SyncClient] Requesting canvas sync from user ${normalizedTarget}...`);
    } else {
      console.log('[SyncClient] Requesting canvas sync (auto-select provider)...');
    }

    this.wsClient.requestSync(normalizedTarget);
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
   * Clears any in-progress sync bookkeeping before starting a new request.
   * @returns {void}
   * @private
   */
  _resetSyncAttempt() {
    this._syncSessionId += 1;
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    this.syncing = false;
    this.buffering = false;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = null;
  }

  /**
   * Starts or refreshes the sync idle timeout.
   *
   * @param {number} [timeoutMs=this.SYNC_IDLE_TIMEOUT_MS] - Time to wait for more sync progress.
   * @returns {void}
   * @private
   */
  _armSyncTimeout(timeoutMs = this.SYNC_IDLE_TIMEOUT_MS) {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(() => {
      if (!this.syncing) return;
      console.warn('[SyncClient] Sync timeout - completing anyway');
      this.handleSyncComplete();
    }, timeoutMs);
  }

  /**
   * Refreshes the sync timeout after receiving progress from the provider.
   * @returns {void}
   * @private
   */
  _noteSyncProgress() {
    if (!this.syncing) return;
    this._armSyncTimeout(this.SYNC_IDLE_TIMEOUT_MS);
  }

  /**
   * Aborts an in-progress sync and ignores any late packets from that attempt.
   *
   * @param {string} [reason='Sync cancelled'] - Optional UI message.
   * @param {{markCompleted?: boolean}} [options={}] - Additional behavior flags.
   * @returns {void}
   */
  abortSync(reason = 'Sync cancelled', options = {}) {
    const { markCompleted = true } = options;
    if (!this.syncing && !this.buffering) return;

    console.warn('[SyncClient] Aborting sync:', reason);
    this._resetSyncAttempt();
    this.hideOverlay();
    this.inactive = false;
    this.hasCompletedSync = !!markCompleted;

    if (this.progressTextEl) {
      this.progressTextEl.textContent = reason;
    }
    if (this.progressFillEl) {
      this.progressFillEl.style.width = '0%';
    }
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

    // Selection moves are throttled separately from the general input buffer.
    // Flush any pending final corners before we snapshot so inactive-tab replay
    // does not stop on an older move/rotation state.
    const selectToolLoader = this.app?.toolManager?.getTool?.('select');
    const selectTool = selectToolLoader?.realTool ?? selectToolLoader;
    selectTool?.flushPendingSelectionBroadcast?.();

    // Drain any pending broadcasts before snapshotting, so snapshot is consistent with sent state
    this.app?.inputBufferManager?.drainBroadcastQueue?.();

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
            // For blur/glitchBlur strokes, send the computed result instead of the mask
            const isFilter = stroke.filterType === 'blur' || stroke.filterType === 'glitchBlur';
            const sourceCanvas = (isFilter && stroke._cachedBlurResult) ? stroke._cachedBlurResult : stroke.canvas;
            const img = await this._captureCanvasElement(sourceCanvas);
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
            const isFilter = record.filterType === 'blur' || record.filterType === 'glitchBlur';
            const sourceCanvas = (isFilter && record._cachedBlurResult) ? record._cachedBlurResult : record.canvas;
            const img = await this._captureCanvasElement(sourceCanvas);
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
    if (!this.syncing) return;
    this._noteSyncProgress();
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
    if (!this.syncing) return;
    this._noteSyncProgress();
    const syncSessionId = this._syncSessionId;
    const p = this._importLayerBin(data, syncSessionId);
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
  async _importLayerBin(data, syncSessionId = this._syncSessionId) {
    if (!this.board?.layerManager) return;
    try {
      const blob = new Blob([data.imageData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      if (syncSessionId !== this._syncSessionId || !this.syncing) {
        bitmap.close();
        return;
      }
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
    if (!this.syncing) return;
    this._noteSyncProgress();
    const syncSessionId = this._syncSessionId;
    const p = this._importStroke(data, syncSessionId);
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
  async _importStroke(data, syncSessionId = this._syncSessionId) {
    if (!this.board?.layerManager) return;

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Stroke import timeout (>2s)')), 2000);
    });

    try {
      await Promise.race([
        (async () => {
          const blob = new Blob([data.imageData], { type: 'image/png' });
          const bitmap = await createImageBitmap(blob);
          if (syncSessionId !== this._syncSessionId || !this.syncing) {
            bitmap.close();
            return;
          }

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
    if (!this.syncing || !data.strokes || !Array.isArray(data.strokes)) return;
    this._noteSyncProgress();

    const syncSessionId = this._syncSessionId;

    for (const s of data.strokes) {
      // Note: s is already mapped by WebSocketClient to have imageData, w, h, etc.
      const p = this._importStroke(s, syncSessionId);
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
    this._noteSyncProgress();
    if (!this.syncing) return;
    // No action needed here — handleSyncComplete waits for _pendingImports.
  }

  /**
   * Applies dirty tile data received from sync provider.
   * @param {Object} data - Tile occupancy payload
   * @param {Array} data.dirtyTiles - Array of dirty tile indices
   * @returns {void}
   */
  handleSyncDirtyTiles(data) {
    this._noteSyncProgress();
    if (!this.syncing) return;
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
    if (!this.syncing) return;
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }

    const pending = this._pendingImports;
    this._pendingImports = [];

    const finalize = () => {
      if (this.board) {
        this.board.markCompositeFull();
        this.board.compositeAllLayers();
      }
      this.replayBuffer();
      this.hideOverlay();
      this.syncing = false;
      this.buffering = false;
      this.hasCompletedSync = true;
      this.inactive = false;
      this.expectedMessages = 0;
      this.receivedMessages = 0;
      this.currentSyncTargetId = null;

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
      this.overlayEl.style.pointerEvents = 'auto';
    }
    if (this.progressBarEl) {
      this.progressBarEl.style.display = '';
    }
    if (this.progressHintEl) {
      this.progressHintEl.style.display = '';
    }
    if (this.inactiveControlsEl) {
      this.inactiveControlsEl.style.display = 'none';
    }
  }

  /**
   * Hides the synchronization progress overlay.
   * @returns {void}
   */
  hideOverlay() {
    if (this.overlayEl) {
      if (this.inactive) {
        this.showInactiveUi();
        return;
      }
      this.overlayEl.classList.remove('active');
      this.overlayEl.style.pointerEvents = '';
    }
    if (this.inactiveControlsEl) {
      this.inactiveControlsEl.style.display = 'none';
    }
    if (this.progressHintEl) {
      this.progressHintEl.style.display = '';
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
    this.inactiveControlsEl?.remove();
    if (this.overlayEl) {
      this.overlayEl.classList.remove('active');
      this.overlayEl.style.pointerEvents = '';
    }
    this.wsClient = null;
    this.board = null;
    this.initialized = false;
    this.hasCompletedSync = false;
    this.inactive = false;
  }

  /**
   * Reset transient sync state when leaving a room or switching rooms.
   * Keeps the instance reusable for the next room.
   * @returns {void}
   */
  resetForRoomChange() {
    this._syncSessionId += 1;
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    this.syncing = false;
    this.buffering = false;
    this.inactive = false;
    this.hasCompletedSync = false;
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = null;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.hideInactiveUi();
    this.hideOverlay();
    if (this.progressFillEl) {
      this.progressFillEl.style.width = '0%';
    }
  }
}
