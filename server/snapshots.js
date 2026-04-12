/** @fileoverview Handles board snapshot saving, listing, restoring, and deletion. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { authorize, Action } from './permissions.js';
import { getRecorder } from './deltaRecorder.js';
import { uploadSnapshotBundle, getSnapshotBundle, deleteSnapshotBundle } from './r2.js';

const DEFAULT_SNAPSHOT_MAX_PER_ROOM = 100;
const SNAPSHOT_LIST_PAGE_SIZE = 20;

function canViewSnapshotHistory(ws) {
  return Number(ws?.userRole || 0) >= 1;
}

function getSnapshotMaxPerRoom() {
  const parsed = Number.parseInt(process.env.SNAPSHOT_MAX_PER_ROOM || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_MAX_PER_ROOM;
}

async function deleteSnapshotRecord(db, room, doc) {
  if (doc.r2Key) {
    await deleteSnapshotBundle(doc.r2Key);
  }

  await db.collection('board_snapshots').deleteOne({ _id: doc._id });
  room.snapshots = room.snapshots.filter(s => s.id !== doc.snapshotId);
}

async function pruneSnapshotsForRoom(db, room) {
  const maxSnapshots = getSnapshotMaxPerRoom();
  const overflowDocs = await db.collection('board_snapshots')
    .find({ roomId: room.id })
    .sort({ timestamp: -1, _id: -1 })
    .skip(maxSnapshots)
    .project({ _id: 1, snapshotId: 1, r2Key: 1 })
    .toArray();

  for (const doc of overflowDocs) {
    await deleteSnapshotRecord(db, room, doc);
  }

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
  const existing = await db.collection('board_snapshots')
    .countDocuments({ roomId, auto: true });
  if (existing > 0) return;

  const id = `snap_initial_${roomId}`;
  await db.collection('board_snapshots').insertOne({
    roomId,
    snapshotId: id,
    timestamp: ts,
    issuer: 'server',
    // Layers are expected to be empty for initial checkpoint as client fills with bg color on restore.
    // The actual layer data for this initial state is not stored in DB as it's just a blank canvas.
    layers: [],
    thumb: null,
    auto: true,
    initial: true,
    bgColor
  });
  getRecorder(roomId).onCheckpoint(id);
}

export async function handleSnapshotSave(ws, data, room) {
  // Server-initiated auto-snapshots: any user who was explicitly asked may respond.
  // Manual saves require Helper+ authorization.
  const isServerRequested = room?._pendingSnapshotRequests?.has(ws.sessionIndex);
  if (isServerRequested) {
    room._pendingSnapshotRequests.delete(ws.sessionIndex);
  } else if (!authorize(ws, Action.MOD_MUTE, null)) {
    return; // Helper+ required for manual saves
  }
  if (!room?.isRegistered?.()) {
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

  const snapshotInMemory = {
    id: snapshotId,
    ts: snapshotTs,
    issuer: issuer,
    // Store QOI layers directly in memory for quick access if needed.
    // These won't be persisted to DB/R2 in the new scheme for manual/auto saves.
    // Initial checkpoint is handled differently and doesn't store layers here.
    layers: isAuto ? layers : [], // Only store layers in memory for auto snapshots for now
    thumb: thumbBytes,
    auto: isAuto
  };

  // Add to in-memory rolling buffer for quick access/restore before DB/R2 operation
  room.addSnapshot(snapshotInMemory);

  if (db) {
    try {
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
        layers: layers, // QOI encoded layers
        thumbnail: thumbBytes // JPEG encoded thumbnail
      };

      // Upload snapshot bundle to R2
      await uploadSnapshotBundle(r2Key, bundleData);

      // Store metadata and R2 key in MongoDB
      const mongoDoc = {
        roomId: room.id,
        snapshotId: snapshotId,
        timestamp: snapshotTs,
        issuer: issuer,
        auto: isAuto,
        thumbnail: thumbBytes, // Keep thumbnail in MongoDB for fast listing
        r2Key: r2Key, // Store the key to the bundle in R2
        name: data.n || (isAuto ? `Auto-save ${new Date(snapshotTs).toLocaleTimeString()}` : `Snapshot ${new Date(snapshotTs).toLocaleString()}`)
      };

      await db.collection('board_snapshots').insertOne(mongoDoc);
      await pruneSnapshotsForRoom(db, room);

      // Notify deltaRecorder if it's an auto snapshot (checkpoint)
      if (isAuto) {
        getRecorder(room.id).onCheckpoint(snapshotId);
      }

    } catch (err) {
      console.error(`[Snapshot] Failed to save snapshot ${snapshotId} for room ${room.id}:`, err);
      // Consider cleanup if R2 upload succeeded but DB insert failed, or vice-versa.
      // For now, error is logged and re-thrown.
      throw err;
    }
  }
}

/**
 * Handles requesting the list of snapshots.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotList(ws, data, room) {
  if (!canViewSnapshotHistory(ws)) return;
  const db = getDB();
  let dbSnapshots = [];
  const beforeTs = Number(data?.snapshotTs || 0);

  if (db) {
    try {
      // Fetch snapshot metadata from MongoDB, which includes thumbnail and r2Key
      const filter = { roomId: room.id };
      if (beforeTs > 0) {
        filter.timestamp = { $lt: beforeTs };
      }

      dbSnapshots = await db.collection('board_snapshots')
        .find(filter)
        .sort({ timestamp: -1, _id: -1 })
        .limit(SNAPSHOT_LIST_PAGE_SIZE)
        .toArray();
    } catch (err) {
      console.error('[Snapshot] DB list error:', err);
    }
  }

  const list = [
    // Snapshots in the in-memory rolling buffer (these might not be persisted yet or are recent auto-saves)
    // For simplicity, we'll primarily rely on DB snapshots for the list response,
    // as they are guaranteed to be persisted or have an R2 counterpart.
    // If a snapshot is in memory AND in DB, the DB version (with r2Key) is preferred.
    // In-memory snapshots that aren't in DB yet might not have full data.
    // For now, focus on listing what's in the DB.

    ...dbSnapshots.map(s => ({
      id: s.snapshotId,
      ts: s.timestamp,
      issuer: s.issuer,
      auto: s.auto,
      // Thumbnail is directly from MongoDB as per plan
      thumb: s.thumbnail ? (s.thumbnail.buffer || s.thumbnail) : null,
      name: s.name || (s.auto ? `Auto-save ${new Date(s.timestamp).toLocaleTimeString()}` : `Saved ${new Date(s.timestamp).toLocaleString()}`)
    }))
  ];

  // De-dupe by ID and sort by TS (though DB query should already be sorted)
  const uniqueList = Array.from(new Map(list.map(s => [s.id, s])).values())
    .sort((a, b) => b.ts - a.ts);

  ws.send(room.Msg.encode(room.Msg.create({
    t: T.BOARD_SNAPSHOT_LIST_RESPONSE,
    snapshotList: uniqueList
  })).finish());
}

/**
 * Handles restoring a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotRestore(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ only

  const snapshotId = data.snapshotId;
  let snapshotData = null; // Will hold { id, ts, issuer, layers }

  // 1. Check in-memory buffer first for very recent/auto snapshots
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    // Found layers in memory (likely auto-save or recently saved manual)
    // No need to fetch from DB/R2 if layers are readily available.
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers
    };
  } else {
    // 2. If not in memory or no layers, fetch metadata from MongoDB and then bundle from R2
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });

        if (!doc) {
          console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} metadata not found in DB.`);
          return;
        }

        // If doc has r2Key, fetch the bundle from R2
        if (doc.r2Key) {
          const bundle = await getSnapshotBundle(doc.r2Key); // Use the new R2 fetch utility
          if (!bundle) {
            console.warn(`[Snapshot] Restore failed: Snapshot bundle not found in R2 for key ${doc.r2Key}.`);
            return;
          }
          snapshotData = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: bundle.layers // Layers from R2 bundle
          };
        } else {
          // Fallback for older snapshots that might only have layers in MongoDB
          snapshotData = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: (doc.layers || []).map(l => l.buffer || l) // Directly from old DB doc
          };
        }
      } catch (err) {
        console.error(`[Snapshot] DB/R2 fetch error during restore for ${snapshotId}:`, err);
        return; // Stop restore if fetching fails
      }
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  // Broadcast restoration to everyone
  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_RESTORE,
    snapshotLayers: snapshotData.layers,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer
  });

  // Clear server-side tile tracking as the board has been reset
  room.clearAllTiles();
}

/**
 * Handles a private request to fetch one snapshot's layer data (not broadcast).
 * Used by the HistoryPanel to show a preview and apply region-based restores.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId: string }
 * @param {Room} room
 */
