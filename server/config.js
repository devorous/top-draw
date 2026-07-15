/** @fileoverview Shared server configuration and production startup validation. */

import 'dotenv/config';
import crypto from 'crypto';

export const DEFAULT_LOCAL_MONGODB_URI = 'mongodb://127.0.0.1:27017';

const LOCAL_MONGODB_URIS = new Set([
  DEFAULT_LOCAL_MONGODB_URI,
  'mongodb://localhost:27017'
]);

const devFallbacks = {
  jwtSecret: crypto.randomBytes(32).toString('hex'),
  ipSalt: crypto.randomBytes(32).toString('hex'),
  dmSecret: crypto.randomBytes(32).toString('hex')
};

const warned = new Set();

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function isTruthyEnv(name, defaultValue = false) {
  const value = getEnv(name).toLowerCase();
  if (!value) return defaultValue;
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function isLocalMongoUri(uri) {
  const normalized = String(uri || '').trim().replace(/\/+$/, '');
  if (LOCAL_MONGODB_URIS.has(normalized)) return true;

  try {
    const parsed = new URL(normalized);
    return parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
  } catch {
    return false;
  }
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function getJwtSecret() {
  const value = getEnv('JWT_SECRET');
  if (value) return value;
  if (isProduction()) {
    throw new Error('JWT_SECRET is required when NODE_ENV=production');
  }
  warnOnce('JWT_SECRET', '[SECURITY] JWT_SECRET not set - using random secret (sessions will not persist across restarts)');
  return devFallbacks.jwtSecret;
}

export function getIpSalt() {
  const value = getEnv('IP_SALT');
  if (value) return value;
  if (isProduction()) {
    throw new Error('IP_SALT is required when NODE_ENV=production');
  }
  warnOnce('IP_SALT', '[SECURITY] IP_SALT not set - ban fingerprints will not persist across server restarts');
  return devFallbacks.ipSalt;
}

export function getDmSecret() {
  const value = getEnv('SERVER_DM_SECRET');
  if (value) return value;
  if (isProduction()) {
    throw new Error('SERVER_DM_SECRET is required when NODE_ENV=production');
  }
  warnOnce('SERVER_DM_SECRET', '[SECURITY] SERVER_DM_SECRET not set - direct messages will be unreadable across server restarts');
  return devFallbacks.dmSecret;
}

export function getMongoUri() {
  return getEnv('MONGODB_URI') || DEFAULT_LOCAL_MONGODB_URI;
}

// --- Stripe (supporter subscriptions) ---
// Stripe is optional: when STRIPE_SECRET_KEY is unset the supporter purchase
// endpoints report 503 and the rest of the server runs normally.

export function getStripeSecretKey() {
  return getEnv('STRIPE_SECRET_KEY');
}

export function getStripeWebhookSecret() {
  return getEnv('STRIPE_WEBHOOK_SECRET');
}

export function getStripePriceId() {
  return getEnv('STRIPE_PRICE_ID');
}

// Non-recurring price for one-time support (optional — the one-time button
// reports unavailable without it).
export function getStripeOnetimePriceId() {
  return getEnv('STRIPE_ONETIME_PRICE_ID');
}

export function isStripeEnabled() {
  return !!getStripeSecretKey();
}

function hasCompleteR2Config(prefix = '') {
  const accessKeyNames = prefix ? [`${prefix}_ACCESS_KEY_ID`, 'R2_ACCESS_KEY_ID'] : ['R2_ACCESS_KEY_ID'];
  const secretNames = prefix
    ? [`${prefix}_SECRET_ACCESS_KEY`, `${prefix}_SECRET_KEY`]
    : ['R2_SECRET_ACCESS_KEY'];
  const bucketNames = prefix
    ? [`${prefix}_BUCKET`, 'R2_BUCKET_NAME']
    : ['R2_BUCKET_NAME'];

  return Boolean(
    getEnv('R2_ENDPOINT') &&
    accessKeyNames.some(getEnv) &&
    secretNames.some(getEnv) &&
    bucketNames.some(getEnv)
  );
}

function validateProductionR2(errors) {
  const galleryRequired = isTruthyEnv('REQUIRE_GALLERY_R2', true);
  const snapshotsRequired = isTruthyEnv('REQUIRE_SNAPSHOT_R2', true);

  if (galleryRequired && !hasCompleteR2Config()) {
    errors.push('Gallery R2 storage requires R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY');
  }

  if (snapshotsRequired && !hasCompleteR2Config('R2_SNAPSHOTS')) {
    errors.push('Snapshot R2 storage requires R2_ENDPOINT, R2_SNAPSHOTS_BUCKET or R2_BUCKET_NAME, R2_SNAPSHOTS_ACCESS_KEY_ID or R2_ACCESS_KEY_ID, and R2_SNAPSHOTS_SECRET_KEY/R2_SNAPSHOTS_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY');
  }
}

export function validateProductionConfig() {
  if (!isProduction()) return;

  const errors = [];
  const mongoUri = getEnv('MONGODB_URI');

  if (!getEnv('JWT_SECRET')) errors.push('JWT_SECRET is required');
  if (!getEnv('IP_SALT')) errors.push('IP_SALT is required');
  if (!getEnv('SERVER_DM_SECRET')) errors.push('SERVER_DM_SECRET is required');
  if (!mongoUri) {
    errors.push('MONGODB_URI is required');
  } else if (isLocalMongoUri(mongoUri)) {
    errors.push('MONGODB_URI must not point to the local development database');
  }

  validateProductionR2(errors);

  // Stripe is opt-in, but a partially configured Stripe is a bug: the webhook
  // would be unverifiable or checkout sessions would fail at runtime.
  if (getEnv('STRIPE_SECRET_KEY')) {
    if (!getEnv('STRIPE_WEBHOOK_SECRET')) errors.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
    if (!getEnv('STRIPE_PRICE_ID')) errors.push('STRIPE_PRICE_ID is required when STRIPE_SECRET_KEY is set');
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration is invalid:\n- ${errors.join('\n- ')}`);
  }
}
