/** @fileoverview Gallery API handlers — upload to R2, store metadata in MongoDB. */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { getDB } from './db.js';
import { getBearerToken, getRequestUser, getUserFromToken } from './authUser.js';
import { INLINE_IMAGE_MIME_TYPES, validateDataUrlImage } from './imageValidation.js';
import { getClientIp, httpRateLimiter } from './security.js';

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
const MAX_GALLERY_IMAGE_WIDTH = 8192;
const MAX_GALLERY_IMAGE_HEIGHT = 8192;
const MAX_GALLERY_IMAGE_PIXELS = 33_554_432;
const JSON_BODY_LIMIT = MAX_IMAGE_BYTES + 65536;
const GALLERY_UPLOAD_LIMIT = { max: 12, windowMs: 60 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const GALLERY_COMMENT_LIMIT = { max: 20, windowMs: 5 * 60 * 1000, blockMs: 10 * 60 * 1000 };
const GALLERY_LIKE_LIMIT = { max: 240, windowMs: 60 * 1000, blockMs: 60 * 1000 };
const GALLERY_FAVORITE_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };

/** Verify that the buffer's magic bytes match the declared MIME type. */
function verifyMagicBytes(buffer, mimeType) {
  if (buffer.length < 4) return false;

  // PNG: 89 50 4E 47
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  }
  // JPEG: FF D8 FF
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  }
  // GIF: 47 49 46 38
  if (mimeType === 'image/gif') {
    return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  }
  // WebP: RIFF....WEBP
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  }
  // Unknown MIME — reject
  return false;
}

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
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const RESERVED_TAGS = ['nsfw'];
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 24;

// Callback for broadcasting floating art updates via WebSocket
let broadcastFloatingArtUpdate = null;
let galleryDiscordPoster = null;

/**
 * Set the callback for broadcasting floating art updates to WebSocket clients
 * @param {Function} callback - Function to call with (roomTags, galleryItem)
 */
export function setFloatingArtBroadcaster(callback) {
  broadcastFloatingArtUpdate = callback;
}

/**
 * Set the callback for posting opt-in gallery uploads to Discord.
 * @param {Function} callback - Function to call with the saved gallery item
 */
export function setGalleryDiscordPoster(callback) {
  galleryDiscordPoster = callback;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

async function requireAuthenticatedUser(req, res, options = {}) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  const user = await getRequestUser(req, options);
  if (!user) {
    json(res, 401, { error: 'Invalid or expired token' });
    return null;
  }

  return user;
}

