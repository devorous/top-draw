/**
 * @fileoverview Rolling "DVR" tape recorder.
 *
 * Unlike the manual {@link Recorder} (toggled by the topbar tape button, records
 * an open-ended session and exports `.ddraw`), this recorder runs automatically
 * in the background once a room has synced and keeps only a bounded window of
 * recent activity — roughly the last two minutes. Opening History → "Recent"
 * freezes the current window into an immutable {@link ReplayRecording} and hands
 * it to `TimeMachine.loadFromRecording()` while the live recorder keeps going.
 *
 * It is built on the exact same `ReplayRecording` shape the manual recorder and
 * TimeMachine already consume, so the scrubber, visual-checkpoint preview grid,
 * `.ddraw` export and parity harness all work unchanged.
 *
 * Pruning is checkpoint-aware (see {@link RollingTapeRecorder._prune}): we never
 * drop deltas without keeping a base checkpoint at or before the oldest visible
 * timestamp, otherwise the frozen tape would have nothing to replay from.
 */
import { captureOpeningSnapshot } from './snapshotCapture.js';
import { shouldRecord } from './messageAllowlist.js';
import { isCommitType } from '../../shared/StrokeFingerprint.js';

const RECORDING_VERSION = 2;

/** Visible scrub window. Two minutes of "what just happened". */
const DEFAULT_WINDOW_MS = 120_000;
const DEFAULT_ENABLED = true;
/** Anchor/intra checkpoint cadence. Plan calls for 10–15s. */
const INTRA_CHECKPOINT_INTERVAL_MS = 12_000;
/** Low-res scrub-preview cadence (matches Recorder + TimeMachine). */
const VISUAL_CHECKPOINT_INTERVAL_MS = 2000;
const VISUAL_CHECKPOINT_SCALE = 1 / 6;
const VISUAL_CHECKPOINT_QUALITY = 0.6;
/** How often the ring buffer is pruned back to the horizon. */
const PRUNE_INTERVAL_MS = 5000;
/**
 * Safety cap on resident deltas. Two minutes of normal drawing is far below
 * this; the cap only matters during pathological floods (e.g. a script). When
 * hit we drop the oldest deltas regardless of the checkpoint anchor — a slightly
 * shorter window beats unbounded memory.
 */
const HARD_MAX_DELTAS = 200_000;

/**
 * @typedef {import('./Recorder.js').ReplayRecording} ReplayRecording
 */

