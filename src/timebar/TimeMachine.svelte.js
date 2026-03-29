import { appState } from '../state.svelte.js';
import { ReplayEngine } from './ReplayEngine.js';

/**
 * Snapshot structure to store board and application state at a point in time.
 */
class Snapshot {
  constructor(timestamp, appStateData, canvasData, topCanvasData, layerStates) {
    this.timestamp = timestamp;
    this.appState = JSON.parse(JSON.stringify(appStateData));
    this.canvasData = canvasData; // base64 PNG of main board
    this.topCanvasData = topCanvasData; // base64 PNG of active strokes
    this.layerStates = JSON.parse(JSON.stringify(layerStates));
    this.actions = []; // Array of { timestamp, buffer }
  }
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

  _snapshotInterval = null;
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
    
    console.log('[TimeMachine] Starting recording...');
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
    this._showReplayCanvas(false);
    this._removeBotCursors();

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

    // Tick every second to update maxTime even if no actions occur
    this._tickInterval = setInterval(() => {
      this._tick();
    }, 1000);
  }

  /**
   * Internal tick to keep the timebar growing.
   * @private
   */
  _tick() {
    if (!this.isStarted || this.recordingBuffer.length === 0) return;

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
    if (!this._board || !this.isStarted) return;

    const timestamp = Date.now();
    console.log(`[TimeMachine] Taking snapshot at ${new Date(timestamp).toLocaleTimeString()}`);
    
    // Capture both main board and active strokes canvas
    const canvasData = this._board.mainCanvas.toDataURL('image/png');
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
    if (window.app?.users) {
      window.app.users.forEach((user, id) => {
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

    const snapshot = new Snapshot(timestamp, appStateData, canvasData, topCanvasData, layerStates);
    
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

    this.isReviewing = this.currentTime < (this.maxTime - 500); // 500ms threshold

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

    // 1. Find the snapshot closest to, but not exceeding, the target timestamp
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

    console.log('[TimeMachine] Applying state at', new Date(timestamp).toLocaleTimeString(),
      'using snapshot from', new Date(snapshot.timestamp).toLocaleTimeString());

    // 2. Load snapshot into replay engine
    await this._replayEngine.loadSnapshot(snapshot);

    // 3. Gather all actions from snapshot to target timestamp
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

    console.log('[TimeMachine] Replaying', actionsToReplay.length, 'actions');

    // 4. Process actions through replay engine
    await this._replayEngine.processActions(actionsToReplay, timestamp);

    // 5. Draw replay result to the replay canvas
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
   */
  catchUp() {
    this.pause();
    this.seek(this.maxTime);
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
