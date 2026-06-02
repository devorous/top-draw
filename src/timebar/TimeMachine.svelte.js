/**
 * @fileoverview TimeMachine — server-side checkpoint scrubbing.
 *
 * Local snapshot recording has been removed. All timeline data comes from
 * the server's checkpoint/delta DB. Opening the timebar triggers a
 * CHECKPOINT_LIST request; seeking triggers a REPLAY_REQUEST.
 */

import { ReplayEngine } from './ReplayEngine.js';
import { T } from '../../shared/MessageTypes.js';
import { encodeDdraw, suggestDdrawFilename } from '../replay/ddrawCodec.js';
import { TimeLapseExporter, suggestImageSequenceFilename, suggestVideoFilename } from '../replay/TimeLapseExporter.js';

const SEEK_TELEMETRY_LOG_INTERVAL_MS = 1500;
const LOCAL_REVERSE_SCRUB_FRAME_MS = 500;
const LOCAL_REVERSE_SCRUB_INTERVAL_MS = 90;
const VISUAL_CHECKPOINT_INTERVAL_MS = 2000;
/** Hard cap on visual checkpoints (frame count, before stride). */
const VISUAL_CHECKPOINT_MAX_COUNT = 600;
/** Downscale source before compressing — keeps blobs tiny while staying readable when upscaled. */
const VISUAL_CHECKPOINT_MAX_EDGE = 320;
/** Lossy WebP quality. At 1/6 source size, 0.6 keeps frames around ~5–10 KB. */
const VISUAL_CHECKPOINT_QUALITY = 0.6;
/** Decoded ImageBitmap LRU size. Recent scrub frames stay hot; rest live as compressed blobs. */
const VISUAL_CHECKPOINT_DECODED_CACHE = 12;
const DYN_CHECKPOINT_DEFAULT_INTERVAL_MS = 3000;
const DYN_CHECKPOINT_SCRUB_INTERVAL_MS = 500;
const DYN_CHECKPOINT_MAX_COUNT = 24;

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
  /** true while the user is dragging the replay thumb */
  isScrubbing = $state(false);
  /** true while loading checkpoint list or a replay window */
  isLoading = $state(false);
  /** true once checkpoint list has been loaded for the current room */
  isOpen = $state(false);
  /** controls whether the timebar panel is visible */
  isVisible = $state(false);
  previewData = $state(null);
  /** true when the visible replay canvas is showing a low-res cached frame rather than full replay output */
  isPreviewMode = $state(false);
  /** true while a time-lapse video export is in progress */
  isExportingVideo = $state(false);
  /** 0..1 export progress */
  videoExportProgress = $state(0);
  /**
   * true while replay output is being painted into an in-panel canvas (the
   * History "Recent" mini-player) rather than the full-board #replayCanvas
   * overlay. Gates the bottom Timebar + chrome-hiding body classes off.
   */
  isEmbedded = $state(false);

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
  _scrubLastRequestedTimestamp = null;
  _scrubLastSeekAt = 0;
  _scrubQueuedTimestamp = null;
  _scrubTimer = null;
  _isPlaybackAdvancing = false;
  _pendingPlaybackTimestamp = null;
  _playbackStartPerf = 0;
  _playbackStartOffset = 0;
  _pendingServerReplay = false;
  _playbackFrameId = null;
  _tickInterval = null;
  _telemetry = { seek: null };
  /** @type {Array<{ts: number, blob: Blob, botStates: Array<Object>}>} sorted ascending */
  _visualCheckpoints = [];
  _visualCheckpointBuildGeneration = 0;
  /** ts -> ImageBitmap. LRU bounded by VISUAL_CHECKPOINT_DECODED_CACHE. */
  _decodedCheckpointCache = new Map();
  /** ts -> Promise<ImageBitmap>. Dedupes concurrent decodes when scrubbing fast. */
  _pendingCheckpointDecode = new Map();
  /** Most-recently requested cp ts (used so async decode skips drawing a stale frame). */
  _activeCheckpointTs = null;
  /** @type {Array<{ts: number, bitmap: ImageBitmap, botStates: Object}>} sorted ascending */
  _dynCheckpoints = [];
  _dynCheckpointInFlight = false;
  _lastDynCheckpointTs = null;
  /** @type {TimeLapseExporter|null} */
  _activeVideoExporter = null;
  /** @type {HTMLCanvasElement|null} in-panel canvas the replay is mirrored into */
  _embedCanvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  _embedCtx = null;

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

  /**
   * Point replay output at an in-panel canvas (the History "Recent" mini-player).
   * While attached, painting routines mirror the board-sized #replayCanvas into
   * this canvas and the board chrome is left untouched (the modal sits on top).
   * @param {HTMLCanvasElement} canvas
   */
  attachEmbedTarget(canvas) {
    if (!canvas) return;
    this._embedCanvas = canvas;
    this._embedCtx = canvas.getContext('2d');
    this.isEmbedded = true;
    if (this._replayCanvas) {
      canvas.width = this._replayCanvas.width;
      canvas.height = this._replayCanvas.height;
    }
  }

  /** Stop mirroring into the in-panel canvas. */
  detachEmbedTarget() {
    this._embedCanvas = null;
    this._embedCtx = null;
    this.isEmbedded = false;
  }

  /** Mirror the current #replayCanvas pixels into the embed canvas, 1:1. @private */
  _blitToEmbed() {
    if (!this.isEmbedded || !this._embedCtx || !this._embedCanvas || !this._replayCanvas) return;
    if (this._embedCanvas.width !== this._replayCanvas.width ||
        this._embedCanvas.height !== this._replayCanvas.height) {
      this._embedCanvas.width = this._replayCanvas.width;
      this._embedCanvas.height = this._replayCanvas.height;
    }
    this._embedCtx.clearRect(0, 0, this._embedCanvas.width, this._embedCanvas.height);
    this._embedCtx.drawImage(this._replayCanvas, 0, 0);
  }

  _drawToReplayCanvas() {
    if (!this._replayCtx || !this._replayEngine.outputCanvas) return;
    const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
    this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
    this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
    this._replayCtx.filter = 'none';
    this._replayCtx.imageSmoothingEnabled = true;
    this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
    // Overlay ephemeral vector text (faded by playhead age) then bot cursors on
    // top of the crisp output. Drawn here (not baked into the engine's
    // outputCanvas) so restore-to-live can't stamp them into real board pixels.
    // Mirrored into the embed canvas by _blitToEmbed below, so the mini-player
    // gets them too.
    this._replayEngine.drawVectorText(this._replayCtx);
    this._replayEngine.drawCursors(this._replayCtx);
    // Painting from the replay engine output means we're crisp — drop the preview flag.
    // Also clear the active checkpoint ts so any in-flight WebP decode skips its
    // paint (the cached frame would otherwise slam back over this crisp output
    // and resurrect preview mode).
    this._activeCheckpointTs = null;
    this.isPreviewMode = false;
    this._blitToEmbed();
  }

  _drawVisualCheckpoint(cp) {
    if (!cp || !this._replayCtx || !this._replayCanvas) return false;
    this._activeCheckpointTs = cp.ts;

    const cached = this._decodedCheckpointCache.get(cp.ts);
    if (cached) {
      // LRU bump: re-insert so the most-recently-used moves to the end.
      this._decodedCheckpointCache.delete(cp.ts);
      this._decodedCheckpointCache.set(cp.ts, cached);
      this._paintCheckpointBitmap(cached, cp.botStates);
      return true;
    }

    if (!cp.blob) return false;
    this._decodeCheckpointBlob(cp);
    // Leave whatever frame is currently on the replay canvas in place until
    // the decode resolves. Returning true keeps the caller from falling back
    // to a full replay (which would be much slower than a 1–3ms WebP decode).
    return true;
  }

  _paintCheckpointBitmap(bitmap, botStates) {
    const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
    this._replayCtx.filter = 'none';
    this._replayCtx.imageSmoothingEnabled = true;
    this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
    this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
    // Bitmap may be downscaled (see VISUAL_CHECKPOINT_MAX_EDGE); upscale to fit.
    this._replayCtx.drawImage(bitmap, 0, 0, this._replayCanvas.width, this._replayCanvas.height);
    this.previewData = true;
    // The blur + "Loading..." overlay in Timebar.svelte keys off this flag.
    this.isPreviewMode = true;
    this._showReplayCanvas(true);
    this._syncBotCursorsFromStates(botStates || []);
    this._blitToEmbed();
  }

  _decodeCheckpointBlob(cp) {
    if (this._pendingCheckpointDecode.has(cp.ts)) return;
    const promise = createImageBitmap(cp.blob)
      .then((bitmap) => {
        this._pendingCheckpointDecode.delete(cp.ts);
        // The recording may have been swapped out while we were decoding.
        if (!this._localRecording || !this.isOpen) {
          bitmap.close?.();
          return;
        }
        this._decodedCheckpointCache.set(cp.ts, bitmap);
        this._evictDecodedCheckpoints();
        // Only paint if this is still the frame the user wants — fast scrubs
        // can issue many decode requests before any of them resolve.
        if (this._activeCheckpointTs === cp.ts) {
          this._paintCheckpointBitmap(bitmap, cp.botStates);
        }
      })
      .catch((err) => {
        this._pendingCheckpointDecode.delete(cp.ts);
        console.warn('[TimeMachine] visual checkpoint decode failed:', err);
      });
    this._pendingCheckpointDecode.set(cp.ts, promise);
  }

  _evictDecodedCheckpoints() {
    while (this._decodedCheckpointCache.size > VISUAL_CHECKPOINT_DECODED_CACHE) {
      // Map iteration order is insertion order, so the first entry is the LRU.
      const oldest = this._decodedCheckpointCache.keys().next().value;
      const bitmap = this._decodedCheckpointCache.get(oldest);
      this._decodedCheckpointCache.delete(oldest);
      bitmap?.close?.();
    }
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
    const app = (typeof window !== 'undefined' ? window.app : null);
    const dir = direction === 'inbound' ? 'in' : 'out';

    // MIR is a relative toggle on the wire, so replaying it depends on the
    // mirror state being correct at that point — a single dropped MIR (gappy
    // tape, AFK draw-filtering) would invert global mirror for the rest of
    // playback. Stamp the post-toggle absolute state onto our own outbound
    // toggles so the replay engine can re-assert rather than blind-flip. This is
    // reliable only outbound: the local board is toggled before broadcastMirror()
    // runs, and the outbound msg is a throwaway spread (safe to mutate). Inbound
    // MIRs stay relative but self-heal from the periodic absolute SETTINGS.
    if (msg && msg.t === T.MIR && dir === 'out' && app?.board) {
      msg.m = !!app.board.mirror;
    }

    // Automatic rolling DVR tape — always fed while enabled (independent of the
    // manual recorder toggle below).
    const rolling = app?.rollingTapeRecorder;
    if (rolling?.isEnabled?.()) rolling.record(msg, dir);

    // Manual session tape (topbar tape button).
    const rec = app?.recorder;
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

    this.isLoading = true;
    this._source = 'local';
    this._localRecording = rec;
    this._clearDynCheckpoints();
    this._clearVisualCheckpoints();

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
      if (this._embedCanvas) {
        this._embedCanvas.width = rw;
        this._embedCanvas.height = rh;
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

    this.isOpen = false;
    this.isReviewing = false;
    this.isPlaying = false;
    this.isVisible = true;
    this._lastAppliedTimestamp = null;

    // Find users with no UNDO/REDO in the tape and tell the replay engine
    // their strokes can bake immediately. Cuts per-frame composite work on
    // long multi-user tapes where most strokes will never be undone.
    this._replayEngine?.setEagerBakeUsers?.(_collectEagerBakeUsers(rec));

    try {
      // Fast path: the .ddraw file already carries a baked scrub grid. Hydrate
      // `_visualCheckpoints` straight from it, paint the last frame as a
      // blurred preview, then run the replay engine to catch up in the
      // background so future seeks land on full-resolution output.
      const persistedVc = Array.isArray(rec.visualCheckpoints) ? rec.visualCheckpoints : null;
      if (persistedVc && persistedVc.length > 0 && persistedVc.some((cp) => cp?.blob)) {
        this._visualCheckpoints = persistedVc
          .filter((cp) => cp && cp.blob && Number.isFinite(cp.ts))
          .map((cp) => ({ ts: cp.ts, blob: cp.blob, botStates: cp.botStates || [] }))
          .sort((a, b) => a.ts - b.ts);

        this.isOpen = true;
        this.isReviewing = true;
        this._lastAppliedTimestamp = null;
        this.previewData = true;

        // Paint the last cached frame immediately as the initial preview.
        const lastCp = this._visualCheckpoints[this._visualCheckpoints.length - 1];
        if (lastCp) this._drawVisualCheckpoint(lastCp);
        this._showReplayCanvas(true);

        // Kick off full-resolution catch-up to the end of the tape. When it
        // resolves, `_drawToReplayCanvas` will clear isPreviewMode and the
        // overlay disappears. Errors fall back to staying in preview mode.
        this.seek(this.sessionEnd).catch((err) => {
          console.warn('[TimeMachine] background catch-up failed:', err);
        });

        window.app?.ui?.showToast?.(`Replay loaded (${this._visualCheckpoints.length} preview frames)`, 1800);
      } else {
        await this._buildVisualCheckpoints(rec);
        this.isOpen = true;
        this.isReviewing = true;
        this._lastAppliedTimestamp = this.sessionEnd;
        this._drawToReplayCanvas();
        this._showReplayCanvas(true);
        this._updateBotCursors();
        this.previewData = true;
        window.app?.ui?.showToast?.(`Replay ready (${this._visualCheckpoints.length} frames cached)`, 1800);
      }
    } catch (err) {
      console.warn('[TimeMachine] visual replay cache failed, falling back to live replay:', err);
      this.isOpen = true;
      await this.seek(this.sessionEnd);
    } finally {
      this.isLoading = false;
      this._refitBoardToContainer();
    }
  }

  /**
   * Re-run the board's fit-and-center calculation after a layout change.
   * The chrome-hiding effect in Timebar.svelte applies its body class after
   * Svelte flushes, so we wait a frame before measuring the container.
   * @private
   */
  _refitBoardToContainer() {
    // Don't move the live board's view while the embedded mini-player is up —
    // the board is untouched behind the modal.
    if (this.isEmbedded) return;
    const board = this._board ?? window.app?.board;
    if (!board?.resetView) return;
    if (typeof requestAnimationFrame === 'undefined') {
      board.resetView();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => board.resetView()));
  }

  /**
   * Clear all state when leaving a room.
   */
  stop() {
    this._seekGeneration += 1;
    this._clearScrubState();
    this.isOpen = false;
    this.isReviewing = false;
    this.isPlaying = false;
    this.isLoading = false;
    this.checkpoints = [];
    this.currentTime = 0;
    this.sessionStart = 0;
    this.sessionEnd = 0;
    this.previewData = null;
    this.isPreviewMode = false;
    this._lastAppliedTimestamp = null;
    this._pendingSeekTimestamp = null;
    this._pendingPlaybackTimestamp = null;
    this._source = 'server';
    this._localRecording = null;
    this._clearVisualCheckpoints();
    this._clearDynCheckpoints();
    if (this._replayEngine?.setAssetResolver) {
      this._replayEngine.setAssetResolver(null);
    }
    this._showReplayCanvas(false);
    this._removeBotCursors();
    this.detachEmbedTarget();

    // Make sure we don't leave the live WS drain paused after teardown.
    if (this._wsClient) {
      this._wsClient._reviewPaused = false;
      this._flushLiveMessageQueue();
    }

    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
    this._refitBoardToContainer();
  }

  /**
   * Seek to a specific timestamp.
   * @param {number} timestamp
   * @param {{ suppressPlaybackPause?: boolean }} [options]
   */
  async seek(timestamp, options = {}) {
    if (!this.isOpen) return;
    const { suppressPlaybackPause = false } = options;

    this.currentTime = this._clampTimestamp(timestamp);

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
      // Entered review mode — pause live draw-message processing so the live
      // board doesn't keep churning under the replay canvas. Bytes still
      // queue in WebSocketClient; catchUp() drains them.
      if (this._wsClient) this._wsClient._reviewPaused = true;
    } else if (!this.isReviewing && wasReviewing) {
      // Exited review mode — resume + drain.
      if (this._wsClient) {
        this._wsClient._reviewPaused = false;
        this._flushLiveMessageQueue();
      }
    }

    if (this.isReviewing) {
      if (this.isPlaying && !suppressPlaybackPause) {
        this.pause();
      }

      if (this._lastAppliedTimestamp === this.currentTime) {
        this._drawToReplayCanvas();
        this._showReplayCanvas(true);
        this._updateBotCursors();
        return;
      }

      if (this._isSeeking) {
        this._pendingSeekTimestamp = this.currentTime;
        this._seekGeneration += 1;
        return;
      }

      this._isSeeking = true;
      const seekGeneration = ++this._seekGeneration;
      try {
        const applied = await this._applyStateAt(this.currentTime, seekGeneration);
        if (!applied || seekGeneration !== this._seekGeneration || !this.isReviewing) return;
        this._showReplayCanvas(true);
        this._updateBotCursors();
      } finally {
        this._isSeeking = false;
        if (this.isOpen && this.isReviewing && this._pendingSeekTimestamp !== null) {
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

  beginScrub() {
    if (!this.isOpen) return;
    this.isScrubbing = true;
    this._seekGeneration += 1;
    this._pendingSeekTimestamp = null;
    this._scrubLastRequestedTimestamp = this.currentTime;
    this._scrubLastSeekAt = 0;
    this.pause();
  }

  scrubTo(timestamp) {
    if (!this.isOpen) return;
    if (!this.isScrubbing) this.beginScrub();

    const clamped = this._clampTimestamp(timestamp);
    const previous = this._scrubLastRequestedTimestamp ?? this.currentTime;
    const isReverse = clamped < previous;
    this._scrubLastRequestedTimestamp = clamped;

    // Forward scrubs from the engine's current applied state take the
    // incremental appendActions path (no snapshot reload, no re-replay from a
    // checkpoint) — crisp and usually fast enough to keep up with the drag.
    // Skip the blurred cached preview so the user sees real frames as they
    // move forward instead of a "Loading…" overlay.
    const canIncrementForward =
      this._source === 'local' &&
      !isReverse &&
      this._lastAppliedTimestamp != null &&
      clamped >= this._lastAppliedTimestamp;

    if (
      this._source === 'local' &&
      this._visualCheckpoints.length > 0 &&
      !canIncrementForward
    ) {
      this.currentTime = clamped;
      const cp = this._findVisualCheckpointNear(clamped);
      if (this._drawVisualCheckpoint(cp)) return;
    }

    let target = clamped;
    if (this._source === 'local' && isReverse) {
      target = this._quantizeScrubTimestamp(clamped);
    }

    this._scrubQueuedTimestamp = target;
    const elapsed = performance.now() - this._scrubLastSeekAt;
    if (elapsed >= LOCAL_REVERSE_SCRUB_INTERVAL_MS || !isReverse) {
      this._flushScrubSeek();
      return;
    }

    if (this._scrubTimer == null) {
      this._scrubTimer = setTimeout(() => {
        this._scrubTimer = null;
        this._flushScrubSeek();
      }, LOCAL_REVERSE_SCRUB_INTERVAL_MS - elapsed);
    }
  }

  endScrub(timestamp = null) {
    if (!this.isOpen) return;
    this.isScrubbing = false;
    if (this._scrubTimer != null) {
      clearTimeout(this._scrubTimer);
      this._scrubTimer = null;
    }
    const exact = timestamp == null
      ? (this._scrubLastRequestedTimestamp ?? this.currentTime)
      : this._clampTimestamp(timestamp);
    this._scrubQueuedTimestamp = null;
    this._scrubLastRequestedTimestamp = null;
    this.seek(exact);
  }

  _flushScrubSeek() {
    if (this._scrubQueuedTimestamp == null) return;
    const target = this._scrubQueuedTimestamp;
    this._scrubQueuedTimestamp = null;
    this._scrubLastSeekAt = performance.now();
    this.seek(target);
  }

  _clampTimestamp(timestamp) {
    return Math.max(
      this.sessionStart || 0,
      Math.min(timestamp, this.sessionEnd)
    );
  }

  _quantizeScrubTimestamp(timestamp) {
    const start = this.sessionStart || 0;
    const offset = Math.max(0, timestamp - start);
    return this._clampTimestamp(start + Math.floor(offset / LOCAL_REVERSE_SCRUB_FRAME_MS) * LOCAL_REVERSE_SCRUB_FRAME_MS);
  }

  _clearScrubState() {
    this.isScrubbing = false;
    if (this._scrubTimer != null) {
      clearTimeout(this._scrubTimer);
      this._scrubTimer = null;
    }
    this._scrubQueuedTimestamp = null;
    this._scrubLastRequestedTimestamp = null;
  }

  /**
   * Return to the live board state.
   */
  catchUp() {
    this.pause();
    this._seekGeneration += 1;
    this._clearScrubState();
    // Resume processing before draining — otherwise the drain bails out.
    if (this._wsClient) this._wsClient._reviewPaused = false;
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
  /**
   * Serialise the active local recording to a .ddraw Blob and trigger a
   * browser download. No-op for server-source replays.
   * @returns {Promise<boolean>} true if a download was triggered
   */
  async exportCurrentRecording() {
    const rec = this._localRecording;
    if (this._source !== 'local' || !rec) {
      window.app?.ui?.showToast?.('No local replay to save', 2000);
      return false;
    }
    try {
      const blob = await encodeDdraw(rec);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestDdrawFilename(rec);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      const sizeKb = Math.max(1, Math.round(blob.size / 1024));
      window.app?.ui?.showToast?.(`Saved replay (${sizeKb} KB)`, 2500);
      return true;
    } catch (err) {
      console.error('[TimeMachine] export failed:', err);
      window.app?.ui?.showToast?.('Could not save replay', 3000, 'error');
      return false;
    }
  }

  /**
   * Render the active local recording and trigger a browser
   * download. Uses a dedicated ReplayEngine instance so the user's current
   * scrub position is unaffected.
   *
   * @param {{ speed?: number, fps?: number, output?: 'video'|'sequence', region?: {x:number,y:number,width:number,height:number}|null }} [opts]
   * @returns {Promise<boolean>}
   */
  async exportTimeLapseVideo(opts = {}) {
    const rec = this._localRecording;
    if (this._source !== 'local' || !rec) {
      window.app?.ui?.showToast?.('No local replay to export', 2000);
      return false;
    }
    if (this.isExportingVideo) return false;

    const speed = Math.max(1, Math.min(240, Number(opts.speed) || 30));
    const fps = Math.max(10, Math.min(60, Math.round(Number(opts.fps) || 30)));
    const output = opts.output === 'sequence' ? 'sequence' : 'video';
    const region = opts.region ?? null;

    this.isExportingVideo = true;
    this.videoExportProgress = 0;
    this._activeVideoExporter = new TimeLapseExporter({
      recording: rec,
      wsClient: this._wsClient,
      speed,
      fps,
      output,
      region,
      backgroundColor: this._board?.backgroundColor,
      onProgress: (p) => { this.videoExportProgress = p; },
    });

    try {
      const result = await this._activeVideoExporter.export();
      if (!result) {
        window.app?.ui?.showToast?.('Render cancelled', 2000);
        return false;
      }
      const isSequence = result.kind === 'sequence' || output === 'sequence';
      const ext = result.mimeType.includes('webm') ? 'webm' : 'mp4';
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = isSequence ? suggestImageSequenceFilename(rec) : suggestVideoFilename(rec, ext);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(1);
      const label = isSequence ? 'image sequence' : 'time-lapse';
      window.app?.ui?.showToast?.(`Saved ${label} (${sizeMb} MB)`, 2500);
      return true;
    } catch (err) {
      console.error('[TimeMachine] render failed:', err);
      window.app?.ui?.showToast?.(`Could not render: ${err.message || err}`, 4000, 'error');
      return false;
    } finally {
      this.isExportingVideo = false;
      this.videoExportProgress = 0;
      this._activeVideoExporter = null;
    }
  }

  cancelVideoExport() {
    if (this._activeVideoExporter) this._activeVideoExporter.cancel();
  }

  async restoreLocalToCurrentState() {
    if (this._source !== 'local' || !this.isReviewing) return;
    const src = this._replayEngine?.outputCanvas;
    const liveBoard = this._board;
    if (!src || !liveBoard) return;

    // The board is reverted to the replay state at the current position. This
    // restore is broadcast as a BOARD_SNAPSHOT_RESTORE, which the rolling DVR
    // tape records and the replay engine re-applies — so it lands as a new event
    // at the END of the timeline. Nothing before or after the undo point is
    // lost; the history stays fully intact and scrubbable.
    if (window.app?.connected && window.app?.snapshotManager?.broadcastReplayCanvasRestore) {
      const sent = await window.app.snapshotManager.broadcastReplayCanvasRestore(src);
      if (sent) {
        this.catchUp();
        return true;
      }
    }

    liveBoard.clear?.();
    const layer0 = liveBoard.layerManager?.layerGroups?.[0];
    if (layer0?.flatCtx) {
      layer0.flatCtx.drawImage(src, 0, 0);
    }
    liveBoard.markCompositeFull?.();
    liveBoard.compositeAllLayers?.();
    this.catchUp();
    return true;
  }

  /**
   * Region variant of {@link restoreLocalToCurrentState}: revert only the given
   * rectangle to the currently-displayed replay state, keeping the rest of the
   * live board as-is. `region` is in board pixels ({x, y, width, height}); null
   * falls back to the full-board restore.
   *
   * Like the full version this is a single-user "rewind my own canvas" op — it
   * collapses to layer 0 and the server is unaware until the next stroke.
   * @param {{x:number,y:number,width:number,height:number}|null} region
   */
  async restoreLocalRegionToCurrentState(region) {
    if (!region) return await this.restoreLocalToCurrentState();
    if (this._source !== 'local' || !this.isReviewing) return;
    const replaySrc = this._replayEngine?.outputCanvas;
    const liveBoard = this._board;
    const lm = liveBoard?.layerManager;
    if (!replaySrc || !liveBoard || !lm?.getCompositedCanvas) return;

    const current = lm.getCompositedCanvas();
    const w = current.width, h = current.height;
    const rx = Math.max(0, Math.round(region.x));
    const ry = Math.max(0, Math.round(region.y));
    const rw = Math.min(w - rx, Math.round(region.width));
    const rh = Math.min(h - ry, Math.round(region.height));
    if (rw <= 0 || rh <= 0) return;

    if (window.app?.connected && window.app?.snapshotManager?.broadcastReplayRegionRestore) {
      const sent = await window.app.snapshotManager.broadcastReplayRegionRestore(replaySrc, {
        x: rx,
        y: ry,
        width: rw,
        height: rh
      });
      if (sent) {
        this.catchUp();
        return true;
      }
    }

    // Build current board + the region replaced by the replayed pixels.
    const merged = document.createElement('canvas');
    merged.width = w;
    merged.height = h;
    const mctx = merged.getContext('2d');
    mctx.drawImage(current, 0, 0);
    mctx.clearRect(rx, ry, rw, rh);
    mctx.drawImage(replaySrc, rx, ry, rw, rh, rx, ry, rw, rh);

    liveBoard.clear?.();
    const layer0 = lm.layerGroups?.[0];
    if (layer0?.flatCtx) layer0.flatCtx.drawImage(merged, 0, 0);
    liveBoard.markCompositeFull?.();
    liveBoard.compositeAllLayers?.();
    // Offline/no-broadcast path only. Like the full-board restoreLocalToCurrentState,
    // we do NOT reset the rolling tape here — resetting would discard the entire
    // replay history. When connected, the region restore is broadcast, recorded,
    // and replayed as a timeline event (history preserved); offline there is no
    // recording path, so we leave the existing tape intact.
    this.catchUp();
    return true;
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
  async _applyStateAt(timestamp, seekGeneration = null) {
    if (this._source === 'local') {
      return await this._applyStateAtLocal(timestamp, seekGeneration);
    } else {
      return await this._fetchAndApplyServerReplay(timestamp, seekGeneration);
    }
  }

  async _buildVisualCheckpoints(rec) {
    if (!rec || !this._replayEngine) return;
    this._clearVisualCheckpoints();
    const generation = ++this._visualCheckpointBuildGeneration;

    const start = rec.startedAt;
    const end = rec.endedAt ?? Date.now();
    const duration = Math.max(1, end - start);
    // Stride out the cache for long recordings so we cap total memory. Short
    // recordings still get a frame per second; longer ones get whatever stride
    // keeps us at or below MAX_COUNT.
    const intervalMs = Math.max(
      VISUAL_CHECKPOINT_INTERVAL_MS,
      Math.ceil(duration / VISUAL_CHECKPOINT_MAX_COUNT),
    );
    const times = [];
    for (let ts = start; ts < end; ts += intervalMs) {
      times.push(ts);
    }
    if (times.length === 0 || times[times.length - 1] !== end) {
      times.push(end);
    }

    const ui = window.app?.ui;
    ui?.showToast?.(`Loading replay... 0/${times.length}`, 60_000);

    await this._replayEngine.loadSnapshot(rec.openingSnapshot);
    const initialized = await this._replayEngine.processActions([], start);
    if (!initialized || generation !== this._visualCheckpointBuildGeneration) return;

    const deltas = rec.deltas ?? [];
    let deltaIdx = 0;
    let lastTarget = start;

    for (let i = 0; i < times.length; i++) {
      const target = times[i];
      const actions = [];
      while (deltaIdx < deltas.length && deltas[deltaIdx].ts <= target) {
        if (deltas[deltaIdx].ts > lastTarget || target === start) {
          actions.push({ timestamp: deltas[deltaIdx].ts, msg: deltas[deltaIdx].msg });
        }
        deltaIdx++;
      }

      if (i > 0 || actions.length > 0) {
        const applied = await this._replayEngine.appendActions(actions, target);
        if (!applied || generation !== this._visualCheckpointBuildGeneration) return;
      }

      await this._captureVisualCheckpoint(target);
      lastTarget = target;

      if (i === 0 || i === times.length - 1 || (i + 1) % 5 === 0) {
        ui?.showToast?.(`Loading replay... ${i + 1}/${times.length}`, 60_000);
      }

      // Yield so the loading toast can paint during long recordings.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    this._lastAppliedTimestamp = end;
  }

  async _captureVisualCheckpoint(timestamp) {
    const src = this._replayEngine?.outputCanvas;
    if (!src) return;
    // Downscale to a temp canvas, then encode as a lossy WebP Blob. WebP keeps
    // alpha so transparent regions of the board stay transparent — the bg fill
    // happens at paint time, not in the cached frame.
    const maxEdge = Math.max(src.width, src.height);
    const scale = maxEdge > VISUAL_CHECKPOINT_MAX_EDGE
      ? VISUAL_CHECKPOINT_MAX_EDGE / maxEdge
      : 1;
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(src, 0, 0, w, h);
    const blob = await new Promise((resolve) => {
      // toBlob falls back to PNG if WebP is unsupported — still smaller than
      // a resident decoded bitmap, just less compressed.
      tmp.toBlob(resolve, 'image/webp', VISUAL_CHECKPOINT_QUALITY);
    });
    if (!blob) return;

    const botStates = this._captureBotCursorStates();
    const existingIdx = this._visualCheckpoints.findIndex((cp) => cp.ts === timestamp);
    if (existingIdx >= 0) {
      // Invalidate any cached decode for the displaced frame.
      const stale = this._decodedCheckpointCache.get(timestamp);
      if (stale) {
        stale.close?.();
        this._decodedCheckpointCache.delete(timestamp);
      }
      this._visualCheckpoints[existingIdx] = { ts: timestamp, blob, botStates };
      return;
    }
    this._visualCheckpoints.push({ ts: timestamp, blob, botStates });
  }

  _captureBotCursorStates() {
    const states = [];
    for (const [id, user] of this._replayEngine?.botUsers ?? []) {
      const x = Number(user?.x);
      const y = Number(user?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      states.push({
        id,
        username: user.username || `User ${id}`,
        role: user.role ?? 0,
        color: Array.isArray(user.color) ? [...user.color] : [100, 100, 100, 1],
        size: user.size || 10,
        tool: user.tool || 'brush',
        x,
        y,
        text: user.text || '',
      });
    }
    return states;
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
  async _applyStateAtLocal(timestamp, seekGeneration = null) {
    const rec = this._localRecording;
    if (!rec || !this._replayEngine) return false;
    const seekStart = performance.now();
    const isStale = () =>
      seekGeneration != null &&
      (seekGeneration !== this._seekGeneration || !this.isOpen || !this.isReviewing);

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
      const applied = await this._replayEngine.appendActions(actions, timestamp, { shouldCancel: isStale });
      if (!applied || isStale()) return false;

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
      return true;
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
    if (isStale()) return false;

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
    const applied = await this._replayEngine.processActions(actions, timestamp, { shouldCancel: isStale });
    if (!applied || isStale()) return false;

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
    return true;
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
    const minInterval = this.isScrubbing
      ? DYN_CHECKPOINT_SCRUB_INTERVAL_MS
      : DYN_CHECKPOINT_DEFAULT_INTERVAL_MS;
    if (
      this._lastDynCheckpointTs != null &&
      Math.abs(timestamp - this._lastDynCheckpointTs) < minInterval
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
        this._evictDynCheckpointsAround(timestamp);
        this._lastDynCheckpointTs = timestamp;
      })
      .catch((err) => console.warn('[TimeMachine] dyn checkpoint capture failed:', err))
      .finally(() => { this._dynCheckpointInFlight = false; });
  }

  _evictDynCheckpointsAround(anchorTs) {
    while (this._dynCheckpoints.length > DYN_CHECKPOINT_MAX_COUNT) {
      let dropIdx = 0;
      let farthest = -1;
      for (let i = 0; i < this._dynCheckpoints.length; i++) {
        const distance = Math.abs(this._dynCheckpoints[i].ts - anchorTs);
        if (distance > farthest) {
          farthest = distance;
          dropIdx = i;
        }
      }
      const [dropped] = this._dynCheckpoints.splice(dropIdx, 1);
      dropped?.bitmap?.close?.();
    }
  }

  _findDynCheckpointBefore(ts) {
    let best = null;
    for (const cp of this._dynCheckpoints) {
      if (cp.ts <= ts && (!best || cp.ts > best.ts)) best = cp;
    }
    return best;
  }

  _findVisualCheckpointNear(ts) {
    let best = null;
    let bestDistance = Infinity;
    for (const cp of this._visualCheckpoints) {
      const distance = Math.abs(cp.ts - ts);
      if (distance < bestDistance) {
        best = cp;
        bestDistance = distance;
      }
    }
    return best;
  }

  _clearVisualCheckpoints() {
    this._visualCheckpointBuildGeneration += 1;
    this._visualCheckpoints = [];
    for (const bitmap of this._decodedCheckpointCache.values()) bitmap?.close?.();
    this._decodedCheckpointCache.clear();
    this._pendingCheckpointDecode.clear();
    this._activeCheckpointTs = null;
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
  async _fetchAndApplyServerReplay(timestamp, seekGeneration = null) {
    if (this._pendingServerReplay) return false;
    this._pendingServerReplay = true;
    const seekStart = performance.now();
    const isStale = () =>
      seekGeneration != null &&
      (seekGeneration !== this._seekGeneration || !this.isOpen || !this.isReviewing);

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
      if (isStale()) return false;

      if (!data.checkpointImg || data.checkpointImg.length === 0) {
        console.warn('[TimeMachine] Server returned no checkpoint image');
        return false;
      }

      await this._replayEngine.loadCheckpointImage(data.checkpointImg, {
        m: data.mirror,
        mirrorRegions: data.mirrorRegions || []
      });
      if (isStale()) return false;

      const actions = data.deltas?.length
        ? data.deltas.map(d => ({ timestamp: d._ts, msg: d }))
        : [];
      const applied = await this._replayEngine.processActions(actions, timestamp, { shouldCancel: isStale });
      if (!applied || isStale()) return false;

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
      return true;
    } catch (err) {
      console.error('[TimeMachine] Server replay failed:', err);
      return false;
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
    // Embedded mode mirrors into an in-panel canvas, so the board-overlay
    // #replayCanvas stays hidden and the live board/chrome are left alone.
    if (this.isEmbedded) {
      if (this._replayCanvas) this._replayCanvas.style.display = 'none';
      return;
    }
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

    this._syncBotCursorsFromStates(this._captureBotCursorStates());
  }

  _syncBotCursorsFromStates(_states) {
    // Bot cursors are now baked directly into the replay output canvas by
    // ReplayEngine.drawCursors (see replay/cursorOverlay.js). That paints
    // them in both the embedded mini-player and the full-board replay, perfectly
    // aligned with the drawing pixels. Tear down any legacy DOM bot cursors and
    // skip creating new ones so they don't render twice.
    if (this._botCursorIds.size > 0) this._removeBotCursors();
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
