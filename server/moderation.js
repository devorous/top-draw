import { getDB } from './db.js';

/**
 * Obfuscate an IP address — show first 2 octets, replace last 2 with x.x
 * Handles IPv4, IPv6-mapped IPv4 (::ffff:x.x.x.x)
 */
export function obfuscateIp(ip) {
  if (!ip) return 'unknown';

  // Handle IPv6-mapped IPv4 (::ffff:10.0.1.2 -> 10.0.x.x)
  const v4Match = ip.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)/i);
  if (v4Match) {
    const parts = v4Match[1].split('.');
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  // IPv6 — show first 2 groups
  const v6Parts = ip.split(':');
  if (v6Parts.length > 2) {
    return `${v6Parts[0]}:${v6Parts[1]}:x:x`;
  }

  return 'unknown';
}

/**
 * Check if a user is banned (by userId or IP)
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
 * Check if a user is muted (by userId or IP)
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
 * Issue a moderation action (ban, mute)
 * @param {Object} opts
 * @param {string} opts.type - 'ban' or 'mute'
 * @param {string|null} opts.targetUserId
 * @param {string} opts.targetUsername
 * @param {string} opts.targetIp
 * @param {string} opts.reason
 * @param {string} opts.issuedBy - moderator userId
 * @param {string} opts.issuedByUsername
 * @param {number} opts.duration - minutes, 0 = permanent
 * @param {string} [opts.roomId] - room scope (optional, null = global)
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
 * Revoke a moderation action
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
 * Get all active moderation entries (for mod panel)
 * @deprecated Use getModEntries instead
 */
export async function getActiveModEntries() {
  return getModEntries({ showHistory: false, search: '' });
}

/**
 * Get moderation entries with optional history and search filtering
 * @param {Object} opts
 * @param {boolean} [opts.showHistory=false] - include revoked/expired entries
 * @param {string}  [opts.search='']         - filter by target username prefix
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
