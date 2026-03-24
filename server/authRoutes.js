/** @fileoverview HTTP auth endpoints for gallery and other non-WebSocket clients. */

import { getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';

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
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * POST /api/auth/login — authenticate with username/password
 * Body: { username, password }
 * Returns: { success, token, username, role } or { success: false, error }
 */
export async function handleAuthLogin(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const { username, password } = body;
  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  try {
    const user = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (!user) {
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    const token = generateToken({
      userId: user._id.toString(),
      username: user.username,
      role: user.role || 1,
    });

    json(res, 200, {
      success: true,
      token,
      username: user.username,
      role: user.role || 1,
    });
  } catch (err) {
    console.error('[AuthRoutes] Login error:', err);
    json(res, 500, { success: false, error: 'Login failed' });
  }
}

/**
 * POST /api/auth/register — create new account
 * Body: { username, password, email?, secretQuestion?, secretAnswer? }
 * Returns: { success, token, username, role } or { success: false, error }
 */
export async function handleAuthRegister(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const { username, password, email, secretQuestion, secretAnswer } = body;
  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  // Validate username format
  if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
    return json(res, 400, { success: false, error: 'Username must be 2-20 characters (letters, numbers, _ -)' });
  }

  if (password.length < 4) {
    return json(res, 400, { success: false, error: 'Password must be at least 4 characters' });
  }

  try {
    // Check if username exists
    const existing = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );
    if (existing) {
      return json(res, 409, { success: false, error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);

    // Check if this is the first user (auto-promote to DEITY)
    const userCount = await db.collection('users').countDocuments();
    const role = userCount === 0 ? 9 : 1; // DEITY(9) for first user, USER(1) otherwise

    const doc = {
      username,
      passwordHash,
      email: email || null,
      secretQuestion: secretQuestion || null,
      secretAnswer: secretAnswer || null,
      role,
      createdAt: new Date(),
    };

    const result = await db.collection('users').insertOne(doc);

    const token = generateToken({
      userId: result.insertedId.toString(),
      username,
      role,
    });

    json(res, 201, {
      success: true,
      token,
      username,
      role,
    });
  } catch (err) {
    console.error('[AuthRoutes] Register error:', err);
    if (err.code === 11000) {
      return json(res, 409, { success: false, error: 'Username already taken' });
    }
    json(res, 500, { success: false, error: 'Registration failed' });
  }
}

/**
 * GET /api/auth/me — validate token and return user info
 * Header: Authorization: Bearer <token>
 * Returns: { success, username, role, userId } or { success: false, error }
 */
export async function handleAuthMe(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { success: false, error: 'No token provided' });
  }

  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) {
    return json(res, 401, { success: false, error: 'Invalid or expired token' });
  }

  json(res, 200, {
    success: true,
    userId: decoded.userId,
    username: decoded.username,
    role: decoded.role,
  });
}
