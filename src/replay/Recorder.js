/**
 * @fileoverview Local replay recorder.
 *
 * Sits on the WebSocketClient message tap (both directions). The taps already
 * call into `TimeMachine.recordAction(msg, direction)` from
 * `src/network/WebSocketClient.js`; we route those calls into the active
 * Recorder so it sees both incoming and outgoing traffic in a single tape.
 *
 * Opening snapshot is captured at `start()`. Optional intra-checkpoints are
 * appended on a timer so seeks don't have to replay the entire tape (Phase 3
 * uses these; Phase 1 records them but doesn't index them yet).
 */
import { captureOpeningSnapshot } from './snapshotCapture.js';
import { shouldRecord } from './messageAllowlist.js';
import { isCommitType } from '../../shared/StrokeFingerprint.js';
import { T } from '../../shared/MessageTypes.js';

/**
 * @typedef {Object} ReplayDelta
 * @property {number} ts          - wall-clock ms when the message hit the tap
 * @property {Object} msg         - decoded message (JSON, not protobuf bytes)
 * @property {'in'|'out'} dir     - which tap it came from (helps diagnose drift)
 */

/**
 * @typedef {Object} ReplayRecording
 * @property {number}   version
 * @property {string|null} roomId
 * @property {number}   startedAt
 * @property {number|null} endedAt
 * @property {Object}   openingSnapshot
 * @property {ReplayDelta[]} deltas
 * @property {Array<{ts: number, snapshot: Object}>} intraCheckpoints
 * @property {Array<{ts: number, blob: Blob}>} visualCheckpoints - low-res scrub previews
 * @property {Record<string, string>} assets - SHA-1 → dataURL (Phase 3+)
 */

/** Clone a decoded message, tolerating typed-array/alias-bearing payloads. */
function structuredCloneSafe(msg) {
  try {
    return structuredClone(msg);
  } catch {
    return JSON.parse(JSON.stringify(msg));
  }
}

const RECORDING_VERSION = 2;
const DEFAULT_INTRA_CHECKPOINT_INTERVAL_MS = 30_000;
const HARD_MAX_DELTAS = 500_000;
// Visual-checkpoint cadence. Each tick downscales the live board to a small WebP
// so .ddraw files ship with a scrub-preview grid baked in — the load path can
// show a blurred preview immediately instead of re-replaying the whole tape.
const VISUAL_CHECKPOINT_INTERVAL_MS = 2000;
const VISUAL_CHECKPOINT_SCALE = 1 / 6;
const VISUAL_CHECKPOINT_QUALITY = 0.6;
const VISUAL_CHECKPOINT_MAX_COUNT = 600;

export class Recorder {
  constructor() {
    /** @type {'idle' | 'recording'} */
    this.state = 'idle';
    /** @type {ReplayRecording | null} */
    this.recording = null;
    /** @type {number | null} */
    this._intraCheckpointTimer = null;
    /** @type {number | null} */
    this._visualCheckpointTimer = null;
    /** @type {number | null} */
    this._maxLengthTimer = null;
    /** @type {number} */
    this._intraCheckpointIntervalMs = DEFAULT_INTRA_CHECKPOINT_INTERVAL_MS;
    /** @type {number} 0 means unlimited. */
    this._maxLengthMs = 0;
    /** @type {boolean} */
    this._visualCheckpointInFlight = false;
    /**
     * True when at least one input (delta) has been recorded since the last
     * visual checkpoint. Gates the visual-checkpoint timer so an idle canvas
     * doesn't append duplicate "nothing changed" frames to the recording.
     * @type {boolean}
     */
    this._activitySinceVisual = false;
    /** @type {Object | null} */
    this._app = null;
    /**
     * One-shot inbound filter armed around our own "undo to here" restore
     * broadcast — see {@link Recorder.suppressNextInbound}.
     * @type {{type: number, until: number} | null}
     */
    this._suppressInbound = null;
    /** @type {((rec: ReplayRecording|null) => void) | null} */
    this.onStateChange = null;
  }

  /** True when actively recording. */
  isRecording() { return this.state === 'recording'; }

  /** ms elapsed since start(), or 0 when idle. */
  elapsedMs() {
    if (!this.recording) return 0;
    return Date.now() - this.recording.startedAt;
  }

  /** Number of deltas captured so far. */
  deltaCount() {
    return this.recording?.deltas.length ?? 0;
  }

