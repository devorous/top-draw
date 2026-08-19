/** @fileoverview Shared server-side security helpers: IP extraction and in-memory rate limiting. */

import { normalizeIpString } from './ipIdentity.js';

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
 * The forwarded value must parse as a real address before it is trusted. It is
 * the leftmost X-Forwarded-For entry, which is client-supplied whenever the
 * proxy appends rather than overwrites — so it is attacker-controlled input,
 * and every IP-based control (ban, mute, shadowban, per-IP rate limits) is
 * keyed on the result. Unvalidated, junk here bought a fresh identity per
 * request in two different ways: `::ffff:999.1.1.1` minted a well-formed
 * "IPv4" identity in its own synthetic /24, and an unparseable string produced
 * no range fingerprints at all, so no stored ban could ever match it. Either
 * one lets a banned client reconnect indefinitely.
 *
 * An unusable value therefore falls back to the socket peer — which for a real
 * proxy deployment is the proxy itself. That is deliberately unhelpful to an
 * evader (one shared identity, and a bannable one) rather than silently
 * unbannable.
 *
 * The return value is canonicalized, so `ws.clientIp` carries one spelling of
 * one address everywhere downstream. Ban semantics are unaffected: `buildIpIdentity`
 * already canonicalized before hashing, so existing stored ranges still match.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const remoteAddress = req?.socket?.remoteAddress || '';
  const trustProxy = process.env.TRUST_PROXY === 'true' || isTrustedProxyAddress(remoteAddress);
  const forwarded = req?.headers?.['x-forwarded-for'];

  if (trustProxy && typeof forwarded === 'string' && forwarded.trim()) {
    const canonical = normalizeIpString(forwarded.split(',')[0].trim());
    if (canonical) return canonical;
  }

  return normalizeIpString(remoteAddress) || remoteAddress;
}

/**
 * Simple fixed-window limiter suitable for a single-process beta deployment.
 * For multi-instance deployments, move these counters to Redis or similar shared storage.
 *
 * Pass a `defaultConfig` to bake in a window/cap so callers can use the boolean
 * `check(key)` convenience; richer callers can still call `consume(key, config)`
 * directly with a per-call config.
 */
export class FixedWindowRateLimiter {
  /**
   * @param {string} name
   * @param {{ max: number, windowMs: number, blockMs?: number, cost?: number }} [defaultConfig]
   */
  constructor(name, defaultConfig = null) {
    this.name = name;
    this.entries = new Map();
    this.defaultConfig = defaultConfig;

    // Eagerly purge expired/unblocked entries so per-key state (often keyed by
    // connection UUID) does not accumulate between abuse bursts.
    const sweepMs = Math.max(30 * 1000, (defaultConfig?.windowMs || 60 * 1000) * 2);
    const sweep = setInterval(() => this._purgeExpired(), sweepMs);
    sweep.unref();
  }

  _purgeExpired() {
    const now = Date.now();
    for (const [entryKey, existing] of this.entries) {
      if (existing.resetAt <= now && existing.blockedUntil <= now) {
        this.entries.delete(entryKey);
      }
    }
  }

  /**
   * Boolean convenience over {@link consume} using the baked-in default config.
   *
   * @param {string} key
   * @param {{ max: number, windowMs: number, blockMs?: number, cost?: number }} [config]
   * @returns {boolean} true if allowed, false if rate limited
   */
  check(key, config = this.defaultConfig) {
    if (!config) throw new Error(`Rate limiter "${this.name}" has no config for check()`);
    return this.consume(key, config).allowed;
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
      this._purgeExpired();
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

// --- Pre-configured limiters (baked-in config; used via check(key)) ---

/** Auth endpoints: 10 attempts per 15 minutes */
export const authLimiter = new FixedWindowRateLimiter('auth', { windowMs: 15 * 60 * 1000, max: 10 });

/** Gallery uploads: 10 per hour */
export const uploadLimiter = new FixedWindowRateLimiter('upload', { windowMs: 60 * 60 * 1000, max: 10 });

/** WebSocket messages: coarse burst guard, keyed per connection by caller */
export const wsMessageLimiter = new FixedWindowRateLimiter('wsMessage', { windowMs: 1000, max: 1200 });

/** WebSocket sync messages: high throughput during sync operations (much more generous) */
export const wsSyncMessageLimiter = new FixedWindowRateLimiter('wsSync', { windowMs: 1000, max: 10000 });

/** WebSocket connections: 60 per minute per IP (tolerant of shared-NAT users) */
export const wsConnectionLimiter = new FixedWindowRateLimiter('wsConnection', { windowMs: 60 * 1000, max: 60 });

/** Feedback submissions: 3 per 10 minutes per IP */
export const feedbackLimiter = new FixedWindowRateLimiter('feedback', { windowMs: 10 * 60 * 1000, max: 3 });
