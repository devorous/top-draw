/**
 * @fileoverview Stroke-log fingerprinting primitives shared between client and server.
 *
 * The whole divergence-detection system depends on client and server agreeing on:
 *   1. Which messages count as a "commit" (i.e. modify the stroke log).
 *   2. How the fingerprint is computed from the encoded message bytes.
 *
 * Keeping both in one module that runs on both sides guarantees they never drift.
 * See docs/000Server_Rendering.md for the larger plan.
 */

import { T } from './MessageTypes.js';

/**
 * Message types that mutate the stroke log on receipt. Only these are
 * fingerprinted; intra-stroke chatter (MM/MD/CP/CS/CC/CT/...) is ignored.
 *
 * Categorized for the audit panel:
 *   stroke:    MU, FILL, GLITCH_RESULT          → adds a stroke record
 *   selection: SEL_COMMIT, SEL_DELETE, SEL_FILL,
 *              SEL_STAMP, SEL_MERGE, IMG_PASTE  → selection-as-stroke commits
 *   text:      TEXT_APPLY, TEXT_REMOVE          → text overlay commits
 *   history:   UNDO, REDO                       → modifies existing log
 *   admin:     CLR, MOD_WIPE,
 *              MOD_UNDO_TO_STATE                → wholesale log mutations
 *   board:     BOARD_SNAPSHOT_RESTORE           → base-image replacement at a seq
 *
 * BOARD_SNAPSHOT_RESTORE is a commit ONLY when the server broadcasts it through
 * the sequenced path (broadcastSequencedRestore): it then carries a real server
 * seq and appends to the log on both sides at that seq, fixing a fixed z-point
 * for the restore so every client applies it identically (see Bug A in
 * docs/000Sync_Parity_Findings.md). The private join-sync restore (SyncCoordinator
 * sendTo, no seq) is NOT logged — clients gate recording on seq presence.
 *
 * NOTE: COMPRESS_USER_STROKES is intentionally NOT a commit type. It rewrites
 * existing history rather than appending, but record() only ever appends — so
 * fingerprinting it produced a systematic, unrecoverable desync (client logged
 * it at seq:0; server's window never matched). See docs/000Sync_Parity_Findings.md.
 */
export const COMMIT_KIND = {
  [T.MU]:                     'stroke.mu',
  [T.FILL]:                   'stroke.fill',
  [T.GLITCH_RESULT]:          'stroke.glitch',
  [T.SEL_COMMIT]:             'selection.commit',
  [T.SEL_DELETE]:             'selection.delete',
  [T.SEL_FILL]:               'selection.fill',
  [T.SEL_STAMP]:              'selection.stamp',
  [T.SEL_MERGE]:              'selection.merge',
  [T.IMG_PASTE]:              'selection.paste',
  [T.TEXT_APPLY]:             'text.apply',
  [T.TEXT_REMOVE]:            'text.remove',
  [T.UNDO]:                   'history.undo',
  [T.REDO]:                   'history.redo',
  [T.CLR]:                    'admin.clear',
  [T.MOD_WIPE]:               'admin.wipe',
  [T.MOD_UNDO_TO_STATE]:      'admin.undoToState',
  [T.BOARD_SNAPSHOT_RESTORE]: 'board.restore',
};

/**
 * Quick check: does this message type contribute to the stroke fingerprint log?
 * @param {number} t - Message type from T enum
 * @returns {boolean}
 */
export function isCommitType(t) {
  return COMMIT_KIND[t] !== undefined;
}

/**
 * FNV-1a 32-bit hash over a Uint8Array. Fast, simple, good distribution for
 * our purposes (we only need stable equality + low collision rate, not
 * cryptographic strength). Returns an unsigned 32-bit int.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Combine a new entry fingerprint into a running 32-bit hash. Order-sensitive
 * (good — we want to catch reorderings as desyncs).
 * @param {number} prev - Previous rolling hash (start with 0)
 * @param {number} fingerprint - New entry fingerprint
 * @returns {number}
 */
