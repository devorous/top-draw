/** @fileoverview Handles board snapshot saving, listing, restoring, and deletion. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { authorize, Action } from './permissions.js';
import { getRecorder } from './deltaRecorder.js';
import { uploadSnapshotBundle, getSnapshotBundle, deleteSnapshotBundle } from './r2.js';
import { snapshotLayerDimensions } from '../shared/qoi.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';

const DEFAULT_SNAPSHOT_MAX_PER_ROOM = 100;
const SNAPSHOT_LIST_PAGE_SIZE = 20;

function isSoloRoomOccupant(room) {
  return room?.getClientCount?.() === 1;
}

function canViewSnapshotHistory(ws, room) {
  return Number(ws?.userRole || 0) >= 1 || isSoloRoomOccupant(room);
}

function canLoadSnapshot(ws, room) {
  return authorize(ws, Action.MOD_MUTE, null) || isSoloRoomOccupant(room);
}

function canManualSaveSnapshot(ws, room) {
  return authorize(ws, Action.MOD_MUTE, null) || isSoloRoomOccupant(room);
}

function canRestoreWholeBoard(ws) {
  // Full-board restore is Trusted+ only (no solo-user bypass).
  return authorize(ws, Action.MOD_MUTE, null);
}

function snapshotCoversRoomBoard(snapshotLayers, room) {
  const snapshotDimensions = snapshotLayerDimensions(snapshotLayers);
  const [boardHeight, boardWidth] = getBoardDimensionsForSize(room?.settings?.boardSize);

  return !!snapshotDimensions &&
    snapshotDimensions.width >= boardWidth &&
    snapshotDimensions.height >= boardHeight;
}

function getSnapshotMaxPerRoom() {
  const parsed = Number.parseInt(process.env.SNAPSHOT_MAX_PER_ROOM || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_MAX_PER_ROOM;
}

async function deleteSnapshotRecord(db, room, doc) {
  if (doc.r2Key) {
    await deleteSnapshotBundle(doc.r2Key);
  }

  await db.collection('room_snapshots').deleteOne({ snapshotId: doc.snapshotId });
  room.snapshots = room.snapshots.filter(s => s.id !== doc.snapshotId);
}

async function pruneSnapshotsForRoom(db, room) {
  const maxSnapshots = getSnapshotMaxPerRoom();

  const overflow = await db.collection('room_snapshots')
    .find({ roomId: room.id })
    .sort({ timestamp: -1 })
    .skip(maxSnapshots)
    .project({ snapshotId: 1, r2Key: 1 })
    .toArray();

  for (const doc of overflow) {
    await deleteSnapshotRecord(db, room, doc);
  }
}

/**
 * Removes the legacy embedded `snapshots` array from a room document.
 * Called once per snapshot save so old bloated rooms get cleaned up during normal usage.
 */
async function unsetLegacyEmbeddedSnapshots(db, roomId) {
  try {
    await db.collection('rooms').updateOne(
      { _id: roomId, snapshots: { $exists: true } },
      { $unset: { snapshots: '' } }
    );
  } catch (err) {
    console.warn(`[Snapshot] Failed to unset legacy embedded snapshots for room ${roomId}:`, err);
  }
}


/**
 * Looks up a snapshot metadata document by its snapshotId, scoped to the room.
 * @param {string} roomId
 * @param {string} snapshotId
 * @returns {Promise<Object|null>}
 */
async function findSnapshotDoc(roomId, snapshotId) {
  const db = getDB();
  if (!db) return null;
  return db.collection('room_snapshots').findOne({ roomId, snapshotId });
}

/**
 * Insert a blank "session start" checkpoint for a room if none exists yet.
 * Called before the first auto snapshot so deltas always have an anchor.
 * @param {string} roomId
 * @param {string} bgColor - e.g. '#ffffff'
 * @param {number} ts - room creation time
 */
async function maybeCreateInitialCheckpoint(roomId, bgColor, ts) {
  const db = getDB();
  if (!db) return;

  const existing = await db.collection('room_snapshots').findOne(
    { roomId, auto: true },
    { projection: { _id: 1 } }
  );
  if (existing) return;

  const id = `snap_initial_${roomId}`;
  await db.collection('room_snapshots').insertOne({
    snapshotId: id,
    roomId,
    timestamp: ts,
    issuer: 'server',
    auto: true,
    initial: true,
    bgColor,
    thumbnail: null,
    r2Key: null,
    name: 'Initial checkpoint'
  });
  getRecorder(roomId).onCheckpoint(id);
}

