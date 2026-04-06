/** @fileoverview Server-side uploader election — picks the best client to upload board checkpoints. */

const ELECTION_INTERVAL_MS = 30_000;
const ACTIVE_WINDOW_MS = 60_000;

/**
 * Score a single WebSocket client as a checkpoint uploader candidate.
 * Higher is better. Returns -Infinity if disqualified.
 * @param {WebSocket} ws
 * @param {Object} user - SessionManager user object
 * @returns {number}
 */
function scoreCandidate(ws, user) {
  if (ws.lowPowerMode) return -Infinity;

  let score = 0;

  // +20 if recently active
  const lastActivity = user?.lastActivity ?? 0;
  if (lastActivity && Date.now() - lastActivity < ACTIVE_WINDOW_MS) {
    score += 20;
  }

  // Ping penalty — lower ping = higher score
  if (ws.pingRtt != null) {
    score -= ws.pingRtt / 5;
  } else {
    // No ping data yet — mild penalty, don't disqualify
    score -= 20;
  }

  return score;
}

/**
 * Run an election for the given room.
 * Returns the elected username (registeredName preferred, else display name), or null.
 * @param {Room} room
 * @returns {{ winner: string|null, candidates: Array }}
 */
export function runElection(room) {
  const candidates = [];

  for (const ws of room.clients) {
    if (!ws.username) continue;
    const user = room.sessionManager.getUser(ws.sessionIndex);
    const score = scoreCandidate(ws, user);
    candidates.push({
      username: ws.registeredName || ws.username,
      ping: ws.pingRtt,
      lowPower: ws.lowPowerMode,
      active: user && (Date.now() - (user.lastActivity ?? 0)) < ACTIVE_WINDOW_MS,
      score
    });
  }

  if (candidates.length === 0) return { winner: null, candidates };

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const winner = top.score > -Infinity ? top.username : null;

  return { winner, candidates };
}

/**
 * Start the per-room election timer.
 * Fires immediately, then every ELECTION_INTERVAL_MS.
 * Stores the elected username on room._electedUploader.
 * Calls broadcastSettings(room) after each election.
 * @param {Room} room
 * @param {Function} broadcastSettings - (room) => void
 */
export function startElection(room, broadcastSettings) {
  stopElection(room);

  const tick = () => {
    const { winner, candidates } = runElection(room);
    const changed = room._electedUploader !== winner;
    room._electedUploader = winner;
    room._electionCandidates = candidates;
    if (changed) {
      broadcastSettings(room);
    }
  };

  tick(); // Run immediately on first join
  room._electionTimer = setInterval(tick, ELECTION_INTERVAL_MS);
}

/**
 * Stop the per-room election timer.
 * @param {Room} room
 */
export function stopElection(room) {
  if (room._electionTimer) {
    clearInterval(room._electionTimer);
    room._electionTimer = null;
  }
  room._electedUploader = null;
  room._electionCandidates = [];
}
