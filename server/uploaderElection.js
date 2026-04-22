/** @fileoverview Server-side uploader election — picks the best client to upload board checkpoints. */

import { ObjectId } from 'mongodb';
import { isRecentlyActive, scoreProvider } from './providerScoring.js';
import { getUploaderIdentity } from './uploaderIdentity.js';
import { startProbe } from './bandwidthProbe.js';
import { getDB } from './db.js';

const ELECTION_INTERVAL_MS = 30_000;
const PROBE_STALENESS_MS = 120_000; // Re-probe a client if their last measurement is older than this

/**
 * Pick one client per tick to probe (round-robin) to bound overall bandwidth cost.
 * Prefers clients with no measurement or stale measurement.
 * @param {Room} room
 * @param {Function} sendTo
 */
function probeOneClient(room, sendTo) {
  const now = Date.now();
  const eligible = [];
  for (const ws of room.clients) {
    if (ws.readyState !== 1) continue;        // OPEN
    if (ws.skipUploadBps) continue;           // Localhost/dev connections can report unrealistic bps
    if (ws._bwProbeId) continue;              // Already probing
    if (ws.tabHidden) continue;               // Background tabs — skip
    if (ws.lowPowerMode) continue;
    const user = room.sessionManager.getUser(ws.sessionIndex);
    if (!user?.name) continue;
    eligible.push({
      ws,
      user,
      lastProbeTs: ws.lastProbeTs || 0
    });
  }
  if (eligible.length === 0) return;

  // Prefer never-measured, then oldest measurement
  eligible.sort((a, b) => a.lastProbeTs - b.lastProbeTs);
  const stalest = eligible[0];
  if (stalest.lastProbeTs && (now - stalest.lastProbeTs) < PROBE_STALENESS_MS) {
    // Everyone's measurement is fresh — skip this tick
    return;
  }

  const { ws, user } = stalest;
  startProbe(ws, {
    sendTo,
    username: user.name,
    onPersist: (bps) => {
      user.uploadBps = bps;
      user.lastProbeTs = Date.now();
      if (ws.userId) {
        const db = getDB();
        if (db) {
          db.collection('users').updateOne(
            { _id: new ObjectId(ws.userId) },
            { $set: { uploadBps: bps, uploadBpsAt: new Date() } }
          ).catch(() => {});
        }
      }
    }
  });
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
    const user = room.sessionManager.getUser(ws.sessionIndex);
    const username = getUploaderIdentity(room, ws);
    if (!username) continue;
    const score = scoreProvider(ws, user);
    candidates.push({
      username,
      ping: ws.pingRtt,
      lowPower: ws.lowPowerMode,
      hidden: !!ws.tabHidden,
      active: isRecentlyActive(user),
      uploadBps: ws.uploadBps ?? null,
      lastProbeTs: ws.lastProbeTs ?? 0,
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
export function startElection(room, broadcastSettings, sendTo = null) {
  stopElection(room);

  const tick = () => {
    // Kick off a bandwidth probe for one client (round-robin, stale-first).
    // Probe result updates ws.uploadBps asynchronously — the *next* tick uses it.
    if (sendTo) probeOneClient(room, sendTo);

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