async function readBody(req, maxBytes = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function normalizeTags(input) {
  const source = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];

  const seen = new Set();
  const tags = [];

  for (const rawTag of source) {
    const tag = String(rawTag || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }

  return tags;
}

function toClientGalleryItem(item, likedGalleryIds = null) {
  const id = item._id.toString();
  const tagUsername = item.tagUsername !== false;
  return {
    id,
    url: item.url,
    thumbUrl: item.thumbUrl || item.url,
    author: tagUsername ? item.author : 'Anonymous',
    tagUsername,
    title: item.title || '',
    description: item.description || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    likesCount: item.likesCount || 0,
    liked: likedGalleryIds ? likedGalleryIds.has(id) : false,
    likedByCurrentUser: likedGalleryIds ? likedGalleryIds.has(id) : false,
    views: item.views || 0,
    createdAt: item.createdAt,
  };
}

async function getRequestLikedGalleryIds(req, galleryIds = []) {
  const token = getBearerToken(req);
  if (!token || galleryIds.length === 0) return new Set();

  const user = await getUserFromToken(token, { projection: { likedGalleryIds: 1 } });
  if (!user || !Array.isArray(user.likedGalleryIds)) return new Set();

  const requested = new Set(galleryIds.map(String));
  return new Set(user.likedGalleryIds.map(String).filter(id => requested.has(id)));
}

async function recordGalleryLike(db, { galleryId, userId, username }) {
  try {
    await db.collection('gallery_likes').updateOne({
      galleryId,
      userId,
    }, {
      $setOnInsert: {
        galleryId,
        userId,
        username,
        createdAt: new Date(),
      }
    }, { upsert: true });
  } catch (err) {
    if (err?.code === 11000) {
      console.warn('[Gallery] gallery_likes duplicate during like record; continuing with user like state:', err.keyValue || err.message);
      return;
    }
    throw err;
  }
}

/**
 * GET /api/gallery — list gallery items.
 * Query params:
 *   - page (default 1)
 *   - limit (default 24, max 50)
 *   - sort: newest (default), active, top, views
 *   - period: week, month, year, all (top sort only; default all)
 *   - author: filter by username
 *   - tag: filter by tag
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
    top: { likesCount: -1, createdAt: -1 },
    views: { views: -1, createdAt: -1 },
  };
  const sort = sortOptions[sortParam] || sortOptions.newest;
  const periodParam = urlObj.searchParams.get('period') || 'all';
  const topPeriodMs = {
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  // Author filter
  const author = urlObj.searchParams.get('author');
  const tag = normalizeTags(urlObj.searchParams.get('tag')).at(0) || null;
  const query = {};
  if (author) query.author = author;
  if (tag) query.tags = tag;
  if (sortParam === 'top' && topPeriodMs[periodParam]) {
    query.createdAt = { $gte: new Date(Date.now() - topPeriodMs[periodParam]) };
  }

  try {
    const isActiveSort = sortParam === 'active';
    const itemsPromise = isActiveSort
      ? db.collection('gallery').aggregate([
        { $match: query },
        {
          $lookup: {
            from: 'comments',
            let: { galleryId: { $toString: '$_id' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$galleryId', '$$galleryId'] } } },
              { $sort: { createdAt: -1 } },
              { $limit: 1 },
              { $project: { _id: 0, createdAt: 1 } }
            ],
            as: 'latestComment'
          }
        },
        {
          $addFields: {
            activeAt: {
              $ifNull: [{ $arrayElemAt: ['$latestComment.createdAt', 0] }, '$createdAt']
            }
          }
        },
        { $sort: { activeAt: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { latestComment: 0, activeAt: 0 } }
      ]).toArray()
      : db.collection('gallery').find(query).sort(sort).skip(skip).limit(limit).toArray();

    const [items, total] = await Promise.all([
      itemsPromise,
      db.collection('gallery').countDocuments(query),
    ]);

    const likedGalleryIds = await getRequestLikedGalleryIds(req, items.map(item => item._id.toString()));

    json(res, 200, {
      items: items.map(item => toClientGalleryItem(item, likedGalleryIds)),
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
 * Body: { imageData: "data:image/png;base64,...", title?: string, tags?: string[]|string }
 */
export async function handleGalleryUpload(req, res) {
  const clientIp = getClientIp(req);
  const uploadLimit = httpRateLimiter.consume(`gallery:upload:${clientIp}`, GALLERY_UPLOAD_LIMIT);
  if (!uploadLimit.allowed) {
    return json(res, 429, { error: 'Too many uploads. Please try again later.' });
  }

  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!r2) return json(res, 503, { error: 'Storage not configured — set R2_ENDPOINT env var' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { error: 'Request body too large' });
    }
    return json(res, 400, { error: 'Invalid request body' });
  }

  const { imageData, title, description, tags, tagUsername } = body;
  const tagUsernameFlag = tagUsername !== false;
  if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
    return json(res, 400, { error: 'Missing or invalid imageData' });
  }

  const normalizedTags = normalizeTags(tags);

  const imageValidation = await validateDataUrlImage(imageData, {
    maxBytes: MAX_IMAGE_BYTES,
    maxWidth: MAX_GALLERY_IMAGE_WIDTH,
    maxHeight: MAX_GALLERY_IMAGE_HEIGHT,
    maxPixels: MAX_GALLERY_IMAGE_PIXELS,
    allowedMimeTypes: INLINE_IMAGE_MIME_TYPES,
    maxDataUrlLength: Math.ceil(MAX_IMAGE_BYTES * 1.5) + 1024
  });
  if (!imageValidation.ok) {
    return json(res, 400, { error: imageValidation.error || 'Invalid image upload' });
  }

  const { buffer, mimeType } = imageValidation;

  // Verify magic bytes match claimed MIME type
  if (!verifyMagicBytes(buffer, mimeType)) {
    return json(res, 400, { error: 'Image data does not match declared format' });
  }

  // Validate dimensions and strip EXIF metadata using sharp
  const sharpLib = await getSharp();
  if (sharpLib) {
    try {
      const metadata = await sharpLib(buffer).metadata();
      const MAX_MEGAPIXELS = 25_000_000;
      if (metadata.width && metadata.height && metadata.width * metadata.height > MAX_MEGAPIXELS) {
        return json(res, 400, { error: `Image dimensions too large (max ${MAX_MEGAPIXELS / 1_000_000}MP)` });
      }
      if (metadata.width > 20000 || metadata.height > 20000) {
        return json(res, 400, { error: 'Image dimensions too large (max 20000px per side)' });
      }
    } catch {
      return json(res, 400, { error: 'Unable to read image — file may be corrupt' });
    }
  }

  // Compute image hash for duplicate detection
  const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Check for duplicate
  try {
    const existing = await db.collection('gallery').findOne({ imageHash });
    if (existing) {
      return json(res, 409, {
        error: 'This image has already been uploaded',
        duplicate: true,
        existingId: existing._id.toString(),
      });
    }
  } catch (err) {
    console.error('[Gallery] Duplicate check error:', err);
    // Continue with upload if duplicate check fails
  }

  const ext = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'image/webp'
      ? 'webp'
      : 'png';
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const thumbFilename = `${id}_thumb.${ext}`;

  // Strip EXIF/metadata from the original and generate thumbnail
  let sanitizedBuffer = buffer;
  let thumbBuffer = null;
  const sharpUpload = await getSharp();
  if (sharpUpload) {
    try {
      sanitizedBuffer = await sharpUpload(buffer)
        .rotate() // Auto-rotate based on EXIF before stripping
        .withMetadata({}) // Strip all EXIF/ICC/XMP metadata
        .toBuffer();
    } catch (err) {
      console.warn('[Gallery] EXIF strip failed, using original:', err.message);
    }

    try {
      thumbBuffer = await sharpUpload(sanitizedBuffer)
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    } catch (err) {
      console.warn('[Gallery] Thumbnail generation failed:', err.message);
    }
  }

  try {
    // Upload original (with metadata stripped)
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: filename,
      Body: sanitizedBuffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    // Upload thumbnail if generated
    if (thumbBuffer) {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbFilename,
        Body: thumbBuffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
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
    imageHash,
    author: authUser.username,
    authorId: authUser._id.toString(),
    tagUsername: tagUsernameFlag,
    title: (title || '').substring(0, 60).trim(),
    description: (description || '').substring(0, 300).trim(),
    tags: normalizedTags,
    likes: [],
    likesCount: 0,
    views: 0,
    createdAt: new Date(),
  };

  try {
    const result = await db.collection('gallery').insertOne(doc);
    const item = {
      id: result.insertedId.toString(),
      url,
      thumbUrl,
      author: tagUsernameFlag ? authUser.username : 'Anonymous',
      tagUsername: tagUsernameFlag,
      title: doc.title,
      description: doc.description,
      tags: doc.tags,
      likesCount: 0,
      views: 0,
      createdAt: doc.createdAt,
    };

    json(res, 201, item);

    if (doc.tags.includes('discord') && galleryDiscordPoster) {
      galleryDiscordPoster(item).catch(err => {
        console.error('[Gallery] Discord post error:', err);
      });
    }
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

    const likedGalleryIds = await getRequestLikedGalleryIds(req, [id]);
    json(res, 200, toClientGalleryItem(item, likedGalleryIds));
  } catch (err) {
    console.error('[Gallery] Item fetch error:', err);
    json(res, 500, { error: 'Failed to fetch item' });
  }
}

