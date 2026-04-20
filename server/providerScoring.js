/** @fileoverview Shared provider scoring helpers for sync and snapshot selection. */

const ACTIVE_WINDOW_MS = 60_000;
const HIDDEN_TAB_PENALTY = 300;
const AFK_PENALTY = 90;
const MISSING_PING_PENALTY = 20;
const ACTIVELY_DRAWING_BONUS = 50; // Prefer users with active strokes
const MISSING_UPLOAD_BPS_PENALTY = 60; // Haven't measured throughput yet — prefer anyone we have measured

/**
 * Score a client as a provider candidate.
 * Higher is better. Hidden tabs remain eligible, but incur a major penalty
 * so they are only selected when visible providers are unavailable.
 *
 * Prioritizes users who are actively drawing (mousedown) since they likely
 * have the most recent/complete canvas state.
 *
 * @param {WebSocket} ws
 * @param {Object|null|undefined} user
 * @param {{allowAfk?: boolean}} [options]
 * @returns {number}
 */
export function scoreProvider(ws, user, options = {}) {
  const { allowAfk = false } = options;

  if (!ws) return -Infinity;
  if (ws.lowPowerMode) return -Infinity;

  let score = 0;
  const now = Date.now();
  const lastActivity = user?.lastActivity ?? 0;

  if (lastActivity && now - lastActivity < ACTIVE_WINDOW_MS) {
    score += 20;
  }

  // Prefer users with active strokes—they have the most recent canvas state
  if (user?.mousedown) {
    score += ACTIVELY_DRAWING_BONUS;
  }

  if (!allowAfk && user?.afk) {
    score -= AFK_PENALTY;
  }

  if (ws.tabHidden) {
    score -= HIDDEN_TAB_PENALTY;
  }

  // Upload throughput — dominant metric. We measure bytes/sec via periodic probes.
  // Map log10(bps) so: 50 KB/s → ~+34, 500 KB/s → ~+234, 5 MB/s → ~+434.
  // A fast uploader dwarfs ping/activity differences, which is the point.
  if (typeof ws.uploadBps === 'number' && ws.uploadBps > 0) {
    score += Math.max(0, (Math.log10(ws.uploadBps) - 4) * 200);
  } else {
    score -= MISSING_UPLOAD_BPS_PENALTY;
  }

  // Ping is now a tiebreaker rather than a dominant factor — divide by 20 instead of 5.
  if (ws.pingRtt != null) {
    score -= ws.pingRtt / 20;
  } else {
    score -= MISSING_PING_PENALTY;
  }

  return score;
}

/**
 * Whether a client is recently active.
 * @param {Object|null|undefined} user
 * @returns {boolean}
 */
export function isRecentlyActive(user) {
  const lastActivity = user?.lastActivity ?? 0;
  return !!lastActivity && (Date.now() - lastActivity) < ACTIVE_WINDOW_MS;
}

