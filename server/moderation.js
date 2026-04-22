/** @fileoverview Provides utilities for moderation actions, including IP obfuscation, ban/mute checks, and logging. */

import { getDB } from './db.js';
import { obfuscateIp as obfuscateIpFromIdentity } from './ipIdentity.js';

function buildTargetConditions({
  targetUserId = null,
  targetIp = null,
  targetUsername = null,
  targetDeviceId = null,
  targetFingerprintId = null
} = {}) {
  const conditions = [];
  if (targetUserId) conditions.push({ targetUserId });
  if (targetIp) conditions.push({ targetIp });
  if (targetUsername) conditions.push({ targetUsername });
  if (targetDeviceId) conditions.push({ targetDeviceId });
  if (targetFingerprintId) conditions.push({ targetFingerprintId });
  return conditions;
}

function buildRoomCondition(roomId = null) {
  return roomId
    ? { $or: [{ roomId }, { roomId: null }] }
    : { roomId: null };
}

/**
 * Obfuscates an IP address for display to moderators.
 * Uses the IP identity system to ensure consistent obfuscation.
 *
 * For IPv4: shows first 3 octets, masks last (e.g., "203.0.113.x")
 * For IPv6: shows the /64 network (e.g., "2001:db8:abcd:1200::/64")
 *
 * @param {string} ip - The IP address to obfuscate.
 * @returns {string} - The obfuscated IP address.
 */
export function obfuscateIp(ip) {
  return obfuscateIpFromIdentity(ip);
}

/**
 * Checks if a user is currently banned.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The ban entry if active, otherwise null.
 */
/**
 * @param {string|null} userId
 * @param {string|null} ip
 * @param {string|null} [roomId] - When set, matches room-scoped OR global bans.
 *                                  When null/omitted, matches only global bans.
 */