/**
 * POST /api/gallery/:id/like — toggle like (one per device, account, or IP).
 * Body: { deviceId?: string }
 * Rules: Same device/account/IP cannot vote twice. Voting again from same source removes the vote.
 */
export async function handleGalleryLike(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, likedGalleryIds: 1 }
  });
  if (!authUser) return;

  const userId = authUser._id.toString();
  const likeLimit = httpRateLimiter.consume(`gallery:like:user:${userId}`, GALLERY_LIKE_LIMIT);
  if (!likeLimit.allowed) {
    return json(res, 429, { error: 'Too many like requests. Please try again later.' });
  }

  try {
    const objectId = new ObjectId(id);

    // Check if item exists
    if (!await db.collection('gallery').findOne({ _id: objectId }, { projection: { _id: 1 } })) {
      return json(res, 404, { error: 'Item not found' });
    }

    const likedGalleryIds = Array.isArray(authUser.likedGalleryIds)
      ? authUser.likedGalleryIds.map(String)
      : [];
    const alreadyLiked = likedGalleryIds.includes(id);

    if (alreadyLiked) {
      const userUnlikeUpdate = await db.collection('users').updateOne(
        { _id: authUser._id },
        { $pull: { likedGalleryIds: id } }
      );
      if (userUnlikeUpdate.modifiedCount === 0) {
        const current = await db.collection('gallery').findOne(
          { _id: objectId },
          { projection: { likesCount: 1 } }
        );
        return json(res, 200, { liked: false, likesCount: current?.likesCount || 0 });
      }
      await db.collection('gallery_likes').deleteOne({ galleryId: id, userId });
      const updated = await db.collection('gallery').findOneAndUpdate(
        { _id: objectId, likesCount: { $gt: 0 } },
        { $inc: { likesCount: -1 } },
        { returnDocument: 'after', projection: { likesCount: 1 } }
      );
      return json(res, 200, { liked: false, likesCount: updated?.likesCount || 0 });
    }

    const userLikeUpdate = await db.collection('users').updateOne(
      { _id: authUser._id },
      { $addToSet: { likedGalleryIds: id } }
    );
    if (userLikeUpdate.modifiedCount === 0) {
      const current = await db.collection('gallery').findOne(
        { _id: objectId },
        { projection: { likesCount: 1 } }
      );
      return json(res, 200, { liked: true, likesCount: current?.likesCount || 0 });
    }
    await recordGalleryLike(db, { galleryId: id, userId, username: authUser.username });

    const updated = await db.collection('gallery').findOneAndUpdate(
      { _id: objectId },
      { $inc: { likesCount: 1 } },
      { returnDocument: 'after', projection: { likesCount: 1, tags: 1, _id: 1, url: 1, thumbUrl: 1, author: 1, authorId: 1, title: 1, description: 1, createdAt: 1, views: 1 } }
    );

    const newLikesCount = updated?.likesCount || 1;

    // Broadcast to rooms when image first becomes eligible (1 like + room tag).
    // Only items created in the current calendar month participate in the floating
    // gallery rotation, matching the monthly reset behaviour of the list endpoint.
    if (newLikesCount === 1 && broadcastFloatingArtUpdate) {
      const createdAt = updated?.createdAt ? new Date(updated.createdAt) : null;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      if (createdAt && createdAt >= startOfMonth) {
        const item = toClientGalleryItem(updated, new Set([id]));
        const tags = updated?.tags || [];
        broadcastFloatingArtUpdate(tags, item);
      }
    }

    json(res, 200, { liked: true, likesCount: newLikesCount });
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
  const clientIp = getClientIp(req);
  const favoriteLimit = httpRateLimiter.consume(`gallery:favorite:${clientIp}`, GALLERY_FAVORITE_LIMIT);
  if (!favoriteLimit.allowed) {
    return json(res, 429, { error: 'Too many favorite requests. Please try again later.' });
  }

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });
  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  try {
    // Check if favorite exists
    const existing = await db.collection('favorites').findOne({
      userId: authUser._id.toString(),
      galleryId: id,
    });

    if (existing) {
      // Remove favorite
      await db.collection('favorites').deleteOne({ _id: existing._id });
      json(res, 200, { favorited: false });
    } else {
      // Add favorite
      await db.collection('favorites').insertOne({
        userId: authUser._id.toString(),
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
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  try {
    // Get user's favorites
    const favorites = await db.collection('favorites')
      .find({ userId: authUser._id.toString() })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await db.collection('favorites').countDocuments({ userId: authUser._id.toString() });
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
        ...toClientGalleryItem(item),
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
 * GET /api/gallery/liked — list gallery items liked by the authenticated user.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryLiked(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, likedGalleryIds: 1 }
  });
  if (!authUser) return;

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;
  const likedGalleryIds = Array.isArray(authUser.likedGalleryIds)
    ? authUser.likedGalleryIds.map(String).filter(id => /^[a-f0-9]{24}$/i.test(id))
    : [];

  try {
    const pageIds = likedGalleryIds.slice().reverse().slice(skip, skip + limit);
    const objectIds = pageIds.map(id => new ObjectId(id));
    const items = objectIds.length > 0
      ? await db.collection('gallery').find({ _id: { $in: objectIds } }).toArray()
      : [];
    const itemMap = new Map(items.map(item => [item._id.toString(), item]));
    const orderedItems = pageIds.map(id => itemMap.get(id)).filter(Boolean);
    const likedSet = new Set(likedGalleryIds);

    json(res, 200, {
      items: orderedItems.map(item => toClientGalleryItem(item, likedSet)),
      total: likedGalleryIds.length,
      page,
      pages: Math.ceil(likedGalleryIds.length / limit),
    });
  } catch (err) {
    console.error('[Gallery] Liked list error:', err);
    json(res, 500, { error: 'Failed to fetch liked images' });
  }
}

/**
 * GET /api/gallery/:id/favorite — check if user has favorited an item.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavoriteCheck(req, res, id) {
  const token = getBearerToken(req);
  if (!token) {
    return json(res, 200, { favorited: false }); // Not logged in = not favorited
  }

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });
  const authUser = await getUserFromToken(token, { projection: { username: 1 } });
  if (!authUser) return json(res, 200, { favorited: false });

  try {
    const existing = await db.collection('favorites').findOne({
      userId: authUser._id.toString(),
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
        updatedAt: c.updatedAt,
        edited: !!c.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[Gallery] Comments list error:', err);
    json(res, 500, { error: 'Failed to fetch comments' });
  }
}

/**
 * GET /api/gallery/sidebar — fetch recent comments and popular tags for the sidebar.
 */
export async function handleGallerySidebar(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const author = urlObj.searchParams.get('author');
  const activeTag = normalizeTags(urlObj.searchParams.get('tag')).at(0) || null;
  const galleryMatch = {};
  if (author) galleryMatch.author = author;
  if (activeTag) galleryMatch.tags = activeTag;

  try {
    const recentCommentsPromise = db.collection('comments').aggregate([
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'gallery',
          let: { galleryId: '$galleryId' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$galleryId'] }, ...galleryMatch } },
            { $project: { _id: 1, author: 1, title: 1, thumbUrl: 1, url: 1, tags: 1 } }
          ],
          as: 'galleryItem'
        }
      },
      { $unwind: '$galleryItem' },
      { $limit: 12 }
    ]).toArray();

    const tagPipeline = [];
    if (Object.keys(galleryMatch).length > 0) {
      tagPipeline.push({ $match: galleryMatch });
    }
    tagPipeline.push(
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 20 }
    );

    const [recentComments, tags] = await Promise.all([
      recentCommentsPromise,
      db.collection('gallery').aggregate(tagPipeline).toArray()
    ]);

    json(res, 200, {
      reservedTags: RESERVED_TAGS,
      recentComments: recentComments.map((comment) => ({
        id: comment._id.toString(),
        text: comment.text,
        author: comment.author,
        authorId: comment.authorId,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        edited: !!comment.updatedAt,
        galleryId: comment.galleryId,
        image: {
          id: comment.galleryItem._id.toString(),
          title: comment.galleryItem.title || '',
          author: comment.galleryItem.author,
          thumbUrl: comment.galleryItem.thumbUrl || comment.galleryItem.url,
          tags: Array.isArray(comment.galleryItem.tags) ? comment.galleryItem.tags : [],
        }
      })),
      tags: tags.map((tag) => ({
        tag: tag._id,
        count: tag.count
      }))
    });
  } catch (err) {
    console.error('[Gallery] Sidebar error:', err);
    json(res, 500, { error: 'Failed to fetch gallery sidebar' });
  }
}

