/** @fileoverview HTTP auth endpoints for gallery and other non-WebSocket clients. */

import { getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken } from './auth.js';
import { getBearerToken, getUserFromToken } from './authUser.js';
import { getClientIp, httpRateLimiter } from './security.js';
import { getUsernameValidationMessage, isValidUsername, normalizeUsername } from '../shared/identity.js';
import { Role } from './SessionManager.js';
import { getIpSubnet, mergeHistory, normalizeIdentityPayload, recordConnectionEvent } from './identityTracking.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const AUTH_BODY_LIMIT = 16 * 1024;
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const REGISTER_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = AUTH_BODY_LIMIT) {
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
 * POST /api/auth/login — authenticate with username/password
 * Body: { username, password }
 * Returns: { success, token, username, role } or { success: false, error }
 */
export async function handleAuthLogin(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const clientSubnet = getIpSubnet(clientIp);
  const loginLimit = httpRateLimiter.consume(`auth:login:${clientIp}`, LOGIN_RATE_LIMIT);
  if (!loginLimit.allowed) {
    return json(res, 429, { success: false, error: 'Too many login attempts. Please try again later.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const identity = normalizeIdentityPayload(body);
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

    const ipHistory = mergeHistory(user.ipHistory, clientIp);
    const subnetHistory = mergeHistory(user.subnetHistory, clientSubnet);
    const deviceIds = mergeHistory(user.deviceIds, identity.deviceId);
    const fingerprintIds = mergeHistory(user.fingerprintIds, identity.fingerprintId);

    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          lastLoginAt: new Date(),
          lastIp: clientIp,
          lastSubnet: clientSubnet || null,
          lastDeviceId: identity.deviceId || null,
          lastFingerprintId: identity.fingerprintId || null,
          lastIdentitySummary: identity.identitySummary,
          ipHistory,
          subnetHistory,
          deviceIds,
          fingerprintIds
        }
      }
    );

    await recordConnectionEvent(db, {
      type: 'http_login',
      source: 'http',
      userId: user._id.toString(),
      username: user.username,
      ip: clientIp,
      subnet: clientSubnet,
      deviceId: identity.deviceId || null,
      fingerprintId: identity.fingerprintId || null,
      identitySummary: identity.identitySummary,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });

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

  const clientIp = getClientIp(req);
  const clientSubnet = getIpSubnet(clientIp);
  const registerLimit = httpRateLimiter.consume(`auth:register:${clientIp}`, REGISTER_RATE_LIMIT);
  if (!registerLimit.allowed) {
    return json(res, 429, { success: false, error: 'Too many registration attempts. Please try again later.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const secretQuestion = typeof body.secretQuestion === 'string' ? body.secretQuestion.trim() : '';
  const secretAnswer = typeof body.secretAnswer === 'string' ? body.secretAnswer.trim() : '';
  const identity = normalizeIdentityPayload(body);

  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  if (!isValidUsername(username)) {
    return json(res, 400, { success: false, error: getUsernameValidationMessage() });
  }

  if (password.length < 6) {
    return json(res, 400, { success: false, error: 'Password must be at least 6 characters' });
  }

  if (secretQuestion && !secretAnswer) {
    return json(res, 400, { success: false, error: 'Secret answer is required when providing a secret question' });
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
    const secretAnswerHash = secretAnswer ? await hashPassword(secretAnswer.toLowerCase()) : null;
    const role = Role.USER;

    const doc = {
      username,
      passwordHash,
      email: email || null,
      secretQuestion: secretQuestion || null,
      secretAnswerHash,
      role,
      createdAt: new Date(),
      lastLoginAt: new Date(),
      lastIp: clientIp,
      lastSubnet: clientSubnet || null,
      lastDeviceId: identity.deviceId || null,
      lastFingerprintId: identity.fingerprintId || null,
      lastIdentitySummary: identity.identitySummary,
      ipHistory: clientIp ? [clientIp] : [],
      subnetHistory: clientSubnet ? [clientSubnet] : [],
      deviceIds: identity.deviceId ? [identity.deviceId] : [],
      fingerprintIds: identity.fingerprintId ? [identity.fingerprintId] : []
    };

    const result = await db.collection('users').insertOne(doc);

    await recordConnectionEvent(db, {
      type: 'http_register',
      source: 'http',
      userId: result.insertedId.toString(),
      username,
      ip: clientIp,
      subnet: clientSubnet,
      deviceId: identity.deviceId || null,
      fingerprintId: identity.fingerprintId || null,
      identitySummary: identity.identitySummary,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });

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

  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const user = await getUserFromToken(getBearerToken(req), {
    projection: { username: 1, role: 1 }
  });
  if (!user) {
    return json(res, 401, { success: false, error: 'Invalid or expired token' });
  }

  json(res, 200, {
    success: true,
    userId: user._id.toString(),
    username: user.username,
    role: user.role ?? Role.USER,
  });
}
