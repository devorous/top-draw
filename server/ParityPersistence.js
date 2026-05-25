/**
 * @fileoverview Persists stroke-log parity mismatches to MongoDB (collection
 * `debug.parity_events`) so they can be browsed for post-hoc desync analysis.
 *
 * Mongo-optional, matching the rest of this codebase: if `getDB()` returns
 * null, persistence degrades to an in-memory ring buffer and a single
 * console.warn per event. The interface is the same either way.
 *
 * Resolution tracking: every CHECK that yields OK looks up the latest open
 * event for that (roomId, sessionIndex) pair and stamps `resolved=true`
 * with `resolutionKind` so we can later filter "did this client recover on
 * its own?" vs "did the user click Fix?" vs "session ended unresolved".
 *
 * Schema (see docs/000Server_Rendering.md):
 *   {
 *     _id, roomId, sessionIndex, userId?, username?,
 *     ts, serverSeq, clientSeq, serverCount, clientCount,
 *     parityPercent, rolling: { server, client },
 *     // Filled in by attachDetail() once the client reports back:
 *     missingStrokes?, extraStrokes?, mismatchedSeqs?, truncated?,
 *     // Filled in by markResolved():
 *     resolved, resolvedTs?, resolutionKind?
 *   }
 */

import { ObjectId } from 'mongodb';
import { getParityEventsCollection } from './db.js';

const MAX_PERSISTED_ENTRIES = 500; // per-array truncation cap
const IN_MEMORY_RING_CAP = 256;

export class ParityPersistence {
  constructor() {
    /** @type {Array<Object>} — ring buffer fallback when DB is offline */
    this._memoryRing = [];
    /** @type {number} — auto-incrementing in-memory id */
    this._memoryNextId = 1;
    this._loggedOffline = false;
  }

  /**
   * Persist the initial mismatch reading (server's POV). Returns the doc id
   * so the client can echo it back when reporting detail later.
   * @param {Object} args
   * @param {string} args.roomId
   * @param {number} args.sessionIndex
   * @param {string|null} args.username
   * @param {string|null} args.userId
   * @param {number} args.serverSeq
   * @param {number} args.clientSeq
   * @param {number} args.serverCount
   * @param {number} args.clientCount
   * @param {number} args.serverHash
   * @param {number} args.clientHash
   * @param {number} args.parityPercentX100
   * Returns a promise resolving to the doc id once the insert completes.
   * Awaited inline by the coordinator so the MISMATCH reply carries a real
   * id that's already queryable — the follow-up MISMATCH_REPORT from the
   * client would race the insert otherwise.
   * @returns {Promise<string|null>}
   */
  async recordMismatch(args) {
    const baseDoc = {
      roomId: args.roomId,
      sessionIndex: args.sessionIndex | 0,
      userId: args.userId ?? null,
      username: args.username ?? null,
      ts: new Date(),
      serverSeq: args.serverSeq | 0,
      clientSeq: args.clientSeq | 0,
      serverCount: args.serverCount | 0,
      clientCount: args.clientCount | 0,
      parityPercent: Math.round(args.parityPercentX100) / 100,
      rolling: {
        server: args.serverHash >>> 0,
        client: args.clientHash >>> 0,
      },
      resolved: false,
    };

    const col = getParityEventsCollection();
    if (!col) {
      const id = `mem_${this._memoryNextId++}`;
      this._memoryRing.push({ _id: id, ...baseDoc });
      if (this._memoryRing.length > IN_MEMORY_RING_CAP) this._memoryRing.shift();
      if (!this._loggedOffline) {
        console.log('[ParityPersistence] DB offline — recording mismatches in memory only.');
        this._loggedOffline = true;
      }
      return id;
    }

    try {
      const _id = new ObjectId();
      await col.insertOne({ _id, ...baseDoc });
      return _id.toString();
    } catch (err) {
      console.warn('[ParityPersistence] recordMismatch insert failed:', err.message);
      return null;
    }
  }