export async function checkBan(userId, ip, roomId = null) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({ targetUserId: userId, targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'ban',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * Checks if a user is currently muted.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The mute entry if active, otherwise null.
 */
/**
 * @param {string|null} userId
 * @param {string|null} ip
 * @param {string|null} [roomId] - When set, matches room-scoped OR global mutes.
 */
export async function checkMute(userId, ip, roomId = null) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({ targetUserId: userId, targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'mute',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * @param {Object} opts
 * @param {string|null} [opts.userId]
 * @param {string|null} [opts.ip]
 * @param {string|null} [opts.deviceId]
 * @param {string|null} [opts.fingerprintId]
 * @param {string|null} [opts.roomId]
 * @returns {Promise<Object|null>}
 */
export async function checkShadowBan({
  userId = null,
  ip = null,
  deviceId = null,
  fingerprintId = null,
  roomId = null
} = {}) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({
    targetUserId: userId,
    targetIp: ip,
    targetDeviceId: deviceId,
    targetFingerprintId: fingerprintId
  });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'shadowban',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * Records a new moderation action in the database.
 * @param {Object} opts - Action options.
 * @param {string} opts.type - The type of action ('ban' or 'mute').
 * @param {string|null} opts.targetUserId - The ID of the target user.
 * @param {string} opts.targetUsername - The username of the target user.
 * @param {string} opts.targetIp - The IP of the target user.
 * @param {string|null} [opts.targetDeviceId] - The device ID of the target user.
 * @param {string|null} [opts.targetFingerprintId] - The fingerprint ID of the target user.
 * @param {string} opts.reason - The reason for the action.
 * @param {string} opts.issuedBy - The ID of the moderator who issued the action.
 * @param {string} opts.issuedByUsername - The username of the moderator.
 * @param {number} opts.duration - Duration in minutes (0 for permanent).
 * @param {string} [opts.roomId] - Optional room ID to scope the action.
 * @returns {Promise<Object|null>} - The created moderation entry.
 */
export async function issueModAction(opts) {
  const db = getDB();
  if (!db) return null;

  const now = new Date();
  const expiresAt = opts.duration > 0
    ? new Date(now.getTime() + opts.duration * 60 * 1000)
    : null;

  const entry = {
    type: opts.type,
    targetUserId: opts.targetUserId || null,
    targetUsername: opts.targetUsername,
    targetIp: opts.targetIp || null,
    targetDeviceId: opts.targetDeviceId || null,
    targetFingerprintId: opts.targetFingerprintId || null,
    reason: opts.reason || '',
    issuedBy: opts.issuedBy,
    issuedByUsername: opts.issuedByUsername,
    roomId: opts.roomId || null,
    createdAt: now,
    expiresAt,
    duration: opts.duration || 0,
    active: true,
    revokedAt: null,
    revokedBy: null
  };

  const result = await db.collection('moderation').insertOne(entry);
  return { ...entry, _id: result.insertedId };
}

/**
 * Updates the reason on the most recent active mute or ban entry for a user.
 * @param {string|null} targetUserId
 * @param {string|null} targetIp
 * @param {'mute'|'ban'} type
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function updateModActionReason(targetUserId, targetIp, type, reason) {
  const db = getDB();
  if (!db) return false;

  const conditions = [];
  if (targetUserId) conditions.push({ targetUserId });
  if (targetIp) conditions.push({ targetIp });
  if (conditions.length === 0) return false;

  const result = await db.collection('moderation').findOneAndUpdate(
    { type, active: true, $or: conditions },
    { $set: { reason } },
    { sort: { createdAt: -1 } }
  );
  return !!result;
}

/**
 * Revokes an existing moderation action.
 * @param {string} actionId - The ID of the moderation action to revoke.
 * @param {string} revokedById - The ID of the moderator revoking the action.
 * @returns {Promise<boolean>} - True if the action was successfully revoked.
 */
export async function revokeModAction(actionId, revokedById) {
  const db = getDB();
  if (!db) return false;

  const { ObjectId } = await import('mongodb');
  const result = await db.collection('moderation').updateOne(
    { _id: new ObjectId(actionId) },
    { $set: { active: false, revokedAt: new Date(), revokedBy: revokedById } }
  );

  return result.modifiedCount > 0;
}

/**
 * Revokes all active moderation actions matching the provided target filters.
 * @param {Object} opts
 * @param {'mute'|'ban'} opts.type
 * @param {string|null} [opts.targetUserId]
 * @param {string|null} [opts.targetIp]
 * @param {string|null} [opts.targetUsername]
 * @param {string|null} [opts.targetDeviceId]
 * @param {string|null} [opts.targetFingerprintId]
 * @param {string|null} [opts.roomId]
 * @param {string|null} [opts.revokedById]
 * @returns {Promise<number>} - Number of actions revoked.
 */
export async function revokeMatchingModActions({
  type,
  targetUserId = null,
  targetIp = null,
  targetUsername = null,
  targetDeviceId = null,
  targetFingerprintId = null,
  roomId = null,
  revokedById = null
}) {
  const db = getDB();
  if (!db) return 0;

  const conditions = buildTargetConditions({
    targetUserId,
    targetIp,
    targetUsername,
    targetDeviceId,
    targetFingerprintId
  });
  if (conditions.length === 0) return 0;

  const result = await db.collection('moderation').updateMany(
    {
      type,
      active: true,
      $and: [
        { $or: conditions },
        buildRoomCondition(roomId)
      ]
    },
    {
      $set: {
        active: false,
        revokedAt: new Date(),
        revokedBy: revokedById
      }
    }
  );

  return result.modifiedCount || 0;
}

/**
 * Retrieves moderation entries with optional history and search filters.
 * @param {Object} [opts] - Filter options.
 * @param {boolean} [opts.showHistory=false] - Whether to include inactive entries.
 * @param {string} [opts.search=''] - A prefix to filter target usernames by.
 * @returns {Promise<Array<Object>>} - A list of moderation entries.
 */
/**
 * @param {Object} [opts]
 * @param {boolean} [opts.showHistory=false]
 * @param {string}  [opts.search='']
 * @param {string|null} [opts.roomId=null] - Filter to this room + global entries.
 */
export async function getModEntries({ showHistory = false, search = '', roomId = null } = {}) {
  const db = getDB();
  if (!db) return [];

  const query = {};
  if (!showHistory) {
    query.active = true;
  }
  if (search) {
    query.targetUsername = { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
  }
  if (roomId) {
    query.$or = [{ roomId }, { roomId: null }];
  }

  const entries = await db.collection('moderation')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return entries.map(e => ({
    id: e._id.toString(),
    type: e.type === 'ban' ? 0 : e.type === 'mute' ? 1 : 2,
    username: e.targetUsername || '',
    reason: e.reason || '',
    ip: obfuscateIp(e.targetIp),
    issuedBy: e.issuedByUsername || '',
    createdAt: e.createdAt ? e.createdAt.getTime() : 0,
    expiresAt: e.expiresAt ? e.expiresAt.getTime() : 0,
    active: e.active,
    roomId: e.roomId || null
  }));
}
