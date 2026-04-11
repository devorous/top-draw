import { MongoClient, ServerApiVersion } from 'mongodb';

const DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';

async function getDb() {
  if (globalThis.__feedbackDbPromise) return globalThis.__feedbackDbPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  const isSrv = uri.startsWith('mongodb+srv://');
  const client = new MongoClient(uri, isSrv ? {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  } : {});

  globalThis.__feedbackDbPromise = client.connect().then(() => client.db(DB_NAME));
  return globalThis.__feedbackDbPromise;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await readBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid request body' });

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const page = body.page === 'landing' ? 'landing' : 'app';

  if (text.length < 1 || text.length > 2000) {
    return res.status(422).json({ error: 'Feedback must be between 1 and 2000 characters.' });
  }

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error('[Feedback] DB connect error:', err);
    return res.status(503).json({ error: 'Database unavailable' });
  }

  try {
    await db.collection('feedback').insertOne({
      text,
      page,
      submittedAt: new Date(),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[Feedback] Insert error:', err);
    return res.status(500).json({ error: 'Failed to save feedback' });
  }
}
