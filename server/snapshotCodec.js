/**
 * @fileoverview Server-persisted checkpoint <-> `.ddraw` packing/unpacking.
 *
 * Phase 1 of docs/ddraw_server_snapshots_plan.md: room_snapshots + R2 now
 * store a degenerate `.ddraw` (empty deltas, one opening-snapshot layer set,
 * at most one thumbnail visualCheckpoint) instead of the old protobuf
 * `SnapshotBundle`. The *capture* is unchanged — still flat, watermark-
 * composited per-layer QOI produced client-side — only the container format
 * changes. Both this module's functions return/accept the same
 * `{ layers, thumbnail }` shape the old bundle used, so callers (snapshots.js,
 * RoomManager.js) only need to swap the fetch/decode call, not their
 * surrounding logic.
 */

import { encodeDdraw, decodeDdraw } from '../shared/ddrawCodec.js';
import { decodeLegacyBundle } from './r2.js';

const THUMBNAIL_MIME = 'image/jpeg';

/**
 * Build the `.ddraw` bytes for a server checkpoint.
 * @param {Array<Uint8Array>} layers - QOI-encoded, watermark-composited layers.
 * @param {Uint8Array|Buffer|null} thumbnail - JPEG thumbnail bytes, if any.
 * @param {{ issuer?: string, roomId?: string, ts?: number }} [meta] - Origin info
 *   embedded in the file itself, independent of the room_snapshots Mongo doc
 *   (which can be lost/pruned separately from the R2 object).
 * @returns {Promise<Buffer>}
 */
export async function encodeSnapshotFile(layers, thumbnail, meta = {}) {
  const recording = {
    startedAt: meta.ts || Date.now(),
    duration: 0,
    issuer: meta.issuer || null,
    roomId: meta.roomId || null,
    openingSnapshot: {
      layerBaked: layers || [],
      history: [],
    },
    deltas: [],
    visualCheckpoints: thumbnail
      ? [{ ts: 0, blob: new Blob([thumbnail], { type: THUMBNAIL_MIME }) }]
      : [],
  };
  const blob = await encodeDdraw(recording);
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * Decode a snapshot file's raw bytes back into `{ layers, thumbnail, issuer }`,
 * dispatching on the room_snapshots doc's `format` field. Legacy `.bundle`
 * files never carried an issuer, so `issuer`/`roomId` come back null for them.
 * @param {Buffer|Uint8Array} bytes
 * @param {'ddraw'|'bundle'|undefined} format - undefined/'bundle' = legacy protobuf.
 * @returns {Promise<{layers: Uint8Array[], thumbnail: Uint8Array|null, issuer: string|null, roomId: string|null, ts: number|null}>}
 */
export async function decodeSnapshotFile(bytes, format) {
  if (format === 'ddraw') {
    const recording = await decodeDdraw(bytes);
    const layers = recording?.openingSnapshot?.layerBaked || [];
    const checkpoint = recording?.visualCheckpoints?.[0];
    const thumbnail = checkpoint?.blob
      ? Buffer.from(await checkpoint.blob.arrayBuffer())
      : null;
    return {
      layers,
      thumbnail,
      issuer: recording?.issuer || null,
      roomId: recording?.roomId || null,
      ts: recording?.startedAt || null,
    };
  }
  const legacy = await decodeLegacyBundle(bytes);
  return { ...legacy, issuer: null, roomId: null, ts: null };
}