export function rollHash(prev, fingerprint) {
  // Standard MurmurHash-style mix; cheap and decorrelates from FNV-1a
  let h = (prev ^ fingerprint) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const DEFAULT_CAP = 10_000;
const DEFAULT_CHUNK_SIZE = 64;

/**
 * Append-only ring-buffered log of commit fingerprints. Used identically on
 * client (one per room) and server (one per room).
 *
 * Entries are: { seq, t, kind, userId, fingerprint, timestamp }
 *   - seq: server-assigned monotonic sequence number
 *   - t: raw T.* message type
 *   - kind: human-readable kind from COMMIT_KIND
 *   - userId: sessionIndex of the originating user
 *   - fingerprint: 32-bit hash of the encoded message bytes
 *   - timestamp: wall-clock ms when recorded (informational only)
 */
export class StrokeFingerprintLog {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.cap] - Max entries to retain (oldest evicted)
   * @param {number} [opts.chunkSize] - Chunk size for Merkle-style summaries
   * @param {boolean} [opts.storeBytes=false] - If true, the original wire
   *   bytes are retained on each entry, enabling targeted resync by seq.
   *   Server-only flag — clients have no use for stored bytes.
   */
  constructor(opts = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.storeBytes = !!opts.storeBytes;
    this.entries = [];
    this.rollingHash = 0;
    this.evicted = 0; // count of entries dropped due to cap
    /**
     * Highest seq of any COMMIT this log has dropped, from either the cap
     * overflow in record() or a checkpoint truncateBefore(). 0 = nothing lost.
     *
     * This is the honest answer to "is anything unrecoverable?", which
     * `entries[0].seq` is not: the log records only commit types while the
     * server allocates a seq for EVERY broadcast (MM dominates by roughly 68:1),
     * so the first retained entry sits an arbitrary distance above any given
     * seq and that distance means nothing.
     */
    this.droppedThroughSeq = 0;
    /** @type {Map<number, Uint8Array>|null} */
    this._bytesBySeq = this.storeBytes ? new Map() : null;
  }

  /**
   * Append a commit to the log.
   * @param {Object} args
   * @param {number} args.seq
   * @param {number} args.t
   * @param {number} args.userId
   * @param {Uint8Array} args.bytes - Encoded message bytes
   * @param {number} [args.timestamp] - Defaults to Date.now()
   * @returns {Object|null} the appended entry, or null if not a commit type
   */
  record({ seq, t, userId, bytes, timestamp }) {
    if (!isCommitType(t)) return null;
    if (!bytes || bytes.length === 0) return null;

    const s = seq >>> 0;
    const fingerprint = fnv1a32(bytes);
    const entry = {
      seq: s,
      t,
      kind: COMMIT_KIND[t],
      userId: userId | 0,
      fingerprint,
      timestamp: timestamp ?? Date.now(),
    };

    // Entries are kept sorted ascending by seq — NOT arrival order. The canvas
    // renders in seq order (LayerManager sorts by seq), so a seq-canonical log
    // is what actually corresponds to the rendered state. This means:
    //   - a late/out-of-order delivery (e.g. a parity resync replaying a
    //     missed seq) lands in its correct position and heals the hash,
    //     instead of being appended at the tail and diverging forever;
    //   - the rolling/chunk hashes stop flagging benign arrival-order
    //     differences and only differ when the actual seq set differs.
    const n = this.entries.length;
    let appendedAtEnd = false;
    if (n === 0 || s > this.entries[n - 1].seq) {
      this.entries.push(entry);
      appendedAtEnd = true;
    } else {
      // Binary search for the first index with seq >= s.
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.entries[mid].seq < s) lo = mid + 1; else hi = mid;
      }
      if (lo < n && this.entries[lo].seq === s) {
        // Duplicate seq (idempotent resync of something we already have) — ignore.
        return null;
      }
      this.entries.splice(lo, 0, entry);
    }

    if (this._bytesBySeq) {
      // Copy out of the encoder's pooled buffer so subsequent encodes don't
      // clobber it. Slice() returns a fresh underlying ArrayBuffer.
      this._bytesBySeq.set(s, bytes.slice());
    }

    // rollingHash is defined over the CURRENT seq-sorted entries. The common
    // in-order append folds incrementally (O(1)); a mid-insert recomputes
    // (O(n), rare — only on out-of-order/resync delivery).
    if (appendedAtEnd) {
      this.rollingHash = rollHash(this.rollingHash, fingerprint);
    } else {
      this._recomputeRollingHash();
    }

    if (this.entries.length > this.cap) {
      const overflow = this.entries.length - this.cap;
      const removed = this.entries.splice(0, overflow);
      this.evicted += overflow;
      // Cap eviction is the dangerous one: unlike checkpoint truncation it drops
      // commits with no image covering them, so a joiner served a checkpoint
      // below this seq can never rebuild them.
      if (removed.length) {
        this.droppedThroughSeq = Math.max(this.droppedThroughSeq, removed[removed.length - 1].seq);
      }
      if (this._bytesBySeq) {
        for (const r of removed) this._bytesBySeq.delete(r.seq);
      }
      // Evicting the lowest seqs changes the hashed set, so recompute over what
      // remains. Both sides evict on the same cap, so they stay comparable.
      this._recomputeRollingHash();
    }
    return entry;
  }

  /**
   * Recompute the rolling hash from scratch over the current (seq-sorted)
   * entries. Used after an out-of-order insert or an eviction.
   * @private
   */
  _recomputeRollingHash() {
    let h = 0;
    for (const e of this.entries) h = rollHash(h, e.fingerprint);
    this.rollingHash = h;
  }

  /**
   * Get the original wire bytes for a seq (server-side only).
   * @param {number} seq
   * @returns {Uint8Array|null}
   */
  getBytes(seq) {
    return this._bytesBySeq?.get(seq) ?? null;
  }

  /**
   * @returns {{count: number, evicted: number, latestSeq: number, rollingHash: number}}
   */
  getSummary() {
    return {
      count: this.entries.length,
      evicted: this.evicted,
      latestSeq: this.entries.length > 0
        ? this.entries[this.entries.length - 1].seq
        : 0,
      rollingHash: this.rollingHash,
    };
  }

  /**
   * Merkle-style chunk hashes for diff narrowing. Each chunk hash is FNV-1a
   * over the concatenated fingerprints in that chunk.
   * @returns {{baseSeq: number, chunkSize: number, chunkHashes: number[]}}
   */
  getChunkHashes() {
    const chunkHashes = [];
    const size = this.chunkSize;
    const buf = new Uint8Array(size * 4);
    const view = new DataView(buf.buffer);

    for (let start = 0; start < this.entries.length; start += size) {
      const end = Math.min(start + size, this.entries.length);
      const len = end - start;
      for (let i = 0; i < len; i++) {
        view.setUint32(i * 4, this.entries[start + i].fingerprint);
      }
      chunkHashes.push(fnv1a32(buf.subarray(0, len * 4)));
    }

    return {
      baseSeq: this.entries.length > 0 ? this.entries[0].seq : 0,
      chunkSize: size,
      chunkHashes,
    };
  }

  /**
   * Retrieve a chunk of entries by index for detailed diffing.
   * @param {number} chunkIndex
   * @returns {Object[]}
   */
  getChunk(chunkIndex) {
    const start = chunkIndex * this.chunkSize;
    if (start >= this.entries.length) return [];
    return this.entries.slice(start, start + this.chunkSize);
  }

  /**
   * Retrieve entries with seq in [fromSeq, toSeq] inclusive.
   * @param {number} fromSeq
   * @param {number} toSeq
   * @returns {Object[]}
   */
  getRange(fromSeq, toSeq) {
    return this.entries.filter(e => e.seq >= fromSeq && e.seq <= toSeq);
  }

  /**
   * Whether any live (retained, post-checkpoint) commit is attributed to the
   * given session index. The retained entries ARE the tail a fresh joiner
   * replays on the checkpoint-join path, so an index that still appears here
   * is "haunted": reusing it for a new joiner makes that joiner self-filter the
   * departed author's replayed frames (sessionIndex collision — see
   * docs/0000Sync_Issues.md, Issue 1). Used by session-index allocation to
   * avoid reusing such an index until a checkpoint truncates its commits out.
   * @param {number} userId - Session index to test.
   * @returns {boolean}
   */
  hasLiveCommitsFrom(userId) {
    const uid = userId | 0;
    for (const e of this.entries) {
      if (e.userId === uid) return true;
    }
    return false;
  }

  /**
   * Drop entries with seq < cutoffSeq. Used after a checkpoint is minted —
   * the checkpoint subsumes everything before it.
   *
   * The rolling hash MUST be recomputed over what remains: a fresh joiner builds
   * its log clean over only the post-checkpoint tail, so an existing client whose
   * hash still folded in the (now-removed) pre-checkpoint entries would mismatch
   * it and desync. (See the Stage-1 checkpoint-join path.)
   *
   * Returns the removed entries, each carrying its wire `bytes` when this log
   * stores them, so a caller can archive what a checkpoint retires instead of
   * losing it (server/RoomHistory.js). The bytes are read off `_bytesBySeq`
   * BEFORE it is pruned — retention here is unchanged, the caller just gets a
   * last look at the frames on their way out.
   *
   * @param {number} cutoffSeq
   * @returns {Array<Object>} removed entries, ascending by seq (may be empty)
   */
  truncateBefore(cutoffSeq) {
    if (this.entries.length === 0) return [];
    let idx = this.entries.findIndex(e => e.seq >= cutoffSeq);
    // No entry at/after the cutoff → every entry precedes it; drop them all.
    if (idx === -1) idx = this.entries.length;
    if (idx === 0) return [];

    const removed = this.entries.splice(0, idx);
    this.evicted += idx;
    this.droppedThroughSeq = Math.max(this.droppedThroughSeq, removed[removed.length - 1].seq);
    if (this._bytesBySeq) {
      for (const r of removed) {
        const bytes = this._bytesBySeq.get(r.seq);
        if (bytes) r.bytes = bytes;
        this._bytesBySeq.delete(r.seq);
      }
    }
    this._recomputeRollingHash();
    return removed;
  }

  /**
   * Wipe everything (e.g. on room change).
   */
  clear() {
    this.entries.length = 0;
    this.rollingHash = 0;
    this.evicted = 0;
    this.droppedThroughSeq = 0;
    if (this._bytesBySeq) this._bytesBySeq.clear();
  }
}
