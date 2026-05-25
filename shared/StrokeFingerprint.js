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
 *              MOD_UNDO_TO_STATE,
 *              COMPRESS_USER_STROKES            → wholesale log mutations
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
  [T.COMPRESS_USER_STROKES]:  'admin.compress',
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

    const fingerprint = fnv1a32(bytes);
    const entry = {
      seq: seq >>> 0,
      t,
      kind: COMMIT_KIND[t],
      userId: userId | 0,
      fingerprint,
      timestamp: timestamp ?? Date.now(),
    };

    this.entries.push(entry);
    this.rollingHash = rollHash(this.rollingHash, fingerprint);

    if (this._bytesBySeq) {
      // Copy out of the encoder's pooled buffer so subsequent encodes don't
      // clobber it. Slice() returns a fresh underlying ArrayBuffer.
      this._bytesBySeq.set(entry.seq, bytes.slice());
    }

    if (this.entries.length > this.cap) {
      const overflow = this.entries.length - this.cap;
      const removed = this.entries.splice(0, overflow);
      this.evicted += overflow;
      if (this._bytesBySeq) {
        for (const r of removed) this._bytesBySeq.delete(r.seq);
      }
      // Note: rollingHash intentionally NOT recomputed on eviction. It still
      // represents the hash over the full historical sequence. Both sides
      // evict on the same cap so the running hash stays comparable.
    }
    return entry;
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
   * Drop entries with seq < cutoffSeq. Used after a checkpoint is minted —
   * the checkpoint subsumes everything before it.
   * @param {number} cutoffSeq
   */
  truncateBefore(cutoffSeq) {
    const idx = this.entries.findIndex(e => e.seq >= cutoffSeq);
    if (idx > 0) {
      const removed = this.entries.splice(0, idx);
      this.evicted += idx;
      if (this._bytesBySeq) {
        for (const r of removed) this._bytesBySeq.delete(r.seq);
      }
    }
  }

  /**
   * Wipe everything (e.g. on room change).
   */
  clear() {
    this.entries.length = 0;
    this.rollingHash = 0;
    this.evicted = 0;
    if (this._bytesBySeq) this._bytesBySeq.clear();
  }
}