export async function handleSnapshotSave(ws, data, room) {

  // Only allow saving if in production or specifically enabled for dev
  const isProd = process.env.NODE_ENV === 'production';
  const allowDevSaves = process.env.ALLOW_DEV_SNAPSHOTS === 'true';

  // Manual saves and auto-saves still go to in-memory buffer regardless of DB
  // but we skip the expensive DB/R2 part if not authorized
  const shouldPersist = isProd || allowDevSaves;

  // Server-initiated auto-snapshots: any user who was explicitly asked may respond.
  // Manual saves require Trusted+ unless the user is alone in the room.
  const isServerRequested = room?.clearPendingSnapshotRequest
    ? room.clearPendingSnapshotRequest(ws.sessionIndex)
    : room?._pendingSnapshotRequests?.has(ws.sessionIndex);
  if (isServerRequested) {
    room._pendingSnapshotRequests?.delete(ws.sessionIndex);
  } else if (!canManualSaveSnapshot(ws, room)) {
    return;
  }
  if (!room?.canPersistSnapshots?.()) {
    return;
  }

  const db = getDB();
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const snapshotTs = Date.now();
  const issuer = ws.username || 'Unknown';

  // Layers are expected as QOI bytes from client, thumb as JPEG bytes.
  const layers = data.snapshotLayers || [];
  const thumbBytes = data.snapshotThumb || null; // JPEG bytes
  const isAuto = !!data.a;

  // Applied-seq the capture represents (seq-stamp for the checkpoint timeline).
  const checkpointSeq = Math.max(0, Math.round(Number(data.snapshotSeq) || 0));

  const snapshotInMemory = {
    id: snapshotId,
    ts: snapshotTs,
    issuer: issuer,
    layers: isAuto ? layers : [],
    thumb: thumbBytes,
    auto: isAuto,
    seq: checkpointSeq
  };

  // Add to in-memory rolling buffer for quick access/restore before DB/R2 operation
  room.addSnapshot(snapshotInMemory);

  // Auto-snapshots are the room's checkpoints: advance the shared baseSeq
  // watermark. The server truncates its fingerprint log before the checkpoint
  // seq, and every client does the same on SYNC_CHECKPOINT_MINTED, so the
  // compared parity window collapses to the post-checkpoint tail (bounds the log
  // and heals sub-checkpoint joiner gaps — both subsumed by the checkpoint image).
  if (isAuto && checkpointSeq > 0) {
    // Truncate only up to the seq of the snapshot a joiner would actually be
    // served — the highest-seq retained auto snapshot — and mint with THAT
    // snapshot's id/seq. Truncating to the just-received `checkpointSeq` directly
    // would, when a second client's lower-seq auto-save arrives after a higher-seq
    // one, advance the log base past the served image and lose the strokes in the
    // gap (Issue 6). The base snapshot just added above is included in the
    // selection, so `base.seq >= checkpointSeq` always.
    const base = room.getJoinCheckpointMeta?.() || { id: snapshotId, seq: checkpointSeq };
    const baseSeq = base.seq > 0 ? base.seq : checkpointSeq;
    room.strokeLog?.truncateBefore?.(baseSeq + 1);
    room.strokeTape?.truncateBefore?.(baseSeq + 1);
    room.broadcastToAll({
      t: T.SYNC_CHECKPOINT_MINTED,
      snapshotId: base.id || snapshotId,
      snapshotSeq: baseSeq
    });
  }

  if (db && shouldPersist) {
    try {
      // Snapshot metadata now lives inside the room document. Ensure the room
      // exists in Mongo before we push snapshot metadata, especially for lobby.
      await room.saveToDB();

      // Handle initial checkpointing for auto snapshots
      if (isAuto) {
        await maybeCreateInitialCheckpoint(
          room.id,
          room.settings.backgroundColor || '#ffffff',
          room.createdAt
        );
      }

      // Prepare data for R2 and MongoDB
      const r2Key = `snapshots/${room.id}/${snapshotId}.bundle`;
      const bundleData = {
        layers: layers,
        thumbnail: thumbBytes
      };

      // Upload snapshot bundle to R2
      await uploadSnapshotBundle(r2Key, bundleData);

      const mongoDoc = {
        snapshotId: snapshotId,
        timestamp: snapshotTs,
        issuer: issuer,
        auto: isAuto,
        seq: checkpointSeq,
        thumbnail: thumbBytes,
        r2Key: r2Key,
        name: data.n || (isAuto ? `Auto-save ${new Date(snapshotTs).toLocaleTimeString()}` : `Snapshot ${new Date(snapshotTs).toLocaleString()}`)
      };

      // Include mirror region settings with manual snapshots so full restore can match room state.
      if (!isAuto) {
        const mirrorRegions = room.settings?.mirrorRegions || [];
        if (mirrorRegions.length > 0) {
          mongoDoc.mirrorRegions = mirrorRegions;
        }
      }

      await db.collection('room_snapshots').insertOne({
        ...mongoDoc,
        roomId: room.id
      });
      await unsetLegacyEmbeddedSnapshots(db, room.id);
      await pruneSnapshotsForRoom(db, room);

      if (isAuto) {
        getRecorder(room.id).onCheckpoint(snapshotId);
      }

    } catch (err) {
      console.error(`[Snapshot] Failed to save snapshot ${snapshotId} for room ${room.id}:`, err);
      throw err;
    }
  }

  // If client requested an immediate restore broadcast (used when uploading a
  // local snapshot to share with the room), broadcast the restore now using
  // the layers we just received. This mirrors handleSnapshotRestore's broadcast.
  if (data.snapshotRestoreAfterSave && layers && layers.length > 0 && canRestoreWholeBoard(ws)) {
    // Sequenced broadcast (Bug A) — see handleSnapshotRestore.
    const broadcastRestore = room.broadcastSequencedRestore
      ? room.broadcastSequencedRestore.bind(room)
      : room.broadcastToAll.bind(room);
    broadcastRestore({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotLayers: layers,
      snapshotId: snapshotId,
      snapshotTs: snapshotTs,
      snapshotIssuer: issuer
    });

    if (snapshotCoversRoomBoard(layers, room)) {
      room.clearAllTiles();
    }
  }
}

