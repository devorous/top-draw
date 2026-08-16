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
    // Shape geometry is reconstructed from the drawer's draw mode, so a
    // rectangle/circle in the replayed tail needs it the same way it needs the
    // size or colour. Without it a joiner rebuilt every historical shape with
    // its own default and drew them at the wrong size.
    T.CSDM,
    // The selection MASK is sticky per-user drawing state, NOT selection setup.
    // It clips every subsequent brush/pen/eraser stroke (Board.
    // applySelectionMaskClipForStroke, bound at MD time) and it outlives the
    // Select tool — SelectTool.deactivate() deliberately hands a non-floating
    // mask over to the Board so the user can switch to the brush and draw
    // inside it.
    //
    // It used to live in buildSelectionStateSet, which files a frame under
    // _pendingSelection and only ever emits it in a SELECTION commit's
    // preamble. Brush strokes build their preamble from _toolState + MD + MM,
    // so the mask was never in it: every stroke drawn under a mask replayed
    // UNCLIPPED for anyone who joined or resynced afterwards, while live peers
    // showed it clipped. Silent, permanent divergence — and invisible unless
    // the stroke actually crossed the mask boundary.
    //
    // As tool state it is snapshotted into every stroke's MD preamble, pushed
    // into an already-open stroke on a mid-stroke toggle (see below), and
    // re-sent as latest-state at the end of the join serve. Keyed by `t`, so
    // only the newest mask per user is retained — which is the right
    // semantics, mk=false included.
    T.SEL_MASK,
  ]);
}

function buildSelectionStateSet(T) {
  // SEL_FLIP belongs here: a flip mutates the FLOATING selection and leaves it
  // live (the server's own clearActiveFloatingSelection list deliberately
  // excludes it), so it is setup for the eventual SEL_COMMIT exactly like
  // SEL_MOVE is. It is not a commit — it has no COMMIT_KIND entry, so it is
  // never sequenced or written to the strokeLog — which meant observe() dropped
  // it on the floor and a joiner replayed the commit with an UNFLIPPED image.
  // Pixel diffs missed this for a long time because it only shows up when the
  // selected content is asymmetric enough for the flip to change it.
  // These are appended in order (the list resets only on SEL_LIFT/SEL_PENDING),
  // so two flips replay as two flips and correctly cancel out.
  //
  // SEL_MASK is NOT here — it is tool state, see buildToolStateSet.
  return new Set([T.SEL_LIFT, T.SEL_MOVE, T.SEL_PENDING, T.SEL_FLIP]);
}

/**
 * Commit types that do NOT close an in-flight stroke. History and board-level
 * verbs are commits (they are sequenced and logged) but they own no geometry,
 * so they must not claim the pending MD/MM preamble: doing so filed a stroke's
 * geometry under the UNDO's seq and left the real MU with an empty preamble, so
 * every later joiner replayed the stroke *after* the undo and kept it forever.
 */