  /**
   * Update recording timers from app preferences. Safe while recording.
   * @param {{ checkpointIntervalMs?: number, maxLengthMs?: number }} options
   */
  configure(options = {}) {
    const checkpointIntervalMs = Number(options.checkpointIntervalMs);
    if (Number.isFinite(checkpointIntervalMs) && checkpointIntervalMs > 0) {
      this._intraCheckpointIntervalMs = checkpointIntervalMs;
      if (this.state === 'recording') this._scheduleIntraCheckpoint();
    }

    const maxLengthMs = Number(options.maxLengthMs);
    if (Number.isFinite(maxLengthMs) && maxLengthMs >= 0) {
      this._maxLengthMs = maxLengthMs;
      if (this.state === 'recording') this._scheduleMaxLengthStop();
    }
  }

  /**
   * Begin a recording. Captures the opening snapshot immediately.
   * @param {Object} app - live App instance (window.app)
   */
  start(app) {
    if (this.state === 'recording') return;
    if (!app) throw new Error('[Recorder.start] app is required');

    this._app = app;
    const openingSnapshot = captureOpeningSnapshot(app);

    /** @type {ReplayRecording} */
    this.recording = {
      version: RECORDING_VERSION,
      roomId: app.currentRoomId ?? null,
      startedAt: Date.now(),
      endedAt: null,
      openingSnapshot,
      deltas: [],
      intraCheckpoints: [],
      visualCheckpoints: [],
      assets: {},
    };
    this.state = 'recording';
    this._activitySinceVisual = false;
    this._suppressInbound = null;

    this._scheduleIntraCheckpoint();
    this._scheduleVisualCheckpoint();
    this._scheduleMaxLengthStop();
    this._notifyStateChange();
  }

  /**
   * Stop the recording and return the bundle. Safe to call when idle.
   * @returns {ReplayRecording | null}
   */
  stop() {
    if (this.state !== 'recording' || !this.recording) {
      this._notifyStateChange();
      return null;
    }

    if (this._intraCheckpointTimer != null) {
      clearTimeout(this._intraCheckpointTimer);
      this._intraCheckpointTimer = null;
    }
    if (this._visualCheckpointTimer != null) {
      clearTimeout(this._visualCheckpointTimer);
      this._visualCheckpointTimer = null;
    }
    if (this._maxLengthTimer != null) {
      clearTimeout(this._maxLengthTimer);
      this._maxLengthTimer = null;
    }

    this.recording.endedAt = Date.now();
    const bundle = this.recording;
    this.state = 'idle';
    this.recording = null;
    this._app = null;
    this._notifyStateChange();
    return bundle;
  }

  /**
   * Return a frozen copy of the in-progress recording without stopping it.
   * Used by the "View" button so the user can preview the tape so far while
   * recording continues. Returns null when idle.
   * @returns {ReplayRecording | null}
   */
  snapshot() {
    if (this.state !== 'recording' || !this.recording) return null;
    const rec = this.recording;
    // Deep-clone the snapshot payloads so the bundle really is frozen — the
    // live recording keeps going after this returns, and any future
    // post-processing of a viewed bundle must not reach back into the tape.
    // Snapshots carry Uint8Arrays (QOI layer state), so the JSON fallback in
    // structuredCloneSafe would mangle them — on clone failure keep sharing
    // the reference instead. Visual-checkpoint blobs are immutable; sharing
    // them is safe.
    const cloneSnapshot = (snap) => {
      try { return structuredClone(snap); } catch { return snap; }
    };
    return {
      version: rec.version,
      roomId: rec.roomId,
      startedAt: rec.startedAt,
      endedAt: Date.now(),
      openingSnapshot: cloneSnapshot(rec.openingSnapshot),
      deltas: rec.deltas.map((d) => ({ ts: d.ts, msg: structuredCloneSafe(d.msg), dir: d.dir })),
      intraCheckpoints: rec.intraCheckpoints.map((cp) => ({ ts: cp.ts, snapshot: cloneSnapshot(cp.snapshot) })),
      visualCheckpoints: rec.visualCheckpoints.map((cp) => ({ ts: cp.ts, blob: cp.blob })),
      assets: { ...rec.assets },
    };
  }

  /** Discard the in-progress recording without returning it. */
  cancel() {
    if (this._intraCheckpointTimer != null) {
      clearTimeout(this._intraCheckpointTimer);
      this._intraCheckpointTimer = null;
    }
    if (this._visualCheckpointTimer != null) {
      clearTimeout(this._visualCheckpointTimer);
      this._visualCheckpointTimer = null;
    }
    if (this._maxLengthTimer != null) {
      clearTimeout(this._maxLengthTimer);
      this._maxLengthTimer = null;
    }
    this.state = 'idle';
    this.recording = null;
    this._app = null;
    this._notifyStateChange();
  }

