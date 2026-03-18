/** @fileoverview Gallery API handlers — upload to R2, store metadata in MongoDB. */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { getDB } from './db.js';
import { verifyToken } from './auth.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const r2 = process.env.R2_ENDPOINT
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
    })
  : null;

const BUCKET = process.env.R2_BUCKET_NAME || 'gallery';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://gallery.ddraw.ca').replace(/\/$/, '');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES + 65536) {
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * GET /api/gallery — list gallery items, newest first.
 */
export async function handleGalleryList(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  try {
    const [items, total] = await Promise.all([
      db.collection('gallery').find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection('gallery').countDocuments(),
    ]);

    json(res, 200, {
      items: items.map(item => ({
        id: item._id.toString(),
        url: item.url,
        author: item.author,
        title: item.title || '',
        likes: item.likes || 0,
        views: item.views || 0,
        createdAt: item.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Gallery] List error:', err);
    json(res, 500, { error: 'Failed to fetch gallery' });
  }
}

/**
 * POST /api/gallery/upload — upload canvas to R2 and save metadata.
 * Requires Authorization: Bearer <token>
 * Body: { imageData: "data:image/png;base64,...", title?: string }
 */
export async function handleGalleryUpload(req, res) {
  // Auth
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Authentication required' });
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 401, { error: 'Invalid or expired token' });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!r2) return json(res, 503, { error: 'Storage not configured — set R2_ENDPOINT env var' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const { imageData, title } = body;
  if (!imageData || !imageData.startsWith('data:image/')) {
    return json(res, 400, { error: 'Missing or invalid imageData' });
  }

  // Decode base64
  const commaIdx = imageData.indexOf(',');
  const header = imageData.slice(0, commaIdx);
  const b64 = imageData.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const buffer = Buffer.from(b64, 'base64');

  if (buffer.length > MAX_IMAGE_BYTES) {
    return json(res, 400, { error: 'Image too large (max 10 MB)' });
  }

  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const filename = `${crypto.randomUUID()}.${ext}`;

  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: filename,
      Body: buffer,
      ContentType: mimeType,
    }));
  } catch (err) {
    console.error('[Gallery] R2 upload error:', err);
    return json(res, 500, { error: 'Failed to upload image' });
  }

  const url = `${PUBLIC_URL}/${filename}`;
  const doc = {
    url,
    author: decoded.username,
    authorId: decoded.userId,
    title: (title || '').substring(0, 100).trim(),
    likes: 0,
    views: 0,
    createdAt: new Date(),
  };

  try {
    const result = await db.collection('gallery').insertOne(doc);
    json(res, 201, {
      id: result.insertedId.toString(),
      url,
      author: decoded.username,
      title: doc.title,
      likes: 0,
      views: 0,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error('[Gallery] DB insert error:', err);
    json(res, 500, { error: 'Failed to save gallery item' });
  }
}

/**
 * POST /api/gallery/:id/like — increment like counter.
 */
export async function handleGalleryLike(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  // Validate id is a 24-char hex string
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const { ObjectId } = await import('mongodb');
    const result = await db.collection('gallery').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { likes: 1 } },
      { returnDocument: 'after' }
    );

    if (!result) return json(res, 404, { error: 'Item not found' });
    json(res, 200, { likes: result.likes });
  } catch (err) {
    console.error('[Gallery] Like error:', err);
    json(res, 500, { error: 'Failed to update likes' });
  }
}
