/** @fileoverview User profile API endpoints. */

import { getDB } from './db.js';
import { verifyToken } from './auth.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * GET /api/users/:username — fetch public user profile.
 */
export async function handleUserProfile(req, res, username) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  try {
    // Find user (case-insensitive)
    const user = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (!user) {
      return json(res, 404, { error: 'User not found' });
    }

    // Get gallery stats
    const [uploadCount, totalLikes] = await Promise.all([
      db.collection('gallery').countDocuments({ author: user.username }),
      db.collection('gallery').aggregate([
        { $match: { author: user.username } },
        { $group: { _id: null, total: { $sum: '$likes' } } }
      ]).toArray(),
    ]);

    // Get recent uploads (last 6)
    const recentUploads = await db.collection('gallery')
      .find({ author: user.username })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    json(res, 200, {
      username: user.username,
      createdAt: user.createdAt,
      uploadCount,
      totalLikes: totalLikes[0]?.total || 0,
      recentUploads: recentUploads.map(item => ({
        id: item._id.toString(),
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
        author: item.author,
        title: item.title || '',
        likes: item.likes || 0,
        views: item.views || 0,
        createdAt: item.createdAt,
      })),
    });
  } catch (err) {
    console.error('[Users] Profile error:', err);
    json(res, 500, { error: 'Failed to fetch profile' });
  }
}
