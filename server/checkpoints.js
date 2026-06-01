/** @fileoverview Handles board checkpoint storage and retrieval for the replay system. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { Action, canPerform } from './permissions.js';
import { ENABLE_SERVER_REPLAY_DB } from './replayConfig.js';
import { getUploaderIdentity } from './uploaderIdentity.js';

const COLLECTION = 'checkpoints';
const MAX_CHECKPOINTS_PER_ROOM = 1440; // 24h at 1/min
const CHECKPOINT_INTERVAL_MIN_MS = 30_000; // Reject if < 30s since last

function snapshotActiveTexts(room, now) {
  if (!Array.isArray(room.activeTexts) || room.activeTexts.length === 0) return [];
  room.activeTexts = room.activeTexts.filter((record) => {
    const lifetimeMs = Number(record?.lifetimeMs) || 0;
    const bornAt = Number(record?.bornAt) || 0;
    return lifetimeMs > 0 && bornAt > 0 && now - bornAt < lifetimeMs;
  });
  return room.activeTexts.map((record) => ({
    id: record.id,
    sessionIndex: record.sessionIndex,
    text: record.text,
    font: record.font,
    size: record.size,
    color: record.color,
    opacity: record.opacity,
    layerIndex: record.layerIndex,
    blendMode: record.blendMode,
    blendBakeMode: record.blendBakeMode,
    textPositionMultiplier: record.textPositionMultiplier,
    textPositionOffset: record.textPositionOffset,
    x: record.x,
    y: record.y,
    bornAt: record.bornAt,
    lifetimeMs: record.lifetimeMs,
    fadeMs: record.fadeMs
  }));
}

function sendCheckpointPermissionDenied(ws, room) {
  ws.send(room.Msg.encode(room.Msg.create({
    t: T.MOD_RESULT,
    a: false,
    authError: 'Insufficient permissions'
  })).finish());
}

function ensureCheckpointReadAccess(ws, room) {
  if (canPerform(ws.userRole || 0, Action.MOD_MUTE)) {
    return true;
  }
  sendCheckpointPermissionDenied(ws, room);
  return false;
}

/**
 * Handles a full-board checkpoint upload from the dedicated replay user.
 * Stores the image in the DB and updates the room preview.
 * @param {WebSocket} ws - The sender's WebSocket.
 * @param {Object} data - Sanitized message payload (checkpointImg: Uint8Array).
 * @param {Room} room - The room instance.
 */
export async function handleCheckpointUpload(ws, data, room) {
  // Only the designated uploader may upload checkpoints.
  // Prefer the manually-set dedicated user; fall back to the auto-elected uploader.
  const dedicated = room.settings.dedicatedReplayUser || room._electedUploader;
  const senderName = getUploaderIdentity(room, ws);
  if (!dedicated || senderName !== dedicated) {
    console.warn(`[Checkpoint] Rejected upload from "${senderName}" — dedicated user is "${dedicated}"`);
    return;
  }

  if (!data.checkpointImg || data.checkpointImg.length === 0) return;

  const now = Date.now();

  // Throttle: reject if too soon after last checkpoint
  if (room._lastCheckpointTs && now - room._lastCheckpointTs < CHECKPOINT_INTERVAL_MIN_MS) {
    return;
  }

  const checkpointId = `cp_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const imgBuffer = Buffer.from(data.checkpointImg);

  // Update room preview with the checkpoint image (reuse existing preview mechanism)
  room.setPreview(imgBuffer);
  room._lastCheckpointTs = now;

  if (!ENABLE_SERVER_REPLAY_DB) {
    return null;
  }

  // Persist to DB
  const db = getDB();
  if (!db) return checkpointId;

  try {
    await db.collection(COLLECTION).insertOne({
      checkpointId,
      roomId: room.id,
      timestamp: now,
      uploader: senderName,
      img: imgBuffer,
      mirror: !!room.settings.mirror,
      mirrorRegions: room.settings.mirrorRegions || [],
      activeTexts: snapshotActiveTexts(room, now),
      sizeBytes: imgBuffer.length
    });

    // Prune old checkpoints beyond retention limit
    const count = await db.collection(COLLECTION).countDocuments({ roomId: room.id });
    if (count > MAX_CHECKPOINTS_PER_ROOM) {
      const oldest = await db.collection(COLLECTION)
        .find({ roomId: room.id })
        .sort({ timestamp: 1 })
        .limit(count - MAX_CHECKPOINTS_PER_ROOM)
        .project({ _id: 1 })
        .toArray();
      if (oldest.length > 0) {
        await db.collection(COLLECTION).deleteMany({
          _id: { $in: oldest.map(d => d._id) }
        });
      }
    }
  } catch (err) {
    console.error('[Checkpoint] DB save error:', err);
  }

  return checkpointId;
}

/**
 * Returns a list of checkpoint metadata for a room (no image data).
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Room} room - The room instance.
 */
export async function handleCheckpointList(ws, room) {
  if (!ensureCheckpointReadAccess(ws, room)) return;

  if (!ENABLE_SERVER_REPLAY_DB) {
    ws.send(room.Msg.encode(room.Msg.create({
      t: T.CHECKPOINT_LIST_RESPONSE,
      checkpointList: []
    })).finish());
    return;
  }

  const db = getDB();
  if (!db) {
    ws.send(room.Msg.encode(room.Msg.create({
      t: T.CHECKPOINT_LIST_RESPONSE,
      checkpointList: []
    })).finish());
    return;
  }

  try {
    const docs = await db.collection(COLLECTION)
      .find({ roomId: room.id })
      .sort({ timestamp: -1 })
      .limit(100)
      .project({ checkpointId: 1, timestamp: 1, uploader: 1, sizeBytes: 1 })
      .toArray();

    ws.send(room.Msg.encode(room.Msg.create({
      t: T.CHECKPOINT_LIST_RESPONSE,
      checkpointList: docs.map(d => ({
        id: d.checkpointId,
        ts: d.timestamp,
        uploader: d.uploader,
        sizeBytes: d.sizeBytes || 0
      }))
    })).finish());
  } catch (err) {
    console.error('[Checkpoint] DB list error:', err);
  }
}

/**
 * Sends a specific checkpoint image back to the requester.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - { checkpointId: string }
 * @param {Room} room - The room instance.
 */
export async function handleCheckpointGet(ws, data, room) {
  if (!ensureCheckpointReadAccess(ws, room)) return;

  if (!ENABLE_SERVER_REPLAY_DB) return;

  const db = getDB();
  if (!db) return;

  try {
    const doc = await db.collection(COLLECTION).findOne({
      roomId: room.id,
      checkpointId: data.checkpointId
    });

    if (!doc) return;

    ws.send(room.Msg.encode(room.Msg.create({
      t: T.CHECKPOINT_UPLOAD, // Reuse same type for the response payload
      checkpointImg: doc.img,
      checkpointId: doc.checkpointId,
      checkpointTs: doc.timestamp,
      checkpointUploader: doc.uploader,
      m: !!doc.mirror,
      mirrorRegionsJson: JSON.stringify(doc.mirrorRegions || [])
    })).finish());
  } catch (err) {
    console.error('[Checkpoint] DB get error:', err);
  }
}