export class RollingTapeRecorder {
  constructor() {
    /** @type {boolean} User preference gate for automatic capture. */
    this._configuredEnabled = DEFAULT_ENABLED;
    /** @type {boolean} True while actively capturing. */
    this._enabled = false;
    /**
     * Stale = the buffer may have gaps (disconnect, AFK draw filtering) so the
     * Recent tape can't be trusted as a faithful replay. Cleared on reset/start.
     * @type {boolean}
     */
    this._stale = false;
    /** @type {string|null} Reason the tape was last marked stale (for UI/debug). */
    this._staleReason = null;
    /** @type {Object|null} live App instance */
    this._app = null;
    /** Visible window length in ms. */
    this._windowMs = DEFAULT_WINDOW_MS;

    // Ring buffers, all sorted ascending by ts.
    /** @type {Array<{ts: number, snapshot: Object}>} */
    this._checkpoints = [];
    /** @type {import('./Recorder.js').ReplayDelta[]} */
    this._deltas = [];
    /** @type {Array<{ts: number, blob: Blob}>} */
    this._visualCheckpoints = [];

    this._intraTimer = null;
    this._visualTimer = null;
    this._pruneTimer = null;
    this._visualInFlight = false;

    /** @type {((status: ReturnType<RollingTapeRecorder['getStatus']>) => void) | null} */
    this.onStatusChange = null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** True while the recorder is enabled and capturing. */
  isEnabled() { return this._enabled; }

  /** True when the buffer may have gaps and shouldn't be trusted as a replay. */
  isStale() { return this._stale; }

  /**
   * Update rolling tape preferences. Disabling stops and clears the buffer.
   * @param {{ enabled?: boolean, windowMs?: number }} options
   */
  configure(options = {}) {
    if (options.windowMs != null) {
      const windowMs = Number(options.windowMs);
      if (Number.isFinite(windowMs) && windowMs > 0) {
        this._windowMs = windowMs;
        if (this._enabled) this._prune();
      }
    }

    if (options.enabled != null) {
      this._configuredEnabled = !!options.enabled;
      if (!this._configuredEnabled && this._enabled) {
        this.stop('disabled');
        return;
      }
    }

    this._notify();
  }

  /**
   * Begin (or restart) capture. Captures the anchor checkpoint immediately and
   * starts the checkpoint/prune timers. Idempotent — calling start while already
   * enabled re-anchors (clears the buffer and recaptures), which is what a
   * resync/board-replace wants.
   * @param {Object} app - live App instance (window.app)
   */
  start(app) {
    if (!app) return;
    if (!this._configuredEnabled) {
      this.stop('disabled');
      return;
    }
    this._app = app;
    if (this._enabled) {
      // Already running — treat as a re-anchor.
      this.reset('restart');
      return;
    }
    this._enabled = true;
    this._stale = false;
    this._staleReason = null;
    this._clearBuffers();
    this._captureCheckpoint();
    this._scheduleIntra();
    this._scheduleVisual();
    this._schedulePrune();
    this._notify();
  }

  /**
   * Stop capture and drop the buffer entirely. Use when leaving a room — there
   * is nothing worth keeping from a room we're no longer in.
   * @param {string} [reason]
   */
  stop(reason = 'stop') {
    this._enabled = false;
    this._stale = false;
    this._staleReason = null;
    this._clearTimers();
    this._clearBuffers();
    this._app = null;
    void reason;
    this._notify();
  }

  /**
   * Clear the buffer and re-anchor at the current board state without changing
   * the enabled flag. Use on resync / board replacement: the old deltas no
   * longer compose against the new base.
   * @param {string} [reason]
   */
  reset(reason = 'reset') {
    this._clearBuffers();
    this._stale = false;
    this._staleReason = null;
    void reason;
    if (this._enabled && this._app) {
      this._captureCheckpoint();
      // Make sure timers are running (reset may be the first call after a
      // start that was interrupted).
      if (this._intraTimer == null) this._scheduleIntra();
      if (this._visualTimer == null) this._scheduleVisual();
      if (this._pruneTimer == null) this._schedulePrune();
    }
    this._notify();
  }

  /**
   * Mark the tape stale (gaps possible). Capture continues so the tape can
   * recover after the next reset, but the UI should warn that Recent may be
   * incomplete. No-op when not enabled.
   * @param {string} reason
   */
  markStale(reason = 'stale') {
    if (!this._enabled || this._stale) return;
    this._stale = true;
    this._staleReason = reason;
    this._notify();
  }

  /**
   * App-facing convenience: called whenever room sync completes. Starts the
   * recorder the first time and re-anchors on subsequent (resync) completions.
   * @param {Object} app
   */
  onSyncComplete(app) {
    if (!this._configuredEnabled) {
      this.stop('disabled');
      return;
    }
    if (this._enabled) {
      this.reset('resync');
    } else {
      this.start(app);
    }
  }

  // ── delta tap ─────────────────────────────────────────────────────────────

  /**
   * Feed a tapped message into the ring buffer. Called from
   * `TimeMachine.recordAction` for both directions, mirroring Recorder's
   * self-echo dedup so commits aren't applied twice during replay.
   * @param {Object} msg
   * @param {'in'|'out'} dir
   */
  record(msg, dir) {
    if (!this._enabled) return;
    if (!shouldRecord(msg)) return;

    // Drop the server's inbound echo of our own commit-class messages — we
    // already captured the outbound copy. See Recorder._append for the why.
    if (dir === 'in' && msg?.t != null && isCommitType(msg.t)) {
      const selfIdx = this._app?.wsClient?.sessionIndex
                   ?? this._app?.sessionIndex
                   ?? null;
      if (selfIdx != null && msg.u === selfIdx) return;
    }

    let cloned;
    try {
      cloned = structuredClone(msg);
    } catch {
      cloned = JSON.parse(JSON.stringify(msg));
    }
    this._deltas.push({ ts: Date.now(), msg: cloned, dir });

    if (this._deltas.length > HARD_MAX_DELTAS) {
      // Pathological flood — drop the oldest excess immediately rather than
      // waiting for the prune timer. May shorten the effective window.
      this._deltas.splice(0, this._deltas.length - HARD_MAX_DELTAS);
    }
  }

  // ── snapshotting ────────────────────────────────────────────────────────────

  /**
   * Freeze the current window into an immutable {@link ReplayRecording} suitable
   * for `TimeMachine.loadFromRecording()`. The live recorder keeps running.
   *
   * The anchor is the newest checkpoint at or before `now - windowMs` (so the
   * tape has a valid base for the whole visible range); if the recording is
   * younger than the window we anchor on the very first checkpoint.
   *
   * @returns {ReplayRecording | null} null when nothing has been captured yet
   */
  snapshotRecording() {
    if (this._checkpoints.length === 0) return null;
    const now = Date.now();
    const horizon = now - this._windowMs;
    const anchor = this._pickAnchor(horizon);
    if (!anchor) return null;

    const deltas = this._deltas
      .filter((d) => d.ts >= anchor.ts)
      .map((d) => ({ ts: d.ts, msg: structuredCloneSafe(d.msg), dir: d.dir }));

    const intraCheckpoints = this._checkpoints
      .filter((cp) => cp.ts > anchor.ts)
      .map((cp) => ({ ts: cp.ts, snapshot: cp.snapshot }));

    const visualCheckpoints = this._visualCheckpoints
      .filter((cp) => cp.ts >= anchor.ts)
      .map((cp) => ({ ts: cp.ts, blob: cp.blob }));

    /** @type {ReplayRecording & {rolling: boolean, windowMs: number, anchorTs: number, liveEdgeTs: number, stale: boolean}} */
    const bundle = {
      version: RECORDING_VERSION,
      roomId: this._app?.currentRoomId ?? null,
      startedAt: anchor.ts,
      endedAt: now,
      openingSnapshot: anchor.snapshot,
      deltas,
      intraCheckpoints,
      visualCheckpoints,
      assets: {},
      // Rolling-specific metadata (informational; TimeMachine ignores extras).
      rolling: true,
      windowMs: this._windowMs,
      anchorTs: anchor.ts,
      liveEdgeTs: now,
      stale: this._stale,
    };
    return bundle;
  }

  /**
   * @returns {{ enabled: boolean, stale: boolean, staleReason: string|null,
   *   windowMs: number, deltaCount: number, checkpointCount: number,
   *   oldestTs: number|null, newestTs: number|null, hasContent: boolean }}
   */
  getStatus() {
    const now = Date.now();
    const horizon = now - this._windowMs;
    const anchor = this._checkpoints.length ? this._pickAnchor(horizon) : null;
    return {
      enabled: this._enabled,
      configuredEnabled: this._configuredEnabled,
      stale: this._stale,
      staleReason: this._staleReason,
      windowMs: this._windowMs,
      deltaCount: this._deltas.length,
      checkpointCount: this._checkpoints.length,
      oldestTs: anchor ? anchor.ts : null,
      newestTs: this._enabled ? now : null,
      // "Has something worth scrubbing": at least one delta beyond the anchor.
      hasContent: !!anchor && this._deltas.some((d) => d.ts >= anchor.ts),
    };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  /** Newest checkpoint with ts <= horizon, else the oldest checkpoint. @private */
  _pickAnchor(horizon) {
    let anchor = null;
    for (const cp of this._checkpoints) {
      if (cp.ts <= horizon) anchor = cp;
      else break;
    }
    return anchor ?? this._checkpoints[0] ?? null;
  }

  /** @private */
  _captureCheckpoint() {
    if (!this._enabled || !this._app) return;
    try {
      const snapshot = captureOpeningSnapshot(this._app);
      this._checkpoints.push({ ts: Date.now(), snapshot });
    } catch (err) {
      console.warn('[RollingTape] checkpoint capture failed:', err);
    }
  }

  /** @private */
  _scheduleIntra() {
    if (this._intraTimer != null) clearTimeout(this._intraTimer);
    this._intraTimer = setTimeout(() => {
      // Idle-schedule the capture so a busy drawing frame doesn't stutter.
      const run = () => {
        this._captureCheckpoint();
        if (this._enabled) this._scheduleIntra();
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 2000 });
      } else {
        run();
      }
    }, INTRA_CHECKPOINT_INTERVAL_MS);
  }

