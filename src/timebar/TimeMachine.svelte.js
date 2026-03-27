import { appState } from '../state.svelte.js';
import { T } from '../../shared/MessageTypes.js';

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
  previewData = $state(null); // The current historical view as a data URL

  _snapshotInterval = null;
  _tickInterval = null;
  _playbackInterval = null;
  _board = null;
  _offscreenCanvas = null;
  _offscreenCtx = null;
  _wsClient = null;

  /**
   * Initialize the TimeMachine with a reference to the board and wsClient.
   * @param {Board} board - The main drawing board instance
   * @param {WebSocketClient} wsClient - The websocket client
   */
  init(board, wsClient) {
    this._board = board;
    this._wsClient = wsClient;
    
    // Create off-screen canvas for scrubbing
    this._offscreenCanvas = document.createElement('canvas');
    this._offscreenCanvas.width = board.getWidth();
    this._offscreenCanvas.height = board.getHeight();
    this._offscreenCtx = this._offscreenCanvas.getContext('2d');
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
    const appStateData = {
      users: Array.from(appState.users.entries()),
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
   * Record an incoming or outgoing protobuf action.
   * @param {Uint8Array} actionBuffer - Raw protobuf message buffer
   */
  recordAction(actionBuffer) {
    if (!this.isStarted || this.recordingBuffer.length === 0) return;

    const timestamp = Date.now();
    const latestSnapshot = this.recordingBuffer[this.recordingBuffer.length - 1];
    
    latestSnapshot.actions.push({
      timestamp,
      buffer: actionBuffer
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
  seek(timestamp) {
    if (!this.isStarted) return;

    this.currentTime = Math.max(
      this.recordingBuffer[0]?.timestamp || 0,
      Math.min(timestamp, this.maxTime)
    );
    
    this.isReviewing = this.currentTime < (this.maxTime - 500); // 500ms threshold
    
    if (this.isReviewing) {
      this._applyStateAt(this.currentTime);
    } else {
      this.previewData = null;
    }
  }

  /**
   * Internal method to apply state and actions to the off-screen canvas.
   * @param {number} timestamp - Target timestamp
   * @private
   */
  _applyStateAt(timestamp) {
    // 1. Find the snapshot closest to, but not exceeding, the target timestamp
    let snapshot = null;
    for (let i = this.recordingBuffer.length - 1; i >= 0; i--) {
      if (this.recordingBuffer[i].timestamp <= timestamp) {
        snapshot = this.recordingBuffer[i];
        break;
      }
    }

    if (!snapshot) return;

    // 2. Restore base state to off-screen canvas (both layers)
    const imgMain = new Image();
    const imgTop = new Image();
    let loadedCount = 0;

    const onLayerLoaded = () => {
      loadedCount++;
      if (loadedCount === 2) {
        this._offscreenCtx.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);
        this._offscreenCtx.drawImage(imgMain, 0, 0);
        this._offscreenCtx.drawImage(imgTop, 0, 0);

        // 3. Replay actions forward from snapshot to target timestamp
        const actionsToReplay = snapshot.actions.filter(a => a.timestamp > snapshot.timestamp && a.timestamp <= timestamp);
        
        // Track per-user state during this replay run
        const replayUserStates = new Map();

        for (const action of actionsToReplay) {
          this._replayAction(action.buffer, this._offscreenCtx, replayUserStates);
        }

        // 4. Update preview data URL
        this.previewData = this._offscreenCanvas.toDataURL('image/png');
      }
    };

    imgMain.onload = onLayerLoaded;
    imgTop.onload = onLayerLoaded;
    
    imgMain.src = snapshot.canvasData;
    imgTop.src = snapshot.topCanvasData;
  }

  /**
   * Replay a single protobuf action onto a context.
   * @param {Uint8Array} buffer - Action buffer
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Map} userStates - Map of sessionIndex -> { lastX, lastY, color, size, etc }
   * @private
   */
  _replayAction(buffer, ctx, userStates) {
    if (!this._wsClient || !this._wsClient.Msg) return;

    try {
      const msg = this._wsClient.Msg.decode(buffer);
      const userId = msg.sessionIndex;
      
      // Get or create user state for replay
      if (!userStates.has(userId)) {
        userStates.set(userId, {
          x: 0, y: 0, color: [0, 0, 0, 1], size: 10, mousedown: false
        });
      }
      const state = userStates.get(userId);

      switch (msg.t) {
        case T.MD:
          state.mousedown = true;
          if (msg.ps && msg.ps.length >= 2) {
            state.x = msg.ps[0];
            state.y = msg.ps[1];
            // Draw a dot for MD
            this._drawSegment(ctx, state.x, state.y, state.x, state.y, state.color, state.size);
            // Draw subsequent points if any
            for (let i = 2; i < msg.ps.length; i += 2) {
              const nx = msg.ps[i];
              const ny = msg.ps[i+1];
              this._drawSegment(ctx, state.x, state.y, nx, ny, state.color, state.size);
              state.x = nx;
              state.y = ny;
            }
          }
          break;

        case T.MM:
          if (msg.ps && msg.ps.length >= 2) {
            for (let i = 0; i < msg.ps.length; i += 2) {
              const nx = msg.ps[i];
              const ny = msg.ps[i+1];
              if (state.mousedown) {
                this._drawSegment(ctx, state.x, state.y, nx, ny, state.color, state.size);
              }
              state.x = nx;
              state.y = ny;
            }
          }
          break;

        case T.MU:
          state.mousedown = false;
          break;

        case T.CC: // Color Change
          if (msg.c !== undefined) {
            const color = msg.c;
            const r = (color >> 24) & 0xFF;
            const g = (color >> 16) & 0xFF;
            const b = (color >> 8) & 0xFF;
            const a = (color & 0xFF) / 255;
            state.color = [r, g, b, a];
          }
          break;

        case T.CS: // Size Change
          if (msg.s !== undefined) {
            state.size = msg.s / 100;
          }
          break;

        case T.CLR:
          ctx.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);
          break;
      }
    } catch (err) {
      // Ignore decode errors for non-drawing messages
    }
  }

  /**
   * Helper to draw a line segment.
   * @private
   */
  _drawSegment(ctx, x1, y1, x2, y2, color, size) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
    ctx.lineWidth = size * 2; // Matches board.js line width
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
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
}

export const TimeMachine = new TimeMachineState();
