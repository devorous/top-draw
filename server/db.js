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

    await safeCreateIndex('users', { username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
    await safeCreateIndex('rooms', { lastActiveAt: 1 });
    await safeCreateIndex('moderation', { active: 1, type: 1, targetIp: 1 });
    await safeCreateIndex('moderation', { active: 1, type: 1, roomId: 1, targetUserId: 1 });
    await safeCreateIndex('gallery', { createdAt: -1 });
    await safeCreateIndex('gallery', { author: 1, createdAt: -1 });
    await safeCreateIndex('gallery', { likesCount: -1 });
    await safeCreateIndex('gallery', { tags: 1, createdAt: -1 });
    await safeCreateIndex('gallery', { imageHash: 1 }, { unique: true, sparse: true });
    await safeCreateIndex('gallery_likes', { galleryId: 1, userId: 1 }, { unique: true, sparse: true });
    await safeCreateIndex('gallery_likes', { galleryId: 1, deviceId: 1 }, { unique: true, sparse: true });
    await safeCreateIndex('gallery_likes', { galleryId: 1, ipHash: 1 }, { unique: true, sparse: true });
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
