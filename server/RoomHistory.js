/**
 * @fileoverview Per-room archive of recently-expired replay frames.
 *
 * A joiner is served the room's latest checkpoint image plus the short command
 * tail after it (see SyncCoordinator._serveCheckpointJoin), which reproduces the
 * board exactly — but carries no *history*. Their client-side DVR
 * (`src/replay/RollingTapeRecorder.js`) resets at SYNC_COMPLETE, so History →
 * "Recent" is blank for the first two minutes in every room they enter, while
 * everyone already present can scrub back through what was just drawn.
 *
 * This archive closes that gap. It does NOT extend how long `strokeLog` /
 * `strokeTape` retain their entries: those two are the parity window and the
 * join tail, and every client truncates its own log on SYNC_CHECKPOINT_MINTED,
 * so a server log holding entries its clients have dropped would diverge on the
 * rolling hash and fail parity on every heartbeat. Instead the archive is fed
 * BY the truncation — the frames a checkpoint retires are moved here rather
 * than being dropped on the floor. Retention semantics upstream are untouched;
 * the bytes simply live one step longer, out of the parity path.
 *
 * What is kept, per retired commit, is exactly what the join tail sends for a
 * live one: the geometry/tool-state preamble (from StrokeTape) followed by the
 * commit's own wire bytes (from StrokeFingerprintLog). Replaying that pair
 * through a client's normal receive pipeline redraws the stroke, which is what
 * makes the backfilled tape stroke-level rather than a 15s flip-book.
 *
 * Bounding is checkpoint-anchored, mirroring the rule the client's rolling tape
 * already uses (RollingTapeRecorder._prune): the horizon is the newest
 * checkpoint at or before `now - windowMs`, and nothing below that checkpoint's
 * seq is kept. Frames are never dropped without a base image to replay them
 * onto, because a tape whose oldest delta predates its oldest checkpoint has
 * nothing to start from. A byte budget is a backstop for pathological floods.
 *
 * Checkpoint IMAGES are not copied in here — `room.snapshots` already holds a
 * 24-slot ring of them and duplicating QOI layers would double the room's
 * heaviest allocation. Anchors are metadata (`{id, seq, ts}`) and the image is
 * resolved against that ring at serve time.
 */

/** Visible history window. Matches RollingTapeRecorder's DEFAULT_WINDOW_MS. */
export const HISTORY_WINDOW_MS = 120_000;

/**
 * Backstop cap on archived frame bytes, per room. Two minutes of ordinary
 * drawing sits far below this (the MM stream dominates at roughly 2KB/s per
 * actively drawing user), so it only binds during a flood.
 */
const DEFAULT_BYTE_BUDGET = 24 * 1024 * 1024;

/** Backstop cap on archived commits, independent of their size. */
const DEFAULT_COMMIT_CAP = 20_000;

/**
 * Byte budget for the between-stroke cursor track. MM frames are ~25 bytes, so
 * even ten users hovering continuously for two minutes lands near 2MB.
 */
const DEFAULT_CURSOR_BYTE_BUDGET = 8 * 1024 * 1024;

