import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '30d';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change-me-to-a-random-secret') {
    console.warn('[Auth] JWT_SECRET not set or using default — tokens will be insecure');
  }
  return secret || 'insecure-dev-fallback';
}

/**
 * Hash a plaintext password using bcrypt.
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a JWT token for a user.
 * @param {{ userId: string, username: string, role: string }} payload
 * @returns {string} signed JWT
 */
export function generateToken(payload) {
  return jwt.sign(
    { userId: payload.userId, username: payload.username, role: payload.role },
    getJwtSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * Verify and decode a JWT token.
 * @param {string} token
 * @returns {{ userId: string, username: string, role: string } | null}
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (err) {
    return null;
  }
}
