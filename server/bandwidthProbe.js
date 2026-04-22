/** @fileoverview Measures a client's upload throughput by asking them to send N fixed-size chunks. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';

export const PROBE_BLOB_COUNT = 20;
export const PROBE_BLOB_SIZE = 30 * 1024;   // 30 KB per chunk → 600 KB total
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Map of probeId → active state. A probe is keyed so that stale chunks arriving
 * after timeout/cancellation can be silently ignored.
 * @type {Map<string, { ws: WebSocket, resolve: Function, received: number, bytes: number, firstTs: number, lastTs: number, timeoutHandle: any, onPersist: Function|null, username: string|null }>}
 */
const activeProbes = new Map();

function genProbeId() {
  return `bwp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start a probe for a given client. Resolves with the measured uploadBps (bytes/sec),
 * or null if the probe timed out before any chunks arrived.
 *
 * Options:
 *   - sendTo(ws, msg)     required; send function used elsewhere in the server
 *   - onPersist(bps)      optional; called with final bps (>0) so callers can write to DB
 *   - username            optional; included in logs for context
 *
 * @param {WebSocket} ws
 * @param {{ sendTo: Function, onPersist?: Function, username?: string|null }} opts
 * @returns {Promise<number|null>}
 */
export function startProbe(ws, { sendTo, onPersist = null, username = null } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
  if (ws.skipUploadBps) return Promise.resolve(null);
  // Prevent overlapping probes on the same socket
  if (ws._bwProbeId && activeProbes.has(ws._bwProbeId)) {
    return Promise.resolve(null);
  }

  const probeId = genProbeId();
  ws._bwProbeId = probeId;

  return new Promise((resolve) => {
    const state = {
      ws,
      resolve,
      received: 0,
      bytes: 0,
      firstTs: 0,
      lastTs: 0,
      timeoutHandle: null,
      onPersist,
      username,
      sendTo
    };
    activeProbes.set(probeId, state);

    state.timeoutHandle = setTimeout(() => finishProbe(probeId, /*timedOut*/ true), PROBE_TIMEOUT_MS);

    sendTo(ws, {
      t: T.BW_PROBE_START,
      probeId,
      probeTotal: PROBE_BLOB_COUNT,
      probeBlobSize: PROBE_BLOB_SIZE
    });
  });
}

/**
 * Record one chunk arriving. Called from the WS message handler.
 * @param {WebSocket} ws
 * @param {{ probeId: string, probeSeq: number, probeData: Uint8Array|Buffer }} data
 */
export function handleProbeChunk(ws, data) {
  const probeId = data.probeId;
  if (!probeId) return;
  const state = activeProbes.get(probeId);
  if (!state || state.ws !== ws) return;

  const now = Date.now();
  if (state.received === 0) state.firstTs = now;
  state.lastTs = now;
  state.received += 1;
  state.bytes += (data.probeData?.length || 0);

  if (state.received >= PROBE_BLOB_COUNT) {
    finishProbe(probeId, /*timedOut*/ false);
  }
}

function finishProbe(probeId, timedOut) {
  const state = activeProbes.get(probeId);
  if (!state) return;
  activeProbes.delete(probeId);
  if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
  if (state.ws) state.ws._bwProbeId = null;

  // Compute bps; if we got at least 2 chunks we have a valid interval
  let uploadBps = null;
  if (state.received >= 2 && state.lastTs > state.firstTs) {
    const durationSec = (state.lastTs - state.firstTs) / 1000;
    uploadBps = Math.round(state.bytes / durationSec);
  } else if (timedOut && state.received >= 1) {
    // Cap at timeout boundary: received some, but not enough to measure an interval.
    // Treat as very slow — bytes over full timeout window.
    uploadBps = Math.round(state.bytes / (PROBE_TIMEOUT_MS / 1000));
  }

  if (uploadBps != null && uploadBps > 0) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.uploadBps = uploadBps;
      state.ws.lastProbeTs = Date.now();
      // Echo the measurement back so the client can cache it and re-report it
      // when it switches rooms (keeps guests' bps across reconnects).
      if (typeof state.sendTo === 'function') {
        try { state.sendTo(state.ws, { t: T.BW_REPORT, uploadBps }); } catch (_) {}
      }
    }
    if (typeof state.onPersist === 'function') {
      try { state.onPersist(uploadBps); } catch (_) {}
    }
    console.log(`[BW] Probe ${state.username || '?'}: ${state.received}/${PROBE_BLOB_COUNT} chunks, ${(uploadBps / 1024).toFixed(1)} KB/s${timedOut ? ' (timed out)' : ''}`);
  } else {
    console.log(`[BW] Probe ${state.username || '?'} failed — no data${timedOut ? ' (timed out)' : ''}`);
  }

  state.resolve(uploadBps);
}

/**
 * Abort any active probe bound to the given socket (e.g. on disconnect).
 */
export function cancelProbesForSocket(ws) {
  if (!ws || !ws._bwProbeId) return;
  const probeId = ws._bwProbeId;
  if (activeProbes.has(probeId)) {
    finishProbe(probeId, /*timedOut*/ true);
  }
}