  /** @private */
  _scheduleVisual() {
    if (this._visualTimer != null) clearTimeout(this._visualTimer);
    this._visualTimer = setTimeout(() => {
      this._captureVisualCheckpoint();
      if (this._enabled) this._scheduleVisual();
    }, VISUAL_CHECKPOINT_INTERVAL_MS);
  }

  /** @private */
  _schedulePrune() {
    if (this._pruneTimer != null) clearTimeout(this._pruneTimer);
    this._pruneTimer = setTimeout(() => {
      this._prune();
      if (this._enabled) this._schedulePrune();
    }, PRUNE_INTERVAL_MS);
  }

  /**
   * Prune the ring buffer back to the visible window. Checkpoint-aware: keep the
   * anchor (newest checkpoint <= horizon) plus everything newer, then drop
   * deltas/visuals older than the anchor and checkpoints before it.
   * @private
   */
  _prune() {
    if (this._checkpoints.length === 0) return;
    const horizon = Date.now() - this._windowMs;
    const anchor = this._pickAnchor(horizon);
    if (!anchor) return;
    const cut = anchor.ts;

    // Keep the anchor checkpoint and everything after it.
    if (this._checkpoints[0].ts < cut) {
      this._checkpoints = this._checkpoints.filter((cp) => cp.ts >= cut);
    }
    if (this._deltas.length && this._deltas[0].ts < cut) {
      this._deltas = this._deltas.filter((d) => d.ts >= cut);
    }
    if (this._visualCheckpoints.length && this._visualCheckpoints[0].ts < cut) {
      this._visualCheckpoints = this._visualCheckpoints.filter((cp) => cp.ts >= cut);
    }
  }

