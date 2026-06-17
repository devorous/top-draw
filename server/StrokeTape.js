/**
 * @fileoverview Per-room in-memory tape of replay preambles, keyed by commit seq.
 *
 * The stroke fingerprint log (`shared/StrokeFingerprint.js`) stores only the
 * bytes of *commit* messages (MU/FILL/SEL_COMMIT/…). A commit like MU is just a
 * marker — a brush stroke's actual geometry travels in the non-committed MM
 * stream, and its appearance depends on the user's tool state (tool/color/size),
 * which may have been set by a CT/CC/CS that predates the checkpoint. So commit
 * bytes alone cannot reconstruct a brush stroke for a *fresh joiner* who never
 * saw the live MM/tool-state chatter.
 *
 * This tape closes that gap. For each stroke it retains a **self-contained
 * preamble**: a snapshot of the user's latest tool-state frames (captured as
 * they flow) followed by the MD and every MM frame, all keyed by the seq the
 * server assigns to that stroke's commit. On join, replaying a tape bundle
 * (preamble frames) followed by the commit bytes (from the fingerprint log)
 * lets the joiner draw the stroke itself through the normal pipeline — no
 * rendered pixels, no new client draw code.
 *
 * A few non-stroke commits also need preambles: FILL/IMG_PASTE depend on the
 * user's current tool state, and selection commits depend on non-commit setup
 * frames such as SEL_LIFT/SEL_MOVE. Those lightweight dependencies are retained
 * here too, under the commit seq that consumes them.
 *
 * Bounding: checkpoint truncation (`truncateBefore`, mirrors the fingerprint
 * log) is the primary bound; a count cap is a backstop. Stored byte arrays must
 * be copies — the encoder reuses its output buffer between messages.
 */

/**
 * Tool-state message types whose latest per-user value is snapshotted into a
 * stroke's preamble. Populated from the T enum at construction so this module
 * stays decoupled from import order. These are the `C*` "change" messages.
 */
function buildToolStateSet(T) {
  return new Set([
    T.CT, T.CC, T.CS, T.CP, T.CSP, T.CSM, T.CHD, T.CBR,
    T.CL, T.CBM, T.CF, T.CTHN, T.CSIM,
  ]);
}

function buildSelectionStateSet(T) {
  return new Set([T.SEL_LIFT, T.SEL_MOVE, T.SEL_PENDING, T.SEL_MASK]);
}

const DEFAULT_CAP = 12_000; // backstop; ≥ the fingerprint log's 10k cap

export class StrokeTape {
  /**
   * @param {Object} T - The message-type enum (shared/MessageTypes.js).
   * @param {Object} [opts]
   * @param {number} [opts.cap] - Max bundles retained (oldest evicted).
   */
  constructor(T, opts = {}) {
    this.T = T;
    this.toolStateTypes = buildToolStateSet(T);
    this.selectionStateTypes = buildSelectionStateSet(T);
    this.cap = opts.cap ?? DEFAULT_CAP;
    /** Latest tool-state frame bytes per user: userId -> Map<t, Uint8Array> */
    this._toolState = new Map();
    /** In-flight stroke preamble per user: userId -> Uint8Array[] */
    this._pending = new Map();
    /** In-flight selection setup per user: userId -> Uint8Array[] */
    this._pendingSelection = new Map();
    /** Completed bundles: commitSeq -> Uint8Array[] (preamble frames, ordered) */
    this._bundles = new Map();
  }

