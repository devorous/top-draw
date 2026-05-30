/** @fileoverview Provides utilities for password hashing and JWT token management. */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './config.js';

const SALT_ROUNDS = 10;

/**
 * Hashes a plaintext password using bcrypt.
 * @param {string} password - The plaintext password to hash.
 * @returns {Promise<string>} - The hashed password.
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verifies a plaintext password against a bcrypt hash.
 * @param {string} password - The plaintext password to verify.
 * @param {string} hash - The bcrypt hash to check against.
 * @returns {Promise<boolean>} - True if the password matches the hash, false otherwise.
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generates a JWT token for a given payload.
 * @param {Object} payload - The data to include in the token payload.
 * @returns {string} - The generated JWT token.
 */
export function generateToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '30d' });
}

/**
 * Verifies a JWT token and returns the decoded payload.
 * @param {string} token - The JWT token to verify.
 * @returns {Object|null} - The decoded payload if valid, otherwise null.
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}