/**
 * POST /api/gallery/:id/comments — add a comment.
 * Requires Authorization: Bearer <token>
 * Body: { text: string }
 */
export async function handleGalleryCommentCreate(req, res, id) {
  const clientIp = getClientIp(req);
  const commentLimit = httpRateLimiter.consume(`gallery:comment:${clientIp}`, GALLERY_COMMENT_LIMIT);
  if (!commentLimit.allowed) {
    return json(res, 429, { error: 'Too many comments. Please try again later.' });
  }

  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { error: 'Request body too large' });
    }
    return json(res, 400, { error: 'Invalid request body' });
  }

  const text = (body.text || '').trim();
  if (!text || text.length > 500) {
    return json(res, 400, { error: 'Comment must be 1-500 characters' });
  }

  try {
    const galleryItem = await db.collection('gallery').findOne(
      { _id: new ObjectId(id) },
      { projection: { _id: 1 } }
    );
    if (!galleryItem) {
      return json(res, 404, { error: 'Item not found' });
    }

    const doc = {
      galleryId: id,
      authorId: authUser._id.toString(),
      author: authUser.username,
      text,
      createdAt: new Date(),
    };

    const result = await db.collection('comments').insertOne(doc);

    json(res, 201, {
      id: result.insertedId.toString(),
      author: authUser.username,
      authorId: authUser._id.toString(),
      text,
      createdAt: doc.createdAt,
      updatedAt: null,
      edited: false,
    });
  } catch (err) {
    console.error('[Gallery] Comment create error:', err);
    json(res, 500, { error: 'Failed to add comment' });
  }
}

