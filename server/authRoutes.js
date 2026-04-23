/** @fileoverview HTTP auth endpoints for gallery and other non-WebSocket clients. */

import { getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken } from './auth.js';
import { getBearerToken, getUserFromToken } from './authUser.js';
import { getClientIp, httpRateLimiter } from './security.js';
import { getUsernameValidationMessage, isValidUsername, normalizeUsername } from '../shared/identity.js';
import { Role } from './SessionManager.js';
import { getIpSubnet, mergeHistory, normalizeIdentityPayload, recordConnectionEvent } from './identityTracking.js';
import crypto from 'crypto';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const AUTH_BODY_LIMIT = 16 * 1024;
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const REGISTER_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_REQUEST_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_COMPLETE_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getRequestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (host?.includes('localhost') ? 'http' : 'https');
  return host ? `${proto}://${host}` : (process.env.PUBLIC_APP_URL || 'https://ddraw.ca');
}

function buildResetLink(req, token) {
  const baseUrl = (process.env.PUBLIC_APP_URL || getRequestOrigin(req)).replace(/\/+$/, '');
  return `${baseUrl}/go/?resetToken=${encodeURIComponent(token)}`;
}

async function createPasswordResetToken(db, user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await db.collection('password_reset_tokens').insertOne({
    userId: user._id,
    username: user.username,
    tokenHash,
    createdAt: new Date(),
    expiresAt,
    usedAt: null,
    requestedIp: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  });

  return { token, expiresAt };
}

async function sendPasswordResetEmail({ to, username, resetLink }) {
  const from = process.env.RESET_EMAIL_FROM || 'support@ddraw.ca';
  const subject = 'Reset your DDraw password';
  const text = [
    `Hi ${username},`,
    '',
    'Use this link to reset your DDraw password:',
    resetLink,
    '',
    'This link expires in 1 hour. If you did not request it, you can ignore this email.',
    '',
    'DDraw Support'
  ].join('\n');

  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend email failed: ${response.status} ${detail}`);
    }
    return true;
  }

  console.warn('[AuthRoutes] RESEND_API_KEY not set; password reset link:', resetLink);
  return false;
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
  const loginKey = `auth:login:${clientIp}`;
  const loginLimit = httpRateLimiter.inspect(loginKey);
  if (loginLimit.blocked) {
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
      httpRateLimiter.consume(loginKey, LOGIN_RATE_LIMIT);
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      httpRateLimiter.consume(loginKey, LOGIN_RATE_LIMIT);
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    httpRateLimiter.reset(loginKey);

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
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
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

/**
 * POST /api/auth/password-reset/request
 * Body: { identifier, secretAnswer? }
 * Creates a reset link by email, or by secret answer when the username path is used.
 */
export async function handlePasswordResetRequest(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const limit = httpRateLimiter.consume(`auth:reset-request:${clientIp}`, RESET_REQUEST_RATE_LIMIT);
  if (!limit.allowed) {
    return json(res, 429, { success: false, error: 'Too many reset attempts. Please try again later.' });
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

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  const secretAnswer = typeof body.secretAnswer === 'string' ? body.secretAnswer.trim() : '';
  if (!identifier) {
    return json(res, 400, { success: false, error: 'Email or username required' });
  }

  try {
    const isEmail = identifier.includes('@');
    const query = isEmail
      ? { email: normalizeEmail(identifier) }
      : { username: normalizeUsername(identifier) };
    const user = await db.collection('users').findOne(query, {
      collation: { locale: 'en', strength: 2 },
      projection: { username: 1, email: 1, secretQuestion: 1, secretAnswerHash: 1 }
    });

    const genericMessage = 'If that account can be reset, a reset link will be sent or shown after verification.';
    if (!user) {
      return json(res, 200, { success: true, message: genericMessage });
    }

    if (isEmail) {
      const { token } = await createPasswordResetToken(db, user, req);
      const resetLink = buildResetLink(req, token);
      const emailSent = await sendPasswordResetEmail({
        to: user.email,
        username: user.username,
        resetLink,
      });

      return json(res, 200, {
        success: true,
        message: emailSent
          ? 'Password reset link sent. Check your email.'
          : 'Email sending is not configured, so the reset link was written to the server log.',
        emailSent,
      });
    }

    if (!secretAnswer) {
      if (user.secretQuestion && user.secretAnswerHash) {
        return json(res, 200, {
          success: true,
          requiresSecretAnswer: true,
          secretQuestion: user.secretQuestion,
        });
      }

      if (user.email) {
        const { token } = await createPasswordResetToken(db, user, req);
        const resetLink = buildResetLink(req, token);
        const emailSent = await sendPasswordResetEmail({
          to: user.email,
          username: user.username,
          resetLink,
        });

        return json(res, 200, {
          success: true,
          message: emailSent
            ? 'Password reset link sent. Check your email.'
            : 'Email sending is not configured, so the reset link was written to the server log.',
          emailSent,
        });
      }

      return json(res, 200, { success: true, message: genericMessage });
    }

    if (!user.secretAnswerHash) {
      return json(res, 400, { success: false, error: 'This account does not have a secret answer set.' });
    }

    const answerValid = await verifyPassword(secretAnswer.toLowerCase(), user.secretAnswerHash);
    if (!answerValid) {
      return json(res, 401, { success: false, error: 'Secret answer did not match' });
    }

    const { token } = await createPasswordResetToken(db, user, req);
    const resetLink = buildResetLink(req, token);
    json(res, 200, {
      success: true,
      resetLink,
      message: 'Secret answer accepted. Use the reset link to choose a new password.',
    });
  } catch (err) {
    console.error('[AuthRoutes] Password reset request error:', err);
    json(res, 500, { success: false, error: 'Password reset request failed' });
  }
}

/**
 * POST /api/auth/password-reset/complete
 * Body: { token, password }
 */
export async function handlePasswordResetComplete(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const limit = httpRateLimiter.consume(`auth:reset-complete:${clientIp}`, RESET_COMPLETE_RATE_LIMIT);
  if (!limit.allowed) {
    return json(res, 429, { success: false, error: 'Too many reset attempts. Please try again later.' });
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

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token || !password) {
    return json(res, 400, { success: false, error: 'Reset token and new password required' });
  }

  if (password.length < 6) {
    return json(res, 400, { success: false, error: 'Password must be at least 6 characters' });
  }

  try {
    const tokenHash = hashResetToken(token);
    const resetDoc = await db.collection('password_reset_tokens').findOne({
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });

    if (!resetDoc) {
      return json(res, 400, { success: false, error: 'Reset link is invalid or expired' });
    }

    const passwordHash = await hashPassword(password);
    await db.collection('users').updateOne(
      { _id: resetDoc.userId },
      { $set: { passwordHash, passwordChangedAt: new Date() } }
    );
    await db.collection('password_reset_tokens').updateOne(
      { _id: resetDoc._id },
      { $set: { usedAt: new Date(), completedIp: clientIp } }
    );

    json(res, 200, { success: true, message: 'Password updated. You can log in with the new password.' });
  } catch (err) {
    console.error('[AuthRoutes] Password reset complete error:', err);
    json(res, 500, { success: false, error: 'Password reset failed' });
  }
}
