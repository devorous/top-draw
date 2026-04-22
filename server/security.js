/** @fileoverview Shared server-side security helpers: IP extraction and in-memory rate limiting. */

/**
 * Best-effort check for whether an address belongs to a trusted local/private proxy.
 * This lets us honor X-Forwarded-For only when the immediate peer is local/private
 * or when TRUST_PROXY is explicitly enabled.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isTrustedProxyAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;

  const normalized = ip.trim().toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized === '::ffff:127.0.0.1'
  ) {
    return true;
  }

  const v4Match = normalized.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)/);
  if (!v4Match) {
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  const [a, b] = v4Match[1].split('.').map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Returns true for loopback addresses only. Private LAN addresses are not treated
 * as localhost because they can still represent real multi-device testing.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isLoopbackAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;

  const normalized = ip.trim().toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized === '::ffff:127.0.0.1'
  ) {
    return true;
  }

  const v4Match = normalized.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)/);
  if (!v4Match) return false;

  const [a] = v4Match[1].split('.').map(Number);
  return a === 127;
}

/**
 * Detects WebSocket/HTTP requests made through localhost so local development
 * does not persist unrealistic browser-to-same-machine bandwidth measurements.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} [clientIp]
 * @returns {boolean}
 */
export function isLocalhostRequest(req, clientIp = '') {
  const rawHost = String(req?.headers?.host || '').trim().toLowerCase();
  if (rawHost) {
    const host = rawHost.startsWith('[')
      ? rawHost.slice(0, rawHost.indexOf(']') + 1)
      : rawHost.split(':')[0];
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  }

  return isLoopbackAddress(clientIp || req?.socket?.remoteAddress || '');
}

/**
 * Extracts the best available client IP address for logging, moderation, and rate limiting.
 * X-Forwarded-For is only trusted when the direct peer looks like a private/local proxy,
 * or when TRUST_PROXY=true is set.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const remoteAddress = req?.socket?.remoteAddress || '';
  const trustProxy = process.env.TRUST_PROXY === 'true' || isTrustedProxyAddress(remoteAddress);
  const forwarded = req?.headers?.['x-forwarded-for'];

  if (trustProxy && typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return remoteAddress;
}

/**
 * Simple fixed-window limiter suitable for a single-process beta deployment.
 * For multi-instance deployments, move these counters to Redis or similar shared storage.
 */
export class FixedWindowRateLimiter {
  /**
   * @param {string} name
   */
  constructor(name) {
    this.name = name;
    this.entries = new Map();
  }

  /**
   * Attempts to consume capacity from the limiter.
   *
   * @param {string} key
   * @param {{ max: number, windowMs: number, blockMs?: number, cost?: number }} config
   * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number }}
   */
  consume(key, { max, windowMs, blockMs = 0, cost = 1 }) {
    const now = Date.now();
    if (this.entries.size > 5000) {
      for (const [entryKey, existing] of this.entries) {
        if (existing.resetAt <= now && existing.blockedUntil <= now) {
          this.entries.delete(entryKey);
        }
      }
    }

    let entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + windowMs,
        blockedUntil: 0
      };
    }

    if (entry.blockedUntil > now) {
      this.entries.set(key, entry);
      return {
        allowed: false,
        retryAfterMs: entry.blockedUntil - now,
        remaining: 0
      };
    }

    if (entry.count + cost > max) {
      if (blockMs > 0) {
        entry.blockedUntil = now + blockMs;
      }
      this.entries.set(key, entry);
      return {
        allowed: false,
        retryAfterMs: Math.max(entry.blockedUntil, entry.resetAt) - now,
        remaining: 0
      };
    }

    entry.count += cost;
    this.entries.set(key, entry);
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, max - entry.count)
    };
  }

  /**
   * Checks whether a key is currently blocked without consuming capacity.
   *
   * @param {string} key
   * @returns {{ blocked: boolean, retryAfterMs: number }}
   */
  inspect(key) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) {
      return { blocked: false, retryAfterMs: 0 };
    }

    if (entry.blockedUntil > now) {
      return {
        blocked: true,
        retryAfterMs: entry.blockedUntil - now
      };
    }

    if (entry.resetAt <= now) {
      this.entries.delete(key);
    }

    return { blocked: false, retryAfterMs: 0 };
  }

  /**
   * Clears any tracked state for a key.
   *
   * @param {string} key
   * @returns {void}
   */
  reset(key) {
    this.entries.delete(key);
  }
}

export const httpRateLimiter = new FixedWindowRateLimiter('http');
export const wsRateLimiter = new FixedWindowRateLimiter('ws');
export const messengerRateLimiter = new FixedWindowRateLimiter('messenger');