  /**
   * Attach the client's computed diff detail to a previously-recorded
   * mismatch event. Arrays are truncated to 500 entries with a flag.
   * @param {string|null} docId - id returned by recordMismatch
   * @param {Object} detail
   * @param {Object[]} detail.missing - FingerprintEntry-shaped
   * @param {Object[]} detail.extra
   * @param {number[]} detail.mismatchedSeqs
   */
  async attachDetail(docId, detail) {
    if (!docId) return;

    const truncate = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      return { items: a.slice(0, MAX_PERSISTED_ENTRIES), truncated: a.length > MAX_PERSISTED_ENTRIES };
    };
    const missing = truncate(detail.missing);
    const extra = truncate(detail.extra);
    const mismatched = truncate(detail.mismatchedSeqs);

    const patch = {
      missingStrokes: missing.items,
      extraStrokes: extra.items,
      mismatchedSeqs: mismatched.items,
      truncated: missing.truncated || extra.truncated || mismatched.truncated,
      detailAttachedTs: new Date(),
    };

    // In-memory fallback
    if (typeof docId === 'string' && docId.startsWith('mem_')) {
      const entry = this._memoryRing.find((e) => e._id === docId);
      if (entry) Object.assign(entry, patch);
      return;
    }

    const col = getParityEventsCollection();
    if (!col) return;
    try {
      await col.updateOne({ _id: new ObjectId(docId) }, { $set: patch });
    } catch (err) {
      console.warn('[ParityPersistence] attachDetail failed:', err.message);
    }
  }

  /**
   * Stamp `resolved=true` on the most-recent open event for a (roomId,
   * sessionIndex). Used when a subsequent CHECK comes back OK — we infer
   * the client recovered (either via auto-resync, manual fix, or natural
   * convergence).
   * @param {string} roomId
   * @param {number} sessionIndex
   * @param {string} resolutionKind - 'auto-ok' | 'manual-fix' | 'reconnect' | 'session-end'
   */
  async markResolved(roomId, sessionIndex, resolutionKind = 'auto-ok') {
    const sidx = sessionIndex | 0;

    // In-memory fallback: patch the most-recent open entry for this session
    if (this._memoryRing.length > 0 && !getParityEventsCollection()) {
      for (let i = this._memoryRing.length - 1; i >= 0; i--) {
        const e = this._memoryRing[i];
        if (e.roomId === roomId && e.sessionIndex === sidx && !e.resolved) {
          e.resolved = true;
          e.resolvedTs = new Date();
          e.resolutionKind = resolutionKind;
          return;
        }
      }
      return;
    }

    const col = getParityEventsCollection();
    if (!col) return;
    try {
      // Resolve only the latest open event so we don't sweep all of history
      const candidate = await col.findOne(
        { roomId, sessionIndex: sidx, resolved: false },
        { sort: { ts: -1 }, projection: { _id: 1 } }
      );
      if (!candidate) return;
      await col.updateOne(
        { _id: candidate._id },
        { $set: { resolved: true, resolvedTs: new Date(), resolutionKind } }
      );
    } catch (err) {
      console.warn('[ParityPersistence] markResolved failed:', err.message);
    }
  }

  /**
   * Test helper / mod panel hook — retrieve recent events. Hits DB only;
   * in-memory fallback returns its ring as-is.
   * @param {Object} filter - e.g. { roomId, username, resolved }
   * @param {number} limit
   * @returns {Promise<Object[]>}
   */
  async list(filter = {}, limit = 50) {
    const col = getParityEventsCollection();
    if (!col) {
      return this._memoryRing
        .filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v))
        .slice(-limit)
        .reverse();
    }
    try {
      return await col.find(filter).sort({ ts: -1 }).limit(limit).toArray();
    } catch (err) {
      console.warn('[ParityPersistence] list failed:', err.message);
      return [];
    }
  }
}

// Module-level singleton — there's no per-room state, and the collection
// itself naturally segregates by roomId. Saves having to pass an instance
// through Room→ParityCoordinator constructor chains.
export const parityPersistence = new ParityPersistence();