export async function handleSnapshotGet(ws, data, room) {
  if (!canViewSnapshotHistory(ws)) return;

  const snapshotId = data.snapshotId;
  let snapshotData = null; // Will hold { id, ts, issuer, layers, thumb }

  // 1. Check in-memory buffer first
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers,
      thumb: snapshotInMemory.thumb
    };
  } else {
    // 2. Fetch metadata from MongoDB and bundle from R2
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });

        if (!doc) {
          console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} metadata not found in DB.`);
          return;
        }

        // If doc has r2Key, fetch the bundle from R2
        if (doc.r2Key) {
          const bundle = await getSnapshotBundle(doc.r2Key); // Use the new R2 fetch utility
          if (!bundle) {
            console.warn(`[Snapshot] Get failed: Snapshot bundle not found in R2 for key ${doc.r2Key}.`);
            return;
          }
          snapshotData = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: bundle.layers, // Layers from R2 bundle
            thumb: bundle.thumbnail // Thumbnail from R2 bundle
          };
        } else {
          // Fallback for older snapshots
          snapshotData = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: (doc.layers || []).map(l => l.buffer || l),
            thumb: doc.thumb
          };
        }
      } catch (err) {
        console.error(`[Snapshot] DB/R2 fetch error during get for ${snapshotId}:`, err);
        return;
      }
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  // Send snapshot data back to the requesting client
  ws.send(room.Msg.encode(room.Msg.create({
    t: T.BOARD_SNAPSHOT_SAVE, // Re-using save message type to send data
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer,
    snapshotLayers: snapshotData.layers,
    snapshotThumb: snapshotData.thumb // Sending thumb data as well
  })).finish());
}

/**
 * Handles restoring a region from a snapshot and broadcasting it to all clients.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId, a (isLasso), sx, sy, sw, sh, cr }
 * @param {Room} room
 */
export async function handleSnapshotRegionRestore(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ only

  const snapshotId = data.snapshotId;
  let snapshotData = null; // Will hold { id, layers }

  // 1. Check in-memory buffer
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      layers: snapshotInMemory.layers
    };
  } else {
    // 2. Fetch metadata from MongoDB and bundle from R2
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });

        if (!doc) {
          console.warn(`[Snapshot] Region restore failed: Snapshot ${snapshotId} metadata not found in DB.`);
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
        } else {
          // Fallback for older snapshots
          snapshotData = {
            id: doc.snapshotId,
            layers: (doc.layers || []).map(l => l.buffer || l)
          };
        }
      } catch (err) {
        console.error(`[Snapshot] DB/R2 fetch error during region restore for ${snapshotId}:`, err);
        return;
      }
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
    a: !!data.a,         // isLasso
    sx: data.sx || 0,
    sy: data.sy || 0,
    sw: data.sw || 0,
    sh: data.sh || 0,
    cr: data.cr || []    // lasso points
  });
}

/**
 * Handles deleting a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotDelete(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ only

  const snapshotId = data.snapshotId;

  // Attempt to remove from R2 if it exists
  const db = getDB();
  if (db) {
    try {
      const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });
      if (doc) {
        await deleteSnapshotRecord(db, room, doc);
      }
    } catch (err) {
      console.error(`[Snapshot Delete] Error checking/deleting R2 object for ${snapshotId}:`, err);
    }
  }

  // Remove from in-memory buffer
  room.snapshots = room.snapshots.filter(s => s.id !== snapshotId);
}
