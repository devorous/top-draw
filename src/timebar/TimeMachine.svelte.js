/**
 * @fileoverview TimeMachine — server-side checkpoint scrubbing.
 *
 * Local snapshot recording has been removed. All timeline data comes from
 * the server's checkpoint/delta DB. Opening the timebar triggers a
 * CHECKPOINT_LIST request; seeking triggers a REPLAY_REQUEST.
 */

import { ReplayEngine } from './ReplayEngine.js';
import { T } from '../../shared/MessageTypes.js';

const SEEK_TELEMETRY_LOG_INTERVAL_MS = 1500;

/**
 * Return the set of user IDs that have no UNDO or REDO message in the
 * recording. Their strokes can be baked into flatCanvas immediately during
 * replay instead of sitting in strokeStack until the per-user threshold trips.
 * @param {{ deltas: Array<{msg: { t?: number, u?: number }}> }} rec
 * @returns {Set<number>}
 */
function _collectEagerBakeUsers(rec) {
  const all = new Set();
  const undoers = new Set();
  for (const d of rec?.deltas ?? []) {
    const u = d?.msg?.u;
    if (u == null) continue;
    all.add(u);
    if (d.msg.t === T.UNDO || d.msg.t === T.REDO) undoers.add(u);
  }
  const eager = new Set();
  for (const u of all) if (!undoers.has(u)) eager.add(u);
  return eager;
}

/**
 * TimeMachine manages server-side replay of board history.
 */
class TimeMachineState {
  // ── public reactive state ──────────────────────────────────────────────────
  /** [{id, ts, uploader, sizeBytes}] sorted ascending by ts */
  checkpoints = $state([]);
  /** timestamp of first checkpoint */
  sessionStart = $state(0);
  /** timestamp of latest known activity (ticks live when in a room) */
  sessionEnd = $state(0);
  currentTime = $state(0);
  isReviewing = $state(false);
  isPlaying = $state(false);
  /** true while loading checkpoint list or a replay window */
  isLoading = $state(false);
  /** true once checkpoint list has been loaded for the current room */
  isOpen = $state(false);
  /** controls whether the timebar panel is visible */
  isVisible = $state(false);
  previewData = $state(null);

  // ── backward-compat getters ────────────────────────────────────────────────
  /** @deprecated use isOpen */
  get isStarted() { return this.isOpen; }
  /** @deprecated use sessionEnd */
  get maxTime() { return this.sessionEnd; }
  /** kept so Timebar.svelte can reference it safely */
  get frozenMaxTime() { return null; }
  /** true when the scrubber is showing a finite local Recorder tape */
  get isLocalReplay() { return this._source === 'local'; }
  /** no longer relevant — always false */
  get needsResync() { return false; }
  /** no local buffer — always empty */
  get recordingBuffer() { return []; }

  // ── private ────────────────────────────────────────────────────────────────
  _board = null;
  _wsClient = null;
  _replayEngine = null;
  _replayCanvas = null;
  _replayCtx = null;
  /** 'server' = server checkpoint+delta DB, 'local' = client-side Recorder bundle */
  _source = 'server';
  /** Active local recording (set by loadFromRecording). */
  _localRecording = null;
  /** @type {Set<number>} negative IDs of bot cursors created in the UI */
  _botCursorIds = new Set();
  /** @type {Array<{element: HTMLElement|SVGElement, display: string}>} */
  _hiddenRealtimeCursorElements = [];
  _isSeeking = false;
  _seekGeneration = 0;
  _pendingSeekTimestamp = null;
  _lastAppliedTimestamp = null;
  _lastSeekLogAt = 0;
  _isPlaybackAdvancing = false;
  _pendingPlaybackTimestamp = null;
  _playbackStartPerf = 0;
  _playbackStartOffset = 0;
  _pendingServerReplay = false;
  _playbackFrameId = null;
  _tickInterval = null;
  _telemetry = { seek: null };
  /** @type {Array<{ts: number, bitmap: ImageBitmap, botStates: Object}>} sorted ascending */
  _dynCheckpoints = [];
  _dynCheckpointMinIntervalMs = 3000;
  _dynCheckpointMaxCount = 8;
  _dynCheckpointInFlight = false;
  _lastDynCheckpointTs = null;