  /**
   * Drop everything recorded after `wallTs` — the recorder's half of "undo to
   * here". The live board has just been reverted to that moment's state, so
   * the undone tail must not survive on the tape (stopping and replaying the
   * recording would resurrect strokes that no longer exist on the board).
   * A fresh intra-checkpoint of the restored board is captured so post-undo
   * seeks have a base on the far side of the review gap. If the cut predates
   * the recording entirely, the whole tape was undone: it re-bases on the
   * restored board (fresh opening snapshot, empty delta list) and recording
   * continues.
   * @param {number} wallTs - cut point, wall-clock ms
   */
  truncateAfter(wallTs) {
    if (this.state !== 'recording' || !this.recording) return;
    const cut = Number(wallTs);
    if (!Number.isFinite(cut)) return;
    const rec = this.recording;

    if (cut < rec.startedAt) {
      try {
        rec.openingSnapshot = captureOpeningSnapshot(this._app);
        rec.startedAt = Date.now();
      } catch (err) {
        console.warn('[Recorder] re-base snapshot capture failed:', err);
      }
      rec.deltas = [];
      rec.intraCheckpoints = [];
      rec.visualCheckpoints = [];
      this._activitySinceVisual = false;
      this._scheduleMaxLengthStop();
      this._notifyStateChange();
      return;
    }

    rec.deltas = rec.deltas.filter((d) => d.ts <= cut);
    rec.intraCheckpoints = rec.intraCheckpoints.filter((cp) => cp.ts <= cut);
    rec.visualCheckpoints = rec.visualCheckpoints.filter((cp) => cp.ts <= cut);
    this._activitySinceVisual = false;
    this._captureIntraCheckpoint();
    this._notifyStateChange();
  }

  /**
   * Arm a one-shot filter that drops the next inbound message of `type`.
   * Armed just before our own "undo to here" restore broadcast: the tape is
   * truncated at the undo point, and the server's echo of the restore carries
   * no user id (so it dodges the commit self-echo dedup) — without this it
   * would re-append a full board image the truncated tape already equals.
   * @param {number} type - T enum message type
   * @param {number} [windowMs] - how long the filter stays armed
   */
  suppressNextInbound(type, windowMs = 10_000) {
    if (type == null) return;
    this._suppressInbound = { type, until: Date.now() + windowMs };
  }

  /**
   * Called by TimeMachine.recordAction when WebSocketClient sees an inbound
   * message. `msg` is the decoded JSON (post-protobuf).
   * @param {Object} msg
   */
  recordIncoming(msg) { this._append(msg, 'in'); }

  /**
   * Called by TimeMachine.recordAction when WebSocketClient sends an outbound
   * message. The tap site already stamps `u = sessionIndex` for outbound.
   * @param {Object} msg
   */
  recordOutgoing(msg) { this._append(msg, 'out'); }

  /** @private */
  _append(msg, dir) {
    if (this.state !== 'recording' || !this.recording) return;
    if (!shouldRecord(msg)) return;

    // One-shot suppression (see suppressNextInbound): our own restore echoed
    // back by the server after an "undo to here" truncation must not land on
    // the freshly cut tape.
    const sup = this._suppressInbound;
    if (sup && dir === 'in' && msg?.t === sup.type) {
      this._suppressInbound = null;
      if (Date.now() <= sup.until) return;
    }

    // The server echoes commit-class messages (MU, FILL, SEL_COMMIT, UNDO, …)
    // back to the sender so its strokeLog stays in sync. We see the same
    // payload twice — once as 'out' from our own send and once as 'in' from
    // the server echo — and ReplayEngine has no idea they're duplicates, so
    // each commit would re-apply, stacking opacity. Drop the inbound echo
    // when its `u` matches our session index.
    // SEL_LIFT is echoed to its sender too (so the lift-erase can reconcile to
    // the broadcast's seq — see server/index.js SEL_LIFT), but it is not a
    // COMMIT_KIND type, so it needs naming explicitly or the sender tapes it
    // twice and replay applies the destination-out erase twice.
    if (dir === 'in' && msg?.t != null && (isCommitType(msg.t) || msg.t === T.SEL_LIFT)) {
      const selfIdx = this._app?.wsClient?.sessionIndex
                   ?? this._app?.sessionIndex
                   ?? null;
      if (selfIdx != null && msg.u === selfIdx) return;
    }

    if (this.recording.deltas.length >= HARD_MAX_DELTAS) {
      // Soft auto-stop on hard cap. The tape stays usable up to this point.
      console.warn('[Recorder] HARD_MAX_DELTAS hit, auto-stopping recording');
      const bundle = this.stop();
      if (bundle) {
        // Re-publish via onStateChange so any UI listener can save / discard.
        this._notifyStateChange(bundle);
      }
      return;
    }

    // structuredClone keeps protobuf field aliases (the `ps` array on draw
    // messages is a typed Float32Array post-decode; cloning normalises it).
    let cloned;
    try {
      cloned = structuredClone(msg);
    } catch {
      // Falls through for symbol/function-bearing payloads (none expected,
      // but cheap insurance).
      cloned = JSON.parse(JSON.stringify(msg));
    }
    this.recording.deltas.push({ ts: Date.now(), msg: cloned, dir });
    this._activitySinceVisual = true;

    // Check the length cap after recording so the delta that trips it stays
    // on the tape (the max-length timer usually stops us first; this is the
    // backstop for throttled timers).
    if (this._maxLengthMs > 0 && this.elapsedMs() >= this._maxLengthMs) {
      this._autoStop('max recording length reached');
    }
  }

