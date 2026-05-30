/** @fileoverview Shared provider scoring helpers for sync and snapshot selection. */

const ACTIVE_WINDOW_MS = 60_000;
const HIDDEN_TAB_PENALTY = 300;
// NOTE: AFK is disqualifying, not a soft penalty — see the early return in
// scoreProvider. The server filters ALL canvas-mutating messages (MD/MU/FILL/
// CLR/UNDO/SEL_*/GLITCH_RESULT/TILE_*) away from AFK recipients (see
// INACTIVE_FILTERED_TYPES), so an AFK client's canvas is frozen at the moment
// they went idle. Using one as a sync/snapshot provider hands the joiner — or
// the persisted snapshot — a STALE canvas.
const MISSING_PING_PENALTY = 20;
const RECENT_ACTIVITY_BONUS = 160;
const ACTIVELY_DRAWING_BONUS = 500; // Prefer users with active strokes
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
 * @returns {number}
 */
export function scoreProvider(ws, user) {
  if (!ws) return -Infinity;
  if (ws.lowPowerMode) return -Infinity;
  // AFK clients have a stale canvas (see AFK_PENALTY note) — never a valid data
  // source.
  if (user?.afk) return -Infinity;

  let score = 0;
  const now = Date.now();
  const lastActivity = user?.lastActivity ?? 0;

  const recentlyActive = lastActivity && now - lastActivity < ACTIVE_WINDOW_MS;
  if (recentlyActive) {
    score += RECENT_ACTIVITY_BONUS;
  }

  // Prefer users with active strokes—they have the most recent canvas state
  if (user?.mousedown && recentlyActive && !user?.afk) {
    score += ACTIVELY_DRAWING_BONUS;
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

/**
 * Activity tier for provider ranking.
 * Higher is better. This is intentionally separate from raw score so sync
 * provider selection can prefer the highest-scoring active user before trying
 * inactive but high-bandwidth clients.
 *
 * @param {Object|null|undefined} user
 * @returns {number}
 */
export function getProviderActivityTier(user) {
  if (!user || user.afk) return 0;
  const recentlyActive = isRecentlyActive(user);
  if (user.mousedown && recentlyActive) return 2;
  return recentlyActive ? 1 : 0;
}

