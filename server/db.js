import 'dotenv/config';
import { MongoClient, ServerApiVersion } from 'mongodb';


const uri = process.env.MONGODB_URI

let db = null;
let client = null;

export async function connectDB() {
  if (db) return db;

  // Use the modern Stable API settings Atlas gave you
  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  });

  try {
    await client.connect();
    // You can choose your database name here
    db = client.db("Draw"); 

    await db.collection('users').createIndex(
      { username: 1 },
      { unique: true, collation: { locale: 'en', strength: 2 } }
    );
    // ... rest of your indexes ...

    console.log('Connected to MongoDB Atlas');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

export function getDB() {
  return db;
}