  // ── initialisation ─────────────────────────────────────────────────────────

  /**
   * @param {import('../canvas/Board.js').Board} board
   * @param {import('../network/WebSocketClient.js').WebSocketClient} wsClient
   */
  init(board, wsClient) {
    this._board = board;
    this._wsClient = wsClient;

    this._replayEngine = new ReplayEngine();
    this._replayEngine.init(board.getWidth(), board.getHeight(), wsClient);

    this._replayEngine.onOutputUpdate = () => {
      if (this._replayCtx && this._replayEngine.outputCanvas && this.isReviewing) {
        this._drawToReplayCanvas();
      }
    };

    this._createReplayCanvas();
  }

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
    boardsWrapper.appendChild(this._replayCanvas);
  }

  _drawToReplayCanvas() {
    if (!this._replayCtx || !this._replayEngine.outputCanvas) return;
    const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
    this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
    this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
    this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
  }

  /**
   * Replay engine's internal LayerManager. Exposed so the parity harness can
   * diff replayed pixels against live ones without poking at private state.
   * @returns {import('../canvas/LayerManager.js').LayerManager|null}
   */
  getReplayLayerManager() {
    return this._replayEngine?._replayBoard?.layerManager ?? null;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Load checkpoint list from server and open the timebar.
   * Safe to call multiple times — subsequent calls refresh the list.
   */
  async loadFromServer() {
    if (!this._wsClient) return;
    if (this.isLoading) return;

    this.isLoading = true;
    try {
      const data = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._wsClient.messageHandlers.delete('checkpoint_list_response');
          reject(new Error('Checkpoint list request timed out'));
        }, 10_000);

        this._wsClient.on('checkpoint_list_response', (response) => {
          clearTimeout(timeout);
          this._wsClient.messageHandlers.delete('checkpoint_list_response');
          resolve(response);
        });

        this._wsClient.requestCheckpointList();
      });

      this._onCheckpointListReceived(data.checkpoints || []);
    } catch (err) {
      console.error('[TimeMachine] Failed to load from server:', err);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * @deprecated Legacy name — calls loadFromServer() for backward compat with App.js.
   */
  start() {
    this.loadFromServer();
  }

  /**
   * Forward a tapped WebSocket message into the active local Recorder, if any.
   * Called by WebSocketClient for both inbound and outbound messages.
   *
   * @param {Object} msg - decoded JSON message
   * @param {'inbound'|'outbound'} direction
   */
  recordAction(msg, direction) {
    const rec = (typeof window !== 'undefined' ? window.app?.recorder : null);
    if (!rec?.isRecording?.()) return;
    if (direction === 'inbound') {
      rec.recordIncoming(msg);
    } else {
      rec.recordOutgoing(msg);
    }
  }

  /**
   * Open the timebar against a local Recorder bundle (no server round trip).
   * Wires the replay engine to the recording's asset pool and seeks to the
   * end of the tape.
   *
   * @param {import('../replay/Recorder.js').ReplayRecording} rec
   */
  async loadFromRecording(rec) {
    if (!rec) return;
    if (this.isLoading) return;
    // If a server source was loaded, tear it down first.
    if (this._source === 'server' && this.isOpen) this.stop();

    this._source = 'local';
    this._localRecording = rec;
    this._clearDynCheckpoints();

    // Match the replay engine to the recording's board dimensions. The engine
    // was sized to whatever the live board was at App boot, which is usually
    // the default 1920x1080 — but rooms can have larger boards (e.g. 2560x1440)
    // and the snapshot's canvasData is at the room's actual size.
    const [rh, rw] = Array.isArray(rec.openingSnapshot?.boardDimensions)
      ? rec.openingSnapshot.boardDimensions
      : [this._board?.getHeight?.() ?? 0, this._board?.getWidth?.() ?? 0];
    if (rw && rh) {
      this._replayEngine.resize(rw, rh);
      if (this._replayCanvas) {
        this._replayCanvas.width = rw;
        this._replayCanvas.height = rh;
      }
    }

    // Build a checkpoint list out of the opening snapshot + intra-checkpoints.
    const checkpoints = [
      { id: 'opening', ts: rec.startedAt, kind: 'opening' },
      ...rec.intraCheckpoints.map((cp, idx) => ({
        id: `intra_${idx}`,
        ts: cp.ts,
        kind: 'intra',
      })),
    ];

    this.checkpoints = checkpoints;
    this.sessionStart = rec.startedAt;
    this.sessionEnd = rec.endedAt ?? Date.now();
    this.currentTime = this.sessionEnd;

    // Asset resolver wires the recording's asset pool into the replay engine.
    // ReplayEngine pipes EVERY image source through this resolver — including
    // plain dataURL strings (the snapshot's canvasData). So we must pass
    // strings through unchanged; only `{ assetRef }` objects get rewritten.
    if (this._replayEngine?.setAssetResolver) {
      this._replayEngine.setAssetResolver((source) => {
        if (!source) return null;
        if (typeof source === 'string') return source;
        if (typeof source === 'object' && source.assetRef) {
          return rec.assets?.[source.assetRef] ?? null;
        }
        return null;
      });
    }

    this.isOpen = true;
    this.isReviewing = false;
    this.isPlaying = false;
    this._lastAppliedTimestamp = null;

    // Find users with no UNDO/REDO in the tape and tell the replay engine
    // their strokes can bake immediately. Cuts per-frame composite work on
    // long multi-user tapes where most strokes will never be undone.
    this._replayEngine?.setEagerBakeUsers?.(_collectEagerBakeUsers(rec));

    // Drop into review at the end of the tape immediately so the user sees
    // the final frame the moment they stop recording.
    await this.seek(this.sessionEnd);
  }

  /**
   * Clear all state when leaving a room.
   */
  stop() {
    this._seekGeneration += 1;
    this.isOpen = false;
    this.isReviewing = false;
    this.isPlaying = false;
    this.isLoading = false;
    this.checkpoints = [];
    this.currentTime = 0;
    this.sessionStart = 0;
    this.sessionEnd = 0;
    this.previewData = null;
    this._lastAppliedTimestamp = null;
    this._pendingSeekTimestamp = null;
    this._pendingPlaybackTimestamp = null;
    this._source = 'server';
    this._localRecording = null;
    this._clearDynCheckpoints();
    if (this._replayEngine?.setAssetResolver) {
      this._replayEngine.setAssetResolver(null);
    }
    this._showReplayCanvas(false);
    this._removeBotCursors();

    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
  }

  /**
   * Seek to a specific timestamp.
   * @param {number} timestamp
   * @param {{ suppressPlaybackPause?: boolean }} [options]
   */
  async seek(timestamp, options = {}) {
    if (!this.isOpen) return;
    const { suppressPlaybackPause = false } = options;

    this.currentTime = Math.max(
      this.sessionStart || 0,
      Math.min(timestamp, this.sessionEnd)
    );

    const wasReviewing = this.isReviewing;
    if (this._source === 'local') {
      // Local recordings have no live edge — the tape ended. Every position
      // shows replay pixels, including the final frame at sessionEnd.
      this.isReviewing = true;
    } else {
      // "At live" = within 60s of sessionEnd (a checkpoint may be ~60s stale)
      this.isReviewing = this.currentTime < (this.sessionEnd - 60_000);
    }

    if (this.isReviewing && !wasReviewing) {
      // Entered review mode
    } else if (!this.isReviewing && wasReviewing) {
      // Exited review mode
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
      const seekGeneration = ++this._seekGeneration;
      try {
        await this._applyStateAt(this.currentTime);
        if (seekGeneration !== this._seekGeneration || !this.isReviewing) return;
        this._showReplayCanvas(true);
        this._updateBotCursors();
      } finally {
        this._isSeeking = false;
        if (seekGeneration === this._seekGeneration && this._pendingSeekTimestamp !== null) {
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
   * Return to the live board state.
   */
  catchUp() {
    this.pause();
    this._seekGeneration += 1;
    this._flushLiveMessageQueue();

    if (this._source === 'local') {
      // A local recording is a finite tape, not the server's live timeline.
      // The live board has kept processing socket messages while the replay
      // canvas was visible, so leaving the tape should reveal that board.
      this.stop();
      window.app?.updateRecordingButtonState?.();
      return;
    }

    this.sessionEnd = Math.max(this.sessionEnd || 0, Date.now());
    this.currentTime = this.sessionEnd;
    this.isReviewing = false;
    this._lastAppliedTimestamp = null;
    this._pendingSeekTimestamp = null;
    this._pendingPlaybackTimestamp = null;
    this.previewData = null;
    this._showReplayCanvas(false);
    this._removeBotCursors();
  }

  play() {
    if (!this.isOpen || this.isPlaying || this.currentTime >= this.sessionEnd) return;
    this.isPlaying = true;
    this._playbackStartPerf = performance.now();
    this._playbackStartOffset = this.currentTime;
    this._playbackFrameId = requestAnimationFrame((now) => this._playbackFrame(now));
  }

  pause() {
    this.isPlaying = false;
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
    this._pendingPlaybackTimestamp = null;
  }

  /**
   * Request the server to revert the board to a specific timestamp.
   * @param {number} timestamp
   */
  requestUndoTo(timestamp) {
    if (!this._wsClient) return;
    this._wsClient.send({ t: T.MOD_UNDO_TO_STATE, mod_undo_ts: timestamp });
  }

  /**
   * Local-replay equivalent of requestUndoTo: paint the currently-displayed
   * replay state onto the live board and drop back to live view. Only
   * meaningful for client-side recordings (no server coordination). The
   * server is unaware — collaborators would see this as a clear+redraw on
   * any subsequent stroke, so this is really a single-user "rewind my own
   * canvas" operation.
   */
  restoreLocalToCurrentState() {
    if (this._source !== 'local' || !this.isReviewing) return;
    const src = this._replayEngine?.outputCanvas;
    const liveBoard = this._board;
    if (!src || !liveBoard) return;
    liveBoard.clear?.();
    const layer0 = liveBoard.layerManager?.layerGroups?.[0];
    if (layer0?.flatCtx) {
      layer0.flatCtx.drawImage(src, 0, 0);
    }
    liveBoard.markCompositeFull?.();
    liveBoard.compositeAllLayers?.();
    this.catchUp();
  }

  // ── private helpers ────────────────────────────────────────────────────────

  _onCheckpointListReceived(rawList) {
    const sorted = [...rawList].sort((a, b) => a.ts - b.ts);
    this.checkpoints = sorted;

    if (sorted.length > 0) {
      this.sessionStart = sorted[0].ts;
      this.sessionEnd = sorted[sorted.length - 1].ts;
    } else {
      this.sessionStart = Date.now();
      this.sessionEnd = Date.now();
    }

    this.currentTime = this.sessionEnd;
    this.isOpen = true;
    this._startLiveTick();

    console.log(`[TimeMachine] Loaded ${sorted.length} server checkpoints`);
  }

  /**
   * Tick sessionEnd forward so the scrubber's live edge stays current.
   * @private
   */
  _startLiveTick() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      if (!this.isReviewing) {
        this.sessionEnd = Date.now();
        this.currentTime = this.sessionEnd;
      }
    }, 5_000);
  }

  /**
   * Apply state at the given timestamp from whichever source is active.
   * @param {number} timestamp
   * @private
   */
  async _applyStateAt(timestamp) {
    if (this._source === 'local') {
      await this._applyStateAtLocal(timestamp);
    } else {
      await this._fetchAndApplyServerReplay(timestamp);
    }
  }

  /**
   * Apply state at `timestamp` by replaying from the nearest local checkpoint.
   *
   * Strategy: find the latest checkpoint with `ts <= timestamp`, load its
   * snapshot into the ReplayEngine, then `processActions()` every delta in
   * `(checkpoint.ts, timestamp]`. ReplayEngine routes those through the real
   * RemoteUserHandler so the output is byte-identical to a fresh live draw.
   *
   * @param {number} timestamp
   * @private
   */
  async _applyStateAtLocal(timestamp) {
    const rec = this._localRecording;
    if (!rec || !this._replayEngine) return;
    const seekStart = performance.now();

    // Fast path: forward seek within the same session — the engine is already
    // at _lastAppliedTimestamp, so we only need to push the new deltas through
    // appendActions (no snapshot reload, no re-replay from the checkpoint).
    // Anything else (first seek, backward scrub, source change) falls through
    // to the full rebuild below.
    const canIncrement =
      this._lastAppliedTimestamp != null &&
      timestamp >= this._lastAppliedTimestamp;

    if (canIncrement) {
      const lastTs = this._lastAppliedTimestamp;
      const actions = [];
      for (const d of rec.deltas) {
        if (d.ts <= lastTs) continue;
        if (d.ts > timestamp) break;
        actions.push({ timestamp: d.ts, msg: d.msg });
      }
      await this._replayEngine.appendActions(actions, timestamp);

      this._lastAppliedTimestamp = timestamp;
      this._drawToReplayCanvas();
      this.previewData = true;

      const totalMs = (performance.now() - seekStart).toFixed(1);
      this._telemetry.seek = {
        timestamp,
        totalMs: Number(totalMs),
        actionsReplayed: actions.length,
        incremental: true,
      };
      this._maybeLogSeekTelemetry();
      this._maybeCaptureDynCheckpoint(timestamp);
      return;
    }

    // Backward-scrub path. Prefer a dynamic in-engine checkpoint over the
    // static intra-checkpoint when one exists later in the tape — that's the
    // whole reason the cache exists. Falls back gracefully if none is closer.
    const staticCp = this._findCheckpointBefore(timestamp);
    const dynCp = this._findDynCheckpointBefore(timestamp);
    const useDyn = dynCp && (!staticCp || dynCp.ts > staticCp.ts);

    let cpTs;
    let usedDyn = false;
    if (useDyn) {
      await this._replayEngine.loadDynamicCheckpoint(dynCp);
      cpTs = dynCp.ts;
      usedDyn = true;
    } else {
      cpTs = staticCp?.ts ?? rec.startedAt;
      const snapshot = staticCp?.id === 'opening' || !staticCp
        ? rec.openingSnapshot
        : rec.intraCheckpoints[Number(staticCp.id.slice('intra_'.length))]?.snapshot
          ?? rec.openingSnapshot;
      await this._replayEngine.loadSnapshot(snapshot);
    }

    const actions = [];
    for (const d of rec.deltas) {
      if (d.ts < cpTs) continue;
      if (d.ts > timestamp) break;
      actions.push({ timestamp: d.ts, msg: d.msg });
    }

    // Always call processActions — even with no actions, the rebase-snapshot
    // path inside _runActionBatch paints the loaded snapshot pixels into
    // layer 0's flatCanvas and runs _compositeOutput. Skipping this when
    // actions is empty (e.g. seeking to a position right at an intra
    // checkpoint with nothing after it) leaves the replay engine's
    // LayerManager blank.
    await this._replayEngine.processActions(actions, timestamp);

    this._lastAppliedTimestamp = timestamp;
    this._drawToReplayCanvas();
    this.previewData = true;

    const totalMs = (performance.now() - seekStart).toFixed(1);
    this._telemetry.seek = {
      timestamp,
      totalMs: Number(totalMs),
      actionsReplayed: actions.length,
      cpKind: usedDyn ? 'dyn' : 'static',
    };
    this._maybeLogSeekTelemetry();
    this._maybeCaptureDynCheckpoint(timestamp);
  }

  /**
   * Fire-and-forget: capture a dynamic checkpoint at the current state if
   * enough tape time has elapsed since the last one and no bot is mid-stroke.
   * Mid-stroke captures would be awkward to resume (active stroke canvases
   * would have to be cloned too), so we just skip and try again on the next
   * settled frame.
   * @param {number} timestamp - The tape timestamp this state represents.
   * @private
   */
  _maybeCaptureDynCheckpoint(timestamp) {
    if (!this._replayEngine || this._dynCheckpointInFlight) return;
    if (
      this._lastDynCheckpointTs != null &&
      Math.abs(timestamp - this._lastDynCheckpointTs) < this._dynCheckpointMinIntervalMs
    ) return;

    for (const u of this._replayEngine.botUsers?.values?.() ?? []) {
      if (u?.mousedown) return;
    }

    this._dynCheckpointInFlight = true;
    this._replayEngine.captureDynamicCheckpoint()
      .then((cp) => {
        if (!cp) return;
        // Discard if a different recording was loaded while we were capturing.
        if (!this._localRecording || !this.isOpen) {
          cp.bitmap.close?.();
          return;
        }
        // Insert sorted by ts; replace if same ts already exists.
        const existingIdx = this._dynCheckpoints.findIndex((e) => e.ts === timestamp);
        if (existingIdx >= 0) {
          this._dynCheckpoints[existingIdx].bitmap?.close?.();
          this._dynCheckpoints[existingIdx] = { ts: timestamp, ...cp };
        } else {
          this._dynCheckpoints.push({ ts: timestamp, ...cp });
          this._dynCheckpoints.sort((a, b) => a.ts - b.ts);
        }
        while (this._dynCheckpoints.length > this._dynCheckpointMaxCount) {
          const dropped = this._dynCheckpoints.shift();
          dropped?.bitmap?.close?.();
        }
        this._lastDynCheckpointTs = timestamp;
      })
      .catch((err) => console.warn('[TimeMachine] dyn checkpoint capture failed:', err))
      .finally(() => { this._dynCheckpointInFlight = false; });
  }

  _findDynCheckpointBefore(ts) {
    let best = null;
    for (const cp of this._dynCheckpoints) {
      if (cp.ts <= ts && (!best || cp.ts > best.ts)) best = cp;
    }
    return best;
  }

  _clearDynCheckpoints() {
    for (const cp of this._dynCheckpoints) cp?.bitmap?.close?.();
    this._dynCheckpoints = [];
    this._lastDynCheckpointTs = null;
  }

  /**
   * Request checkpoint image + deltas from the server and play them into the
   * ReplayEngine.
   * @param {number} timestamp - Target replay timestamp
   * @private
   */
  async _fetchAndApplyServerReplay(timestamp) {
    if (this._pendingServerReplay) return;
    this._pendingServerReplay = true;
    const seekStart = performance.now();

    try {
      const data = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._wsClient.messageHandlers.delete('replay_response');
          reject(new Error('Replay request timed out'));
        }, 15_000);

        this._wsClient.on('replay_response', (response) => {
          clearTimeout(timeout);
          this._wsClient.messageHandlers.delete('replay_response');
          resolve(response);
        });

        // Find the checkpoint just before the target and request from there
        const cp = this._findCheckpointBefore(timestamp);
        const startTs = cp ? cp.ts : timestamp - 5 * 60_000;
        this._wsClient.requestReplay(startTs, timestamp);
      });

      if (!data.checkpointImg || data.checkpointImg.length === 0) {
        console.warn('[TimeMachine] Server returned no checkpoint image');
        return;
      }

      await this._replayEngine.loadCheckpointImage(data.checkpointImg);

      if (data.deltas && data.deltas.length > 0) {
        const actions = data.deltas.map(d => ({ timestamp: d._ts, msg: d }));
        await this._replayEngine.processActions(actions, timestamp);
      }

      this._lastAppliedTimestamp = timestamp;

      const totalMs = (performance.now() - seekStart).toFixed(1);
      this._telemetry.seek = {
        timestamp,
        totalMs: Number(totalMs),
        actionsReplayed: data.deltas?.length || 0
      };
      this._maybeLogSeekTelemetry();

      this._drawToReplayCanvas();
      this.previewData = true;

      console.log(`[TimeMachine] Seek to ${new Date(timestamp).toLocaleTimeString()}: checkpoint + ${data.deltas?.length || 0} deltas in ${totalMs}ms`);
    } catch (err) {
      console.error('[TimeMachine] Server replay failed:', err);
    } finally {
      this._pendingServerReplay = false;
    }
  }

  /**
   * Return the most recent checkpoint with ts <= timestamp, or null.
   * @param {number} timestamp
   * @returns {{id: string, ts: number}|null}
   * @private
   */
  _findCheckpointBefore(timestamp) {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      if (this.checkpoints[i].ts <= timestamp) {
        return this.checkpoints[i];
      }
    }
    return null;
  }

  _maybeLogSeekTelemetry() {
    const now = performance.now();
    if ((now - this._lastSeekLogAt) < SEEK_TELEMETRY_LOG_INTERVAL_MS) return;
    this._lastSeekLogAt = now;
    const s = this._telemetry.seek;
    if (!s) return;
    console.log(`[TimeMachine] Seek ${s.totalMs}ms (${s.actionsReplayed} actions replayed)`);
  }

  /**
   * Drain any decoded/batched websocket work before revealing the live board.
   * Replay mode does not pause live handling, but the WebSocket client may have
   * a frame-budgeted queue. Draining it here gives "catch up" a crisp edge
   * without doing a destructive full resync.
   * @private
   */
  _flushLiveMessageQueue() {
    const ws = this._wsClient;
    if (!ws || typeof ws._processMessageQueue !== 'function') return;
    if (!Array.isArray(ws._messageQueue) || ws._messageQueue.length === 0) return;
    try {
      ws._processMessageQueue(true);
    } catch (err) {
      console.warn('[TimeMachine] Failed to flush live message queue before catch-up:', err);
    }
  }

  async _playbackFrame(now) {
    if (!this.isPlaying) return;

    const elapsed = now - this._playbackStartPerf;
    const targetTime = Math.min(this._playbackStartOffset + elapsed, this.sessionEnd);

    if (targetTime >= this.sessionEnd) {
      await this.seek(this.sessionEnd, { suppressPlaybackPause: true });
      this.pause();
      return;
    }

    await this.seek(targetTime, { suppressPlaybackPause: true });
    if (!this.isPlaying) return;
    this._playbackFrameId = requestAnimationFrame((frameNow) => this._playbackFrame(frameNow));
  }

  // ── canvas overlay ─────────────────────────────────────────────────────────

  _showReplayCanvas(show) {
    if (this._replayCanvas) {
      this._replayCanvas.style.display = show ? 'block' : 'none';
    }

    window.app?.ui?.remoteUserUI?.setReplayModeActive(show);

    if (this._board) {
      const display = show ? 'none' : 'block';
      if (this._board.mainCanvas) this._board.mainCanvas.style.display = display;
      if (this._board.topCanvas) this._board.topCanvas.style.display = display;
      if (this._board.upperLayersCanvas) this._board.upperLayersCanvas.style.display = display;

      const userBoards = document.getElementById('userBoards');
      if (userBoards) userBoards.style.display = display;
    }

    this._setRealtimeCursorVisibility(!show);
  }

  _setRealtimeCursorVisibility(visible) {
    const ui = window.app?.ui;
    if (!ui) return;

    if (visible) {
      for (const { element, display } of this._hiddenRealtimeCursorElements) {
        if (element?.style) element.style.display = display;
      }
      this._hiddenRealtimeCursorElements = [];
      return;
    }

    if (this._hiddenRealtimeCursorElements.length > 0) return;

    const hideElement = (element) => {
      if (!element?.style) return;
      this._hiddenRealtimeCursorElements.push({ element, display: element.style.display });
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

    // Hide ALL user-list entries (bots too). The cursor visuals above are
    // kept on the canvas overlay so the viewer still sees who's drawing; the
    // sidebar/list itself is just chrome that distracts from playback.
    for (const [userId] of remoteCursors ?? []) {
      hideElement(document.querySelector(`.userEntry.u${userId}`));
    }

    for (const group of remoteUserUI.userGroups?.values?.() ?? []) {
      hideElement(group?.element);
    }

    const userListEl = document.getElementById('userList') || document.querySelector('.userList');
    hideElement(userListEl);
  }

  // ── bot cursors ────────────────────────────────────────────────────────────

  _updateBotCursors() {
    const ui = window.app?.ui;
    if (!ui || !this._replayEngine) return;

    for (const [id, user] of this._replayEngine.botUsers) {
      const botId = -1000 - id;

      if (!this._botCursorIds.has(botId)) {
        ui.createRemoteUser(botId, {
          username: user.username || `User ${id}`,
          role: user.role ?? 0,
          color: user.color || [100, 100, 100, 1],
          size: user.size || 10,
          tool: user.tool || 'brush',
          x: user.x ?? 0,
          y: user.y ?? 0
        });
        this._botCursorIds.add(botId);
      }

      if (user.x !== undefined && user.y !== undefined) {
        ui.updateRemoteCursor(botId, user.x, user.y, user.size || 10);
      }
      ui.updateRemoteSize(botId, user.size || 10);
      ui.updateRemoteToolDisplay(botId, user.tool || 'brush');
      if (user.color) ui.updateRemoteColor(botId, user.color);

      if (user.tool === 'text') {
        ui.updateRemoteText(botId, user.text || '');
        ui.setRemoteTextDomVisible(botId, false);
      } else {
        ui.updateRemoteText(botId, '');
        ui.setRemoteTextDomVisible(botId, false);
      }
    }
  }

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
