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
  /** @type {Set<number>} negative IDs of bot cursors created in the UI */
  _botCursorIds = new Set();
  /** @type {Array<{element: HTMLElement|SVGElement, display: string}>} */
  _hiddenRealtimeCursorElements = [];
  _isSeeking = false;
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
   * No-op. Local action recording has been removed.
   * The method is kept so callers in WebSocketClient don't need to change.
   */
  recordAction() {}

  /**
   * Clear all state when leaving a room.
   */
  stop() {
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
    // "At live" = within 60s of sessionEnd (a checkpoint may be ~60s stale)
    this.isReviewing = this.currentTime < (this.sessionEnd - 60_000);

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
   * Return to the live board state.
   */
  catchUp() {
    this.pause();
    this.seek(this.sessionEnd);
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
   * Apply state at the given timestamp by fetching from the server.
   * @param {number} timestamp
   * @private
   */
  async _applyStateAt(timestamp) {
    await this._fetchAndApplyServerReplay(timestamp);
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

    for (const [userId] of remoteCursors ?? []) {
      if (this._botCursorIds.has(Number(userId))) continue;
      hideElement(document.querySelector(`.userEntry.u${userId}`));
    }

    for (const group of remoteUserUI.userGroups?.values?.() ?? []) {
      hideElement(group?.element);
    }
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