  /** @private */
  _scheduleIntraCheckpoint() {
    if (this._intraCheckpointTimer != null) clearTimeout(this._intraCheckpointTimer);
    this._intraCheckpointTimer = setTimeout(() => {
      this._captureIntraCheckpoint();
      if (this.state === 'recording') this._scheduleIntraCheckpoint();
    }, this._intraCheckpointIntervalMs);
  }

  /** @private */
  _scheduleMaxLengthStop() {
    if (this._maxLengthTimer != null) {
      clearTimeout(this._maxLengthTimer);
      this._maxLengthTimer = null;
    }
    if (this._maxLengthMs <= 0 || !this.recording) return;

    const remaining = Math.max(0, this.recording.startedAt + this._maxLengthMs - Date.now());
    this._maxLengthTimer = setTimeout(() => {
      if (this.state === 'recording') {
        this._autoStop('max recording length reached');
      }
    }, remaining);
  }

  /** @private */
  _autoStop(reason) {
    console.warn(`[Recorder] ${reason}, auto-stopping recording`);
    const bundle = this.stop();
    if (bundle) {
      this._notifyStateChange(bundle);
    }
  }

  /** @private */
  _captureIntraCheckpoint() {
    if (this.state !== 'recording' || !this.recording || !this._app) return;
    try {
      const snapshot = captureOpeningSnapshot(this._app);
      this.recording.intraCheckpoints.push({ ts: Date.now(), snapshot });
    } catch (err) {
      console.warn('[Recorder] intra-checkpoint capture failed:', err);
    }
  }

  /** @private */
  _scheduleVisualCheckpoint() {
    if (this._visualCheckpointTimer != null) clearTimeout(this._visualCheckpointTimer);
    this._visualCheckpointTimer = setTimeout(() => {
      this._captureVisualCheckpoint();
      if (this.state === 'recording') this._scheduleVisualCheckpoint();
    }, VISUAL_CHECKPOINT_INTERVAL_MS);
  }

  /**
   * Snapshot the live composited board to a small WebP blob. The resulting
   * grid is what `TimeMachine.loadFromRecording` paints as a blurred preview
   * before the replay engine has caught up.
   * @private
   */
  _captureVisualCheckpoint() {
    if (this.state !== 'recording' || !this.recording || !this._app) return;
    if (this._visualCheckpointInFlight) return;
    if (this.recording.visualCheckpoints.length >= VISUAL_CHECKPOINT_MAX_COUNT) return;
    // Skip idle frames: nothing happened on the canvas since the last capture,
    // so re-snapshotting would only append an identical frame.
    if (!this._activitySinceVisual) return;

    const board = this._app.board;
    const src = board?.mainCanvas;
    if (!src || !src.width || !src.height) return;

    this._activitySinceVisual = false;
    // Make sure pending strokes are reflected before we read pixels. Cheap when
    // nothing's dirty.
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
    this._visualCheckpointInFlight = true;
    tmp.toBlob(
      (blob) => {
        this._visualCheckpointInFlight = false;
        if (!blob) return;
        if (this.state !== 'recording' || !this.recording) return;
        this.recording.visualCheckpoints.push({ ts, blob });
      },
      'image/webp',
      VISUAL_CHECKPOINT_QUALITY,
    );
  }

  /** @private */
  _notifyStateChange(extra = null) {
    if (typeof this.onStateChange === 'function') {
      try { this.onStateChange(extra ?? this.recording); } catch {}
    }
  }
}

/** Process-wide singleton. App.js wires it onto window.app.recorder. */
export const recorder = new Recorder();