/**
 * PATCH /api/gallery/comments/:commentId — edit own comment.
 * Requires Authorization: Bearer <token>
 * Body: { text: string }
 */
export async function handleGalleryCommentUpdate(req, res, commentId) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(commentId)) return json(res, 400, { error: 'Invalid id' });

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
    const updatedAt = new Date();
    const comment = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return json(res, 404, { error: 'Comment not found' });
    }

    // Only allow the original author to edit their comment.
    if (comment.authorId !== authUser._id.toString()) {
      return json(res, 403, { error: 'Not authorized to edit this comment' });
    }

    await db.collection('comments').updateOne(
      { _id: new ObjectId(commentId) },
      { $set: { text, updatedAt } }
    );

    json(res, 200, { text, updatedAt, edited: true });
  } catch (err) {
    console.error('[Gallery] Comment update error:', err);
    json(res, 500, { error: 'Failed to update comment' });
  }
}

/**
 * DELETE /api/gallery/comments/:commentId — delete own comment.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryCommentDelete(req, res, commentId) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(commentId)) return json(res, 400, { error: 'Invalid id' });

  try {
    const comment = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return json(res, 404, { error: 'Comment not found' });
    }

    // Only allow author or HOLY+ (role >= 8) to delete
    if (comment.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to delete this comment' });
    }

    await db.collection('comments').deleteOne({ _id: new ObjectId(commentId) });
    json(res, 200, { deleted: true });
  } catch (err) {
    console.error('[Gallery] Comment delete error:', err);
    json(res, 500, { error: 'Failed to delete comment' });
  }
}

/**
 * PATCH /api/gallery/:id/tags — replace tags for a gallery item.
 * Requires Authorization: Bearer <token>
 * Body: { tags: string[]|string }
 */
