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
 * @property {Record<string, string>} assets - SHA-1 → dataURL (Phase 3+)
 */

const RECORDING_VERSION = 2;
const INTRA_CHECKPOINT_INTERVAL_MS = 30_000;
const HARD_MAX_DELTAS = 500_000;

export class Recorder {
  constructor() {
    /** @type {'idle' | 'recording'} */
    this.state = 'idle';
    /** @type {ReplayRecording | null} */
    this.recording = null;
    /** @type {number | null} */
    this._intraCheckpointTimer = null;
    /** @type {Object | null} */
    this._app = null;
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
      assets: {},
    };
    this.state = 'recording';

    this._scheduleIntraCheckpoint();
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

    this.recording.endedAt = Date.now();
    const bundle = this.recording;
    this.state = 'idle';
    this.recording = null;
    this._app = null;
    this._notifyStateChange();
    return bundle;
  }

  /** Discard the in-progress recording without returning it. */
  cancel() {
    if (this._intraCheckpointTimer != null) {
      clearTimeout(this._intraCheckpointTimer);
      this._intraCheckpointTimer = null;
    }
    this.state = 'idle';
    this.recording = null;
    this._app = null;
    this._notifyStateChange();
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
  }

  /** @private */
  _scheduleIntraCheckpoint() {
    if (this._intraCheckpointTimer != null) clearTimeout(this._intraCheckpointTimer);
    this._intraCheckpointTimer = setTimeout(() => {
      this._captureIntraCheckpoint();
      if (this.state === 'recording') this._scheduleIntraCheckpoint();
    }, INTRA_CHECKPOINT_INTERVAL_MS);
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
  _notifyStateChange(extra = null) {
    if (typeof this.onStateChange === 'function') {
      try { this.onStateChange(extra ?? this.recording); } catch {}
    }
  }
}

/** Process-wide singleton. App.js wires it onto window.app.recorder. */
export const recorder = new Recorder();
