/**
 * Per-room role assignment CRUD and effective-role computation.
 *
 * Room roles are stored as an embedded `roles` array within each room document.
 * Global roles live on the user doc; effective role in a room is max(globalRole, roomRole).
 */

import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { Role } from './SessionManager.js';

/**
 * Get a user's room-specific role document.
 * @param {string} roomId
 * @param {string} userId
 * @returns {Promise<{role: number}|null>}
 */
export async function getRoomRole(roomId, userId) {
  const db = getDB();
  if (!db || !roomId || !userId) return null;
  const room = await db.collection('rooms').findOne(
    { _id: roomId, 'roles.userId': userId },
    { projection: { 'roles.$': 1 } }
  );
  return room?.roles?.[0] || null;
}

/**
 * Set (upsert) a user's room-specific role.
 * @param {string} roomId
 * @param {string} userId
 * @param {number} role - 0-6 (room-scoped tiers, including OWNER)
 * @param {string} assignedBy - userId of the assigner
 */
export async function setRoomRole(roomId, { userId, username = '', role, assignedBy, assignedByUsername = '', previousRole = 0 }) {
  const db = getDB();
  if (!db) return null;
  const assignedAt = new Date();
  const changeType = role > previousRole ? 'promoted' : role < previousRole ? 'demoted' : 'assigned';
  const roleDoc = { userId, username, role, assignedBy, assignedByUsername, assignedAt, previousRole, changeType };

  // Remove any existing entry for this user, then push the new one.
  await db.collection('rooms').updateOne({ _id: roomId }, { $pull: { roles: { userId } } });
  return db.collection('rooms').updateOne({ _id: roomId }, { $push: { roles: roleDoc } });
}

/**
 * Remove a user's room-specific role.
 * @param {string} roomId
 * @param {string} userId
 */
export async function removeRoomRole(roomId, userId) {
  const db = getDB();
  if (!db) return null;
  return db.collection('rooms').updateOne({ _id: roomId }, { $pull: { roles: { userId } } });
}

/**
 * Get all room role assignments for a room.
 * @param {string} roomId
 * @returns {Promise<Array<{userId: string, role: number, assignedBy: string, assignedAt: Date}>>}
 */
export async function getRoomRoles(roomId) {
  const db = getDB();
  if (!db) return [];
  const room = await db.collection('rooms').findOne({ _id: roomId }, { projection: { roles: 1 } });
  return room?.roles || [];
}

/**
 * Returns moderation roster entries for the room, including the synthetic owner row.
 * @param {Object} room
 * @returns {Promise<Array<Object>>}
 */
export async function getRoomRoleRoster(room) {
  const db = getDB();
  if (!db || !room?.id) return [];

  const roomDoc = await db.collection('rooms').findOne({ _id: room.id }, { projection: { roles: 1 } });
  const docs = (roomDoc?.roles || [])
    .filter(r => r.role >= Role.TRUSTED)
    .sort((a, b) =>
      (b.role - a.role) ||
      ((b.assignedAt instanceof Date ? b.assignedAt.getTime() : 0) - (a.assignedAt instanceof Date ? a.assignedAt.getTime() : 0)) ||
      (a.username || '').localeCompare(b.username || '')
    );

  const userIdsToHydrate = [];
  const assignerIdsToHydrate = [];
  for (const doc of docs) {
    if (!doc.username && doc.userId) userIdsToHydrate.push(doc.userId);
    if (!doc.assignedByUsername && doc.assignedBy) assignerIdsToHydrate.push(doc.assignedBy);
  }

  const ids = [...new Set([...userIdsToHydrate, ...assignerIdsToHydrate])]
    .filter(id => ObjectId.isValid(id))
    .map(id => new ObjectId(id));
  const usernamesById = new Map();
  if (ids.length > 0) {
    const users = await db.collection('users')
      .find({ _id: { $in: ids } }, { projection: { username: 1 } })
      .toArray();
    for (const user of users) {
      usernamesById.set(user._id.toString(), user.username || '');
    }
  }

  const roster = docs
    .filter(doc => doc.userId !== room.ownerId)
    .map(doc => ({
      userId: doc.userId,
      username: doc.username || usernamesById.get(doc.userId) || 'Unknown user',
      role: doc.role || 0,
      updatedBy: doc.assignedBy || '',
      updatedByUsername: doc.assignedByUsername || usernamesById.get(doc.assignedBy) || '',
      updatedAt: doc.assignedAt instanceof Date ? doc.assignedAt.getTime() : 0,
      previousRole: doc.previousRole || 0,
      changeType: doc.changeType || 'assigned',
      isOwner: false
    }));

  if (room.ownerId) {
    roster.unshift({
      userId: room.ownerId,
      username: room.ownerUsername || usernamesById.get(room.ownerId) || 'Room owner',
      role: Role.OWNER,
      updatedBy: room.ownerId,
      updatedByUsername: room.ownerUsername || usernamesById.get(room.ownerId) || 'Room owner',
      updatedAt: Number(room.createdAt || 0),
      previousRole: 0,
      changeType: 'owner',
      isOwner: true
    });
  }

  return roster;
}

/**
 * Compute the effective role for a user in a room.
 * Global role sets a floor; room role can only raise it, never lower.
 * @param {number} globalRole - 0-9
 * @param {number} roomRole   - 0-5 (or 0 if none)
 * @returns {number}
 */
export function computeEffectiveRole(globalRole, roomRole) {
  return Math.max(globalRole || 0, roomRole || 0);
}