/**
 * Handles requesting the list of snapshots.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotList(ws, data, room) {
  if (!canViewSnapshotHistory(ws, room)) return;
  const db = getDB();
  let dbSnapshots = [];
  const beforeTs = Number(data?.snapshotTs || 0);

  if (db) {
    try {
      const filter = { roomId: room.id };
      if (beforeTs) filter.timestamp = { $lt: beforeTs };

      dbSnapshots = await db.collection('room_snapshots')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(SNAPSHOT_LIST_PAGE_SIZE)
        .toArray();
    } catch (err) {
      console.error('[Snapshot] DB list error:', err);
    }
  }

  const list = dbSnapshots.map(s => ({
    id: s.snapshotId,
    ts: s.timestamp,
    issuer: s.issuer,
    auto: s.auto,
    thumb: s.thumbnail ? (s.thumbnail.buffer || s.thumbnail) : null,
    name: s.name || (s.auto ? `Auto-save ${new Date(s.timestamp).toLocaleTimeString()}` : `Saved ${new Date(s.timestamp).toLocaleString()}`)
  }));

  // De-dupe by ID (in-memory and DB may overlap) and sort by TS
  const uniqueList = Array.from(new Map(list.map(s => [s.id, s])).values())
    .sort((a, b) => b.ts - a.ts);

  room.sendTo(ws, {
    t: T.BOARD_SNAPSHOT_LIST_RESPONSE,
    snapshotList: uniqueList
  });
}

/**
 * Handles restoring a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotRestore(ws, data, room) {
  if (!canRestoreWholeBoard(ws)) return; // Trusted+ only

  const snapshotId = data.snapshotId;
  let snapshotData = null;

  if (Array.isArray(data.snapshotLayers) && data.snapshotLayers.length > 0) {
    snapshotData = {
      id: snapshotId || `restore_${Date.now()}`,
      ts: Date.now(),
      issuer: ws.username || 'Unknown',
      layers: data.snapshotLayers
    };
  }

  // 1. Check in-memory buffer first for very recent/auto snapshots
  let snapshotInMemory = !snapshotData && room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers
    };
  } else if (!snapshotData) {
    if (!snapshotId) {
      console.warn(`[Snapshot] Restore failed: no snapshotId or direct layer payload for room "${room.id}".`);
      return;
    }
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        const bundle = await getSnapshotBundle(doc.r2Key);
        if (!bundle) {
          console.warn(`[Snapshot] Restore failed: Snapshot bundle not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        snapshotData = {
          id: doc.snapshotId,
          ts: doc.timestamp,
          issuer: doc.issuer,
          layers: bundle.layers
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during restore for ${snapshotId}:`, err);
      return;
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  // Sequenced broadcast: the restore is assigned a server seq and ordered
  // against the MU stream so every client applies it at the same z-point
  // (Bug A). Fall back to the legacy immediate broadcast if the sequenced
  // broadcaster hasn't been wired (e.g. very early in a room's life).
  const broadcastRestore = room.broadcastSequencedRestore
    ? room.broadcastSequencedRestore.bind(room)
    : room.broadcastToAll.bind(room);
  const restoreSeq = Number(broadcastRestore({
    t: T.BOARD_SNAPSHOT_RESTORE,
    snapshotLayers: snapshotData.layers,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer
  })) || 0;

  if (snapshotCoversRoomBoard(snapshotData.layers, room)) {
    room.clearAllTiles();

    // Re-baseline join sync. The restore is the authoritative full board as of
    // restoreSeq, so register it as the in-memory join checkpoint and truncate
    // the command tail (incl. the restore commit itself) up to and including it.
    // Without this, the stale pre-restore auto-snapshot stays the join base AND
    // the pre-restore strokes stay in the tail — a joiner then renders the
    // original board from the checkpoint image AND the same strokes replayed
    // from the tail, double-drawing at ~2x opacity once a later checkpoint
    // advances past the restore. Mirrors the SYNC_CHECKPOINT_MINTED truncation.
    if (restoreSeq > 0) {
      room.addSnapshot?.({
        id: snapshotData.id,
        ts: snapshotData.ts,
        issuer: snapshotData.issuer,
        layers: snapshotData.layers,
        seq: restoreSeq,
        auto: true,
      });
      room.strokeLog?.truncateBefore?.(restoreSeq + 1);
      room.strokeTape?.truncateBefore?.(restoreSeq + 1);
      // We now hold a fresh, valid in-memory base, so undo any prior "skip the
      // persisted checkpoint" invalidation from a blank/lone-join session.
      room.joinCheckpointInvalidated = false;
    }
  }
}

/**
 * Handles a private request to fetch one snapshot's layer data (not broadcast).
 * Used by the HistoryPanel to show a preview and apply region-based restores.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId: string }
 * @param {Room} room
 */
