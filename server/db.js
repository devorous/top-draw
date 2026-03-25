/** @fileoverview Handles MongoDB connection and index initialization. */

import 'dotenv/config';
import { MongoClient, ServerApiVersion } from 'mongodb';

const uri = process.env.MONGODB_URI;

let db = null;
let client = null;

/**
 * Connects to MongoDB Atlas and initializes the database and indexes.
 * @returns {Promise<Object>} - The connected database object.
 * @throws {Error} - If connection fails.
 */
export async function connectDB() {
  if (db) return db;

  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  });

  try {
    await client.connect();
    db = client.db("Draw"); 

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
    await db.collection('favorites').createIndex({ userId: 1, galleryId: 1 }, { unique: true });
    await db.collection('favorites').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('comments').createIndex({ galleryId: 1, createdAt: 1 });
    await db.collection('messages').createIndex({ room_id: 1, timestamp: 1 });
    await db.collection('messages').createIndex({ sender_id: 1, timestamp: -1 });
    await db.collection('messages').createIndex({ receiver_id: 1, timestamp: -1 });

    console.log('Connected to MongoDB Atlas');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
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
