/** @fileoverview Handles MongoDB connection and index initialization. */

import 'dotenv/config';
import { MongoClient, ServerApiVersion } from 'mongodb';

const DEFAULT_LOCAL_URI = 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';

let db = null;
let client = null;

/**
 * Connects to MongoDB Atlas and initializes the database and indexes.
 * @returns {Promise<Object>} - The connected database object.
 * @throws {Error} - If connection fails.
 */
export async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI || DEFAULT_LOCAL_URI;
  const isSrvUri = uri.startsWith('mongodb+srv://');
  const clientOptions = isSrvUri ? {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  } : {};

  client = new MongoClient(uri, clientOptions);

  try {
    await client.connect();
    db = client.db(DB_NAME);

    // Helper to safely create indexes, ignoring duplicate key errors
    async function safeCreateIndex(collection, key, opts = {}) {
      try {
        await db.collection(collection).createIndex(key, opts);
      } catch (err) {
        if (err.code === 11000 || err.code === 11001) {
          console.warn(`  [Index] Skipping ${collection}.${JSON.stringify(key)} — duplicate key exists (will be cleaned up)`);
        } else {
          throw err;
        }
      }
    }

    async function ensureGalleryLikesPartialIndex(key, fieldName) {
      const collection = db.collection('gallery_likes');
      const indexName = `galleryId_1_${fieldName}_1`;
      const partialFilterExpression = { [fieldName]: { $exists: true, $type: 'string' } };

      const indexes = await collection.listIndexes().toArray();
      const existing = indexes.find(index => index.name === indexName);
      const existingPartial = JSON.stringify(existing?.partialFilterExpression || {});
      const expectedPartial = JSON.stringify(partialFilterExpression);

      if (existing && existingPartial !== expectedPartial) {
        await collection.dropIndex(indexName);
      }

      await safeCreateIndex('gallery_likes', key, {
        unique: true,
        name: indexName,
        partialFilterExpression
      });
    }

    await safeCreateIndex('users', { username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
    await safeCreateIndex('users', { email: 1 }, { sparse: true, collation: { locale: 'en', strength: 2 } });
    await safeCreateIndex('users', { 'discord.id': 1 }, { unique: true, sparse: true });
    await safeCreateIndex('discord_oauth_states', { stateHash: 1 }, { unique: true });
    await safeCreateIndex('discord_oauth_states', { expiresAt: 1 }, { expireAfterSeconds: 0 });
    await safeCreateIndex('discord_release_posts', { version: 1 }, { unique: true });
    await safeCreateIndex('rooms', { lastActiveAt: 1 });
    await safeCreateIndex('room_snapshots', { roomId: 1, timestamp: -1 });
    await safeCreateIndex('room_snapshots', { snapshotId: 1 }, { unique: true });
    await safeCreateIndex('moderation', { active: 1, type: 1, targetIp: 1 });
    await safeCreateIndex('moderation', { active: 1, type: 1, targetIpKeys: 1 });
    await safeCreateIndex('moderation', { active: 1, type: 1, roomId: 1, targetUserId: 1 });
    await safeCreateIndex('gallery', { createdAt: -1 });
    await safeCreateIndex('gallery', { author: 1, createdAt: -1 });
    await safeCreateIndex('gallery', { likesCount: -1 });
    await safeCreateIndex('gallery', { tags: 1, createdAt: -1 });
    await safeCreateIndex('gallery', { imageHash: 1 }, { unique: true, sparse: true });
    await ensureGalleryLikesPartialIndex({ galleryId: 1, userId: 1 }, 'userId');
    await ensureGalleryLikesPartialIndex({ galleryId: 1, deviceId: 1 }, 'deviceId');
    await ensureGalleryLikesPartialIndex({ galleryId: 1, ipHash: 1 }, 'ipHash');
    await safeCreateIndex('gallery_likes', { galleryId: 1, createdAt: -1 });
    await safeCreateIndex('favorites', { userId: 1, galleryId: 1 }, { unique: true });
    await safeCreateIndex('favorites', { userId: 1, createdAt: -1 });
    await safeCreateIndex('comments', { galleryId: 1, createdAt: 1 });
    await safeCreateIndex('comments', { createdAt: -1 });
    await safeCreateIndex('messages', { room_id: 1, timestamp: 1 });
    await safeCreateIndex('messages', { sender_id: 1, timestamp: -1 });
    await safeCreateIndex('messages', { receiver_id: 1, timestamp: -1 });
    await safeCreateIndex('feedback', { submittedAt: -1 });
    await safeCreateIndex('connection_events', { createdAt: -1 });
    await safeCreateIndex('connection_events', { deviceId: 1, createdAt: -1 });
    await safeCreateIndex('connection_events', { fingerprintId: 1, createdAt: -1 });
    await safeCreateIndex('connection_events', { userId: 1, createdAt: -1 });
    await safeCreateIndex('password_reset_tokens', { tokenHash: 1 }, { unique: true });
    await safeCreateIndex('password_reset_tokens', { userId: 1, createdAt: -1 });
    await safeCreateIndex('password_reset_tokens', { expiresAt: 1 }, { expireAfterSeconds: 0 });

    // Sync parity debug events — 30-day TTL, indexed for mod-panel filtering
    await safeCreateIndex('debug.parity_events', { ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
    await safeCreateIndex('debug.parity_events', { roomId: 1, ts: -1 });
    await safeCreateIndex('debug.parity_events', { roomId: 1, sessionIndex: 1, resolved: 1 });
    await safeCreateIndex('debug.parity_events', { username: 1, ts: -1 }, { sparse: true });

    console.log(`[DB] Connected to MongoDB: ${uri} (${DB_NAME})`);
    return db;
  } catch (error) {
    console.error(`[DB] Failed to connect to MongoDB at ${uri}:`, error);
    throw error;
  }
}

/**
 * Returns the current database instance.
 * @returns {Object|null} - The database object or null if not connected.
 */
export function getDB() {
  return db;
}

/**
 * Returns a database handle for the connected Mongo client.
 * @param {string} name
 * @returns {import('mongodb').Db|null}
 */
export function getMongoDatabase(name) {
  if (!client || !name) return null;
  return client.db(name);
}

/**
 * Sync parity event collection — mongo-optional like the rest of the DB layer.
 * @returns {import('mongodb').Collection|null}
 */
export function getParityEventsCollection() {
  return db ? db.collection('debug.parity_events') : null;
}

/**
 * Updates user metrics (both lifetime totals and daily accumulations).
 * @param {string} userId - The user's MongoDB ObjectId as a string.
 * @param {Object} metrics - Metrics to increment.
 * @param {number} [metrics.distanceDrawn] - Distance in pixels.
 * @param {number} [metrics.strokes] - Number of strokes.
 * @param {number} [metrics.timeSpentMs] - Time in milliseconds.
 * @param {number} [metrics.chatMessages] - Number of chat messages.
 * @param {string[]} [metrics.toolsUsed] - Array of tool names used.
 * @returns {Promise<void>}
 */
export async function updateUserMetrics(userId, metrics) {
  if (!db) return;

  const { ObjectId } = await import('mongodb');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format

  const lifetimeIncrements = {};
  const dailyIncrements = {};

  if (metrics.distanceDrawn) {
    lifetimeIncrements.distanceDrawn = metrics.distanceDrawn;
    dailyIncrements['dailyMetrics.$.distanceDrawn'] = metrics.distanceDrawn;
  }
  if (metrics.strokes) {
    lifetimeIncrements.totalStrokes = metrics.strokes;
    dailyIncrements['dailyMetrics.$.strokes'] = metrics.strokes;
  }
  if (metrics.timeSpentMs) {
    lifetimeIncrements.timeSpentMs = metrics.timeSpentMs;
    dailyIncrements['dailyMetrics.$.timeSpentMs'] = metrics.timeSpentMs;
  }
  if (metrics.chatMessages) {
    lifetimeIncrements.chatMessagesSent = metrics.chatMessages;
    dailyIncrements['dailyMetrics.$.chatMessages'] = metrics.chatMessages;
  }

  const updates = { $inc: lifetimeIncrements };

  // Add unique tools to lifetime set
  if (metrics.toolsUsed && metrics.toolsUsed.length > 0) {
    updates.$addToSet = {
      uniqueToolsUsed: { $each: metrics.toolsUsed }
    };
  }

  // Update lifetime metrics
  await db.collection('users').updateOne(
    { _id: new ObjectId(userId) },
    updates
  );

  // Check if today's entry exists
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(userId), 'dailyMetrics.date': todayStr },
    { projection: { _id: 1 } }
  );

  if (user) {
    // Today's entry exists - update it with positional operator
    const dailyUpdate = { $inc: dailyIncrements };
    if (metrics.toolsUsed && metrics.toolsUsed.length > 0) {
      dailyUpdate.$addToSet = { 'dailyMetrics.$.toolsUsed': { $each: metrics.toolsUsed } };
    }

    await db.collection('users').updateOne(
      { _id: new ObjectId(userId), 'dailyMetrics.date': todayStr },
      dailyUpdate
    );
  } else {
    // Today's entry doesn't exist - create it
    await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $push: {
          dailyMetrics: {
            $each: [{
              date: todayStr,
              distanceDrawn: metrics.distanceDrawn || 0,
              strokes: metrics.strokes || 0,
              timeSpentMs: metrics.timeSpentMs || 0,
              chatMessages: metrics.chatMessages || 0,
              toolsUsed: metrics.toolsUsed || []
            }],
            $position: 0, // Add to beginning (most recent first)
            $slice: 365   // Keep only last 365 days
          }
        }
      }
    );
  }
}