export async function handleGalleryTagsUpdate(req, res, id) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const tags = normalizeTags(body.tags);

  try {
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });
    if (!item) return json(res, 404, { error: 'Item not found' });

    if (item.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to edit tags for this item' });
    }

    await db.collection('gallery').updateOne(
      { _id: new ObjectId(id) },
      { $set: { tags } }
    );

    json(res, 200, { tags });
  } catch (err) {
    console.error('[Gallery] Tags update error:', err);
    json(res, 500, { error: 'Failed to update tags' });
  }
}

/**
 * DELETE /api/gallery/:id — delete own gallery item.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryDelete(req, res, id) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });

    if (!item) {
      return json(res, 404, { error: 'Item not found' });
    }

    // Only allow author or HOLY+ (role >= 8) to delete
    if (item.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to delete this item' });
    }

    // Delete from R2 if configured
    if (r2 && item.url) {
      try {
        const filename = item.url.split('/').pop();
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: filename }));
        // Also delete thumbnail if exists
        if (item.thumbUrl && item.thumbUrl !== item.url) {
          const thumbFilename = item.thumbUrl.split('/').pop();
          await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: thumbFilename }));
        }
      } catch (err) {
        console.warn('[Gallery] R2 delete failed (continuing):', err.message);
      }
    }

    // Delete associated comments and favorites
    await Promise.all([
      db.collection('gallery').deleteOne({ _id: new ObjectId(id) }),
      db.collection('comments').deleteMany({ galleryId: id }),
      db.collection('favorites').deleteMany({ galleryId: id }),
      db.collection('gallery_likes').deleteMany({ galleryId: id }),
      db.collection('users').updateMany({}, { $pull: { likedGalleryIds: id } }),
    ]);

    json(res, 200, { deleted: true });
  } catch (err) {
    console.error('[Gallery] Delete error:', err);
    json(res, 500, { error: 'Failed to delete item' });
  }
}

/**
 * GET /api/gallery/floating?room=<roomId>&minLikes=2&limit=20
 * Fetch gallery images suitable for floating art display (images with minimum likes, tagged with room)
 */