export class RoomHistory {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.windowMs] - Visible history window.
   * @param {number} [opts.byteBudget] - Max retained frame bytes.
   * @param {number} [opts.commitCap] - Max retained commits.
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? HISTORY_WINDOW_MS;
    this.byteBudget = opts.byteBudget ?? DEFAULT_BYTE_BUDGET;
    this.commitCap = opts.commitCap ?? DEFAULT_COMMIT_CAP;

    /**
     * Retired commits, ascending by seq. Each is
     * `{seq, ts, userId, frames: Uint8Array[], bytes: Uint8Array|null}`.
     * @type {Array<Object>}
     */
    this._commits = [];
    /**
     * Checkpoint anchors, ascending by seq: `{id, seq, ts}`. The image itself
     * stays in `room.snapshots`; this is only the timeline.
     * @type {Array<{id: string, seq: number, ts: number}>}
     */
    this._anchors = [];
    this._bytes = 0;
    /** Commits dropped by budget/cap rather than by falling out of the window. */
    this.overflowed = 0;

    /**
     * Between-stroke cursor movement, ascending by seq:
     * `{seq, ts, userId, bytes}`.
     *
     * Held apart from `_commits` because it is not stroke geometry and must not
     * be bounded against it — a quiet room is mostly hover, a busy one mostly
     * strokes, and one starving the other would be the wrong trade either way.
     * StrokeTape only retains MM frames INSIDE a stroke (MD→MU), so without
     * this the backfilled tape drew every stroke correctly and then teleported
     * each cursor to the start of the next one.
     * @type {Array<Object>}
     */
    this._cursors = [];
    this._cursorBytes = 0;
    this.cursorByteBudget = opts.cursorByteBudget ?? DEFAULT_CURSOR_BYTE_BUDGET;
  }

  /**
   * Retain one between-stroke cursor frame. Called for hover MM only — a move
   * inside a stroke already rides in that stroke's preamble.
   * @param {{seq: number, ts: number, userId: number, bytes: Uint8Array}} frame
   */
  recordCursor({ seq, ts, userId, bytes }) {
    const s = Number(seq) || 0;
    if (s <= 0 || !bytes || bytes.length === 0) return;

    // Seqs are allocated in broadcast order, so this is an append in the normal
    // case; the guard keeps the array sorted if one ever arrives late.
    const entry = { seq: s, ts: Number(ts) || Date.now(), userId: userId | 0, bytes };
    const n = this._cursors.length;
    if (n === 0 || s > this._cursors[n - 1].seq) this._cursors.push(entry);
    else return; // out-of-order hover frame; not worth an insert
    this._cursorBytes += bytes.byteLength;

    while (this._cursors.length > 0 && this._cursorBytes > this.cursorByteBudget) {
      this._cursorBytes -= this._cursors.shift().bytes.byteLength;
    }
  }

  /**
   * Record a checkpoint on the history timeline. Called when an auto-snapshot
   * is minted, with the same id/seq the join path would serve.
   *
   * Also called once at session start with the ORIGIN anchor at seq 0 — either
   * a blank board (`blank: true`) or the persisted snapshot this session
   * adopted. Without it the frames retired by a room's first checkpoint had no
   * base image before them and were unusable, so history only began working
   * from the second checkpoint on. A room starts blank; that is a perfectly
   * good base, and an adopted snapshot is stamped at seq 0 for the same reason
   * (see Room._adoptPersistedBase).
   *
   * @param {{id?: string, seq: number, ts: number, blank?: boolean}} anchor
   */
  addAnchor({ id, seq, ts, blank = false }) {
    const s = Number(seq) || 0;
    if (s < 0) return;
    // Only the origin may sit at seq 0, and it must say what the board looked
    // like there — a named image or an explicit blank.
    if (!id && !blank) return;
    if (s === 0 && this._anchors.length > 0 && this._anchors[0].seq === 0) return;
    // Anchors arrive in mint order, which is seq order in the normal case; a
    // lower-seq late arrival is inserted rather than appended so the horizon
    // scan below can assume ascending order.
    const n = this._anchors.length;
    if (n === 0 || s > this._anchors[n - 1].seq) {
      this._anchors.push({ id: id || null, seq: s, ts: Number(ts) || Date.now(), blank: !!blank });
      return;
    }
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._anchors[mid].seq < s) lo = mid + 1; else hi = mid;
    }
    if (lo < n && this._anchors[lo].seq === s) return; // already known
    this._anchors.splice(lo, 0, { id: id || null, seq: s, ts: Number(ts) || Date.now(), blank: !!blank });
  }

  /**
   * Archive the commits a checkpoint truncation just retired.
   *
   * @param {Array<Object>} entries - Removed StrokeFingerprintLog entries, each
   *   carrying `{seq, userId, timestamp, bytes}`. Ascending by seq.
   * @param {Map<number, {frames: Uint8Array[], ts: number[]}>|null} bundlesBySeq
   *   Resolved preambles for those seqs, from StrokeTape.truncateBefore.
   */
  archive(entries, bundlesBySeq = null) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    for (const entry of entries) {
      const seq = Number(entry?.seq) || 0;
      if (seq <= 0) continue;
      const bytes = entry.bytes || null;
      const bundle = bundlesBySeq?.get(seq);
      const frames = bundle?.frames || [];
      // Per-frame arrival times. Without them a stroke's frames all carry the
      // commit's timestamp and the replay draws the whole thing on one instant.
      const frameTs = bundle?.ts || [];
      // A commit with neither its own bytes nor a preamble cannot be replayed;
      // archiving it would only inflate the count the client is told to expect.
      if (!bytes && frames.length === 0) continue;

      let size = bytes ? bytes.byteLength : 0;
      for (const f of frames) size += f.byteLength;

      this._commits.push({
        seq,
        ts: Number(entry.timestamp) || Date.now(),
        userId: entry.userId | 0,
        frames,
        frameTs,
        bytes,
      });
      this._bytes += size;
    }

    // Retirement order is checkpoint order, so pushes are already ascending by
    // seq in the normal case. Re-sort defensively: a late resync commit can be
    // retired below an already-archived seq, and the serve replays in seq order.
    let sorted = true;
    for (let i = 1; i < this._commits.length; i++) {
      if (this._commits[i - 1].seq > this._commits[i].seq) { sorted = false; break; }
    }
    if (!sorted) this._commits.sort((a, b) => a.seq - b.seq);

    this._enforceBudget();
  }

  /**
   * Drop everything below the history horizon: the newest anchor at or before
   * `now - windowMs`. Nothing is dropped while no such anchor exists, because
   * the surviving deltas would then have no base image to replay from.
   * @param {number} [now]
   */
  prune(now = Date.now()) {
    const horizonTs = now - this.windowMs;
    let anchorIdx = -1;
    for (let i = this._anchors.length - 1; i >= 0; i--) {
      if (this._anchors[i].ts <= horizonTs) { anchorIdx = i; break; }
    }
    if (anchorIdx <= 0) {
      // No anchor old enough (or it is already the oldest we hold) — the whole
      // buffer is inside the window.
      this._enforceBudget();
      return;
    }

    this._anchors.splice(0, anchorIdx);
    this._dropCommitsBelow(this._anchors[0].seq);
    this._enforceBudget();
  }

  /** @private Drop archived commits and cursor frames with seq < cutoffSeq. */
  _dropCommitsBelow(cutoffSeq) {
    let idx = 0;
    while (idx < this._commits.length && this._commits[idx].seq < cutoffSeq) idx++;
    if (idx > 0) {
      for (let i = 0; i < idx; i++) this._bytes -= this._sizeOf(this._commits[i]);
      this._commits.splice(0, idx);
    }

    // The cursor track shares the commits' horizon: a hover frame below the
    // base image is movement the viewer will never see a board for.
    let cIdx = 0;
    while (cIdx < this._cursors.length && this._cursors[cIdx].seq < cutoffSeq) cIdx++;
    if (cIdx > 0) {
      for (let i = 0; i < cIdx; i++) this._cursorBytes -= this._cursors[i].bytes.byteLength;
      this._cursors.splice(0, cIdx);
    }
  }

  /** @private */
  _sizeOf(commit) {
    let size = commit.bytes ? commit.bytes.byteLength : 0;
    for (const f of commit.frames) size += f.byteLength;
    return size;
  }

  /**
   * @private Backstop trim. Drops the oldest commits — and any anchor they
   * strand — until both caps are satisfied.
   */
  _enforceBudget() {
    while (this._commits.length > 0
      && (this._bytes > this.byteBudget || this._commits.length > this.commitCap)) {
      const dropped = this._commits.shift();
      this._bytes -= this._sizeOf(dropped);
      this.overflowed++;
    }
    // Re-anchor after an overflow trim. Dropping head commits leaves the oldest
    // anchor sitting BELOW the surviving frames, and replaying from an image
    // that old would silently skip the strokes in the gap — history with a
    // hole in it, which is worse than shorter history. Advance to the newest
    // anchor that the surviving commits still fully follow.
    if (this._commits.length === 0 || this._anchors.length <= 1) return;
    const oldestSeq = this._commits[0].seq;
    let keep = 0;
    for (let i = 1; i < this._anchors.length; i++) {
      if (this._anchors[i].seq <= oldestSeq) keep = i; else break;
    }
    if (keep > 0) this._anchors.splice(0, keep);
  }

  /**
   * The base anchor a backfill replays from: the OLDEST anchor still held,
   * which after pruning is the history horizon and therefore the longest window
   * we can honestly serve.
   *
   * Deliberately not "the newest anchor below the oldest archived commit".
   * Early in a session the archive holds commits that predate every checkpoint
   * — the strokes retired by checkpoint #1 have no image before them — and a
   * base picked strictly below the head commit would be null, suppressing the
   * ENTIRE backfill because of a few unbased frames at the front. Anchoring at
   * the oldest checkpoint instead and discarding what precedes it (see
   * getBackfill) costs those first frames and keeps everything after them.
   *
   * @returns {{id: string, seq: number, ts: number}|null}
   */
  getBaseAnchor() {
    return this._anchors[0] || null;
  }

  /**
   * The archived history, oldest first, for serving to a joiner. Commits at or
   * below the anchor are excluded: the anchor's image already contains them.
   * @returns {{anchor: Object|null, commits: Array<Object>, bytes: number}}
   */
  getBackfill() {
    const anchor = this.getBaseAnchor();
    if (!anchor) return { anchor: null, commits: [], bytes: 0 };

    let start = 0;
    while (start < this._commits.length && this._commits[start].seq <= anchor.seq) start++;
    const commits = start === 0 ? this._commits : this._commits.slice(start);

    let cStart = 0;
    while (cStart < this._cursors.length && this._cursors[cStart].seq <= anchor.seq) cStart++;
    const cursors = cStart === 0 ? this._cursors : this._cursors.slice(cStart);

    return {
      anchor,
      commits,
      cursors,
      bytes: start === 0 ? this._bytes : commits.reduce((n, c) => n + this._sizeOf(c), 0),
    };
  }

  /** Wipe everything (room reset / board clear). */
  clear() {
    this._commits.length = 0;
    this._anchors.length = 0;
    this._cursors.length = 0;
    this._bytes = 0;
    this._cursorBytes = 0;
    this.overflowed = 0;
  }

  /** @returns {{commits: number, anchors: number, bytes: number, overflowed: number, spanMs: number}} */
  getSummary() {
    const first = this._commits[0];
    const last = this._commits[this._commits.length - 1];
    return {
      commits: this._commits.length,
      anchors: this._anchors.length,
      cursors: this._cursors.length,
      bytes: this._bytes,
      cursorBytes: this._cursorBytes,
      overflowed: this.overflowed,
      spanMs: first && last ? last.ts - first.ts : 0,
    };
  }
}
