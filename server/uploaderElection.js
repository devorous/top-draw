/** @fileoverview Server-side uploader election — picks the best client to upload board checkpoints. */

import { isRecentlyActive, scoreProvider } from './providerScoring.js';

const ELECTION_INTERVAL_MS = 30_000;

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
    const score = scoreProvider(ws, user);
    candidates.push({
      username: ws.registeredName || ws.username,
      ping: ws.pingRtt,
      lowPower: ws.lowPowerMode,
      hidden: !!ws.tabHidden,
      active: isRecentlyActive(user),
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
