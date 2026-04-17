/** @fileoverview Handles board snapshot saving, listing, restoring, and deletion. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { authorize, Action } from './permissions.js';
import { getRecorder } from './deltaRecorder.js';
import { uploadSnapshotBundle, getSnapshotBundle, deleteSnapshotBundle } from './r2.js';

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

function getSnapshotMaxPerRoom() {
  const parsed = Number.parseInt(process.env.SNAPSHOT_MAX_PER_ROOM || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_MAX_PER_ROOM;
}

async function deleteSnapshotRecord(db, room, doc) {
  if (doc.r2Key) {
    await deleteSnapshotBundle(doc.r2Key);
  }

  await db.collection('rooms').updateOne(
    { _id: room.id },
    { $pull: { snapshots: { snapshotId: doc.snapshotId } } }
  );
  room.snapshots = room.snapshots.filter(s => s.id !== doc.snapshotId);
}

async function pruneSnapshotsForRoom(db, room) {
  const maxSnapshots = getSnapshotMaxPerRoom();

  const roomDoc = await db.collection('rooms').findOne(
    { _id: room.id },
    { projection: { snapshots: 1 } }
  );

  if (!roomDoc?.snapshots?.length) return;

  const sorted = [...roomDoc.snapshots].sort((a, b) => (b.timestamp - a.timestamp));
  const overflow = sorted.slice(maxSnapshots);

  for (const doc of overflow) {
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

  const existing = await db.collection('rooms').findOne(
    { _id: roomId, 'snapshots.auto': true },
    { projection: { _id: 1 } }
  );
  if (existing) return;

  const id = `snap_initial_${roomId}`;
  await db.collection('rooms').updateOne(
    { _id: roomId },
    {
      $push: {
        snapshots: {
          snapshotId: id,
          timestamp: ts,
          issuer: 'server',
          layers: [],
          thumb: null,
          auto: true,
          initial: true,
          bgColor
        }
      }
    }
  );
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
  // Manual saves require Trusted+ authorization.
  const isServerRequested = room?._pendingSnapshotRequests?.has(ws.sessionIndex);
  if (isServerRequested) {
    room._pendingSnapshotRequests.delete(ws.sessionIndex);
  } else if (!authorize(ws, Action.MOD_MUTE, null)) {
    return; // Trusted+ required for manual saves
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
    layers: isAuto ? layers : [],
    thumb: thumbBytes,
    auto: isAuto
  };

  // Add to in-memory rolling buffer for quick access/restore before DB/R2 operation
  room.addSnapshot(snapshotInMemory);

  if (db && shouldPersist) {
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
        thumbnail: thumbBytes,
        r2Key: r2Key,
        name: data.n || (isAuto ? `Auto-save ${new Date(snapshotTs).toLocaleTimeString()}` : `Snapshot ${new Date(snapshotTs).toLocaleString()}`)
      };

      await db.collection('rooms').updateOne(
        { _id: room.id },
        { $push: { snapshots: mongoDoc } }
      );
      await pruneSnapshotsForRoom(db, room);

      if (isAuto) {
        getRecorder(room.id).onCheckpoint(snapshotId);
      }

    } catch (err) {
      console.error(`[Snapshot] Failed to save snapshot ${snapshotId} for room ${room.id}:`, err);
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
  if (!canViewSnapshotHistory(ws, room)) return;
  const db = getDB();
  let dbSnapshots = [];
  const beforeTs = Number(data?.snapshotTs || 0);

  if (db) {
    try {
      const roomDoc = await db.collection('rooms').findOne(
        { _id: room.id },
        { projection: { snapshots: 1 } }
      );

      const allSnapshots = (roomDoc?.snapshots || [])
        .filter(s => !beforeTs || s.timestamp < beforeTs)
        .sort((a, b) => b.timestamp - a.timestamp);

      dbSnapshots = allSnapshots.slice(0, SNAPSHOT_LIST_PAGE_SIZE);
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
  if (!canLoadSnapshot(ws, room)) return; // Trusted+ only unless user is alone in the room

  const snapshotId = data.snapshotId;
  let snapshotData = null;

  // 1. Check in-memory buffer first for very recent/auto snapshots
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers
    };
  } else {
    // 2. Fetch from the room's embedded snapshots array and then R2
    const db = getDB();
    if (db) {
      try {
        const roomDoc = await db.collection('rooms').findOne(
          { _id: room.id, 'snapshots.snapshotId': snapshotId },
          { projection: { 'snapshots.$': 1 } }
        );
        const doc = roomDoc?.snapshots?.[0];

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
        } else {
          snapshotData = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: (doc.layers || []).map(l => l.buffer || l)
          };
        }
      } catch (err) {
        console.error(`[Snapshot] DB/R2 fetch error during restore for ${snapshotId}:`, err);
        return;
      }
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_RESTORE,
    snapshotLayers: snapshotData.layers,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer
  });

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
  if (!canViewSnapshotHistory(ws, room)) return;

  const snapshotId = data.snapshotId;
  let snapshotData = null;

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
    // 2. Fetch from the room's embedded snapshots array and then R2
    const db = getDB();
    if (db) {
      try {
        const roomDoc = await db.collection('rooms').findOne(
          { _id: room.id, 'snapshots.snapshotId': snapshotId },
          { projection: { 'snapshots.$': 1 } }
        );
        const doc = roomDoc?.snapshots?.[0];

        if (!doc) {
          console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
          return;
        }

        if (doc.r2Key) {
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
            thumb: bundle.thumbnail
          };
        } else {
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

  ws.send(room.Msg.encode(room.Msg.create({
    t: T.BOARD_SNAPSHOT_SAVE,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer,
    snapshotLayers: snapshotData.layers,
    snapshotThumb: snapshotData.thumb
  })).finish());
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

  // 1. Check in-memory buffer
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      layers: snapshotInMemory.layers
    };
  } else {
    // 2. Fetch from the room's embedded snapshots array and then R2
    const db = getDB();
    if (db) {
      try {
        const roomDoc = await db.collection('rooms').findOne(
          { _id: room.id, 'snapshots.snapshotId': snapshotId },
          { projection: { 'snapshots.$': 1 } }
        );
        const doc = roomDoc?.snapshots?.[0];

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
        } else {
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
      const roomDoc = await db.collection('rooms').findOne(
        { _id: room.id, 'snapshots.snapshotId': snapshotId },
        { projection: { 'snapshots.$': 1 } }
      );
      const doc = roomDoc?.snapshots?.[0];
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
  // Prefer in-memory snapshots that have both a thumb AND layers (auto-saves).
  for (let i = room.snapshots.length - 1; i >= 0; i--) {
    const s = room.snapshots[i];
    if (s.thumb && s.layers && s.layers.length > 0) {
      ws.send(room.Msg.encode(room.Msg.create({
        t: T.BOARD_SNAPSHOT_JOIN_NOTIFY,
        snapshotId: s.id,
        snapshotTs: s.ts,
        snapshotIssuer: s.issuer || 'Unknown',
        snapshotThumb: s.thumb
      })).finish());
      return;
    }
  }

  // Fall back to DB — find the most recent snapshot with a thumbnail
  const db = getDB();
  if (!db) return;

  try {
    const roomDoc = await db.collection('rooms').findOne(
      { _id: room.id },
      { projection: { snapshots: 1 } }
    );

    const doc = (roomDoc?.snapshots || [])
      .filter(s => s.thumbnail)
      .sort((a, b) => b.timestamp - a.timestamp)[0];

    if (!doc) return;

    ws.send(room.Msg.encode(room.Msg.create({
      t: T.BOARD_SNAPSHOT_JOIN_NOTIFY,
      snapshotId: doc.snapshotId,
      snapshotTs: doc.timestamp,
      snapshotIssuer: doc.issuer || 'Unknown',
      snapshotThumb: doc.thumbnail?.buffer || doc.thumbnail
    })).finish());
  } catch (err) {
    console.error(`[Snapshot] Failed to fetch latest snapshot for join notify in room "${room.id}":`, err);
  }
}
