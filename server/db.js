import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Connect to MongoDB Atlas and set up indexes.
 * Reads MONGODB_URI from environment variables.
 */
export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[DB] MONGODB_URI not set — database features disabled');
    return null;
  }

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(); // uses DB name from the URI

    await createIndexes();

    console.log('[DB] Connected to MongoDB Atlas');
    return db;
  } catch (err) {
    console.error('[DB] Failed to connect to MongoDB:', err.message);
    throw err;
  }
}

/**
 * Create collection indexes for users and moderation.
 */
async function createIndexes() {
  const users = db.collection('users');
  const moderation = db.collection('moderation');

  // Unique case-insensitive username index
  await users.createIndex(
    { username: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } }
  );

  // IP history index for ban matching
  await users.createIndex({ ipHistory: 1 });

  // Moderation indexes
  await moderation.createIndex({ targetIp: 1 });
  await moderation.createIndex({ targetUserId: 1 });
  await moderation.createIndex({ type: 1, active: 1 });

  // TTL index to auto-remove expired moderation entries
  await moderation.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } }
  );
}

/**
 * Get the database instance.
 * Returns null if not connected.
 */
export function getDB() {
  return db;
}

/**
 * Check if the database is connected.
 */
export function isDBConnected() {
  return db !== null;
}

/**
 * Close the database connection.
 */
export async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[DB] Connection closed');
  }
}
