/** @fileoverview Lightweight in-memory rate limiter for HTTP and WebSocket endpoints. */

/**
 * Creates a rate limiter that tracks requests per key (typically IP).
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @returns {{ check(key: string): boolean, reset(key: string): void }}
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Periodically clean expired entries to prevent memory leaks
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, windowMs * 2);
  cleanup.unref();

  return {
    /**
     * Check if a request is allowed. Returns true if allowed, false if rate limited.
     * @param {string} key
     * @returns {boolean}
     */
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);

      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      entry.count++;
      return entry.count <= max;
    },

    reset(key) {
      hits.delete(key);
    },
  };
}

// --- Pre-configured limiters ---

/** Auth endpoints: 10 attempts per 15 minutes */
export const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

/** Gallery uploads: 10 per hour */
export const uploadLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

/** Gallery likes: 30 per minute (prevent spam-clicking) */
export const likeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

/** WebSocket messages: 200 per second per connection (burst protection) */
export const wsMessageLimiter = createRateLimiter({ windowMs: 1000, max: 200 });

/** WebSocket connections: 5 per minute per IP */
export const wsConnectionLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });
