/** @fileoverview Provides utilities for moderation actions, including IP obfuscation, ban/mute checks, and logging. */

import { getDB } from './db.js';

/**
 * Obfuscates an IP address by showing only the first two octets or groups.
 * @param {string} ip - The IP address to obfuscate.
 * @returns {string} - The obfuscated IP address.
 */
export function obfuscateIp(ip) {
  if (!ip) return 'unknown';

  const v4Match = ip.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)/i);
  if (v4Match) {
    const parts = v4Match[1].split('.');
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  const v6Parts = ip.split(':');
  if (v6Parts.length > 2) {
    return `${v6Parts[0]}:${v6Parts[1]}:x:x`;
  }

  return 'unknown';
}

/**
 * Checks if a user is currently banned.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The ban entry if active, otherwise null.
 */
export async function checkBan(userId, ip) {
  const db = getDB();
  if (!db) return null;

  const conditions = [];
  if (userId) conditions.push({ targetUserId: userId });
  if (ip) conditions.push({ targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'ban',
    active: true,
    $or: conditions
  });
}

/**
 * Checks if a user is currently muted.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The mute entry if active, otherwise null.
 */
export async function checkMute(userId, ip) {
  const db = getDB();
  if (!db) return null;

  const conditions = [];
  if (userId) conditions.push({ targetUserId: userId });
  if (ip) conditions.push({ targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'mute',
    active: true,
    $or: conditions
  });
}

/**
 * Records a new moderation action in the database.
 * @param {Object} opts - Action options.
 * @param {string} opts.type - The type of action ('ban' or 'mute').
 * @param {string|null} opts.targetUserId - The ID of the target user.
 * @param {string} opts.targetUsername - The username of the target user.
 * @param {string} opts.targetIp - The IP of the target user.
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
 * Retrieves moderation entries with optional history and search filters.
 * @param {Object} [opts] - Filter options.
 * @param {boolean} [opts.showHistory=false] - Whether to include inactive entries.
 * @param {string} [opts.search=''] - A prefix to filter target usernames by.
 * @returns {Promise<Array<Object>>} - A list of moderation entries.
 */
export async function getModEntries({ showHistory = false, search = '' } = {}) {
  const db = getDB();
  if (!db) return [];

  const query = {};
  if (!showHistory) {
    query.active = true;
  }
  if (search) {
    query.targetUsername = { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
  }

  const entries = await db.collection('moderation')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return entries.map(e => ({
    id: e._id.toString(),
    type: e.type === 'ban' ? 0 : 1,
    username: e.targetUsername || '',
    reason: e.reason || '',
    ip: obfuscateIp(e.targetIp),
    issuedBy: e.issuedByUsername || '',
    createdAt: e.createdAt ? e.createdAt.getTime() : 0,
    expiresAt: e.expiresAt ? e.expiresAt.getTime() : 0,
    active: e.active
  }));
}
