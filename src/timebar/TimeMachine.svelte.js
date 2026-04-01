import { appState } from '../state.svelte.js';
import { ReplayEngine } from './ReplayEngine.js';

/** How long a user can be in replay mode before we stop recording and require resync (1 minute) */
const REPLAY_TIMEOUT_MS = 60 * 1000;

/**
 * Snapshot structure to store board and application state at a point in time.
 */
class Snapshot {
  constructor(timestamp, appStateData, canvasData, topCanvasData, layerStates, history = [], redoHistory = {}, activeStrokes = []) {
    this.timestamp = timestamp;
    this.appState = JSON.parse(JSON.stringify(appStateData));
    this.canvasData = canvasData; // base64 PNG of main board (baked content only)
    this.topCanvasData = topCanvasData; // base64 PNG of active strokes
    this.layerStates = JSON.parse(JSON.stringify(layerStates));
    this.history = history; // Array of per-layer stroke stacks
    this.redoHistory = redoHistory; // Map of userId -> redo batches
    this.activeStrokes = activeStrokes; // Array of per-layer active in-progress strokes
    this.actions = []; // Array of { timestamp, buffer }
  }
}

function serializeCanvasData(canvas) {
  return canvas ? canvas.toDataURL('image/png') : null;
}

function clonePoints(points) {
  if (!Array.isArray(points)) return null;
  return points.map((pt) => {
    if (Array.isArray(pt)) return [...pt];
    return pt && typeof pt === 'object' ? { ...pt } : pt;
  });
}

function serializePatternBrushState(user) {
  if (!user?.patternBrush) return null;

  const brush = { ...user.patternBrush };
  delete brush.image;
  delete brush.images;
  delete brush.reset;
  delete brush.getNextBrush;
  delete brush.index;
  delete brush.ncells;

  return {
    brush,
    scale: user.patternScale ?? 100,
    rotation: user.patternRotation ?? 0,
    spacing: user.patternSpacing ?? 0,
    offsetX: user.patternOffsetX ?? 0,
    offsetY: user.patternOffsetY ?? 0,
    colorMode: user.patternColorMode ?? 'original'
  };
}

function serializeActiveStroke(active, userId) {
  if (!active?.canvas) return null;

  return {
    userId,
    blendMode: active.blendMode ?? 'source-over',
    dirtyRect: active.dirtyRect ? { ...active.dirtyRect } : null,
    affectedTiles: active.affectedTiles ? Array.from(active.affectedTiles) : [],
    filterType: active.filterType,
    blurRadius: active.blurRadius,
    canvasData: serializeCanvasData(active.canvas),
    maskCanvasData: active.maskCanvas && active.maskCanvas !== active.canvas
      ? serializeCanvasData(active.maskCanvas)
      : null
  };
}

/**
 * TimeMachine manages recording and replaying of board state and user actions.
 */
class TimeMachineState {
  recordingBuffer = $state([]);
  currentTime = $state(0);
  maxTime = $state(0);
  isPlaying = $state(false);
  isReviewing = $state(false); // True when currentTime < maxTime
  isStarted = $state(false); // True when recording has actually started
  isVisible = $state(false); // UI toggle for showing/hiding the timebar
  previewData = $state(null); // The current historical view as a data URL
  needsResync = $state(false); // True when user has been in replay too long and needs resync
  isRecordingPaused = $state(false); // True when we've stopped recording due to replay timeout
  frozenMaxTime = $state(null); // The maxTime captured when starting review mode

  _snapshotInterval = null;
  _replayTimeoutId = null; // Timer for replay mode timeout
  _reviewStartTime = null; // When user entered replay mode
  _tickInterval = null;
  _playbackInterval = null;
  _board = null;
  _wsClient = null;
  _replayEngine = null;

  /** @type {HTMLCanvasElement} Replay overlay canvas injected into #boards */
  _replayCanvas = null;
  _replayCtx = null;

  /** @type {Set<number>} IDs of bot cursors we've created in the UI */
  _botCursorIds = new Set();

  /** @type {boolean} Prevents overlapping seeks */
  _isSeeking = false;
  /** @type {number|null} Pending seek timestamp */
  _pendingSeekTimestamp = null;

