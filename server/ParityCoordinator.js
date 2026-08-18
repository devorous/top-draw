/**
 * @fileoverview Server-side coordinator for stroke-log parity checks.
 *
 * Flow:
 *   client → SYNC_PARITY_CHECK { seq, parityCount, parityRollingHash }
 *   server → SYNC_PARITY_OK                  (if everything matches)
 *           ─or─
 *   server → SYNC_PARITY_MISMATCH { seq, parityServerCount, parityPercentX100,
 *                                   parityBaseSeq, parityChunkSize, parityChunkHashes[] }
 *   (the MISMATCH carries the manifest inline to save a round-trip)
 *
 *   client → SYNC_PARITY_CHUNK_REQUEST { parityChunkIndex } (one per diverging chunk)
 *   server → SYNC_PARITY_CHUNK { parityChunkIndex, parityEntries[] }
 *
 * The coordinator is stateless across calls — everything lives on the room's
 * StrokeFingerprintLog, which is mutated by broadcastToRoom() as messages flow.
 */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { parityPersistence } from './ParityPersistence.js';
import { TapeFrameFilter } from './StrokeTape.js';

const MAX_CHUNKS_PER_RESPONSE = 256; // sanity cap — 256 * 64 = 16k entries
const MAX_RESYNC_SEQS_PER_REQUEST = 500; // upper bound on a single resync batch

export class ParityCoordinator {
  /**
   * @param {Object} room - The Room (must have .strokeLog)
   * @param {(ws: any, payload: Object) => void} sendTo - Send a message to a single client
   */
  constructor(room, sendTo) {
    this.room = room;
    this.sendTo = sendTo;
    this._lastPixelProbeLogBySession = new Map();
  }

  /**
   * Handle SYNC_PARITY_CHECK from a client. Compares the client's summary
   * against the server's stroke log and replies with OK or MISMATCH+manifest.
   * @param {any} ws - The client's WebSocket
   * @param {Object} data - Decoded incoming message
   */
  async handleCheck(ws, data) {
    const log = this.room?.strokeLog;
    if (!log) return; // No log on this room — silently ignore

    // _discovery is a room-browse/bandwidth-probe connection with no board, so
    // its log is empty and every check would record a false mismatch. Ignore it
    // server-side too, so older clients that still send checks can't pollute the
    // debug.parity_events store. See docs/000Sync_Parity_Findings.md.
    if (this.room?.id === '_discovery') return;

    const clientSeq = Number(data.seq || 0);
    const clientCount = Number(data.parityCount || 0);
    const clientHash = (data.parityRollingHash >>> 0);
    this._handlePixelProbe(ws, data);

    const summary = log.getSummary();
    const serverCount = summary.count;
    const serverHash = summary.rollingHash;
    const serverSeq = summary.latestSeq;

    const matches =
      clientCount === serverCount &&
      clientHash === serverHash &&
      clientSeq === serverSeq;

    if (matches) {
      this.sendTo(ws, { t: T.SYNC_PARITY_OK, seq: serverSeq });
      // Stamp the most-recent open mismatch event for this session as
      // resolved-on-its-own. Fire-and-forget — no need to block the OK.
      parityPersistence.markResolved(this.room.id, ws.sessionIndex, 'auto-ok')
        .catch((err) => console.warn('[Parity] markResolved threw', err));
      return;
    }

    // Compute a rough prefix-match percentage. The precise per-stroke
    // diagnosis happens client-side once it receives the chunk hashes.
    // If the client has more strokes than the server, parity is capped by
    // serverCount (extra client strokes are spurious — likely from a stale
    // session). If the server has more, parity is the fraction the client
    // has at least *count* of.
    const denom = Math.max(clientCount, serverCount, 1);
    const numer = Math.min(clientCount, serverCount);
    const parityPercentX100 = Math.round((numer / denom) * 10000);

    const manifest = log.getChunkHashes();
    const chunkHashes = manifest.chunkHashes.length > MAX_CHUNKS_PER_RESPONSE
      ? manifest.chunkHashes.slice(0, MAX_CHUNKS_PER_RESPONSE)
      : manifest.chunkHashes;

    // Persist the mismatch (initial counts/hashes; the client follows up
    // with the per-stroke detail via SYNC_PARITY_MISMATCH_REPORT).
    const user = this.room.sessionManager?.getUser(ws.sessionIndex);
    const eventId = await parityPersistence.recordMismatch({
      roomId: this.room.id,
      sessionIndex: ws.sessionIndex,
      userId: ws.userId || null,
      username: user?.name || null,
      serverSeq,
      clientSeq,
      serverCount,
      clientCount,
      serverHash,
      clientHash,
      parityPercentX100,
    });

    this.sendTo(ws, {
      t: T.SYNC_PARITY_MISMATCH,
      seq: serverSeq,
      parityServerCount: serverCount,
      parityPercentX100: parityPercentX100,
      parityBaseSeq: manifest.baseSeq,
      parityChunkSize: manifest.chunkSize,
      parityChunkHashes: chunkHashes,
      parityEventId: eventId,
    });
  }

