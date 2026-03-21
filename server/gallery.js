/** @fileoverview Gallery API handlers — upload to R2, store metadata in MongoDB. */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { getDB } from './db.js';
import { verifyToken } from './auth.js';

// Lazy-load sharp to avoid startup issues if not installed
let sharp = null;
async function getSharp() {
  if (sharp === null) {
    try {
      sharp = (await import('sharp')).default;
    } catch {
      sharp = false; // Mark as unavailable
    }
  }
  return sharp || null;
}

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
 * GET /api/gallery — list gallery items.
 * Query params:
 *   - page (default 1)
 *   - limit (default 24, max 50)
 *   - sort: newest (default), top, views
 *   - author: filter by username
 */
export async function handleGalleryList(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  // Sorting
  const sortParam = urlObj.searchParams.get('sort') || 'newest';
  const sortOptions = {
    newest: { createdAt: -1 },
    top: { likes: -1, createdAt: -1 },
    views: { views: -1, createdAt: -1 },
  };
  const sort = sortOptions[sortParam] || sortOptions.newest;

  // Author filter
  const author = urlObj.searchParams.get('author');
  const query = author ? { author } : {};

  try {
    const [items, total] = await Promise.all([
      db.collection('gallery').find(query).sort(sort).skip(skip).limit(limit).toArray(),
      db.collection('gallery').countDocuments(query),
    ]);

    json(res, 200, {
      items: items.map(item => ({
        id: item._id.toString(),
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
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
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const thumbFilename = `${id}_thumb.${ext}`;

  // Generate thumbnail if sharp is available
  let thumbBuffer = null;
  const sharpLib = await getSharp();
  if (sharpLib) {
    try {
      thumbBuffer = await sharpLib(buffer)
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    } catch (err) {
      console.warn('[Gallery] Thumbnail generation failed:', err.message);
    }
  }

  try {
    // Upload original
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: filename,
      Body: buffer,
      ContentType: mimeType,
    }));

    // Upload thumbnail if generated
    if (thumbBuffer) {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbFilename,
        Body: thumbBuffer,
        ContentType: mimeType,
      }));
    }
  } catch (err) {
    console.error('[Gallery] R2 upload error:', err);
    return json(res, 500, { error: 'Failed to upload image' });
  }

  const url = `${PUBLIC_URL}/${filename}`;
  const thumbUrl = thumbBuffer ? `${PUBLIC_URL}/${thumbFilename}` : url;
  const doc = {
    url,
    thumbUrl,
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
      thumbUrl,
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
 * GET /api/gallery/:id — fetch a single gallery item.
 */
export async function handleGalleryItem(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const { ObjectId } = await import('mongodb');
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });

    if (!item) return json(res, 404, { error: 'Item not found' });

    json(res, 200, {
      id: item._id.toString(),
      url: item.url,
      thumbUrl: item.thumbUrl || item.url,
      author: item.author,
      title: item.title || '',
      likes: item.likes || 0,
      views: item.views || 0,
      createdAt: item.createdAt,
    });
  } catch (err) {
    console.error('[Gallery] Item fetch error:', err);
    json(res, 500, { error: 'Failed to fetch item' });
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

/**
 * POST /api/gallery/:id/favorite — toggle favorite status.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavorite(req, res, id) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Authentication required' });
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 401, { error: 'Invalid or expired token' });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const { ObjectId } = await import('mongodb');
    const galleryId = new ObjectId(id);

    // Check if favorite exists
    const existing = await db.collection('favorites').findOne({
      userId: decoded.userId,
      galleryId: id,
    });

    if (existing) {
      // Remove favorite
      await db.collection('favorites').deleteOne({ _id: existing._id });
      json(res, 200, { favorited: false });
    } else {
      // Add favorite
      await db.collection('favorites').insertOne({
        userId: decoded.userId,
        galleryId: id,
        createdAt: new Date(),
      });
      json(res, 200, { favorited: true });
    }
  } catch (err) {
    console.error('[Gallery] Favorite error:', err);
    json(res, 500, { error: 'Failed to update favorite' });
  }
}

/**
 * GET /api/gallery/favorites — list user's favorited items.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavorites(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Authentication required' });
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 401, { error: 'Invalid or expired token' });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  try {
    const { ObjectId } = await import('mongodb');

    // Get user's favorites
    const favorites = await db.collection('favorites')
      .find({ userId: decoded.userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await db.collection('favorites').countDocuments({ userId: decoded.userId });
    const galleryIds = favorites.map(f => new ObjectId(f.galleryId));

    // Fetch gallery items
    const items = galleryIds.length > 0
      ? await db.collection('gallery').find({ _id: { $in: galleryIds } }).toArray()
      : [];

    // Maintain favorite order
    const itemMap = new Map(items.map(i => [i._id.toString(), i]));
    const orderedItems = favorites
      .map(f => itemMap.get(f.galleryId))
      .filter(Boolean);

    json(res, 200, {
      items: orderedItems.map(item => ({
        id: item._id.toString(),
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
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
    console.error('[Gallery] Favorites list error:', err);
    json(res, 500, { error: 'Failed to fetch favorites' });
  }
}

/**
 * GET /api/gallery/:id/favorite — check if user has favorited an item.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavoriteCheck(req, res, id) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 200, { favorited: false }); // Not logged in = not favorited
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 200, { favorited: false });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const existing = await db.collection('favorites').findOne({
      userId: decoded.userId,
      galleryId: id,
    });
    json(res, 200, { favorited: !!existing });
  } catch (err) {
    console.error('[Gallery] Favorite check error:', err);
    json(res, 500, { error: 'Failed to check favorite' });
  }
}

/**
 * GET /api/gallery/:id/comments — list comments for a gallery item.
 */
export async function handleGalleryCommentsList(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const comments = await db.collection('comments')
      .find({ galleryId: id })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    json(res, 200, {
      comments: comments.map(c => ({
        id: c._id.toString(),
        author: c.author,
        authorId: c.authorId,
        text: c.text,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    console.error('[Gallery] Comments list error:', err);
    json(res, 500, { error: 'Failed to fetch comments' });
  }
}

/**
 * POST /api/gallery/:id/comments — add a comment.
 * Requires Authorization: Bearer <token>
 * Body: { text: string }
 */
export async function handleGalleryCommentCreate(req, res, id) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Authentication required' });
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 401, { error: 'Invalid or expired token' });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const text = (body.text || '').trim();
  if (!text || text.length > 500) {
    return json(res, 400, { error: 'Comment must be 1-500 characters' });
  }

  try {
    const doc = {
      galleryId: id,
      authorId: decoded.userId,
      author: decoded.username,
      text,
      createdAt: new Date(),
    };

    const result = await db.collection('comments').insertOne(doc);

    json(res, 201, {
      id: result.insertedId.toString(),
      author: decoded.username,
      authorId: decoded.userId,
      text,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error('[Gallery] Comment create error:', err);
    json(res, 500, { error: 'Failed to add comment' });
  }
}

/**
 * DELETE /api/gallery/comments/:commentId — delete own comment.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryCommentDelete(req, res, commentId) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Authentication required' });
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) return json(res, 401, { error: 'Invalid or expired token' });

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(commentId)) return json(res, 400, { error: 'Invalid id' });

  try {
    const { ObjectId } = await import('mongodb');
    const comment = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return json(res, 404, { error: 'Comment not found' });
    }

    // Only allow author or admin (role >= 5) to delete
    if (comment.authorId !== decoded.userId && decoded.role < 5) {
      return json(res, 403, { error: 'Not authorized to delete this comment' });
    }

    await db.collection('comments').deleteOne({ _id: new ObjectId(commentId) });
    json(res, 200, { deleted: true });
  } catch (err) {
    console.error('[Gallery] Comment delete error:', err);
    json(res, 500, { error: 'Failed to delete comment' });
  }
}
