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

    await db.collection('users').createIndex(
      { username: 1 },
      { unique: true, collation: { locale: 'en', strength: 2 } }
    );
    await db.collection('rooms').createIndex({ lastActiveAt: 1 });
    await db.collection('moderation').createIndex({ active: 1, type: 1, targetIp: 1 });
    await db.collection('moderation').createIndex({ active: 1, type: 1, roomId: 1, targetUserId: 1 });
    await db.collection('room_roles').createIndex(
      { roomId: 1, userId: 1 },
      { unique: true }
    );
    await db.collection('gallery').createIndex({ createdAt: -1 });
    await db.collection('gallery').createIndex({ author: 1, createdAt: -1 });
    await db.collection('gallery').createIndex({ likes: -1 });
    await db.collection('gallery').createIndex({ tags: 1, createdAt: -1 });
    await db.collection('gallery').createIndex({ imageHash: 1 }, { unique: true, sparse: true });
    await db.collection('favorites').createIndex({ userId: 1, galleryId: 1 }, { unique: true });
    await db.collection('favorites').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('comments').createIndex({ galleryId: 1, createdAt: 1 });
    await db.collection('comments').createIndex({ createdAt: -1 });
    await db.collection('messages').createIndex({ room_id: 1, timestamp: 1 });
    await db.collection('messages').createIndex({ sender_id: 1, timestamp: -1 });
    await db.collection('messages').createIndex({ receiver_id: 1, timestamp: -1 });

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