export async function handleSnapshotGet(ws, data, room) {
  const snapshotId = data.snapshotId;
  const isProbeFetch = !!data.snapshotProbe;
  let snapshotData = null;
  let snapshotIsAuto = false;

  if (!isProbeFetch && !canViewSnapshotHistory(ws, room)) return;

  // 1. Check in-memory buffer first
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotIsAuto = !!snapshotInMemory.auto;
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers,
      thumb: snapshotInMemory.thumb,
      seq: snapshotInMemory.seq || 0
    };
  } else if (!snapshotData) {
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        snapshotIsAuto = !!doc.auto;
        const bundle = await getSnapshotBundle(doc.r2Key);
        if (!bundle) {
          console.warn(`[Snapshot] Get failed: Snapshot bundle not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        snapshotData = {
          id: doc.snapshotId,
          ts: doc.timestamp,
          issuer: doc.issuer,
          layers: bundle.layers,
          thumb: bundle.thumbnail,
          seq: doc.seq || 0
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during get for ${snapshotId}:`, err);
      return;
    }
  }

  if (isProbeFetch) {
    // Pixel-parity diagnostics may fetch only auto-checkpoints; this avoids
    // opening the full manual history surface to unregistered clients.
    if (!snapshotIsAuto) return;
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  room.sendTo(ws, {
    t: T.BOARD_SNAPSHOT_SAVE,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer,
    snapshotLayers: snapshotData.layers,
    snapshotThumb: snapshotData.thumb,
    snapshotSeq: snapshotData.seq || 0,
    snapshotProbe: isProbeFetch
  });
}

