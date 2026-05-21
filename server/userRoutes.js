/** @fileoverview User profile API endpoints. */

import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { getRequestUser, getBearerToken, getUserFromToken } from './authUser.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const AVATAR_MAX_BYTES = 64 * 1024; // ~64KB after base64 encoding
const PROFILE_BODY_LIMIT = 128 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function stripSessionSuffix(username) {
  if (typeof username !== 'string') return '';
  return username.trim().replace(/-\d+$/, '');
}

async function readBody(req, maxBytes = PROFILE_BODY_LIMIT) {
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

/**
 * GET /api/users/:username — fetch public user profile.
 */
export async function handleUserProfile(req, res, username) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  try {
    const users = db.collection('users');
    const normalizedUsername = stripSessionSuffix(username);

    let user = await users.findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (!user && normalizedUsername && normalizedUsername !== username) {
      user = await users.findOne(
        { username: normalizedUsername },
        { collation: { locale: 'en', strength: 2 } }
      );
    }

    if (!user) {
      return json(res, 404, { error: 'User not found' });
    }

    // Determine if the requester is viewing their own profile
    let isOwn = false;
    const token = getBearerToken(req);
    if (token) {
      const requester = await getUserFromToken(token, { projection: { _id: 1 } });
      if (requester && String(requester._id) === String(user._id)) {
        isOwn = true;
      }
    }

    const [uploadCount, totalLikes] = await Promise.all([
      db.collection('gallery').countDocuments({ author: user.username }),
      db.collection('gallery').aggregate([
        { $match: { author: user.username } },
        { $group: { _id: null, total: { $sum: '$likesCount' } } }
      ]).toArray(),
    ]);

    const recentUploads = await db.collection('gallery')
      .find({ author: user.username })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    json(res, 200, {
      username: user.username,
      role: user.role || 1,
      createdAt: user.createdAt || null,
      avatar: user.avatar || null,
      status: user.status || '',
      distanceDrawn: user.distanceDrawn || 0,
      totalStrokes: user.totalStrokes || 0,
      timeSpentMs: user.timeSpentMs || 0,
      consecutiveDaysDrawn: user.consecutiveDaysDrawn || 0,
      uploadCount,
      totalLikes: totalLikes[0]?.total || 0,
      isOwn,
      recentUploads: recentUploads.map(item => ({
        id: item._id.toString(),
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
        author: item.author,
        title: item.title || '',
        likesCount: item.likesCount || 0,
        views: item.views || 0,
        createdAt: item.createdAt,
      })),
    });
  } catch (err) {
    console.error('[Users] Profile error:', err);
    json(res, 500, { error: 'Failed to fetch profile' });
  }
}

/**
 * PATCH /api/users/me/profile — update status and/or avatar for the authenticated user.
 * Body: { status?: string, avatar?: string|null }  (avatar is a data URL)
 */
export async function handleUpdateProfile(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const me = await getRequestUser(req, { projection: { _id: 1 } });
  if (!me) return json(res, 401, { error: 'Authentication required' });

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const updates = {};

  if (payload.status !== undefined) {
    if (payload.status === null) {
      updates.status = '';
    } else if (typeof payload.status === 'string') {
      const trimmed = payload.status.replace(/\s+/g, ' ').trim().slice(0, 140);
      updates.status = trimmed;
    } else {
      return json(res, 400, { error: 'Status must be a string' });
    }
  }

  if (payload.avatar !== undefined) {
    if (payload.avatar === null || payload.avatar === '') {
      updates.avatar = null;
    } else if (typeof payload.avatar === 'string') {
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(payload.avatar)) {
        return json(res, 400, { error: 'Avatar must be a base64 image data URL' });
      }
      if (payload.avatar.length > AVATAR_MAX_BYTES) {
        return json(res, 413, { error: 'Avatar too large' });
      }
      updates.avatar = payload.avatar;
    } else {
      return json(res, 400, { error: 'Avatar must be a string or null' });
    }
  }

  if (Object.keys(updates).length === 0) {
    return json(res, 400, { error: 'Nothing to update' });
  }

  try {
    await db.collection('users').updateOne(
      { _id: new ObjectId(me._id) },
      { $set: updates }
    );
    json(res, 200, { ok: true, ...updates });
  } catch (err) {
    console.error('[Users] Update profile error:', err);
    json(res, 500, { error: 'Failed to update profile' });
  }
}
