/**
 * @fileoverview Client-side canvas synchronization orchestration.
 * Handles full canvas state transfer between users, including layers,
 * stroke history, and redo stacks.
 */

import { appState } from '../state.svelte.js';
import { debug } from '../utils/debug.js';
import { normalizeBlendBakeMode } from '../../shared/blendBakeMode.js';

/**
 * SyncClient manages the complex process of synchronizing the canvas state
 * from an existing user to a newly joined user.
 */
export class SyncClient {
  /**
   * Client event names of the per-user tool-state ("C*") messages. Mirrors the
   * server's StrokeTape tool-state set. These are idempotent state setters and
   * are exempt from replayBuffer's (event, seq) dedup — see replayBuffer.
   */
  static _TOOL_STATE_EVENTS = new Set([
    'ct', 'cc', 'cs', 'cp', 'csp', 'csm', 'chd', 'cbr', 'cl', 'cbm', 'cf', 'cthn', 'csim',
    // The selection mask is tool state too (StrokeTape.buildToolStateSet): it
    // rides in every stroke's preamble AND in the join serve's final
    // latest-state snapshot, and must apply at both positions. Deduping to the
    // last occurrence would strip it out of the earlier strokes' preambles and
    // replay them unclipped — the exact bug moving it into tool state fixes.
    'sel_mask',
    // The image-tool payloads (custom brush / pattern tile / confetti sprite)
    // and the pattern-mode flag are tool state for the same reason: an
    // imageBrush stroke is drawn with whatever bitmap its drawer last
    // broadcast, so the join tail interleaves brush frames with the strokes
    // that used them (StrokeTape.buildImageStateSet). Deduping to the last
    // occurrence would apply every brush switch at the END of the rebuild and
    // repaint the whole history with one brush — which is exactly the bug
    // putting them in the tape fixes.
    'gmp', 'gpt', 'image_tool', 'cpm',
  ]);

  /**
   * Per-user fields the image-tool handlers (gmp/gpt/image_tool/cpm) write.
   * Saved and restored around a rebuild for the LOCAL user only — see
   * _replayBufferInner.
   */
  static _IMAGE_TOOL_STATE_KEYS = [
    'imageBrush', 'imageBrushColorMode',
    'patternBrush', 'patternScale', 'patternRotation', 'patternSpacing',
    'patternOffsetX', 'patternOffsetY', 'patternColorMode', 'patternMode',
    'confettiBrush', 'confettiParticles', 'confettiParticleSize',
    'confettiSizeVariation', 'confettiOpacityRandomness', 'confettiSpacing',
    'confettiShape', 'confettiColorMode', 'confettiRotationMode',
  ];

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
     * True from the moment we join a room until the first requestSync() takes
     * over. See beginPendingSync().
     * @type {boolean}
     */
    this.pendingSync = false;
    /** @type {number|null} */
    this._pendingSyncTimer = null;
    /**
     * Ceiling on the pre-sync gate. UserHandlers' fallback fires at 2.5s, so
     * this only ever trips when the sync request never happens at all — better
     * a live board than one wedged behind a permanent overlay.
     * @type {number}
     */
    this.PENDING_SYNC_TIMEOUT_MS = 15000;

    /**
     * Pending async import promises — createImageBitmap is async, and we must
     * wait for ALL imports to settle before replaying buffered events.
     * @private
     * @type {Array<Promise>}
     */
    this._pendingImports = [];