export async function handleFloatingArtList(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const room = urlObj.searchParams.get('room') || 'lobby';
  const minLikes = Math.max(0, parseInt(urlObj.searchParams.get('minLikes') || '2'));
  const limit = Math.min(200, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '20')));
  const includeIds = [...new Set(urlObj.searchParams.getAll('includeId').filter(id => /^[a-f0-9]{24}$/i.test(id)))];
  const excludeIds = [...new Set(urlObj.searchParams.getAll('excludeId').filter(id => /^[a-f0-9]{24}$/i.test(id)))];

  // Normalize room tag
  const roomTag = normalizeTags(room).at(0) || 'lobby';

  try {
    const token = getBearerToken(req);
    const authUser = token ? await getUserFromToken(token, { projection: { likedGalleryIds: 1 } }) : null;

    const baseQuery = {
      _id: excludeIds.length > 0
        ? { $nin: excludeIds.map(id => new ObjectId(id)) }
        : { $exists: true }
    };

    // Monthly rotation: only surface items created during the current calendar month.
    // Resets automatically at the start of each month.
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [includedItems, taggedItems] = await Promise.all([
      includeIds.length > 0
        ? db.collection('gallery')
            .find({
              _id: { $in: includeIds.map(id => new ObjectId(id)) },
              createdAt: { $gte: startOfMonth }
            })
            .toArray()
        : Promise.resolve([]),
      db.collection('gallery')
        .find({
          ...baseQuery,
        tags: roomTag,
        likesCount: { $gte: minLikes },
        createdAt: { $gte: startOfMonth }
      })
      .sort({ likesCount: -1, createdAt: -1 })
      .limit(limit)
      .toArray()
    ]);

    const merged = [];
    const seen = new Set();

    for (const item of includedItems) {
      const id = item?._id?.toString?.();
      if (!id || seen.has(id) || excludeIds.includes(id)) continue;
      seen.add(id);
      merged.push(item);
    }

    for (const item of taggedItems) {
      const id = item?._id?.toString?.();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }

    const mergedIds = merged.map(item => item?._id?.toString?.()).filter(Boolean);
    const likedSet = new Set(
      Array.isArray(authUser?.likedGalleryIds)
        ? authUser.likedGalleryIds.map(String).filter(id => mergedIds.includes(id))
        : []
    );

    json(res, 200, {
      items: merged.slice(0, limit).map((item) => toClientGalleryItem(item, likedSet)),
      room: roomTag,
      minLikes,
      count: merged.length
    });
  } catch (err) {
    console.error('[Gallery] Floating art list error:', err);
    json(res, 500, { error: 'Failed to fetch floating art' });
  }
}
