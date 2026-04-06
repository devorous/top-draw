/** @fileoverview Handles board snapshot saving, listing, restoring, and deletion. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { authorize, Action } from './permissions.js';
import { getRecorder } from './deltaRecorder.js';

/**
 * Handles saving a board snapshot.
 * @param {WebSocket} ws - The sender's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
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
    layers: [],      // empty = blank board (client fills with bg color on restore)
    thumb: null,
    auto: true,
    initial: true,
    bgColor
  });
  getRecorder(roomId).onCheckpoint(id);
  console.log(`[Snapshot] Created initial checkpoint for room "${roomId}" (${bgColor})`);
}

export async function handleSnapshotSave(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ can save

  const db = getDB();
  const snapshot = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    issuer: ws.username || 'Unknown',
    layers: data.snapshotLayers || [],
    thumb: data.snapshotThumb || null,
    auto: !!data.a
  };

  // Add to in-memory rolling buffer
  room.addSnapshot(snapshot);

  if (db) {
    try {
      if (snapshot.auto) {
        // Ensure there's always an initial blank checkpoint before the first real one
        await maybeCreateInitialCheckpoint(
          room.id,
          room.settings.backgroundColor || '#ffffff',
          room.createdAt
        );
        // Auto snapshots are checkpoints — persist to board_snapshots and link deltas to them
        await db.collection('board_snapshots').insertOne({
          roomId: room.id,
          snapshotId: snapshot.id,
          timestamp: snapshot.ts,
          issuer: snapshot.issuer,
          layers: snapshot.layers,
          thumb: snapshot.thumb,
          auto: true
        });
        // Notify deltaRecorder so subsequent deltas are linked to this checkpoint
        getRecorder(room.id).onCheckpoint(snapshot.id);
      } else {
        // Manual saves stored separately with a name
        await db.collection('board_snapshots').insertOne({
          roomId: room.id,
          snapshotId: snapshot.id,
          timestamp: snapshot.ts,
          issuer: snapshot.issuer,
          layers: snapshot.layers,
          thumb: snapshot.thumb,
          auto: false,
          name: data.n || `Snapshot ${new Date(snapshot.ts).toLocaleString()}`
        });
      }
    } catch (err) {
      console.error('[Snapshot] DB save error:', err);
    }
  }
}

/**
 * Handles requesting the list of snapshots.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotList(ws, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ only

  console.log(`[Snapshot] List requested for room ${room.id} by ${ws.username}`);
  const db = getDB();
  let dbSnapshots = [];

  if (db) {
    try {
      dbSnapshots = await db.collection('board_snapshots')
        .find({ roomId: room.id })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();
    } catch (err) {
      console.error('[Snapshot] DB list error:', err);
    }
  }

  const list = [
    ...room.snapshots.map(s => ({
      id: s.id,
      ts: s.ts,
      issuer: s.issuer,
      auto: s.auto,
      thumb: s.thumb || null,
      name: s.auto ? `Auto-save ${new Date(s.ts).toLocaleTimeString()}` : (s.name || `Manual ${new Date(s.ts).toLocaleTimeString()}`)
    })),
    ...dbSnapshots.map(s => ({
      id: s.snapshotId,
      ts: s.timestamp,
      issuer: s.issuer,
      auto: false,
      thumb: s.thumb ? (s.thumb.buffer || s.thumb) : null,
      name: s.name || `Saved ${new Date(s.timestamp).toLocaleString()}`
    }))
  ];

  // De-dupe by ID and sort by TS
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
  let snapshot = room.snapshots.find(s => s.id === snapshotId);

  if (!snapshot) {
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });
        if (doc) {
          snapshot = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: (doc.layers || []).map(l => l.buffer || l)
          };
        }
      } catch (err) {
        console.error('[Snapshot] DB fetch error:', err);
      }
    }
  }

  if (!snapshot) {
    console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} not found`);
    return;
  }

  console.log(`[Snapshot] Restoring board in room ${room.id} to snapshot ${snapshotId} (Issuer: ${ws.username})`);

  // Broadcast restoration to everyone
  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_RESTORE,
    snapshotLayers: snapshot.layers,
    snapshotId: snapshot.id,
    snapshotTs: snapshot.ts,
    snapshotIssuer: snapshot.issuer
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
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Helper+ only

  const snapshotId = data.snapshotId;
  let snapshot = room.snapshots.find(s => s.id === snapshotId);

  if (!snapshot) {
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });
        if (doc) {
          snapshot = {
            id: doc.snapshotId,
            ts: doc.timestamp,
            issuer: doc.issuer,
            layers: (doc.layers || []).map(l => l.buffer || l),
            thumb: doc.thumb
          };
        }
      } catch (err) {
        console.error('[Snapshot] DB get error:', err);
      }
    }
  }

  if (!snapshot) {
    console.warn(`[Snapshot] Get failed: ${snapshotId} not found`);
    return;
  }

  ws.send(room.Msg.encode(room.Msg.create({
    t: T.BOARD_SNAPSHOT_SAVE,
    snapshotId: snapshot.id,
    snapshotTs: snapshot.ts,
    snapshotIssuer: snapshot.issuer,
    snapshotLayers: snapshot.layers
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
  let snapshot = room.snapshots.find(s => s.id === snapshotId);

  if (!snapshot) {
    const db = getDB();
    if (db) {
      try {
        const doc = await db.collection('board_snapshots').findOne({ roomId: room.id, snapshotId });
        if (doc) {
          snapshot = {
            id: doc.snapshotId,
            layers: (doc.layers || []).map(l => l.buffer || l)
          };
        }
      } catch (err) {
        console.error('[Snapshot] DB region-restore fetch error:', err);
      }
    }
  }

  if (!snapshot) {
    console.warn(`[Snapshot] Region restore failed: ${snapshotId} not found`);
    return;
  }

  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_REGION_RESTORE,
    snapshotId: snapshot.id,
    snapshotLayers: snapshot.layers,
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
  room.snapshots = room.snapshots.filter(s => s.id !== snapshotId);

  const db = getDB();
  if (db) {
    try {
      await db.collection('board_snapshots').deleteOne({ roomId: room.id, snapshotId });
    } catch (err) {
      console.error('[Snapshot] DB delete error:', err);
    }
  }
}
