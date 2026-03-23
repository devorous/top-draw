/**
 * Per-room role assignment CRUD and effective-role computation.
 *
 * Room roles are stored in the `room_roles` collection with a compound
 * unique index on (roomId, userId).  Global roles live on the user doc;
 * the effective role in a room is max(globalRole, roomRole).
 */

import { getDB } from './db.js';

/**
 * Get a user's room-specific role document.
 * @param {string} roomId
 * @param {string} userId
 * @returns {Promise<{role: number}|null>}
 */
export async function getRoomRole(roomId, userId) {
  const db = getDB();
  if (!db || !roomId || !userId) return null;
  return db.collection('room_roles').findOne({ roomId, userId });
}

/**
 * Set (upsert) a user's room-specific role.
 * @param {string} roomId
 * @param {string} userId
 * @param {number} role - 0-6 (room-scoped tiers, including OWNER)
 * @param {string} assignedBy - userId of the assigner
 */
export async function setRoomRole(roomId, userId, role, assignedBy) {
  const db = getDB();
  if (!db) return null;
  return db.collection('room_roles').updateOne(
    { roomId, userId },
    { $set: { role, assignedBy, assignedAt: new Date() } },
    { upsert: true }
  );
}

/**
 * Remove a user's room-specific role.
 * @param {string} roomId
 * @param {string} userId
 */
export async function removeRoomRole(roomId, userId) {
  const db = getDB();
  if (!db) return null;
  return db.collection('room_roles').deleteOne({ roomId, userId });
}

/**
 * Get all room role assignments for a room.
 * @param {string} roomId
 * @returns {Promise<Array<{userId: string, role: number, assignedBy: string, assignedAt: Date}>>}
 */
export async function getRoomRoles(roomId) {
  const db = getDB();
  if (!db) return [];
  return db.collection('room_roles').find({ roomId }).toArray();
}

/**
 * Compute the effective role for a user in a room.
 * Global role sets a floor; room role can only raise it, never lower.
 * @param {number} globalRole - 0-8
 * @param {number} roomRole   - 0-5 (or 0 if none)
 * @returns {number}
 */
export function computeEffectiveRole(globalRole, roomRole) {
  return Math.max(globalRole || 0, roomRole || 0);
}
