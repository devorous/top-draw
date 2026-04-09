/** @fileoverview Helpers for resolving the current database-backed user from a bearer token. */

import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { verifyToken } from './auth.js';

export function getBearerToken(req) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

export async function getUserFromToken(token, options = {}) {
  if (!token) return null;

  const decoded = verifyToken(token);
  if (!decoded?.userId || !ObjectId.isValid(decoded.userId)) {
    return null;
  }

  const db = getDB();
  if (!db) return null;

  const projection = options.projection || undefined;
  return db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    projection ? { projection } : undefined
  );
}

export async function getRequestUser(req, options = {}) {
  const token = getBearerToken(req);
  if (!token) return null;
  return getUserFromToken(token, options);
}