function buildNonStrokeCommitSet(T) {
  return new Set([
    T.UNDO, T.REDO, T.CLR,
    T.BOARD_SNAPSHOT_RESTORE, T.BOARD_SNAPSHOT_REGION_RESTORE,
    // Selection commits own no freehand geometry either — their preamble is the
    // SELECTION setup (_buildCommitPreamble), never the MD/MM stream. But the
    // Select tool still broadcasts MD/MM/MU like every other tool (App.js does
    // not gate mouse-down on tool), and a selection commit routinely fires
    // BETWEEN an MD and its MU: clicking outside a floating selection queues MD,
    // then SelectTool.onPointerDown calls commitSelection() -> SEL_COMMIT, and
    // only on release does MU arrive.
    //
    // Without this the `pend && pend.length > 0` branch below claimed that open
    // [toolState, MD] preamble for the SEL_COMMIT, took the early return, and so
    // (a) never built the selection preamble — the joiner replayed the commit
    // with no SEL_LIFT and no trailing SEL_MOVEs, i.e. the selection came back
    // at its previous position/scale — (b) shipped a phantom brush MD under the
    // commit's seq, and (c) skipped the _pendingSelection bookkeeping, leaking
    // those frames into the next commit's bundle.
    T.SEL_COMMIT, T.SEL_DELETE, T.SEL_STAMP, T.SEL_FILL, T.SEL_MERGE
  ].filter(t => t !== undefined));
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
    this.nonStrokeCommitTypes = buildNonStrokeCommitSet(T);
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
      // A history/board verb is sequenced like a commit but owns no geometry —
      // it must leave the in-flight stroke's preamble for that stroke's own MU.
      const pend = this.nonStrokeCommitTypes.has(t) ? null : this._pending.get(uid);
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
      } else if (this._continuesSelection(t)) {
        // The float lives on, so KEEP the entry — but empty it. Emptying rather
        // than deleting is the whole trick:
        //
        //   delete  -> the next SEL_MOVE sees no entry and starts a fresh one,
        //              so every later stamp is served without its SEL_LIFT and
        //              rebuilds as nothing (the bug).
        //   re-emit -> carrying the lift in every stamp's bundle instead sends
        //              the same frame N times with the SAME seq, and
        //              SyncClient.replayBuffer dedups by (event, seq) keeping the
        //              LAST copy — which would apply the lift just before the
        //              final stamp and break all the earlier ones.
        //
        // Emptying gives each commit exactly the frames since the previous one,
        // so a full-tail replay reconstructs the real sequence:
        //   [lift, m1, m2] STAMP  [m3, m4] STAMP  [m5] COMMIT
        // The array stays truthy, so the SEL_MOVE branch appends to it instead
        // of resetting (only SEL_LIFT / SEL_PENDING start a new selection).
        this._pendingSelection.set(uid, []);
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

    if ((this._endsSelection(t) || this._continuesSelection(t)) && selection.length > 0) {
      return [...toolState, ...selection];
    }

    return [];
  }

  /**
   * Commits that CLOSE the selection: the float is gone afterwards, so its
   * setup frames can be dropped.
   *
   * SEL_FLIP is NOT here: a flip transforms the floating selection in place and
   * the selection stays live until a later commit verb closes it.
   *
   * SEL_STAMP and SEL_FILL are NOT here either, for exactly the same reason —
   * see _continuesSelection. Treating them as terminal is what made "fill an
   * area, then move+stamp it around" vanish for anyone who synced afterwards.
   */
  _endsSelection(t) {
    const T = this.T;
    return t === T.SEL_COMMIT ||
      t === T.SEL_DELETE ||
      t === T.SEL_MERGE;
  }

  /**
   * Commits that KEEP the float alive, so more moves and more commits follow on
   * the SAME selection.
   *
   * `RemoteSelectionHandler.handleSelectionStamp` says it outright — "same as
   * commit but keep floating canvas active for further moves/stamps" — and
   * handleSelectionFill has a dedicated floating-fill branch. Both then open
   * with `if (!user.floatingCanvas || !user.selection) return;`, so a client
   * that never replayed the SEL_LIFT silently no-ops every one of them.
   *
   * Dropping the preamble on the first of these (the old behaviour) meant every
   * later stamp was served with only the moves since the previous commit and no
   * SEL_LIFT, leaving a joiner with no float to stamp — so a fill-then-stamp
   * sequence rebuilt as nothing at all, while live clients showed it perfectly.
   */
  _continuesSelection(t) {
    const T = this.T;
    return t === T.SEL_STAMP || t === T.SEL_FILL;
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
   * Latest tool-state frames per user (the running per-user snapshot). Sent at
   * the END of a join serve so the joiner leaves sync with every user's
   * CURRENT tool state. This closes the join-suppression hole: a tool-state
   * frame broadcast while the joiner's live feed was suppressed, for a stroke
   * that had not yet begun at the barrier, is in neither the committed tail
   * (no commit yet) nor a pending bundle (no MD yet) — without this resend the
   * joiner renders that user's next stroke with stale color/size/tool.
   * @returns {Array<{userId: number, frames: Uint8Array[]}>}
   */
  getToolStateBundles() {
    const out = [];
    for (const [userId, st] of this._toolState) {
      if (st.size > 0) out.push({ userId, frames: Array.from(st.values()) });
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