  /**
   * Observe one outgoing room message. Called from the broadcast chokepoint
   * after the seq is assigned and the message is encoded.
   *
   * @param {number} t - Message type (payload.t).
   * @param {number} userId - Originating session index (payload.u | 0).
   * @param {Uint8Array} bytes - Encoded wire bytes (will be copied if retained).
   * @param {number} seq - Server-assigned seq for this message.
   * @param {boolean} isCommit - Whether `t` is a commit type (isCommitType).
   */
  observe(t, userId, bytes, seq, isCommit) {
    const T = this.T;
    const uid = userId | 0;

    // Track the most recent tool-state frame per user (a single copy each).
    if (this.toolStateTypes.has(t)) {
      let st = this._toolState.get(uid);
      if (!st) { st = new Map(); this._toolState.set(uid, st); }
      const copy = bytes.slice();
      st.set(t, copy);
      // If a stroke is already in flight, this change also belongs *inside* the
      // stroke's preamble so a joiner replays mid-stroke tool-state changes in
      // order (e.g. scrolling brush size while dragging a circle/rectangle).
      // The MD-time snapshot only captures state as it was at mousedown; without
      // this the stroke is reconstructed with the original size/color/etc.
      const pend = this._pending.get(uid);
      if (pend) pend.push(copy);
      return;
    }

    if (this.selectionStateTypes.has(t)) {
      let sel = this._pendingSelection.get(uid);
      if (!sel || t === T.SEL_LIFT || t === T.SEL_PENDING) {
        sel = [];
        this._pendingSelection.set(uid, sel);
      }
      sel.push(bytes.slice());
      return;
    }

    if (t === T.MD) {
      // Start a fresh stroke: preamble = current tool-state snapshot, then MD.
      const preamble = [];
      const st = this._toolState.get(uid);
      if (st) for (const b of st.values()) preamble.push(b);
      preamble.push(bytes.slice());
      this._pending.set(uid, preamble);
      return;
    }

    if (t === T.MM) {
      const pend = this._pending.get(uid);
      if (pend) pend.push(bytes.slice());
      return;
    }

    if (t === T.CANCEL) {
      this._pending.delete(uid);
      return;
    }

    if (t === T.SEL_CANCEL) {
      this._pendingSelection.delete(uid);
      return;
    }

    // A commit closes the in-flight stroke (if any), filing its geometry under
    // the commit seq. Some non-stroke commits still depend on user state or
    // transient setup frames, so they get a lightweight preamble too.
    if (isCommit) {
      const pend = this._pending.get(uid);
      if (pend && pend.length > 0) {
        this._bundles.set(seq, pend);
        this._pending.delete(uid);
        this._enforceCap();
        return;
      }

      const bundle = this._buildCommitPreamble(uid, t);
      if (bundle.length > 0) {
        this._bundles.set(seq, bundle);
        this._enforceCap();
      }

      if (this._endsSelection(t)) {
        this._pendingSelection.delete(uid);
      }
    }
  }

  _toolStateSnapshot(uid) {
    const st = this._toolState.get(uid);
    return st ? Array.from(st.values()) : [];
  }

  _buildCommitPreamble(uid, t) {
    const T = this.T;
    const toolState = this._toolStateSnapshot(uid);
    const selection = this._pendingSelection.get(uid) || [];

    if (t === T.FILL || t === T.IMG_PASTE) {
      return [...toolState];
    }

    if (this._endsSelection(t) && selection.length > 0) {
      return [...toolState, ...selection];
    }

    return [];
  }

  _endsSelection(t) {
    const T = this.T;
    return t === T.SEL_COMMIT ||
      t === T.SEL_DELETE ||
      t === T.SEL_FILL ||
      t === T.SEL_STAMP ||
      t === T.SEL_MERGE ||
      t === T.SEL_FLIP;
  }

  _enforceCap() {
    if (this._bundles.size > this.cap) {
      const oldest = this._bundles.keys().next().value;
      this._bundles.delete(oldest);
    }
  }

  /**
   * Preamble frames for a commit, or null if none was needed for that seq.
   * @param {number} seq
   * @returns {Uint8Array[]|null}
   */
  getBundle(seq) {
    return this._bundles.get(seq) ?? null;
  }

  /**
   * In-flight (uncommitted) stroke preambles, one per user currently mid-stroke.
   * Each bundle is the same shape as a committed bundle (tool-state snapshot +
   * MD + the MM frames seen so far) but has no closing commit yet. A fresh
   * joiner replays these AFTER the committed tail so it re-begins each active
   * stroke with the correct tool state (incl. blend mode) and partial geometry;
   * the live MM/MU continuation then lands on that already-open stroke instead
   * of a lazily-created source-over one.
   * @returns {Array<{userId: number, frames: Uint8Array[]}>}
   */
  getPendingBundles() {
    const out = [];
    for (const [userId, frames] of this._pending) {
      if (frames && frames.length > 0) out.push({ userId, frames });
    }
    return out;
  }

  /**
   * Drop bundles with seq < cutoffSeq. Mirrors StrokeFingerprintLog.truncateBefore
   * so the geometry tape and the commit log stay bounded together at checkpoints.
   * Keys are inserted in ascending seq order, so we can stop at the first kept key.
   * @param {number} cutoffSeq
   */
  truncateBefore(cutoffSeq) {
    for (const k of this._bundles.keys()) {
      if (k < cutoffSeq) this._bundles.delete(k);
      else break;
    }
  }

  /** Discard any in-flight (uncommitted) stroke geometry for a departed user. */
  dropUser(userId) {
    const uid = userId | 0;
    this._pending.delete(uid);
    this._toolState.delete(uid);
    this._pendingSelection.delete(uid);
  }

  /** Wipe everything (room reset). */
  clear() {
    this._toolState.clear();
    this._pending.clear();
    this._pendingSelection.clear();
    this._bundles.clear();
  }

  /** @returns {{bundles: number, pending: number, pendingSelection: number, trackedUsers: number}} */
  getSummary() {
    return {
      bundles: this._bundles.size,
      pending: this._pending.size,
      pendingSelection: this._pendingSelection.size,
      trackedUsers: this._toolState.size,
    };
  }
}