/**
 * Handles restoring a region from a snapshot and broadcasting it to all clients.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId, a (isLasso), sx, sy, sw, sh, cr }
 * @param {Room} room
 */
export async function handleSnapshotRegionRestore(ws, data, room) {
  if (!canLoadSnapshot(ws, room)) return; // Trusted+ only unless user is alone in the room

  const snapshotId = data.snapshotId;
  let snapshotData = null;

  if (Array.isArray(data.snapshotLayers) && data.snapshotLayers.length > 0) {
    snapshotData = {
      id: snapshotId || `region_restore_${Date.now()}`,
      layers: data.snapshotLayers
    };
  }

  // 1. Check in-memory buffer
  let snapshotInMemory = !snapshotData && room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      layers: snapshotInMemory.layers
    };
  } else if (!snapshotData) {
    if (!snapshotId) {
      console.warn(`[Snapshot] Region restore failed: no snapshotId or direct layer payload for room "${room.id}".`);
      return;
    }
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Region restore failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        const bundle = await getSnapshotBundle(doc.r2Key);
        if (!bundle) {
          console.warn(`[Snapshot] Region restore failed: Snapshot bundle not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        snapshotData = {
          id: doc.snapshotId,
          layers: bundle.layers
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during region restore for ${snapshotId}:`, err);
      return;
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Region restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_REGION_RESTORE,
    snapshotId: snapshotData.id,
    snapshotLayers: snapshotData.layers,
    a: !!data.a,
    sx: data.sx || 0,
    sy: data.sy || 0,
    sw: data.sw || 0,
    sh: data.sh || 0,
    cr: data.cr || []
  });
}

/**
 * Handles deleting a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotDelete(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Trusted+ only

  const snapshotId = data.snapshotId;

  const db = getDB();
  if (db) {
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);
      if (doc) {
        await deleteSnapshotRecord(db, room, doc);
      }
    } catch (err) {
      console.error(`[Snapshot Delete] Error deleting snapshot ${snapshotId}:`, err);
    }
  }

  room.snapshots = room.snapshots.filter(s => s.id !== snapshotId);
}

/**
 * Sends the most recent snapshot metadata (with thumbnail) to a newly joined user.
 * Called once per join, only if snapshots exist for the room.
 * @param {WebSocket} ws - The joining user's socket.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotJoinNotify(ws, room) {
  if (!room || room.id === '_discovery' || room.id === 'default') {
    return;
  }

  // Only offer the snapshot to a joiner who's alone in the room. With other
  // users present, the joiner syncs from a live provider; surfacing the
  // snapshot prompt on top of that is confusing.
  const clientCount = typeof room.getClientCount === 'function' ? room.getClientCount() : 1;
  if (clientCount !== 1) {
    console.log(`[Snapshot] Skipping join notify: room.getClientCount() = ${clientCount}`);
    return;
  }
  room.beginBlankJoinSession?.();
  console.log(`[Snapshot] Sending join notify: clientCount = ${clientCount}`);

  // Prefer in-memory snapshots that have both a thumb AND layers (auto-saves).
  for (let i = room.snapshots.length - 1; i >= 0; i--) {
    const s = room.snapshots[i];
    if (s.thumb && s.layers && s.layers.length > 0) {
      room.sendTo(ws, {
        t: T.BOARD_SNAPSHOT_JOIN_NOTIFY,
        snapshotId: s.id,
        snapshotTs: s.ts,
        snapshotIssuer: s.issuer || 'Unknown',
        snapshotThumb: s.thumb
      });
      return;
    }
  }

  // Fall back to DB — find the most recent snapshot with a thumbnail
  const db = getDB();
  if (!db) return;

  try {
    const doc = await db.collection('room_snapshots').findOne(
      { roomId: room.id, thumbnail: { $ne: null } },
      { sort: { timestamp: -1 } }
    );

    if (!doc) return;

    room.sendTo(ws, {
      t: T.BOARD_SNAPSHOT_JOIN_NOTIFY,
      snapshotId: doc.snapshotId,
      snapshotTs: doc.timestamp,
      snapshotIssuer: doc.issuer || 'Unknown',
      snapshotThumb: doc.thumbnail?.buffer || doc.thumbnail
    });
  } catch (err) {
    console.error(`[Snapshot] Failed to fetch latest snapshot for join notify in room "${room.id}":`, err);
  }
}