  /**
   * Handle SYNC_PARITY_MISMATCH_REPORT — the client's post-diff detail.
   * Attaches it to the previously persisted mismatch event.
   * @param {any} _ws
   * @param {Object} data
   */
  handleReport(_ws, data) {
    const eventId = String(data.parityEventId || '');
    if (!eventId) return;
    const missing = Array.isArray(data.parityMissing) ? data.parityMissing.map((e) => ({
      seq: typeof e.seq === 'object' && e.seq !== null ? Number(e.seq.toString()) : Number(e.seq || 0),
      t: e.t | 0,
      userId: e.userId | 0,
      timestamp: typeof e.timestamp === 'object' && e.timestamp !== null ? Number(e.timestamp.toString()) : Number(e.timestamp || 0),
      fingerprint: e.fingerprint >>> 0,
      kind: String(e.kind || ''),
    })) : [];
    const extra = Array.isArray(data.parityExtra) ? data.parityExtra.map((e) => ({
      seq: typeof e.seq === 'object' && e.seq !== null ? Number(e.seq.toString()) : Number(e.seq || 0),
      t: e.t | 0,
      userId: e.userId | 0,
      timestamp: typeof e.timestamp === 'object' && e.timestamp !== null ? Number(e.timestamp.toString()) : Number(e.timestamp || 0),
      fingerprint: e.fingerprint >>> 0,
      kind: String(e.kind || ''),
    })) : [];
    const mismatchedSeqs = Array.isArray(data.parityMismatchedSeqs)
      ? data.parityMismatchedSeqs.map((s) => typeof s === 'object' && s !== null ? Number(s.toString()) : Number(s))
      : [];

    parityPersistence.attachDetail(eventId, { missing, extra, mismatchedSeqs })
      .catch((err) => console.warn('[Parity] attachDetail threw', err));
  }

  _handlePixelProbe(ws, data) {
    const snapshotSeq = Number(data.parityPixelSnapshotSeq || 0);
    if (snapshotSeq <= 0) return;

    const tiles = Array.isArray(data.parityPixelTiles) ? data.parityPixelTiles : [];
    if (tiles.length === 0) return;

    const sessionIndex = Number(ws.sessionIndex);
    const key = `${snapshotSeq}:${tiles.join(',')}:${Number(data.parityPixelMaxMadX100 || 0)}`;
    const previous = this._lastPixelProbeLogBySession.get(sessionIndex);
    if (previous === key) return;
    this._lastPixelProbeLogBySession.set(sessionIndex, key);

    console.warn('[PixelParity] divergent checkpoint tiles', {
      roomId: this.room?.id,
      sessionIndex,
      snapshotId: String(data.parityPixelSnapshotId || ''),
      snapshotSeq,
      tileSize: Number(data.parityPixelTileSize || 0),
      tileCols: Number(data.parityPixelTileCols || 0),
      threshold: Number(data.parityPixelMadThresholdX100 || 0) / 100,
      maxMad: Number(data.parityPixelMaxMadX100 || 0) / 100,
      meanMad: Number(data.parityPixelMeanMadX100 || 0) / 100,
      tiles,
    });
  }

