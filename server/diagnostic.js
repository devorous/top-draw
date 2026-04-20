/**
 * @fileoverview
 * Server-side endpoint for diagnostic canvas state collection.
 * 
 * Allows tests/debugging tools to query the canvas state of all users
 * in a room for sync verification without needing elaborate bot scripts.
 * 
 * Usage:
 *   GET /api/diagnostic/room/{roomId}/canvas-states
 *   Returns: { states: [{ userId, username, hash, layerCount }, ...] }
 */

import { getRoomManager } from './RoomManager.js';

/**
 * Broadcast a diagnostic request to all users in a room asking for canvas state.
 * Wait for responses and return aggregated result.
 * 
 * @param {string} roomId
 * @param {number} timeoutMs - How long to wait for responses (default 5000ms)
 * @returns {Promise<Object>} { states: [{ userId, username, hash, layerCount, strokesByUser }, ...], requestId, timestamp }
 */
export async function getCanvasStatesForRoom(roomId, timeoutMs = 5000) {
  const roomManager = getRoomManager();
  const room = roomManager.getRoom(roomId);
  
  if (!room) {
    return { error: 'Room not found', roomId };
  }

  const requestId = `diag_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const responses = new Map();
  const pendingPromises = [];

  // Listen for responses from clients
  const responseHandler = (userId, data) => {
    if (data.requestId === requestId) {
      responses.set(userId, {
        userId,
        username: data.username,
        hash: data.hash,
        layerCount: data.layerCount,
        strokesByUser: data.strokesByUser, // Map of userId -> stroke count
        timestamp: data.timestamp
      });
    }
  };

  // Register response listener on room
  room.on('diagnostic_response', responseHandler);

  // Broadcast request to all connected clients
  room.broadcast({
    t: 9999, // Custom diagnostic message type
    action: 'REQUEST_CANVAS_STATE',
    requestId
  });

  // Wait for responses (with timeout)
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      room.removeListener('diagnostic_response', responseHandler);
      resolve({
        states: Array.from(responses.values()),
        requestId,
        timestamp: Date.now(),
        timeout: true,
        totalUsers: room.users.size,
        respondedUsers: responses.size
      });
    }, timeoutMs);

    // Also resolve when we get responses from all connected users (or timeout)
    const checkComplete = () => {
      if (responses.size === room.users.size && room.users.size > 0) {
        clearTimeout(timeoutHandle);
        room.removeListener('diagnostic_response', responseHandler);
        resolve({
          states: Array.from(responses.values()),
          requestId,
          timestamp: Date.now(),
          timeout: false,
          totalUsers: room.users.size,
          respondedUsers: responses.size
        });
      }
    };

    // Poll for completion
    const pollHandle = setInterval(() => {
      checkComplete();
    }, 100);

    // Clear polling on timeout
    pendingPromises.push(() => {
      clearInterval(pollHandle);
    });
  });
}

/**
 * Compare canvas states from multiple users.
 * Returns: { allMatch: boolean, hashes: [...], divergences: [...] }
 */
export function compareCanvasStates(states) {
  if (!states || states.length === 0) {
    return { error: 'No states provided' };
  }

  const hashes = states.map(s => s.hash);
  const allHashesMatch = hashes.every(h => h === hashes[0]);
  
  const strokeCounts = states.map(s => ({
    userId: s.userId,
    username: s.username,
    count: s.layerCount
  }));
  const allCountsMatch = strokeCounts.every(sc => sc.count === strokeCounts[0].count);

  const divergences = [];
  if (!allHashesMatch) {
    divergences.push({
      type: 'CANVAS_HASH_MISMATCH',
      expected: hashes[0],
      actual: hashes.filter(h => h !== hashes[0]),
      details: states.map((s, i) => ({
        userId: s.userId,
        username: s.username,
        hash: s.hash,
        matches: s.hash === hashes[0]
      }))
    });
  }

  if (!allCountsMatch) {
    divergences.push({
      type: 'STROKE_COUNT_MISMATCH',
      details: strokeCounts
    });
  }

  return {
    allMatch: allHashesMatch && allCountsMatch,
    canvasHashesMatch: allHashesMatch,
    strokeCountsMatch: allCountsMatch,
    divergences,
    summary: {
      totalUsers: states.length,
      baselineHash: hashes[0],
      baselineStrokeCount: strokeCounts[0]?.count,
      userComparison: states.map((s, i) => ({
        user: `${s.username} (${s.userId})`,
        hash: s.hash,
        hashMatches: s.hash === hashes[0],
        strokes: s.layerCount,
        strokesMatch: s.layerCount === strokeCounts[0].count
      }))
    }
  };
}

/**
 * Express route handler for the diagnostic endpoint.
 * GET /api/diagnostic/room/{roomId}/canvas-states
 */
export async function handleDiagnosticCanvasStates(req, res) {
  try {
    const { roomId } = req.params;
    const timeout = parseInt(req.query.timeout) || 5000;

    const result = await getCanvasStatesForRoom(roomId, timeout);
    
    if (result.error) {
      return res.status(404).json(result);
    }

    const comparison = compareCanvasStates(result.states);
    
    res.json({
      ...result,
      comparison
    });
  } catch (err) {
    console.error('[Diagnostic] Error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Setup diagnostic routes on Express server.
 * Call this in server/index.js
 */
export function setupDiagnosticRoutes(app) {
  app.get('/api/diagnostic/room/:roomId/canvas-states', handleDiagnosticCanvasStates);
  console.log('[Diagnostic] Routes configured at /api/diagnostic/room/:roomId/canvas-states');
}