  /**
   * Snapshot the live composited board to a small WebP blob for instant scrub
   * previews. Mirror of Recorder._captureVisualCheckpoint.
   * @private
   */
  _captureVisualCheckpoint() {
    if (!this._enabled || !this._app || this._visualInFlight) return;
    const board = this._app.board;
    const src = board?.mainCanvas;
    if (!src || !src.width || !src.height) return;

    try { board.compositeAllLayers?.(); } catch {}

    const w = Math.max(1, Math.round(src.width * VISUAL_CHECKPOINT_SCALE));
    const h = Math.max(1, Math.round(src.height * VISUAL_CHECKPOINT_SCALE));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(src, 0, 0, w, h);

    const ts = Date.now();
    this._visualInFlight = true;
    tmp.toBlob(
      (blob) => {
        this._visualInFlight = false;
        if (!blob || !this._enabled) return;
        this._visualCheckpoints.push({ ts, blob });
      },
      'image/webp',
      VISUAL_CHECKPOINT_QUALITY,
    );
  }

  /** @private */
  _clearBuffers() {
    this._checkpoints = [];
    this._deltas = [];
    this._visualCheckpoints = [];
  }

  /** @private */
  _clearTimers() {
    if (this._intraTimer != null) { clearTimeout(this._intraTimer); this._intraTimer = null; }
    if (this._visualTimer != null) { clearTimeout(this._visualTimer); this._visualTimer = null; }
    if (this._pruneTimer != null) { clearTimeout(this._pruneTimer); this._pruneTimer = null; }
  }

  /** @private */
  _notify() {
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(this.getStatus()); } catch {}
    }
  }
}

/** structuredClone with a JSON fallback for symbol/function-bearing payloads. */
function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** Process-wide singleton. App.js wires it onto window.app.rollingTapeRecorder. */
export const rollingTapeRecorder = new RollingTapeRecorder();