  /**
   * Handle SYNC_PARITY_CHUNK_REQUEST from a client. Sends back the full
   * fingerprint entries for the requested chunk index.
   * @param {any} ws
   * @param {Object} data
   */
  handleChunkRequest(ws, data) {
    const log = this.room?.strokeLog;
    if (!log) return;

    const chunkIndex = Number(data.parityChunkIndex || 0);
    if (chunkIndex < 0) return;

    const entries = log.getChunk(chunkIndex);
    // Map from log entries to the proto FingerprintEntry shape. proto field
    // names use snake_case in the schema but protobufjs surfaces them as
    // camelCase, so we send camelCase keys here.
    const payload = entries.map((e) => ({
      seq: e.seq,
      t: e.t,
      userId: e.userId,
      timestamp: e.timestamp,
      fingerprint: e.fingerprint >>> 0,
      kind: e.kind,
    }));

    this.sendTo(ws, {
      t: T.SYNC_PARITY_CHUNK,
      parityChunkIndex: chunkIndex,
      parityEntries: payload,
    });
  }

  /**
   * Handle SYNC_PARITY_RESYNC_REQUEST from a client. For each requested seq we
   * still have the bytes for, replay the same self-contained bundle used by the
   * checkpoint-join tail: retained tool/geometry preamble first, then the
   * original commit bytes. The receiver's normal _processMessage pipeline
   * applies them as if they had just arrived for the first time.
   *
   * Skipped seqs (evicted from the log) are silently ignored — the client
   * will fall back to a full resync via the existing SyncCoordinator path if
   * the next parity check still mismatches.
   *
   * @param {any} ws
   * @param {Object} data
   * @returns {{served: number, missed: number}}
   */
  handleResyncRequest(ws, data) {
    const log = this.room?.strokeLog;
    const result = { served: 0, missed: 0 };
    if (!log) return result;
    if (ws.readyState !== WebSocket.OPEN) return result;

    const requested = Array.isArray(data.parityResyncSeqs) ? data.parityResyncSeqs : [];
    if (requested.length === 0) return result;

    // Preambles carry the drawer's image-tool payload (see StrokeTape); a batch
    // of strokes sharing one brush would otherwise re-send that bitmap per
    // stroke. Scoped to this request — the client's state between requests is
    // not ours to assume.
    const frameFilter = new TapeFrameFilter(this.room?.strokeTape || null);
    const authorBySeq = new Map();
    for (const entry of log.entries) authorBySeq.set(entry.seq, entry.userId);
    const cap = Math.min(requested.length, MAX_RESYNC_SEQS_PER_REQUEST);
    for (let i = 0; i < cap; i++) {
      // Proto uint64 arrives as a Long object via protobufjs (when
      // forceLong default is used); coerce safely.
      const seq = typeof requested[i] === 'object' && requested[i] !== null
        ? Number(requested[i].toString())
        : Number(requested[i]);
      const bytes = log.getBytes(seq);
      if (!bytes) { result.missed++; continue; }
      try {
        const raw = this.room?.strokeTape?.getBundle?.(seq);
        const bundle = raw ? frameFilter.filter(authorBySeq.get(seq) ?? -1, raw) : null;
        if (bundle) {
          for (const frame of bundle) {
            if (this.sendTo(ws, frame) === false) {
              throw new Error('socket closed while sending bundle');
            }
          }
        }
        if (this.sendTo(ws, bytes) !== false) {
          result.served++;
        } else {
          result.missed++;
        }
      } catch (err) {
        console.warn(`[ParityCoordinator] resync send failed for seq ${seq}:`, err.message);
        result.missed++;
      }
    }

    return result;
  }
}