/**
 * Updates the consecutive days drawn streak for a user.
 * Should be called on any drawing activity (stroke, chat, etc.).
 * @param {string} userId - The user's MongoDB ObjectId as a string.
 * @returns {Promise<void>}
 */
export async function updateConsecutiveDays(userId) {
  if (!db) return;

  const { ObjectId } = await import('mongodb');
  const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  if (!user) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;

  if (lastActive) {
    lastActive.setHours(0, 0, 0, 0);
    const daysDiff = Math.floor((today - lastActive) / (1000 * 60 * 60 * 24));

    if (daysDiff === 0) {
      // Same day, no change needed (but update lastActiveDate timestamp)
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { lastActiveDate: new Date() } }
      );
    } else if (daysDiff === 1) {
      // Yesterday, continue streak
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        {
          $inc: { consecutiveDaysDrawn: 1 },
          $set: { lastActiveDate: new Date() }
        }
      );
    } else {
      // Gap > 1 day, reset streak to 1
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            consecutiveDaysDrawn: 1,
            lastActiveDate: new Date()
          }
        }
      );
    }
  } else {
    // First time tracking, initialize
    await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          consecutiveDaysDrawn: 1,
          lastActiveDate: new Date(),
          firstActivityDate: new Date()
        }
      }
    );
  }
}
