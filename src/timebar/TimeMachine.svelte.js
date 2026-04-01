import { appState } from '../state.svelte.js';
import { ReplayEngine } from './ReplayEngine.js';
import { T } from '../../shared/MessageTypes.js';

/** How long a user can be in replay mode before we stop recording and require resync (1 minute) */
const REPLAY_TIMEOUT_MS = 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 10 * 1000;
const FULL_SNAPSHOT_INTERVAL_MS = 30 * 1000;
const REPLAY_BUFFER_MS = 2 * 60 * 1000;
const ACTION_CHUNK_MS = 100;
const ACTION_DEDUPE_WINDOW_MS = 250;
const SEEK_TELEMETRY_LOG_INTERVAL_MS = 1500;

/**
 * Snapshot structure to store board and application state at a point in time.
 */
class Snapshot {
  constructor(kind, timestamp, appStateData, canvasData, topCanvasData, layerStates, history = [], redoHistory = {}, activeStrokes = []) {
    this.kind = kind;
    this.timestamp = timestamp;
    this.appState = JSON.parse(JSON.stringify(appStateData));
    this.canvasData = canvasData; // base64 PNG of main board (baked content only)
    this.topCanvasData = topCanvasData; // base64 PNG of active strokes
    this.layerStates = JSON.parse(JSON.stringify(layerStates));
    this.history = history; // Array of per-layer stroke stacks
    this.redoHistory = redoHistory; // Map of userId -> redo batches
    this.activeStrokes = activeStrokes; // Array of per-layer active in-progress strokes
    this.actionChunks = []; // Array of { startTimestamp, endTimestamp, actions }
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function estimateSerializedBytes(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  return stableStringify(value).length;
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

function serializeActiveStroke(active, userId, serializeImage) {
  if (!active?.canvas) return null;

  return {
    userId,
    blendMode: active.blendMode ?? 'source-over',
    dirtyRect: active.dirtyRect ? { ...active.dirtyRect } : null,
    affectedTiles: active.affectedTiles ? Array.from(active.affectedTiles) : [],
    filterType: active.filterType,
    blurRadius: active.blurRadius,
    canvasData: serializeImage(active.canvas),
    maskCanvasData: active.maskCanvas && active.maskCanvas !== active.canvas
      ? serializeImage(active.maskCanvas)
      : null
  };
}

function serializeSelectionRestoreData(restoreData, serializeImage) {
  if (!restoreData) return null;

  return {
    eraseS: restoreData.eraseS ? { ...restoreData.eraseS } : null,
    eraseLassoPath: clonePoints(restoreData.eraseLassoPath),
    snapshots: (restoreData.snapshots || []).map((snap) => ({
      groupIdx: snap.groupIdx,
      x: snap.x,
      y: snap.y,
      width: snap.canvas?.width ?? 0,
      height: snap.canvas?.height ?? 0,
      canvasData: serializeImage(snap.canvas)
    }))
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
  _playbackFrameId = null;
  _lastFullSnapshotAt = 0;
  _board = null;
  _wsClient = null;
  _replayEngine = null;

  /** @type {HTMLCanvasElement} Replay overlay canvas injected into #boards */
  _replayCanvas = null;
  _replayCtx = null;

  /** @type {Set<number>} IDs of bot cursors we've created in the UI */
  _botCursorIds = new Set();
  /** @type {Array<{element: HTMLElement|SVGElement, display: string}>} */
  _hiddenRealtimeCursorElements = [];

  /** @type {boolean} Prevents overlapping seeks */
  _isSeeking = false;
  /** @type {number|null} Pending seek timestamp */
  _pendingSeekTimestamp = null;
  _lastAppliedTimestamp = null;
  _lastSeekLogAt = 0;
  _isPlaybackAdvancing = false;
  _pendingPlaybackTimestamp = null;
  _playbackStartPerf = 0;
  _playbackStartOffset = 0;
  _recentActionSignatures = new Map();
  _assetDataById = new Map();
  _assetIdByData = new Map();
  _assetRefCounts = new Map();
  _nextAssetId = 1;
  _telemetry = {
    snapshot: null,
    seek: null
  };

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
    this._replayEngine.setAssetResolver((source) => this.resolveAssetRef(source));

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
    this._lastAppliedTimestamp = null;
    this._lastFullSnapshotAt = 0;
    this._recentActionSignatures.clear();
    this._clearAssetStore();
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
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
  }

  /**
   * Start the periodic snapshot timer and action recording.
   * @private
   */
  startRecording() {
    // Take initial full checkpoint
    this.takeCheckpoint('full');

    // Checkpoint every 10 seconds, promoting every 30 seconds to full
    this._snapshotInterval = setInterval(() => {
      const now = Date.now();
      const shouldTakeFull = (now - this._lastFullSnapshotAt) >= FULL_SNAPSHOT_INTERVAL_MS;
      this.takeCheckpoint(shouldTakeFull ? 'full' : 'delta');
    }, CHECKPOINT_INTERVAL_MS);

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
  takeCheckpoint(kind = 'delta') {
    if (!this._board || !this.isStarted || this.isRecordingPaused) return;

    const timestamp = Date.now();
    const snapshotStart = performance.now();
    console.log(`[TimeMachine] Taking ${kind} checkpoint at ${new Date(timestamp).toLocaleTimeString()}`);
    const serializeImage = (canvas) => this._captureCanvasAsset(canvas);
    
    // Capture stroke history for each layer
    const history = this._board.layerManager?.layerGroups.map(group => {
      return group.strokeStack.map(stroke => ({
        imageData: serializeImage(stroke.canvas),
        canvasWidth: stroke.canvas.width,
        canvasHeight: stroke.canvas.height,
        maskCanvasData: stroke.maskCanvas ? serializeImage(stroke.maskCanvas) : null,
        maskCanvasWidth: stroke.maskCanvas?.width ?? null,
        maskCanvasHeight: stroke.maskCanvas?.height ?? null,
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
              imageData: serializeImage(record.canvas),
              canvasWidth: record.canvas.width,
              canvasHeight: record.canvas.height,
              maskCanvasData: record.maskCanvas ? serializeImage(record.maskCanvas) : null,
              maskCanvasWidth: record.maskCanvas?.width ?? null,
              maskCanvasHeight: record.maskCanvas?.height ?? null,
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
        const serialized = serializeActiveStroke(active, userId, serializeImage);
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
    
    const canvasData = serializeImage(this._board.mainCanvas);

    // Restore original stacks and composite again to restore visible state
    if (lm) {
      lm.layerGroups.forEach((g, i) => {
        g.strokeStack = originalStacks[i];
        g.activeStrokeByUser = originalActiveStrokes[i];
      });
      this._board.compositeAllLayers();
    }

    // Capture active strokes canvas (live previews)
    const topCanvasData = serializeImage(this._board.topCanvas);
    
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
          text: user.text || '',
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
          previewCanvasData: serializeImage(user.board),
          penStrokeActive: !!user._penStrokeActive,
          penOffscreenData: serializeImage(user._penOffscreen),
          penStrokeColor: user._penStrokeColor ?? null,
          penAlpha: user._penAlpha ?? null,
          penHardness: user._penHardness ?? null,
          penLastStampPos: user._penLastStampPos ? { ...user._penLastStampPos } : null,
          penPoints: clonePoints(user.penPoints),
          inkStrokeActive: !!user._inkStrokeActive,
          inkOffscreenData: serializeImage(user._inkOffscreen),
          inkStrokeColor: user._inkStrokeColor ?? null,
          inkAlpha: user._inkAlpha ?? null,
          inkHardness: user._inkHardness ?? null,
          inkSize: user._inkSize ?? null,
          inkPoints: clonePoints(user._inkPoints),
          toolLastStampPositions,
          patternRemoteOffscreen: patternRemoteOffscreen ? {
            canvasData: serializeImage(patternRemoteOffscreen.canvas),
            strokePoints: clonePoints(patternRemoteOffscreen.strokePoints)
          } : null,
          selection: user.selection ? { ...user.selection } : null,
          pendingSelection: user.pendingSelection ? { ...user.pendingSelection } : null,
          pendingLassoPath: clonePoints(user.pendingLassoPath),
          lassoPath: clonePoints(user.lassoPath),
          selectionCorners: user.selectionCorners ? {
            tl: { ...user.selectionCorners.tl },
            tr: { ...user.selectionCorners.tr },
            br: { ...user.selectionCorners.br },
            bl: { ...user.selectionCorners.bl }
          } : null,
          originalCorners: user.originalCorners ? {
            tl: { ...user.originalCorners.tl },
            tr: { ...user.originalCorners.tr },
            br: { ...user.originalCorners.br },
            bl: { ...user.originalCorners.bl }
          } : null,
          originalSelectionPos: user.originalSelectionPos ? { ...user.originalSelectionPos } : null,
          floatingCanvasData: serializeImage(user.floatingCanvas),
          floatingCanvasWidth: user.floatingCanvas?.width ?? null,
          floatingCanvasHeight: user.floatingCanvas?.height ?? null,
          cachedSelectionPreviewData: serializeImage(user._cachedPreviewCanvas),
          cachedSelectionPreviewBounds: user._cachedPreviewBounds ? { ...user._cachedPreviewBounds } : null,
          selectionRestoreData: serializeSelectionRestoreData(user._selectionRestoreData, serializeImage),
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

    const snapshot = new Snapshot(kind, timestamp, appStateData, canvasData, topCanvasData, layerStates, history, redoHistory, activeStrokes);
    
    this.recordingBuffer.push(snapshot);
    if (kind === 'full') {
      this._lastFullSnapshotAt = timestamp;
    }

    const snapshotDurationMs = performance.now() - snapshotStart;
    const estimatedBytes =
      estimateSerializedBytes(canvasData) +
      estimateSerializedBytes(topCanvasData) +
      estimateSerializedBytes(history) +
      estimateSerializedBytes(redoHistory) +
      estimateSerializedBytes(activeStrokes) +
      estimateSerializedBytes(appStateData);

    this._telemetry.snapshot = {
      timestamp,
      durationMs: Number(snapshotDurationMs.toFixed(2)),
      estimatedBytes,
      bufferSize: this.recordingBuffer.length
    };
    console.log(
      `[TimeMachine] ${kind} checkpoint complete in ${snapshotDurationMs.toFixed(1)}ms, estimated payload ${Math.round(estimatedBytes / 1024)}KB, buffer size ${this.recordingBuffer.length}`
    );
    
    // Update maxTime immediately on snapshot
    this.maxTime = timestamp;
    if (!this.isReviewing) {
      this.currentTime = this.maxTime;
    }

    this._trimRecordingBuffer(timestamp);
  }

  /**
   * Record an incoming or outgoing action as JSON.
   * @param {Object} msg - Decoded message object
   */
  recordAction(msg, source = 'unknown') {
    if (!this.isStarted || this.recordingBuffer.length === 0) return;

    // Stop recording if we've been in replay mode too long
    if (this.isRecordingPaused) return;

    const timestamp = Date.now();
    const latestSnapshot = this.recordingBuffer[this.recordingBuffer.length - 1];
    if (!latestSnapshot) return;

    if (this._shouldSkipActionRecording(msg, source, timestamp)) {
      return;
    }

    const chunk = this._getOrCreateActionChunk(latestSnapshot, timestamp);
    if (!this._mergeIntoPreviousAction(chunk, timestamp, msg)) {
      chunk.actions.push({ timestamp, msg });
    }
    chunk.endTimestamp = timestamp;

    this.maxTime = timestamp;

    // If we're not reviewing, keep currentTime synced with maxTime
    if (!this.isReviewing) {
      this.currentTime = this.maxTime;
    }
  }

  _getOrCreateActionChunk(snapshot, timestamp) {
    const lastChunk = snapshot.actionChunks[snapshot.actionChunks.length - 1];
    if (lastChunk && (timestamp - lastChunk.startTimestamp) < ACTION_CHUNK_MS) {
      return lastChunk;
    }

    const chunk = {
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      actions: []
    };
    snapshot.actionChunks.push(chunk);
    return chunk;
  }

  _mergeIntoPreviousAction(chunk, timestamp, msg) {
    if (!chunk || !msg) return false;
    const previous = chunk.actions[chunk.actions.length - 1];
    if (!previous?.msg) return false;

    if (msg.t !== previous.msg.t || msg.t !== T.MM) {
      return false;
    }

    if (msg.u !== previous.msg.u) return false;
    if (!Array.isArray(msg.ps) || !Array.isArray(previous.msg.ps)) return false;

    previous.msg.ps.push(...msg.ps);
    if (Array.isArray(msg.rs) && Array.isArray(previous.msg.rs)) {
      previous.msg.rs.push(...msg.rs);
    } else if (Array.isArray(msg.rs) && !previous.msg.rs) {
      previous.msg.rs = [...msg.rs];
    }
    previous.timestamp = timestamp;
    return true;
  }

  _shouldSkipActionRecording(msg, source, timestamp) {
    if (!msg) return true;

    const actionUserId = msg.u;
    const localUserId = this._wsClient?.sessionIndex;
    const isLocalAction = actionUserId != null && localUserId != null && actionUserId === localUserId;
    if (!isLocalAction) return false;

    const actionSignature = this._buildActionSignature(msg);
    const signature = `${source}:${actionSignature}`;
    const oppositeSource = source === 'outbound' ? 'inbound' : source === 'inbound' ? 'outbound' : null;

    if (oppositeSource) {
      const oppositeSignature = `${oppositeSource}:${actionSignature}`;
      const previousTimestamp = this._recentActionSignatures.get(oppositeSignature);
      if (previousTimestamp != null && (timestamp - previousTimestamp) <= ACTION_DEDUPE_WINDOW_MS) {
        return true;
      }
    }

    this._recentActionSignatures.set(signature, timestamp);
    this._pruneRecentActionSignatures(timestamp);
    return false;
  }

  _buildActionSignature(msg) {
    const keys = Object.keys(msg).sort();
    const parts = new Array(keys.length);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = msg[key];
      if (Array.isArray(value)) {
        parts[i] = `${key}:[${value.join(',')}]`;
      } else if (value && typeof value === 'object') {
        parts[i] = `${key}:${stableStringify(value)}`;
      } else {
        parts[i] = `${key}:${String(value)}`;
      }
    }

    return parts.join('|');
  }

  _pruneRecentActionSignatures(now) {
    for (const [signature, ts] of this._recentActionSignatures) {
      if ((now - ts) > ACTION_DEDUPE_WINDOW_MS) {
        this._recentActionSignatures.delete(signature);
      }
    }
  }

  _captureCanvasAsset(canvas) {
    if (!canvas) return null;
    return this._storeAssetData(canvas.toDataURL('image/png'));
  }

  _storeAssetData(dataUrl) {
    if (!dataUrl) return null;

    let assetId = this._assetIdByData.get(dataUrl);
    if (!assetId) {
      assetId = `asset_${this._nextAssetId++}`;
      this._assetIdByData.set(dataUrl, assetId);
      this._assetDataById.set(assetId, dataUrl);
      this._assetRefCounts.set(assetId, 0);
    }

    this._assetRefCounts.set(assetId, (this._assetRefCounts.get(assetId) || 0) + 1);
    return { assetId };
  }

  resolveAssetRef(source) {
    if (!source) return null;
    if (typeof source === 'string') return source;
    if (typeof source === 'object' && source.assetId) {
      return this._assetDataById.get(source.assetId) || null;
    }
    return null;
  }

  _trimRecordingBuffer(nowTimestamp) {
    while (this.recordingBuffer.length > 0) {
      const oldest = this.recordingBuffer[0];
      if ((nowTimestamp - oldest.timestamp) <= REPLAY_BUFFER_MS) {
        break;
      }

      console.log(`[TimeMachine] Rotating buffer, removing oldest ${oldest.kind} checkpoint`);
      this.recordingBuffer.shift();
      this._releaseSnapshotAssets(oldest);
    }
  }

  _releaseSnapshotAssets(snapshot) {
    this._walkAssetRefs(snapshot, (assetId) => this._decrementAssetRef(assetId));
  }

  _walkAssetRefs(value, visitor) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        this._walkAssetRefs(item, visitor);
      }
      return;
    }

    if (typeof value !== 'object') return;
    if (value.assetId) {
      visitor(value.assetId);
      return;
    }

    for (const nested of Object.values(value)) {
      this._walkAssetRefs(nested, visitor);
    }
  }

  _decrementAssetRef(assetId) {
    const current = this._assetRefCounts.get(assetId);
    if (current == null) return;

    if (current <= 1) {
      const dataUrl = this._assetDataById.get(assetId);
      this._assetRefCounts.delete(assetId);
      this._assetDataById.delete(assetId);
      if (dataUrl) {
        this._assetIdByData.delete(dataUrl);
      }
      return;
    }

    this._assetRefCounts.set(assetId, current - 1);
  }

  _clearAssetStore() {
    this._assetDataById.clear();
    this._assetIdByData.clear();
    this._assetRefCounts.clear();
    this._nextAssetId = 1;
  }

  /**
   * Seek to a specific timestamp in the history.
   * @param {number} timestamp - The target timestamp
   */
  async seek(timestamp, options = {}) {
    if (!this.isStarted) return;
    const { suppressPlaybackPause = false } = options;

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
      if (this.isPlaying && !suppressPlaybackPause) {
        this.pause();
      }

      if (this._lastAppliedTimestamp === this.currentTime) {
        this._showReplayCanvas(true);
        this._updateBotCursors();
        return;
      }

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
      this._lastAppliedTimestamp = null;
      this._pendingPlaybackTimestamp = null;
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

    window.app?.ui?.remoteUserUI?.setReplayModeActive(show);

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

    this._setRealtimeCursorVisibility(!show);
  }

  /**
   * Hide live local/remote cursor overlays during replay while keeping replay bot
   * cursors visible, then restore the exact prior display state on exit.
   * @param {boolean} visible
   * @private
   */
  _setRealtimeCursorVisibility(visible) {
    const ui = window.app?.ui;
    if (!ui) return;

    if (visible) {
      for (const { element, display } of this._hiddenRealtimeCursorElements) {
        if (element?.style) {
          element.style.display = display;
        }
      }
      this._hiddenRealtimeCursorElements = [];
      return;
    }

    if (this._hiddenRealtimeCursorElements.length > 0) return;

    const hideElement = (element) => {
      if (!element?.style) return;
      this._hiddenRealtimeCursorElements.push({
        element,
        display: element.style.display
      });
      element.style.display = 'none';
    };

    hideElement(ui.elements?.selfCursor);
    hideElement(ui.elements?.selfCircle);
    hideElement(ui.elements?.selfSquare);
    hideElement(ui.elements?.selfCrosshair);
    hideElement(ui.elements?.selfText);
    hideElement(ui.elements?.selfPressureCircle);
    hideElement(ui.elements?.selfPressureSquare);

    const remoteCursors = ui.remoteUserUI?.cursors;
    if (remoteCursors) {
      for (const [userId, cursorElements] of remoteCursors.entries()) {
        if (this._botCursorIds.has(Number(userId))) continue;
        hideElement(cursorElements?.cursor);
        hideElement(cursorElements?.circle);
        hideElement(cursorElements?.square);
        hideElement(cursorElements?.crosshair);
      }
    }

    const remoteUserUI = ui.remoteUserUI;
    if (!remoteUserUI) return;

    for (const [userId] of remoteCursors ?? []) {
      if (this._botCursorIds.has(Number(userId))) continue;
      hideElement(document.querySelector(`.userEntry.u${userId}`));
    }

    for (const group of remoteUserUI.userGroups?.values?.() ?? []) {
      hideElement(group?.element);
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

    const seekStart = performance.now();
    const heapBefore = performance.memory?.usedJSHeapSize ?? null;

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
    const snapshotLoadMs = performance.now() - seekStart;
    const actionsToReplay = this._collectActionsBetween(snapshotIndex, snapshot.timestamp, timestamp);

    await this._replayEngine.processActions(actionsToReplay, timestamp);
    const totalSeekMs = performance.now() - seekStart;
    const replayMs = totalSeekMs - snapshotLoadMs;
    const heapAfter = performance.memory?.usedJSHeapSize ?? null;
    const heapDelta = heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null;

    this._telemetry.seek = {
      timestamp,
      snapshotTimestamp: snapshot.timestamp,
      snapshotLoadMs: Number(snapshotLoadMs.toFixed(2)),
      replayMs: Number(replayMs.toFixed(2)),
      totalMs: Number(totalSeekMs.toFixed(2)),
      actionsReplayed: actionsToReplay.length,
      heapDelta
    };
    this._lastAppliedTimestamp = timestamp;
    this._maybeLogSeekTelemetry();

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

  _collectActionsBetween(snapshotIndex, startTimestamp, endTimestamp) {
    const actions = [];

    for (let i = snapshotIndex; i < this.recordingBuffer.length; i++) {
      const snap = this.recordingBuffer[i];
      const chunks = snap.actionChunks || [];
      for (const chunk of chunks) {
        if (chunk.startTimestamp > endTimestamp) break;
        if (chunk.endTimestamp <= startTimestamp) continue;

        for (const action of chunk.actions) {
          if (action.timestamp > startTimestamp && action.timestamp <= endTimestamp) {
            actions.push(action);
          }
        }
      }
    }

    return actions;
  }

  _maybeLogSeekTelemetry() {
    const now = performance.now();
    if ((now - this._lastSeekLogAt) < SEEK_TELEMETRY_LOG_INTERVAL_MS) return;
    this._lastSeekLogAt = now;

    const seek = this._telemetry.seek;
    if (!seek) return;

    const heapDeltaText = seek.heapDelta == null
      ? 'n/a'
      : `${Math.round(seek.heapDelta / 1024)}KB`;

    console.log(
      `[TimeMachine] Seek ${seek.totalMs.toFixed(1)}ms (snapshot ${seek.snapshotLoadMs.toFixed(1)}ms, replay ${seek.replayMs.toFixed(1)}ms, actions ${seek.actionsReplayed}, heap delta ${heapDeltaText})`
    );
  }

  play() {
    if (!this.isStarted || this.isPlaying || this.currentTime >= this.maxTime) return;
    this.isPlaying = true;
    this._playbackStartPerf = performance.now();
    this._playbackStartOffset = this.currentTime;
    this._playbackFrameId = requestAnimationFrame((now) => this._playbackFrame(now));
  }

  pause() {
    this.isPlaying = false;
    if (this._playbackInterval) {
      clearInterval(this._playbackInterval);
      this._playbackInterval = null;
    }
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
    this._pendingPlaybackTimestamp = null;
  }

  async _playbackFrame(now) {
    if (!this.isPlaying) return;

    const elapsed = now - this._playbackStartPerf;
    const targetTime = Math.min(this._playbackStartOffset + elapsed, this.maxTime);

    if (targetTime >= this.maxTime) {
      await this._advancePlaybackTo(this.maxTime);
      this.pause();
      return;
    }

    await this._advancePlaybackTo(targetTime);
    if (!this.isPlaying) return;
    this._playbackFrameId = requestAnimationFrame((frameNow) => this._playbackFrame(frameNow));
  }

  async _advancePlaybackTo(targetTimestamp) {
    if (targetTimestamp <= this.currentTime) return;

    if (this._isPlaybackAdvancing) {
      this._pendingPlaybackTimestamp = Math.max(this._pendingPlaybackTimestamp ?? 0, targetTimestamp);
      return;
    }

    this._isPlaybackAdvancing = true;
    try {
      if (!this.isReviewing || this._lastAppliedTimestamp == null || this._lastAppliedTimestamp > targetTimestamp) {
        await this.seek(targetTimestamp, { suppressPlaybackPause: true });
        return;
      }

      const actionsToReplay = this._collectActionsBetween(
        this._getSnapshotIndexForTimestamp(this._lastAppliedTimestamp),
        this._lastAppliedTimestamp,
        targetTimestamp
      );

      const replayStart = performance.now();
      await this._replayEngine.appendActions(actionsToReplay, targetTimestamp);
      const totalMs = performance.now() - replayStart;

      this.currentTime = targetTimestamp;
      this._lastAppliedTimestamp = targetTimestamp;
      this._telemetry.seek = {
        timestamp: targetTimestamp,
        snapshotTimestamp: this._findNearestSnapshotTimestamp(targetTimestamp),
        snapshotLoadMs: 0,
        replayMs: Number(totalMs.toFixed(2)),
        totalMs: Number(totalMs.toFixed(2)),
        actionsReplayed: actionsToReplay.length,
        heapDelta: null
      };
      this._maybeLogSeekTelemetry();

      if (this._replayCtx && this._replayEngine.outputCanvas) {
        const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
        this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
        this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
        this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
      }
      this._showReplayCanvas(true);
      this._updateBotCursors();
    } finally {
      this._isPlaybackAdvancing = false;
      if (this._pendingPlaybackTimestamp != null && this._pendingPlaybackTimestamp > this.currentTime) {
        const next = this._pendingPlaybackTimestamp;
        this._pendingPlaybackTimestamp = null;
        await this._advancePlaybackTo(next);
      }
    }
  }

  _getSnapshotIndexForTimestamp(timestamp) {
    for (let i = this.recordingBuffer.length - 1; i >= 0; i--) {
      if (this.recordingBuffer[i].timestamp <= timestamp) {
        return i;
      }
    }
    return 0;
  }

  _findNearestSnapshotTimestamp(timestamp) {
    const idx = this._getSnapshotIndexForTimestamp(timestamp);
    return this.recordingBuffer[idx]?.timestamp ?? 0;
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

      if (user.tool === 'text') {
        ui.updateRemoteText(botId, user.text || '');
        // ReplayEngine already renders active text previews into the replay canvas.
        // Keep the bot cursor's DOM text hidden so the preview doesn't appear twice.
        ui.setRemoteTextDomVisible(botId, false);
      } else {
        ui.updateRemoteText(botId, '');
        ui.setRemoteTextDomVisible(botId, false);
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