  /**
   * Initialize the TimeMachine with a reference to the board and wsClient.
   * @param {Board} board - The main drawing board instance
   * @param {WebSocketClient} wsClient - The websocket client
   */
  init(board, wsClient) {
    this._board = board;
    this._wsClient = wsClient;

    // Create replay engine with full layer simulation
    this._replayEngine = new ReplayEngine();
    this._replayEngine.init(board.getWidth(), board.getHeight(), wsClient);

    // When async blur worker finishes, refresh the visible replay canvas
    this._replayEngine.onOutputUpdate = () => {
      if (this._replayCtx && this._replayEngine.outputCanvas && this.isReviewing) {
        const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
        this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
        this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
        this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
      }
    };

    // Create and inject replay canvas into #boards wrapper
    this._createReplayCanvas();
  }

  /**
   * Create the replay canvas and inject it into the boards wrapper.
   * @private
   */
  _createReplayCanvas() {
    const boardsWrapper = document.getElementById('boards');
    if (!boardsWrapper) {
      console.warn('[TimeMachine] #boards wrapper not found');
      return;
    }

    this._replayCanvas = document.createElement('canvas');
    this._replayCanvas.id = 'replayCanvas';
    this._replayCanvas.width = this._board.getWidth();
    this._replayCanvas.height = this._board.getHeight();
    this._replayCanvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      display: none;
      z-index: 2;
    `;
    this._replayCtx = this._replayCanvas.getContext('2d');

    // Insert at the top of the stack (after other canvases)
    boardsWrapper.appendChild(this._replayCanvas);
  }

  /**
   * Start the periodic snapshot timer and action recording.
   * This should only be called once a real room is joined.
   */
  start() {
    if (this.isStarted) return;
    
    this.isStarted = true;
    this.startRecording();
  }

  /**
   * Stop recording and clear buffer (e.g. when leaving a room).
   */
  stop() {
    this.isStarted = false;
    this.isReviewing = false;
    this.isPlaying = false;
    this.recordingBuffer = [];
    this.currentTime = 0;
    this.maxTime = 0;
    this.previewData = null;
    this.needsResync = false;
    this.isRecordingPaused = false;
    this._showReplayCanvas(false);
    this._removeBotCursors();
    this._clearReplayTimeout();

    if (this._snapshotInterval) {
      clearInterval(this._snapshotInterval);
      this._snapshotInterval = null;
    }
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._playbackInterval) {
      clearInterval(this._playbackInterval);
      this._playbackInterval = null;
    }
  }

  /**
   * Start the periodic snapshot timer and action recording.
   * @private
   */
  startRecording() {
    // Take initial snapshot
    this.takeSnapshot();

    // Snapshot every 30 seconds
    this._snapshotInterval = setInterval(() => {
      this.takeSnapshot();
    }, 30000);

    // Tick every 50ms to update maxTime smoothly
    this._tickInterval = setInterval(() => {
      this._tick();
    }, 50);
  }

  /**
   * Internal tick to keep the timebar growing.
   * @private
   */
  _tick() {
    if (!this.isStarted || this.recordingBuffer.length === 0) return;

    // Don't update maxTime if recording is paused
    if (this.isRecordingPaused) return;

    this.maxTime = Date.now();

    // If we're not reviewing, keep currentTime synced with maxTime
    if (!this.isReviewing) {
      this.currentTime = this.maxTime;
    }
  }

  /**
   * Take a simultaneous snapshot of the board and application state.
   */
  takeSnapshot() {
    if (!this._board || !this.isStarted || this.isRecordingPaused) return;

    const timestamp = Date.now();
    console.log(`[TimeMachine] Taking snapshot at ${new Date(timestamp).toLocaleTimeString()}`);
    
    // Capture stroke history for each layer
    const history = this._board.layerManager?.layerGroups.map(group => {
      return group.strokeStack.map(stroke => ({
        imageData: stroke.canvas.toDataURL('image/png'),
        x: stroke.x,
        y: stroke.y,
        width: stroke.width,
        height: stroke.height,
        blendMode: stroke.blendMode,
        userId: stroke.userId,
        timestamp: stroke.timestamp,
        eraseAll: stroke.eraseAll || false,
        filterType: stroke.filterType,
        blurRadius: stroke.blurRadius,
        affectedTiles: stroke.affectedTiles ? Array.from(stroke.affectedTiles) : []
      }));
    }) || [];

    // Capture redo stacks
    const redoHistory = {};
    if (this._board.layerManager) {
      for (const [userId, batches] of this._board.layerManager.redoStackByUser) {
        redoHistory[userId] = batches.map(batch => {
          return batch.map(({ groupIdx, record }) => ({
            groupIdx,
            record: {
              imageData: record.canvas.toDataURL('image/png'),
              x: record.x,
              y: record.y,
              width: record.width,
              height: record.height,
              blendMode: record.blendMode,
              userId: record.userId,
              timestamp: record.timestamp,
              eraseAll: record.eraseAll || false,
              filterType: record.filterType,
              blurRadius: record.blurRadius,
              affectedTiles: record.affectedTiles ? Array.from(record.affectedTiles) : []
            }
          }));
        });
      }
    }

    const activeStrokes = this._board.layerManager?.layerGroups.map(group => {
      const strokes = [];
      for (const [userId, active] of group.activeStrokeByUser) {
        const serialized = serializeActiveStroke(active, userId);
        if (serialized) strokes.push(serialized);
      }
      return strokes;
    }) || [];

    // Capture the main board (baked content only) by temporarily clearing stroke stacks
    const lm = this._board.layerManager;
    const originalStacks = lm?.layerGroups.map(g => g.strokeStack) || [];
    const originalActiveStrokes = lm?.layerGroups.map(g => g.activeStrokeByUser) || [];
    if (lm) {
      lm.layerGroups.forEach(g => {
        g.strokeStack = [];
        g.activeStrokeByUser = new Map();
      });
      this._board.compositeAllLayers();
    }
    
    const canvasData = this._board.mainCanvas.toDataURL('image/png');

    // Restore original stacks and composite again to restore visible state
    if (lm) {
      lm.layerGroups.forEach((g, i) => {
        g.strokeStack = originalStacks[i];
        g.activeStrokeByUser = originalActiveStrokes[i];
      });
      this._board.compositeAllLayers();
    }

    // Capture active strokes canvas (live previews)
    const topCanvasData = this._board.topCanvas.toDataURL('image/png');
    
    // Capture relevant layer states
    const layerStates = this._board.layerManager?.layerGroups.map(group => ({
      visible: group.visible,
      opacity: group.opacity,
      blendMode: group.blendMode
    })) || [];

    // Capture relevant app state data (simplified for snapshot)
    // Capture full per-user drawing state for accurate replay
    const userDrawingStates = {};
    const toolManager = window.app?.toolManager;
    const patternTool = toolManager?.getTool?.('pattern');
    if (window.app?.users) {
      window.app.users.forEach((user, id) => {
        const toolLastStampPositions = {};
        for (const toolName of ['imageBrush', 'pixel', 'blur', 'glitchBlur', 'circleBlur', 'pattern']) {
          const tool = toolManager?.getTool?.(toolName);
          const lastStampPos = tool?.lastStampPos?.get?.(id);
          if (lastStampPos) {
            toolLastStampPositions[toolName] = { ...lastStampPos };
          }
        }

        const patternRemoteOffscreen = patternTool?.remoteOffscreens?.get?.(id);
        userDrawingStates[id] = {
          username: user.username || `User ${id}`,
          role: user.role ?? 0,
          color: user.color ? [...user.color] : [0, 0, 0, 255],
          size: user.size ?? 10,
          x: user.x ?? 0,
          y: user.y ?? 0,
          tool: user.tool || 'brush',
          pressure: user.pressure ?? 1,
          thinning: user.thinning ?? 0.5,
          simulatePressure: user.simulatePressure ?? true,
          blendMode: user.blendMode || 'source-over',
          activeLayer: user.activeLayer ?? 2,
          mousedown: !!user.mousedown,
          panning: !!user.panning,
          startPos: user.startPos ? { ...user.startPos } : null,
          currentLine: clonePoints(user.currentLine),
          lineLength: user.lineLength ?? 0,
          smoothBuffer: user.smoothBuffer ? { ...user.smoothBuffer } : null,
          remoteTarget: user.remoteTarget ? { ...user.remoteTarget } : null,
          lassoPoints: clonePoints(user.lassoPoints),
          lastx: user.lastx,
          lasty: user.lasty,
          prevpressure: user.prevpressure,
          previewCanvasData: serializeCanvasData(user.board),
          penStrokeActive: !!user._penStrokeActive,
          penOffscreenData: serializeCanvasData(user._penOffscreen),
          penStrokeColor: user._penStrokeColor ?? null,
          penAlpha: user._penAlpha ?? null,
          penHardness: user._penHardness ?? null,
          penLastStampPos: user._penLastStampPos ? { ...user._penLastStampPos } : null,
          penPoints: clonePoints(user.penPoints),
          inkStrokeActive: !!user._inkStrokeActive,
          inkOffscreenData: serializeCanvasData(user._inkOffscreen),
          inkStrokeColor: user._inkStrokeColor ?? null,
          inkAlpha: user._inkAlpha ?? null,
          inkHardness: user._inkHardness ?? null,
          inkSize: user._inkSize ?? null,
          inkPoints: clonePoints(user._inkPoints),
          toolLastStampPositions,
          patternRemoteOffscreen: patternRemoteOffscreen ? {
            canvasData: serializeCanvasData(patternRemoteOffscreen.canvas),
            strokePoints: clonePoints(patternRemoteOffscreen.strokePoints)
          } : null,
          patternMode: user.patternMode ?? false,
          patternBrush: serializePatternBrushState(user),
          patternScale: user.patternScale ?? 100,
          patternRotation: user.patternRotation ?? 0,
          patternSpacing: user.patternSpacing ?? 0,
          patternOffsetX: user.patternOffsetX ?? 0,
          patternOffsetY: user.patternOffsetY ?? 0,
          patternColorMode: user.patternColorMode ?? 'original',
          spacing: user.spacing ?? 0,
          smoothing: user.smoothing ?? 15,
          hardness: user.hardness ?? 100
        };
      });
    }

    const appStateData = {
      users: Array.from(appState.users.entries()),
      userDrawingStates,
      currentRoomData: appState.currentRoomData,
      activeLayer: appState.activeLayer
    };

    const snapshot = new Snapshot(timestamp, appStateData, canvasData, topCanvasData, layerStates, history, redoHistory, activeStrokes);
    
    this.recordingBuffer.push(snapshot);
    console.log(`[TimeMachine] Buffer size: ${this.recordingBuffer.length}`);
    
    // Update maxTime immediately on snapshot
    this.maxTime = timestamp;
    if (!this.isReviewing) {
      this.currentTime = this.maxTime;
    }

    // Maintain 2-minute buffer (max 5 snapshots)
    if (this.recordingBuffer.length > 5) {
      console.log('[TimeMachine] Rotating buffer, removing oldest snapshot');
      this.recordingBuffer.shift();
    }
  }

  /**
   * Record an incoming or outgoing action as JSON.
   * @param {Object} msg - Decoded message object
   */
  recordAction(msg) {
    if (!this.isStarted || this.recordingBuffer.length === 0) return;

    // Stop recording if we've been in replay mode too long
    if (this.isRecordingPaused) return;

    const timestamp = Date.now();
    const latestSnapshot = this.recordingBuffer[this.recordingBuffer.length - 1];

    latestSnapshot.actions.push({
      timestamp,
      msg // Store decoded JSON directly
    });

    this.maxTime = timestamp;

    // If we're not reviewing, keep currentTime synced with maxTime
    if (!this.isReviewing) {
      this.currentTime = this.maxTime;
    }
  }

  /**
   * Seek to a specific timestamp in the history.
   * @param {number} timestamp - The target timestamp
   */
  async seek(timestamp) {
    if (!this.isStarted) return;

    this.currentTime = Math.max(
      this.recordingBuffer[0]?.timestamp || 0,
      Math.min(timestamp, this.maxTime)
    );

    const wasReviewing = this.isReviewing;
    this.isReviewing = this.currentTime < (this.maxTime - 500); // 500ms threshold

    // Track transitions in/out of replay mode for timeout handling
    if (this.isReviewing && !wasReviewing) {
      this.frozenMaxTime = this.maxTime; // Capture the end of the timeline
      this._startReplayTimeout();
    } else if (!this.isReviewing && wasReviewing) {
      this.frozenMaxTime = null; // Resume timeline expansion
      this._clearReplayTimeout();
    }

    if (this.isReviewing) {
      if (this._isSeeking) {
        this._pendingSeekTimestamp = this.currentTime;
        return;
      }

      this._isSeeking = true;
      try {
        await this._applyStateAt(this.currentTime);
        this._showReplayCanvas(true);
        this._updateBotCursors();
      } finally {
        this._isSeeking = false;
        if (this._pendingSeekTimestamp !== null) {
          const next = this._pendingSeekTimestamp;
          this._pendingSeekTimestamp = null;
          this.seek(next);
        }
      }
    } else {
      this._showReplayCanvas(false);
      this._removeBotCursors();
      this.previewData = null;
    }
  }

  /**
   * Start the replay timeout timer. After REPLAY_TIMEOUT_MS, stop recording
   * and require a resync when returning to live.
   * @private
   */
  _startReplayTimeout() {
    this._clearReplayTimeout();
    this._reviewStartTime = Date.now();

    this._replayTimeoutId = setTimeout(() => {
      this.isRecordingPaused = true;
      this.needsResync = true;
    }, REPLAY_TIMEOUT_MS);
  }

  /**
   * Clear the replay timeout timer.
   * @private
   */
  _clearReplayTimeout() {
    if (this._replayTimeoutId) {
      clearTimeout(this._replayTimeoutId);
      this._replayTimeoutId = null;
    }
    this._reviewStartTime = null;
  }

  /**
   * Show or hide the replay canvas overlay.
   * @param {boolean} show
   * @private
   */
  _showReplayCanvas(show) {
    if (this._replayCanvas) {
      this._replayCanvas.style.display = show ? 'block' : 'none';
    }

    // Hide/show the real board canvases to prevent them showing through
    if (this._board) {
      const display = show ? 'none' : 'block';
      if (this._board.mainCanvas) this._board.mainCanvas.style.display = display;
      if (this._board.topCanvas) this._board.topCanvas.style.display = display;
      if (this._board.upperLayersCanvas) this._board.upperLayersCanvas.style.display = display;

      // Also hide user boards (remote user canvases)
      const userBoards = document.getElementById('userBoards');
      if (userBoards) userBoards.style.display = display;
    }
  }

  /**
   * Internal method to apply state and actions using the ReplayEngine.
   * @param {number} timestamp - Target timestamp
   * @private
   */
  async _applyStateAt(timestamp) {
    if (!this._replayEngine) {
      console.warn('[TimeMachine] No replay engine');
      return;
    }

    //  Find the snapshot closest to, but not exceeding, the target timestamp
    let snapshot = null;
    let snapshotIndex = -1;
    for (let i = this.recordingBuffer.length - 1; i >= 0; i--) {
      if (this.recordingBuffer[i].timestamp <= timestamp) {
        snapshot = this.recordingBuffer[i];
        snapshotIndex = i;
        break;
      }
    }

    if (!snapshot) {
      console.warn('[TimeMachine] No snapshot found for timestamp', timestamp);
      return;
    }


    await this._replayEngine.loadSnapshot(snapshot);


    const actionsToReplay = [];

    for (let i = snapshotIndex; i < this.recordingBuffer.length; i++) {
      const snap = this.recordingBuffer[i];
      for (const action of snap.actions) {
        if (action.timestamp > snapshot.timestamp && action.timestamp <= timestamp) {
          actionsToReplay.push(action);
        }
      }
    }

    // Sort by timestamp to ensure correct order
    actionsToReplay.sort((a, b) => a.timestamp - b.timestamp);

    await this._replayEngine.processActions(actionsToReplay, timestamp);

    if (this._replayCtx && this._replayEngine.outputCanvas) {
      // Fill with background color first to prevent real board showing through
      const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
      this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
      this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);

      this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
    }

    // Also update previewData for the badge/UI (optional, can be removed if not needed)
    this.previewData = true; // Just a flag that we have preview data
    console.log('[TimeMachine] Replay canvas updated, isReviewing:', this.isReviewing);
  }

  play() {
    if (!this.isStarted || this.isPlaying || this.currentTime >= this.maxTime) return;
    this.isPlaying = true;
    
    const startTime = Date.now();
    const startOffset = this.currentTime;

    this._playbackInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const targetTime = startOffset + elapsed;
      
      if (targetTime >= this.maxTime) {
        this.seek(this.maxTime);
        this.pause();
      } else {
        this.seek(targetTime);
      }
    }, 16); // ~60fps
  }

  pause() {
    this.isPlaying = false;
    if (this._playbackInterval) {
      clearInterval(this._playbackInterval);
      this._playbackInterval = null;
    }
  }

  /**
   * Catch up to the present live state.
   * If user was in replay too long, triggers a full resync instead of seeking.
   */
  catchUp() {
    this.pause();
    this._clearReplayTimeout();

    if (this.needsResync) {
      this._triggerResync();
      return;
    }

    this.seek(this.maxTime);
  }

  /**
   * Triggers a full resync via SyncClient. This clears the current recording
   * buffer and restarts from fresh state.
   * @private
   */
  _triggerResync() {
    // Reset TimeMachine state
    this._showReplayCanvas(false);
    this._removeBotCursors();
    this.stop();

    // Trigger resync via app's syncClient
    const syncClient = window.app?.syncClient;
    if (syncClient) {
      // Reset sync state to allow a new sync
      syncClient.hasCompletedSync = false;
      syncClient.requestSync();

      // Restart recording after sync completes
      syncClient.onSyncComplete = () => {
        this.start();
      };
    } else {
      console.warn('[TimeMachine] No syncClient available, cannot resync');
      // Fallback: just restart recording with current state
      this.start();
    }
  }

  /**
   * Request the server to revert the board to a specific timestamp.
   * @param {number} timestamp - The target timestamp
   */
  requestUndoTo(timestamp) {
    if (!this._wsClient) return;

    console.log('Requesting server undo to:', timestamp);
    this._wsClient.send({
      t: T.MOD_UNDO_TO_STATE,
      mod_undo_ts: timestamp
    });
  }

  /**
   * Create or update UI cursors for bot users during replay.
   * @private
   */
  _updateBotCursors() {
    const ui = window.app?.ui;
    if (!ui || !this._replayEngine) return;

    for (const [id, user] of this._replayEngine.botUsers) {
      // Use negative IDs for bots to avoid collision with real users
      const botId = -1000 - id;

      if (!this._botCursorIds.has(botId)) {
        // Create cursor for this bot using real username from snapshot
        const userData = {
          username: user.username || `User ${id}`,
          role: user.role ?? 0,
          color: user.color || [100, 100, 100, 1],
          size: user.size || 10,
          tool: user.tool || 'brush',
          x: user.x ?? 0,
          y: user.y ?? 0
        };
        ui.createRemoteUser(botId, userData);
        this._botCursorIds.add(botId);

        // Hide the user list entry for bot users (keep only the cursor)
        const listEntry = document.querySelector(`.userListEntry.u${botId}`);
        if (listEntry) listEntry.style.display = 'none';
      }

      // Update cursor position and size
      if (user.x !== undefined && user.y !== undefined) {
        ui.updateRemoteCursor(botId, user.x, user.y, user.size || 10);
      }
      ui.updateRemoteSize(botId, user.size || 10);

      // Update tool display
      ui.updateRemoteToolDisplay(botId, user.tool || 'brush');

      // Update color
      if (user.color) {
        ui.updateRemoteColor(botId, user.color);
      }
    }
  }

  /**
   * Remove all bot cursors from the UI.
   * @private
   */
  _removeBotCursors() {
    const ui = window.app?.ui;
    if (!ui) return;

    for (const botId of this._botCursorIds) {
      ui.removeRemoteUser(botId);
    }
    this._botCursorIds.clear();
  }
}

export const TimeMachine = new TimeMachineState();