    /** @type {boolean} */
    this.buffering = false;
    /**
     * Spans the whole rebuild: set in requestSync() (which wipes the board) and
     * cleared when replayBuffer() finishes dispatching. Deliberately NOT derived
     * from `buffering` — handleSyncComplete() clears that one line BEFORE
     * calling replayBuffer(), so anything keyed on it is false for the entire
     * replay. See isRebuilding().
     * @type {boolean}
     */
    this._rebuilding = false;
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
    this._drainTimer = null;
    /** @type {number|null} */
    this.currentSyncTargetId = null;
    /** @type {string|null} */
    this.currentSyncTargetUsername = null;

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
    // WebSocketClient has its own self-echo gate (see _processMessage) that
    // predates the buffering layer and must suspend for the same reason.
    if (wsClient) wsClient._isRebuilding = () => this.isRebuilding();
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
   * Creates the AFK controls inside the existing canvas overlay. Sync is
   * server-served (checkpoint + tail) rather than peer-elected, so there is
   * no user to pick — just a single button to resume.
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
      this.requestSync(null, { force: true });
    });

    controls.appendChild(button);
    this.overlayContentEl.appendChild(controls);

    this.inactiveControlsEl = controls;
    this.inactiveSyncButtonEl = button;
  }

  /**
   * Shows the AFK UI while leaving the rest of the app interactive.
   * @returns {void}
   */
  showInactiveUi() {
    this._ensureInactiveControls();
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
    if (!this.syncing && !this.pendingSync && this.overlayEl) {
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
    const wasInactive = this.inactive;
    this.inactive = !!inactive;
    if (this.inactive) {
      this.showInactiveUi();
      // While AFK the server filters draw traffic to us, so the rolling tape
      // stops seeing the full picture — flag it stale until the resync below.
      this.app?.rollingTapeRecorder?.markStale?.('afk');
    } else {
      this.hideInactiveUi();
      if (wasInactive && this.hasCompletedSync && !this.syncing && this.wsClient?.connected) {
        this.requestSync(null, { force: true });
      }
    }
  }

  /**
   * Arms the pre-sync gate.
   *
   * handleJoinAfterConnect() flips `connected`, hides the login overlay and
   * starts the tick loop — the board is fully live from that instant. But the
   * first requestSync() doesn't fire there: UserHandlers waits for a USERS
   * payload that actually names another user and then defers 500ms (or 2.5s via
   * the alone-in-the-room fallback). That left a half-second-to-two-and-a-half-
   * second window of an interactive board whose contents requestSync() was
   * about to wipe, and a stroke started inside it never got a pointerup —
   * handlePointerUp bails on isSyncing(), so `self.mousedown` stayed true and
   * the preview was never torn down.
   *
   * Hold the overlay up and the input gates closed across that window instead.
   * requestSync() clears the gate as it takes over.
   *
   * @param {string} [text='Loading...'] - Overlay message for the wait.
   * @returns {void}
   */
  beginPendingSync(text = 'Loading...') {
    if (this.syncing || this.pendingSync) return;
    this.pendingSync = true;

    this.showOverlay();
    if (this.progressTextEl) this.progressTextEl.textContent = text;
    if (this.progressFillEl) this.progressFillEl.style.width = '0%';

    if (this._pendingSyncTimer) clearTimeout(this._pendingSyncTimer);
    this._pendingSyncTimer = setTimeout(() => {
      this._pendingSyncTimer = null;
      if (!this.pendingSync) return;
      debug.warn('[SyncClient] Pending-sync gate timed out — releasing the board');
      this.clearPendingSync();
    }, this.PENDING_SYNC_TIMEOUT_MS);
  }

  /**
   * Releases the pre-sync gate. Leaves the overlay to the caller: requestSync()
   * re-shows it immediately for the sync proper, everything else wants it gone.
   *
   * @param {{hideOverlay?: boolean}} [options={}]
   * @returns {void}
   */
  clearPendingSync({ hideOverlay = true } = {}) {
    if (this._pendingSyncTimer) {
      clearTimeout(this._pendingSyncTimer);
      this._pendingSyncTimer = null;
    }
    if (!this.pendingSync) return;
    this.pendingSync = false;
    if (hideOverlay && !this.syncing) this.hideOverlay();
  }

  /**
   * Whether canvas interactions should be blocked.
   * @returns {boolean}
   */
  isCanvasInputBlocked() {
    return !!this.inactive || !!this.pendingSync;
  }

  /**
   * Requests a full canvas synchronization from the server.
   * Clears local state and prepares to buffer incoming remote events.
   *
   * @param {number|null} [targetUserId=null] - Optional specific user ID to sync from
   * @param {{force?: boolean}} [options={}] - Whether to bypass duplicate auto-sync guards
   * @returns {void}
   */
  requestSync(targetUserId = null, options = {}) {
    debug('[SyncClient] requestSync called, current syncing state:', this.syncing);
    debug.trace('[SyncClient] requestSync call stack');

    if (!this.wsClient) {
      debug.warn('[SyncClient] Cannot request sync - no wsClient');
      return;
    }

    // We're taking over the gate below (or bailing out of it on an early
    // return), so retire the pre-sync hold either way.
    this.clearPendingSync({ hideOverlay: false });

    const normalizedTarget = targetUserId !== null && targetUserId !== undefined
      ? Number(targetUserId)
      : null;
    const force = options?.force === true;

    if (this.syncing) {
      if (normalizedTarget === null) {
        debug.warn('[SyncClient] Already syncing, ignoring duplicate auto-sync request');
        return;
      }
      debug(`[SyncClient] Switching sync provider from ${this.currentSyncTargetId ?? 'auto'} to ${normalizedTarget}`);
    }

    if (this.hasCompletedSync && normalizedTarget === null && !this.inactive && !force) {
      debug('[SyncClient] Already completed initial sync, ignoring duplicate auto-sync request');
      // Nothing is going to raise the overlay again on this path — don't leave
      // the pre-sync hold painted over a board we've already released.
      if (!this.syncing) this.hideOverlay();
      return;
    }

    this._resetSyncAttempt();

    // A sync can land while WE are mid-stroke — an AFK resync, a parity
    // fallback, or a moderator-triggered resync from the user list. The board
    // wipe below drops the local half-stroke's pixels, but nothing closes the
    // stroke itself: handlePointerUp bails on isSyncing(), so `self.mousedown`
    // would stay true past _completeSync() and the next pointermove would keep
    // extending a stroke that was never started. cancelCurrentStroke() tears
    // down the tool state, the preview and the active stroke canvas, and sends
    // the CANCEL that tells peers to drop their copy of it too.
    if (this.app?.hasCurrentStrokeInProgress?.()) {
      this.app.cancelCurrentStroke?.();
    }

    const activeRemoteUserIds = new Set();
    if (this.app?.users && this.app?.remoteUserHandler) {
      for (const [userId, user] of this.app.users.entries()) {
        if (userId === this.app.sessionIndex) continue;
        if (user?.mousedown && !user?.panning) {
          activeRemoteUserIds.add(user.id);
          continue;
        }
        this.app.remoteUserHandler._cleanupTransientUserState?.(user);
      }
      if (activeRemoteUserIds.size === 0) {
        this.app.remoteUserHandler.resetTransientState?.();
      }
      // The loop above deliberately skips our own index, but the rebuild now
      // drives our OWN frames through the remote pipeline, so `app.self` also
      // accumulates RemoteSelectionHandler state — floatingCanvas, lassoPath,
      // _selectionRestoreData, the overlay canvas, and `pendingImageLoad`.
      // Nothing else ever resets it, so every rebuild after the first started
      // from the previous one's leftovers; a stale `pendingImageLoad` is the
      // worst of them, because _queueIfLoading would chain the entire next
      // selection sequence onto a promise that already settled in a prior sync,
      // and the lift/move/commit chain would apply against dead state.
      //
      // Only the selection fields, and only via the handler that owns them:
      // SelectTool keeps its own selection on the tool, never on the user, so
      // this cannot disturb a live local selection.
      if (this.app.self) {
        this.app.remoteUserHandler.selectionHandler?._cleanupUserSelection?.(this.app.self);
      }
    }

    const preservedActiveStrokes = this._cloneActiveStrokesForUsers(activeRemoteUserIds);
    if (this.board?.layerManager) {
      debug('[SyncClient] Clearing existing canvas before sync...');
      this.board.layerManager.clearAll();
      // clearAll() destroys every activeStrokeByUser entry, so every entry in
      // the board's mask-clip ledger now names a canvas that no longer exists.
      // Left in place, applySelectionMaskClipForStroke short-circuits on the
      // stale key and the next stroke escapes an active mask.
      this.board.resetSelectionMaskClipTracking?.();
      this._restoreActiveStrokes(preservedActiveStrokes);
      this.board.markCompositeFull();
      this.board.compositeAllLayers();
    }

    this.syncing = true;
    this._syncSessionId += 1;
    this.inactive = false;
    this.buffering = true;
    // The board was just cleared above, so from here until replayBuffer() has
    // dispatched, our own frames are content to rebuild rather than echoes to
    // discard.
    this._rebuilding = true;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = normalizedTarget;

    // Look up the target username if syncing from a specific user
    this.currentSyncTargetUsername = this._getSyncTargetUsername(normalizedTarget);

    this._armSyncTimeout(this.SYNC_INITIAL_TIMEOUT_MS);

    this.showOverlay();
    this.updateProgress();

    if (normalizedTarget !== null) {
      debug(`[SyncClient] Requesting canvas sync from user ${normalizedTarget}...`);
    } else {
      // The server always serves a checkpoint + post-checkpoint command tail here
      // (SyncCoordinator._serveCheckpointJoin); there is no live-peer provider
      // election on the join path anymore.
      debug('[SyncClient] Requesting checkpoint-based canvas sync...');
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
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    this.syncing = false;
    this.buffering = false;
    this._rebuilding = false;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = null;
    this.currentSyncTargetUsername = null;
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
      debug.warn('[SyncClient] Sync timeout - completing anyway');
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
   * Resolves a sync provider session index into the display name used in the overlay.
   *
   * @param {number|null} providerSessionIndex - Provider session index.
   * @returns {string|null}
   * @private
   */
  _getSyncTargetUsername(providerSessionIndex) {
    if (providerSessionIndex === null || providerSessionIndex === undefined || !Number.isFinite(Number(providerSessionIndex))) {
      return null;
    }

    const targetUser = this.app?.users?.get(Number(providerSessionIndex));
    return targetUser?.username || targetUser?.name || `User ${providerSessionIndex}`;
  }

  /**
   * Updates the overlay target once the server confirms which provider is sending data.
   *
   * @param {number|null} providerSessionIndex - Provider session index.
   * @returns {void}
   * @private
   */
  _setSyncTargetFromProvider(providerSessionIndex) {
    if (providerSessionIndex === null || providerSessionIndex === undefined) return;

    const normalizedProvider = Number(providerSessionIndex);
    if (!Number.isFinite(normalizedProvider)) return;

    this.currentSyncTargetId = normalizedProvider;
    this.currentSyncTargetUsername = this._getSyncTargetUsername(normalizedProvider);
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

    debug.warn('[SyncClient] Aborting sync:', reason);
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
   * Receives synchronization metadata containing the total message count.
   *
   * @param {Object} data - Metadata payload
   * @param {number} data.totalCount - Total number of messages expected during sync
   * @returns {void}
   */
  handleSyncMetadata(data) {
    if (!this.syncing) return;
    this._noteSyncProgress();
    this._setSyncTargetFromProvider(data.providerSessionIndex);
    this._resizeBoardForIncomingDimensions(data.boardWidth, data.boardHeight);
    this.expectedMessages = data.totalCount || 0;
    this.updateProgress();
  }

  /**
   * Counts the checkpoint base image used by the checkpoint-join sync path.
   * This is not a user-triggered snapshot restore; it is the first sync payload.
   *
   * @returns {void}
   */
  handleSyncCheckpointRestore() {
    if (!this.syncing) return;
    this._noteSyncProgress();
    this.receivedMessages++;
    this.updateProgress();
  }

  _cloneActiveStrokesForUsers(userIds) {
    if (!this.board?.layerManager || !userIds || userIds.size === 0) return [];
    const clones = [];
    const lm = this.board.layerManager;
    for (let layerIdx = 0; layerIdx < lm.layerGroups.length; layerIdx++) {
      const group = lm.layerGroups[layerIdx];
      for (const [userId, active] of group.activeStrokeByUser.entries()) {
        if (!userIds.has(userId) || !active?.canvas) continue;
        const canvas = document.createElement('canvas');
        canvas.width = active.canvas.width;
        canvas.height = active.canvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(active.canvas, 0, 0);
        clones.push({
          layerIdx,
          userId,
          active: {
            ...active,
            canvas,
            ctx,
            dirtyRect: active.dirtyRect ? { ...active.dirtyRect } : { minX: 0, minY: 0, maxX: canvas.width - 1, maxY: canvas.height - 1 },
            affectedTiles: new Set(active.affectedTiles ? Array.from(active.affectedTiles) : [])
          }
        });
      }
    }
    return clones;
  }

  _restoreActiveStrokes(strokes) {
    if (!this.board?.layerManager || !Array.isArray(strokes) || strokes.length === 0) return;
    const lm = this.board.layerManager;
    for (const { layerIdx, userId, active } of strokes) {
      const group = lm.layerGroups[layerIdx];
      if (!group || group.activeStrokeByUser.has(userId)) continue;
      group.activeStrokeByUser.set(userId, active);
      // _cloneActiveStrokesForUsers hands back a FRESH canvas and context, so
      // any clip the original was carrying is gone. If this user's mask is
      // still active, re-arm it — otherwise the remainder of a stroke that was
      // in flight across the resync paints outside the mask on this client
      // only. (The ledger was just cleared above, so this re-registers the key
      // and MU releases it normally.)
      this.board.applySelectionMaskClipForStroke?.(layerIdx, userId);
    }
  }

  _resizeBoardForIncomingDimensions(width, height) {
    const nextW = Number(width);
    const nextH = Number(height);
    if (!this.board || !Number.isFinite(nextW) || !Number.isFinite(nextH) || nextW <= 0 || nextH <= 0) return;

    const [curH, curW] = this.board.dimensions || [];
    if (curW === nextW && curH === nextH) return;

    this.board.resizeBoard([nextH, nextW]);
    this.app?._bindLayerManagerDependencies?.();
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
    this._pendingImports.push({ promise: p, layerIdx: data.layerIdx });
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
    this._pendingImports.push({ promise: p, layerIdx: data.layerIdx });
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
            blendBakeMode: normalizeBlendBakeMode(data.blendBakeMode),
            userId: data.userId,
            timestamp: data.timestamp,
            seq: data.seq || 0,
            affectedTiles: data.affectedTiles || []
          };
          if (data.eraseAll) record.eraseAll = true;

          if (!data.isRedo) {
            if (data.activeStroke) {
              this._importActiveStroke(data.layerIdx, record);
            } else {
              this.board.layerManager.importStroke(data.layerIdx, record);
            }
          } else {
            this.board.layerManager.importRedoStroke(data.userId, data.redoBatchIdx, data.layerIdx, record);
          }

          this._scheduleComposite();
        })(),
        timeout
      ]);
    } catch (error) {
      debug.warn(`[SyncClient] Skipping stroke (User: ${data.userId}, Layer: ${data.layerIdx}):`, error.message || error);
    }
  }

  _importActiveStroke(layerIdx, record) {
    const lm = this.board?.layerManager;
    const group = lm?.layerGroups?.[layerIdx];
    if (!group || !record?.canvas) return;

    const existing = group.activeStrokeByUser.get(record.userId);
    if (existing?.canvas) return;

    // record.canvas is cropped to record.x/y/width/height, NOT full-board —
    // same shape as a committed StrokeRecord. Track that as `origin`/`x`/`y`
    // (the same fields LayerManager's own windowed active strokes use — see
    // docs/scope_layermanager_active_stroke_windowing_RESULT.md) so any
    // further draw into this stroke (a CP/CS/MU arriving after this sync
    // snapshot) offsets correctly instead of assuming board-absolute (0,0).
    const isFullBoard = record.width === lm.width && record.height === lm.height
      && record.x === 0 && record.y === 0;
    group.activeStrokeByUser.set(record.userId, {
      canvas: record.canvas,
      ctx: record.ctx,
      origin: isFullBoard ? null : { x: record.x, y: record.y },
      x: isFullBoard ? 0 : record.x,
      y: isFullBoard ? 0 : record.y,
      blendMode: record.blendMode || 'source-over',
      blendBakeMode: normalizeBlendBakeMode(record.blendBakeMode),
      dirtyRect: {
        minX: record.x,
        minY: record.y,
        maxX: record.x + record.width - 1,
        maxY: record.y + record.height - 1
      },
      affectedTiles: new Set(record.affectedTiles || []),
      eraseAll: !!record.eraseAll
    });

    const user = this.app?.users?.get(record.userId);
    if (user && user.id !== this.app?.sessionIndex) {
      user.mousedown = true;
      user._strokeLayer = layerIdx;
    }

    lm.needsComposite = true;
    lm._notifyStrokeHistoryPanel?.();
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
    const layerIdx = data.layerIdx;

    for (const s of data.strokes) {
      // Note: s is already mapped by WebSocketClient to have imageData, w, h, etc.
      const p = this._importStroke(s, syncSessionId);
      this._pendingImports.push({ promise: p, layerIdx });
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
    debug(`[SyncClient] Applying ${tiles.length} dirty tile entries`);

    for (const tileIdx of tiles) {
      // Handle both formats: simple index or legacy {idx, users}
      const idx = typeof tileIdx === 'number' ? tileIdx : tileIdx.idx;
      tt.markTileDirty(idx);
    }
  }

  /**
   * Finalizes the synchronization process once all pending imports settle.
   * Prioritizes main layers (0-2) to be fully loaded and composited before other layers.
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
      // Stop re-buffering: the replayed tail and any newly-arriving live events
      // should flow straight to their handlers so the board can drain to the
      // present moment.
      this.buffering = false;
      const bufferedCount = this.eventBuffer.length;
      this.replayBuffer();
      // Nothing was buffered, so there is no replay to wait on: finish now
      // rather than parking the board under a "Catching up..." overlay that
      // describes work we never did. This is the common case for a solo or
      // quiet-room join.
      if (bufferedCount === 0) {
        this._completeSync();
        return;
      }
      // The buffered command tail is dispatched synchronously above, but it does
      // not become visible immediately — remote strokes composite on a later
      // frame and the RemoteUserHandler catch-up loop animates cursors to their
      // final positions. Keep `syncing` true (the overlay stays up and local
      // input stays blocked via isSyncing()) until that work settles, so the
      // user can't draw onto a half-replayed board. _drainReplay() finishes the
      // teardown once the replay has visibly caught up.
      this._drainReplay();
    };

    if (pending.length > 0) {
      this.updateProgress('Processing images...');

      // Separate main layer imports (0-2) from others to prioritize loading
      const mainLayerImports = [];
      const otherLayerImports = [];

      for (const item of pending) {
        const layerIdx = item.layerIdx ?? 0;
        if (layerIdx < 3) {
          mainLayerImports.push(item.promise);
        } else {
          otherLayerImports.push(item.promise);
        }
      }

      // Load main layers first, then composite before loading other layers
      Promise.all(mainLayerImports)
        .then(() => {
          // Composite main layers immediately
          if (this.board) {
            this.board.compositeAllLayers();
            debug('[SyncClient] Main layers loaded and composited');
          }
          // Now load other layers
          return Promise.all(otherLayerImports);
        })
        .then(finalize)
        .catch((err) => {
          console.error('[SyncClient] Error during stroke import:', err);
          finalize();
        });
    } else {
      finalize();
    }
  }

  /**
   * Holds the sync overlay open while the replayed command tail finishes drawing
   * onto the visible canvas. replayBuffer() dispatches the buffered events
   * synchronously, but remote strokes composite over subsequent frames and the
   * RemoteUserHandler catch-up loop animates cursors to their final positions.
   * We force a composite and poll until that work is idle (or a safety cap
   * elapses) before tearing the overlay down and releasing local input — so the
   * "Syncing..." UI covers the actual replay, not just the data transfer.
   *
   * @private
   * @returns {void}
   */
  _drainReplay() {
    const sessionId = this._syncSessionId;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const startedAt = now();
    const MAX_DRAIN_MS = 5000;      // safety cap so the overlay can never wedge open
    const REQUIRED_IDLE_TICKS = 3;  // consecutive idle polls before we call replay done
    const POLL_MS = 48;             // ~3 frames; setTimeout keeps draining in hidden tabs (rAF is paused)
    let idleTicks = 0;
    let announced = false;

    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }

    const poll = () => {
      // A newer sync attempt (or a room change/reset) superseded this drain.
      if (sessionId !== this._syncSessionId || !this.syncing) {
        this._drainTimer = null;
        return;
      }

      // Push the freshly-replayed strokes onto the composited canvas so they are
      // visible underneath the overlay before we hide it.
      this.board?.compositeAllLayers();

      const backlogged = this._hasCatchupBacklog();
      // Only claim to be catching up once there is something to catch up on.
      // Otherwise a quiet join flashed "Catching up..." for the handful of
      // idle polls it takes to confirm there is no backlog.
      if (backlogged && !announced) {
        announced = true;
        this.updateProgress('Catching up...');
      }
      idleTicks = backlogged ? 0 : idleTicks + 1;

      if (idleTicks >= REQUIRED_IDLE_TICKS || (now() - startedAt) >= MAX_DRAIN_MS) {
        this._drainTimer = null;
        this._completeSync();
        return;
      }
      this._drainTimer = setTimeout(poll, POLL_MS);
    };

    this._drainTimer = setTimeout(poll, POLL_MS);
  }

  /**
   * Whether any remote cursor is still far enough behind its latest target that
   * the replayed tail is visibly unfinished.
   *
   * This deliberately does NOT test `remoteUserHandler.catchupTimer`, which was
   * the old signal. That timer runs for as long as ANY remote user is mid-
   * stroke, and every live MM restarts it — so if someone else was simply
   * drawing while we joined, it never went null and the drain sat on its full
   * 5s cap with the overlay up. What actually distinguishes replay backlog from
   * live drawing is distance: a replayed tail leaves the interpolated cursor a
   * long way behind its target, while a live stroke stays within a few pixels
   * of it.
   *
   * @private
   * @returns {boolean}
   */
  _hasCatchupBacklog() {
    const users = this.app?.users;
    if (!users || !this.app?.remoteUserHandler?.catchupTimer) return false;

    const BACKLOG_DIST = 48;                        // board px
    const BACKLOG_DIST_SQ = BACKLOG_DIST * BACKLOG_DIST;
    const selfIdx = this.app.sessionIndex;

    for (const [userId, user] of users.entries()) {
      if (userId === selfIdx) continue;
      if (!user?.mousedown || user.panning) continue;
      const target = user.remoteTarget;
      const buffer = user.smoothBuffer;
      if (!target || !buffer) continue;
      const dx = target.x - buffer.x;
      const dy = target.y - buffer.y;
      if (dx * dx + dy * dy > BACKLOG_DIST_SQ) return true;
    }
    return false;
  }

  /**
   * Finishes sync teardown once the replayed tail has drained. Hides the
   * overlay, releases local input, and fires the sync-complete callback.
   *
   * @private
   * @returns {void}
   */
  _completeSync() {
    if (this.board) {
      this.board.markCompositeFull();
      this.board.compositeAllLayers();
    }
    this.clearPendingSync({ hideOverlay: false });
    this.hideOverlay();
    this.syncing = false;
    this.buffering = false;
    // Backstop: replayBuffer's finally normally clears this, but a sync that
    // times out or aborts never reaches it.
    this._rebuilding = false;
    this.hasCompletedSync = true;
    this.inactive = false;
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = null;
    this.currentSyncTargetUsername = null;

    if (this.onSyncComplete) {
      this.onSyncComplete();
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
    if (this.syncing) {
      this._noteSyncProgress();
      this.receivedMessages++;
      this.updateProgress();
    }
    this.eventBuffer.push({ eventName, data });
  }

  /**
   * Replays all buffered remote events in their original sequence.
   * @returns {void}
   */
  replayBuffer() {
    try {
      this._replayBufferInner();
    } finally {
      // Every exit path retires the rebuild window, including the early return
      // and any handler that throws. Leaving it set would make live self-echoes
      // look like content to redraw and double-apply our own strokes.
      this._rebuilding = false;
    }
  }

  /** @private */
  _replayBufferInner() {
    if (!this.handlerMap || this.eventBuffer.length === 0) {
      this.eventBuffer = [];
      return;
    }

    // Pre-create remote users for any sessionIndex referenced in the buffered
    // stream that isn't already known. The checkpoint-join tail can replay
    // strokes from a user who has since LEFT (absent from our USERS list); the
    // draw handlers `users.get(sid)` and silently bail without this. The next
    // authoritative USERS broadcast cleans up these placeholders. See
    // App.ensureRemoteUser.
    if (this.app?.ensureRemoteUser) {
      for (const { data } of this.eventBuffer) {
        const sid = data?.sessionIndex;
        // Called for EVERY author, our own session included, and no longer
        // skipped when users already has the id: on a resync the tail replays
        // our own commits through the remote draw path, which needs a context to
        // render into, and the local user has never had one. ensureRemoteUser is
        // idempotent and now provisions that lazily — see App.ensureRemoteUser.
        if (sid !== undefined && sid !== null) {
          this.app.ensureRemoteUser(sid);
        }
      }
    }

    // Dedup by (event, seq): the server assigns every room broadcast a unique
    // seq, and the sync tail replays ORIGINAL wire bytes — so a message that
    // reached us both live (buffered) and via the tail appears here twice with
    // identical content. Applying both would duplicate strokes/commits. Keep
    // the LAST occurrence: the tail copy sits inside its stroke's full
    // preamble, whereas an earlier live copy may be a mid-stroke fragment
    // buffered before the tail (applying it first would put MM continuations
    // ahead of their MD). Events without a seq (targeted/out-of-band) are
    // never deduped.
    // Tool-state events are EXEMPT from dedup: they are idempotent state
    // setters, and the join serve intentionally re-sends each user's latest
    // tool-state frames at the end of the sync (SyncCoordinator step 2c). A
    // frame appearing both inside a tail stroke's preamble and in that final
    // snapshot must apply at BOTH positions — deduping to the last occurrence
    // would strip the config out of the earlier stroke's preamble and render
    // it with the previous stroke's color/size.
    // Diagnostic: a rebuild that silently applies nothing is indistinguishable
    // from one the server never fed. Tally what actually ran, split by author,
    // so "blank board after resync" resolves to one of: nothing arrived (server
    // side), arrived but our own frames were filtered (a self-echo gate), or
    // applied but painted nothing (draw path).
    const tally = Object.create(null);
    let bufferedTotal = this.eventBuffer.length;
    let applied = 0;
    let appliedOwn = 0;
    let bufferedOwn = 0;
    for (const { data } of this.eventBuffer) {
      if (data?.sessionIndex === this.app?.sessionIndex) bufferedOwn++;
    }

    // Our OWN image-tool state, saved across the replay. A rebuild dispatches
    // the tail's frames whoever wrote them (see wrapHandler's `rebuilding`
    // gate), so our own brush switches re-apply to `self` while our strokes are
    // redrawn — which is the point: they have to, or our history rebuilds with
    // one brush. But the frames carry the stripped WIRE payload, so what `self`
    // is left holding is a parsed copy of our current brush rather than the
    // gallery object the local tools use (a .gih loses its frame cycling, an
    // uploaded brush its decoded bitmaps). Same content, poorer object — so put
    // ours back once the replay has finished with them.
    const selfUser = this.app?.self;
    const selfImageToolState = selfUser
      ? SyncClient._IMAGE_TOOL_STATE_KEYS.reduce((acc, key) => {
        acc[key] = selfUser[key];
        return acc;
      }, {})
      : null;

    const TOOL_STATE_EVENTS = SyncClient._TOOL_STATE_EVENTS;
    const lastIndexByKey = new Map();
    for (let i = 0; i < this.eventBuffer.length; i++) {
      const { eventName, data } = this.eventBuffer[i];
      if (data?.seq && !TOOL_STATE_EVENTS.has(eventName)) {
        lastIndexByKey.set(`${eventName}:${data.seq}`, i);
      }
    }
    for (let i = 0; i < this.eventBuffer.length; i++) {
      const { eventName, data } = this.eventBuffer[i];
      const seq = data?.seq;
      if (seq && !TOOL_STATE_EVENTS.has(eventName) &&
          lastIndexByKey.get(`${eventName}:${seq}`) !== i) continue;
      const handler = this.handlerMap.get(eventName);
      if (handler) {
        handler(data);
        applied++;
        tally[eventName] = (tally[eventName] || 0) + 1;
        if (data?.sessionIndex === this.app?.sessionIndex) appliedOwn++;
      }
    }
    this.eventBuffer = [];
    if (selfImageToolState) Object.assign(selfUser, selfImageToolState);

    // `own=0` here while the board is blank is the signature of a self-echo gate
    // eating the tail; `buffered=0` means the tail never reached replayBuffer at
    // all (something non-queued overtook SYNC_COMPLETE).
    debug(
      `[SyncClient] replay: buffered=${bufferedTotal} (own=${bufferedOwn}) ` +
      `applied=${applied} (own=${appliedOwn}) rebuilding=${this.isRebuilding()} ` +
      `self=${this.app?.sessionIndex}`,
      tally
    );

    // The tail may have driven our OWN strokes through the remote pipeline,
    // which registers user.context.canvas as a live preview layer in the
    // compositor and hides the overlay behind it. Nothing writes to the local
    // user's overlay outside a rebuild, so retire it here instead of leaving a
    // permanently-registered preview. Committed strokes are unaffected — this
    // only drops the in-progress preview surface.
    const self = this.app?.self;
    if (self?.context) {
      const retire = () => {
        if (!self.context) return;
        self.context.clearRect(0, 0, self.context.canvas.width, self.context.canvas.height);
        this.app.remoteUserHandler?._clearLayeredRemotePreview?.(self);
      };
      // Must run AFTER the selection chain, not here. Selection verbs defer
      // behind the SEL_LIFT PNG decode (_queueIfLoading), so on a rebuild the
      // lift/move/stamp/commit sequence drains in microtasks well after this
      // function returns — and finalizeLiftPreview paints the marching-ants
      // outline onto this very canvas. Clearing synchronously wiped it BEFORE
      // the chain drew, leaving a stray lasso marquee stuck on the local board
      // with no selection behind it.
      if (self.pendingImageLoad) self.pendingImageLoad.then(retire, retire);
      else retire();
    }
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

    // Build the sync text with target username if available
    const syncPrefix = this.currentSyncTargetUsername
      ? `Syncing to.. ${this.currentSyncTargetUsername}`
      : 'Syncing...';

    if (this.expectedMessages > 0) {
      const displayReceived = Math.min(this.receivedMessages, this.expectedMessages);
      percentage = Math.min(100, Math.round((displayReceived / this.expectedMessages) * 100));
      text = `${syncPrefix} ${displayReceived}/${this.expectedMessages} (${percentage}%)`;
      if (this.progressFillEl) {
        this.progressFillEl.style.width = `${percentage}%`;
      }
    } else {
      text = syncPrefix;
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
   * Captures a canvas element's content as a PNG encoded Uint8Array with timeout protection.
   * Returns null if the capture times out after 5 seconds (for non-main layers).
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas to capture
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds (null for no timeout)
   * @returns {Promise<Uint8Array|null>}
   */
  _captureCanvasElement(canvas, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let timeoutHandle = null;
      let completed = false;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        completed = true;
      };

      const capturePromise = new Promise((captureResolve, captureReject) => {
        canvas.toBlob(
          async (blob) => {
            if (!blob) {
              captureReject(new Error('Failed to create blob from canvas'));
              return;
            }
            const arrayBuffer = await blob.arrayBuffer();
            captureResolve(new Uint8Array(arrayBuffer));
          },
          'image/png'
        );
      });

      if (timeoutMs) {
        timeoutHandle = setTimeout(() => {
          if (!completed) {
            completed = true;
            resolve(null); // Return null on timeout for non-main layers
          }
        }, timeoutMs);
      }

      capturePromise
        .then((result) => {
          if (!completed) {
            cleanup();
            resolve(result);
          }
        })
        .catch((error) => {
          if (!completed) {
            cleanup();
            reject(error);
          }
        });
    });
  }

  /**
   * Captures a layer canvas for sync. Layer 0's baked flat canvas can contain
   * room background pixels after blend-mode baking, so strip border-connected
   * background before sending it to preserve a transparent base layer.
   *
   * @private
   * @param {HTMLCanvasElement} canvas
   * @param {number} layerIdx
   * @param {number} [timeoutMs] - Optional timeout in milliseconds
   * @returns {Promise<Uint8Array|null>}
   */
  async _captureLayerCanvasForSync(canvas, layerIdx, timeoutMs = null) {
    if (!canvas || layerIdx !== 0 || !this.board?._stripSnapshotBackground) {
      return this._captureCanvasElement(canvas, timeoutMs);
    }

    const sanitizedCanvas = document.createElement('canvas');
    sanitizedCanvas.width = canvas.width;
    sanitizedCanvas.height = canvas.height;
    const sanitizedCtx = sanitizedCanvas.getContext('2d', { willReadFrequently: true });
    sanitizedCtx.drawImage(canvas, 0, 0);

    const imageData = sanitizedCtx.getImageData(0, 0, sanitizedCanvas.width, sanitizedCanvas.height);
    this.board._stripSnapshotBackground(imageData);
    sanitizedCtx.putImageData(imageData, 0, 0);

    return this._captureCanvasElement(sanitizedCanvas, timeoutMs);
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
   * True while a sync rebuild is in flight — from requestSync()'s clearAll()
   * until _completeSync().
   *
   * The self-echo gates (wrapHandler's allowSelf list and the reconcile-only
   * `sessionIndex === app.sessionIndex` branches in the draw/selection handlers)
   * exist for the LIVE path, where our own commits come back as echoes of work
   * we already drew locally — applying them would double it.
   *
   * A rebuild inverts that premise. requestSync() wipes the board first, and the
   * server's checkpoint join tail is author-agnostic: it replays every commit in
   * (baseSeq, latest], INCLUDING our own. With the gates active we discard our
   * own half of the tail and rebuild only what other people drew — so the client
   * that did all the drawing is exactly the one that resyncs to a blank board.
   * While this is true, treat our own frames like anyone else's.
   *
   * Backed by its own flag, NOT by `buffering`: handleSyncComplete() does
   * `this.buffering = false; this.replayBuffer();` — on purpose, so the tail and
   * any live events that follow reach their handlers directly — which means a
   * `buffering`-derived answer is false for every single frame of the replay and
   * silently restores the exact filtering this exists to suspend.
   * @returns {boolean}
   */
  isRebuilding() {
    return !!this._rebuilding;
  }

  /**
   * Cleans up resources and resets the sync client state.
   * @returns {void}
   */
  destroy() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    this.clearPendingSync({ hideOverlay: false });
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
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    this.clearPendingSync({ hideOverlay: false });
    this.syncing = false;
    this.buffering = false;
    this._rebuilding = false;
    this.inactive = false;
    this.hasCompletedSync = false;
    this.expectedMessages = 0;
    this.receivedMessages = 0;
    this.currentSyncTargetId = null;
    this.currentSyncTargetUsername = null;
    this.eventBuffer = [];
    this._pendingImports = [];
    this.hideInactiveUi();
    this.hideOverlay();
    if (this.progressFillEl) {
      this.progressFillEl.style.width = '0%';
    }
  }
}
